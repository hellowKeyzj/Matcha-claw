use std::{collections::BTreeSet, fmt::Write as _};

use environment::{
    ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort,
    ConnectorSecretValue, InvalidConnectorSecretRef, InvalidProviderModel, ProviderAccount,
    ProviderAccountAuthMode, ProviderAccountId, ProviderAccountStore, ProviderApiProtocol,
    ProviderModel, ProviderModelCapability, ProviderModelStore, ProviderModelStoreFault,
};
use openclaw::{
    port::ProviderNativeConfigurationEffect,
    projection::provider_models::public_provider_model_identities,
};
use sha2::{Digest, Sha256};

use crate::{
    composition::Host,
    provider_accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
    session_model_selection::{
        MatchaProviderRuntimeConfig, MatchaProviderSecret, SessionModelSelectionDiagnostic,
    },
};

const MATCHA_PROVIDER_FINGERPRINT_PREFIX: &str = "matcha-provider:v1:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelDraft {
    pub model_id: String,
    pub capabilities: Vec<ProviderModelCapability>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
}

impl ProviderModelDraft {
    pub fn materialize(
        self,
        account_id: ProviderAccountId,
    ) -> Result<ProviderModel, InvalidProviderModel> {
        ProviderModel::try_new(
            account_id,
            self.model_id,
            self.capabilities,
            self.context_window,
            self.max_tokens,
            self.timeout_ms,
            self.aspect_ratio,
            self.resolution,
            self.quality,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelView {
    pub account_id: String,
    pub label: String,
    pub model_id: String,
    pub capabilities: Vec<ProviderModelCapability>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectableProviderModelView {
    pub model: ProviderModelView,
    pub selection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProviderModelSelection {
    pub(crate) view: ProviderModelView,
    protocol: Option<&'static str>,
    auth_mode: &'static str,
}

impl ResolvedProviderModelSelection {
    pub(crate) fn diagnostic(&self) -> SessionModelSelectionDiagnostic {
        SessionModelSelectionDiagnostic::new(
            self.view.account_id.clone(),
            self.view.model_id.clone(),
            self.protocol,
            self.auth_mode,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedMatchaProviderModelBinding {
    pub(crate) model: String,
    pub(crate) provider_fingerprint: String,
    pub(crate) provider_runtime: MatchaProviderRuntimeConfig,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderModelListOutcome {
    Available(Vec<ProviderModelView>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderModelSelectableOutcome {
    Available(Vec<SelectableProviderModelView>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderModelReplaceOutcome {
    /// The desired catalog is durable. Configuration projection is a separate private effect,
    /// never runtime acceptance, health, or observation.
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationEffect,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Unavailable,
}

pub(crate) struct ProviderModelOwner {
    accounts: ProviderAccountStore,
    models: ProviderModelStore,
    private_resolver: crate::transport::provider_accounts::private_auth::Resolver,
}

impl ProviderModelOwner {
    pub(crate) fn new(accounts: ProviderAccountStore, models: ProviderModelStore) -> Self {
        Self {
            accounts,
            models,
            private_resolver: crate::transport::provider_accounts::private_auth::Resolver::disabled(
            ),
        }
    }

    pub(crate) fn set_private_resolver(
        &mut self,
        private_resolver: crate::transport::provider_accounts::private_auth::Resolver,
    ) {
        self.private_resolver = private_resolver;
    }

    pub(crate) fn reload(&mut self) -> Result<(), ()> {
        self.accounts.reload().map_err(|_| ())?;
        self.models.reload().map_err(|_| ())
    }

    fn account(&self, account_id: &ProviderAccountId) -> Option<&ProviderAccount> {
        self.accounts.account(account_id)
    }

    fn views(&self) -> Vec<ProviderModelView> {
        self.models
            .catalog()
            .models()
            .iter()
            .filter_map(|model| view_for(&self.accounts, model))
            .collect()
    }

    fn selectable(
        &self,
        capability: ProviderModelCapability,
    ) -> Option<Vec<SelectableProviderModelView>> {
        let identities = public_provider_model_identities(self.accounts.accounts()).ok()?;
        Some(
            self.models
                .catalog()
                .selectable_for(capability)
                .into_iter()
                .filter_map(|model| {
                    let account = self.accounts.account(model.account_id())?;
                    let _identity = identities.get(account.id().as_str())?;
                    let view = view_for(&self.accounts, model)?;
                    Some(SelectableProviderModelView {
                        model: view,
                        selection_id: model.selection_id(),
                    })
                })
                .collect::<Vec<_>>(),
        )
    }

    pub(crate) fn resolve_selection(
        &self,
        capability: ProviderModelCapability,
        selection_id: &str,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        for model in self.models.catalog().selectable_for(capability) {
            if model.selection_id() != selection_id {
                continue;
            }
            let Some(account) = self.accounts.account(model.account_id()) else {
                continue;
            };
            let Some(view) = view_for(&self.accounts, model) else {
                continue;
            };
            return Ok(Some(ResolvedProviderModelSelection {
                view,
                protocol: account
                    .configuration()
                    .protocol()
                    .map(provider_api_protocol_label),
                auth_mode: provider_auth_mode_label(account.configuration().auth_mode()),
            }));
        }
        Ok(None)
    }

    pub(crate) fn openclaw_model_ref(
        &self,
        selection: &ResolvedProviderModelSelection,
    ) -> Result<String, ()> {
        let account_id =
            ProviderAccountId::try_new(selection.view.account_id.clone()).map_err(|_| ())?;
        let account = self.accounts.account(&account_id).ok_or(())?;
        let identities =
            public_provider_model_identities(self.accounts.accounts()).map_err(|_| ())?;
        let identity = identities.get(account.id().as_str()).ok_or(())?;
        Ok(identity.runtime_model_ref(account.configuration().kind(), &selection.view.model_id))
    }

    pub(crate) fn matcha_model_binding(
        &self,
        selection: &ResolvedProviderModelSelection,
    ) -> Result<ResolvedMatchaProviderModelBinding, ()> {
        let account_id =
            ProviderAccountId::try_new(selection.view.account_id.clone()).map_err(|_| ())?;
        let account = self.accounts.account(&account_id).ok_or(())?;
        Ok(ResolvedMatchaProviderModelBinding {
            model: selection.view.model_id.clone(),
            provider_fingerprint: matcha_provider_fingerprint(account),
            provider_runtime: matcha_provider_runtime_config(account, &self.private_resolver)?,
        })
    }

    fn replace(
        &mut self,
        account_id: ProviderAccountId,
        drafts: Vec<ProviderModelDraft>,
    ) -> ProviderModelReplaceOutcome {
        if self.accounts.reload().is_err() || self.models.reload().is_err() {
            return ProviderModelReplaceOutcome::Unavailable;
        }
        if self.account(&account_id).is_none() {
            return ProviderModelReplaceOutcome::Rejected;
        }
        let models = match drafts
            .into_iter()
            .map(|draft| draft.materialize(account_id.clone()))
            .collect::<Result<Vec<_>, InvalidProviderModel>>()
        {
            Ok(models) => models,
            Err(_) => return ProviderModelReplaceOutcome::Rejected,
        };
        let stored = models.clone();
        if let Err(fault) = self.models.replace(&account_id, models) {
            return replace_fault(fault);
        }
        let readback = self
            .models
            .catalog()
            .models()
            .iter()
            .filter(|model| model.account_id() == &account_id)
            .collect::<Vec<_>>();
        let confirmed = readback.len() == stored.len()
            && stored
                .iter()
                .all(|model| readback.iter().any(|current| *current == model));
        ProviderModelReplaceOutcome::DesiredStored {
            persisted: if confirmed {
                ProviderPersistedOutcome::Confirmed
            } else {
                ProviderPersistedOutcome::Unknown
            },
            native: ProviderNativeConfigurationEffect::Unavailable,
            commit: if confirmed {
                ProviderCommitOutcome::Committed
            } else {
                ProviderCommitOutcome::CommitOutcomeUnknown
            },
        }
    }
}

impl Host {
    pub(crate) fn list_provider_models(&mut self) -> ProviderModelListOutcome {
        if self.admission.admit_request().is_err() || self.provider_models.reload().is_err() {
            return ProviderModelListOutcome::Unavailable;
        }
        ProviderModelListOutcome::Available(self.provider_models.views())
    }

    pub(crate) fn selectable_provider_models(
        &mut self,
        capability: ProviderModelCapability,
    ) -> ProviderModelSelectableOutcome {
        if self.admission.admit_request().is_err() || self.provider_models.reload().is_err() {
            return ProviderModelSelectableOutcome::Unavailable;
        }
        self.provider_models
            .selectable(capability)
            .map(ProviderModelSelectableOutcome::Available)
            .unwrap_or(ProviderModelSelectableOutcome::Unavailable)
    }

    pub(crate) async fn replace_provider_models(
        &mut self,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> ProviderModelReplaceOutcome {
        if self.admission.admit_request().is_err() {
            return ProviderModelReplaceOutcome::Unavailable;
        }
        let Ok(account_id) = ProviderAccountId::try_new(account_id) else {
            return ProviderModelReplaceOutcome::Rejected;
        };
        let outcome = self.provider_models.replace(account_id.clone(), drafts);
        let ProviderModelReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let native = self
            .reconcile_provider_native_configuration(&[], &BTreeSet::from([account_id]))
            .await;
        ProviderModelReplaceOutcome::DesiredStored {
            persisted,
            native,
            commit,
        }
    }
}

fn matcha_provider_runtime_config(
    account: &ProviderAccount,
    private_resolver: &crate::transport::provider_accounts::private_auth::Resolver,
) -> Result<MatchaProviderRuntimeConfig, ()> {
    let configuration = account.configuration();
    let api_key = match configuration.auth_mode() {
        ProviderAccountAuthMode::Local => None,
        ProviderAccountAuthMode::ApiKey => {
            Some(matcha_provider_api_key(account, private_resolver)?)
        }
        ProviderAccountAuthMode::OAuthBrowser | ProviderAccountAuthMode::OAuthDevice => {
            return Err(());
        }
    };
    let base_url = configuration
        .endpoint()
        .map(|endpoint| endpoint.as_str().to_owned());
    match configuration.protocol().ok_or(())? {
        ProviderApiProtocol::AnthropicMessages => {
            Ok(MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key })
        }
        ProviderApiProtocol::GoogleGenerativeAi => {
            Ok(MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key })
        }
        ProviderApiProtocol::OpenAiCompletions => {
            Ok(MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key })
        }
        ProviderApiProtocol::OpenAiResponses => {
            Ok(MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key })
        }
    }
}

fn matcha_provider_api_key(
    account: &ProviderAccount,
    private_resolver: &crate::transport::provider_accounts::private_auth::Resolver,
) -> Result<MatchaProviderSecret, ()> {
    let credential = account.configuration().credential().ok_or(())?;
    let reference =
        ConnectorSecretRef::try_new(credential.as_str()).map_err(|InvalidConnectorSecretRef| ())?;
    let resolved = private_resolver.resolve(&reference).map_err(|_| ())?;
    let ConnectorSecretResolution::Resolved { value, .. } = resolved else {
        return Err(());
    };
    MatchaProviderSecret::new(connector_secret_to_string(&value)?).map_err(|_| ())
}

fn connector_secret_to_string(value: &ConnectorSecretValue) -> Result<String, ()> {
    let mut secret = None;
    value.with_private_bytes(|bytes| {
        secret = std::str::from_utf8(bytes).ok().map(str::to_owned);
    });
    secret.ok_or(())
}

fn view_for(accounts: &ProviderAccountStore, model: &ProviderModel) -> Option<ProviderModelView> {
    let account = accounts.account(model.account_id())?;
    Some(ProviderModelView {
        account_id: account.id().as_str().to_owned(),
        label: account.configuration().label().to_owned(),
        model_id: model.model_id().to_owned(),
        capabilities: model.capabilities().to_vec(),
        context_window: model.context_window(),
        max_tokens: model.max_tokens(),
        timeout_ms: model.timeout_ms(),
        aspect_ratio: model.aspect_ratio().map(str::to_owned),
        resolution: model.resolution().map(str::to_owned),
        quality: model.quality().map(str::to_owned),
    })
}

fn provider_api_protocol_label(protocol: ProviderApiProtocol) -> &'static str {
    match protocol {
        ProviderApiProtocol::AnthropicMessages => "anthropic_messages",
        ProviderApiProtocol::GoogleGenerativeAi => "google_generative_ai",
        ProviderApiProtocol::OpenAiCompletions => "open_ai_completions",
        ProviderApiProtocol::OpenAiResponses => "open_ai_responses",
    }
}

fn provider_auth_mode_label(auth_mode: ProviderAccountAuthMode) -> &'static str {
    match auth_mode {
        ProviderAccountAuthMode::ApiKey => "api_key",
        ProviderAccountAuthMode::OAuthBrowser => "oauth_browser",
        ProviderAccountAuthMode::OAuthDevice => "oauth_device",
        ProviderAccountAuthMode::Local => "local",
    }
}

fn matcha_provider_fingerprint(account: &ProviderAccount) -> String {
    let configuration = account.configuration();
    let mut hasher = Sha256::new();
    fingerprint_part(&mut hasher, account.id().as_str());
    fingerprint_part(&mut hasher, account.provider().as_str());
    fingerprint_part(&mut hasher, &account.revision().get().to_string());
    fingerprint_part(&mut hasher, &format!("{:?}", configuration.kind()));
    fingerprint_part(
        &mut hasher,
        configuration
            .endpoint()
            .map(|endpoint| endpoint.as_str())
            .unwrap_or(""),
    );
    fingerprint_part(&mut hasher, &format!("{:?}", configuration.protocol()));
    fingerprint_part(&mut hasher, &format!("{:?}", configuration.auth_mode()));
    fingerprint_part(
        &mut hasher,
        configuration
            .credential()
            .map(|credential| credential.as_str())
            .unwrap_or(""),
    );
    fingerprint_part(&mut hasher, configuration.updated_at());
    let digest = hasher.finalize();
    let mut value = String::with_capacity(MATCHA_PROVIDER_FINGERPRINT_PREFIX.len() + 64);
    value.push_str(MATCHA_PROVIDER_FINGERPRINT_PREFIX);
    for byte in digest {
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

fn fingerprint_part(hasher: &mut Sha256, value: &str) {
    hasher.update(value.len().to_le_bytes());
    hasher.update(value.as_bytes());
}

fn replace_fault(fault: ProviderModelStoreFault) -> ProviderModelReplaceOutcome {
    match fault {
        ProviderModelStoreFault::Catalog(_)
        | ProviderModelStoreFault::Decode
        | ProviderModelStoreFault::Encode
        | ProviderModelStoreFault::RecordTooLarge => ProviderModelReplaceOutcome::Rejected,
        ProviderModelStoreFault::CommitOutcomeUnknown(_)
        | ProviderModelStoreFault::RecoveryRequired => ProviderModelReplaceOutcome::DesiredStored {
            persisted: ProviderPersistedOutcome::Unknown,
            native: ProviderNativeConfigurationEffect::Unavailable,
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
        },
        ProviderModelStoreFault::Commit(_) | ProviderModelStoreFault::WriterBusy => {
            ProviderModelReplaceOutcome::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use environment::{
        ProviderAccountConfiguration, ProviderAccountConfigurationInput, ProviderAccountKind,
        ProviderAccountRevision, ProviderEndpoint, ProviderReference,
    };

    use super::*;

    fn account(protocol: ProviderApiProtocol) -> ProviderAccount {
        ProviderAccount::new(
            ProviderAccountId::try_new("account-1").unwrap(),
            ProviderReference::try_new("provider:test").unwrap(),
            ProviderAccountRevision::try_new(1).unwrap(),
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: "Provider".to_owned(),
                enabled: true,
                kind: ProviderAccountKind::Chat,
                endpoint: Some(ProviderEndpoint::try_new("https://api.example/v1").unwrap()),
                protocol: Some(protocol),
                media_protocol: None,
                auth_mode: ProviderAccountAuthMode::Local,
                credential: None,
                created_at: "2026-08-21T00:00:00Z".to_owned(),
                updated_at: "2026-08-21T00:00:00Z".to_owned(),
            })
            .unwrap(),
        )
    }

    #[test]
    fn matcha_runtime_config_keeps_protocols_distinct() {
        let resolver = crate::transport::provider_accounts::private_auth::Resolver::disabled();

        assert!(matches!(
            matcha_provider_runtime_config(
                &account(ProviderApiProtocol::AnthropicMessages),
                &resolver
            ),
            Ok(MatchaProviderRuntimeConfig::AnthropicMessages { .. })
        ));
        assert!(matches!(
            matcha_provider_runtime_config(
                &account(ProviderApiProtocol::GoogleGenerativeAi),
                &resolver
            ),
            Ok(MatchaProviderRuntimeConfig::GoogleGenerativeAi { .. })
        ));
        assert!(matches!(
            matcha_provider_runtime_config(
                &account(ProviderApiProtocol::OpenAiCompletions),
                &resolver
            ),
            Ok(MatchaProviderRuntimeConfig::OpenAiChatCompletions { .. })
        ));
        assert!(matches!(
            matcha_provider_runtime_config(
                &account(ProviderApiProtocol::OpenAiResponses),
                &resolver
            ),
            Ok(MatchaProviderRuntimeConfig::OpenAiResponses { .. })
        ));
    }
}
