use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    io::Read as _,
    time::Duration,
};

use environment::{
    ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort,
    ConnectorSecretValue, InvalidConnectorSecretRef, InvalidProviderModel, ProviderAccount,
    ProviderAccountAuthMode, ProviderAccountId, ProviderApiProtocol, ProviderCascade,
    ProviderCascadeFault, ProviderModel, ProviderModelCapability, ProviderModelReference,
    ProviderModelStoreFault, ProviderRoutingCapability, provider_model_matches_routing_reference,
    provider_routing_model_capability,
};
use sha2::{Digest, Sha256};

use crate::{
    provider::auth::Resolver,
    provider::{
        accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
        model_reference,
        native::ProviderNativeConfigurationView,
        runtime_identity::{
            ProviderRuntimeIdentity, provider_runtime_identities, provider_runtime_identity,
        },
    },
    sessions::model_selection::{
        MatchaProviderRuntimeConfig, MatchaProviderSecret, SessionModelSelectionDiagnostic,
    },
};

const MATCHA_PROVIDER_FINGERPRINT_PREFIX: &str = "matcha-provider:v1:";
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const GOOGLE_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const ARK_DEFAULT_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
const ZAI_CN_DEFAULT_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";
const ZAI_GLOBAL_DEFAULT_BASE_URL: &str = "https://api.z.ai/api/paas/v4";
const MOONSHOT_CN_DEFAULT_BASE_URL: &str = "https://api.moonshot.cn/v1";
const MOONSHOT_GLOBAL_DEFAULT_BASE_URL: &str = "https://api.moonshot.ai/v1";
const SILICONFLOW_DEFAULT_BASE_URL: &str = "https://api.siliconflow.cn/v1";
const DEEPSEEK_DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
const OPENROUTER_DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelDraft {
    pub(crate) model_id: String,
    pub(crate) capabilities: Vec<ProviderModelCapability>,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
    pub(crate) timeout_ms: Option<u64>,
    pub(crate) aspect_ratio: Option<String>,
    pub(crate) resolution: Option<String>,
    pub(crate) quality: Option<String>,
}

impl ProviderModelDraft {
    pub(crate) fn materialize(
        self,
        account_id: ProviderAccountId,
        runtime_provider_key: Option<&str>,
    ) -> Result<ProviderModel, InvalidProviderModel> {
        ProviderModel::try_new(
            account_id,
            model_id_without_current_runtime_provider_prefix(&self.model_id, runtime_provider_key),
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
    pub(crate) account_id: String,
    pub(crate) label: String,
    pub(crate) model_id: String,
    pub(crate) capabilities: Vec<&'static str>,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
    pub(crate) timeout_ms: Option<u64>,
    pub(crate) aspect_ratio: Option<String>,
    pub(crate) resolution: Option<String>,
    pub(crate) quality: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderModelDiscoveryView {
    pub(crate) model_id: String,
    pub(crate) capabilities: Vec<&'static str>,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
    pub(crate) timeout_ms: Option<u64>,
    pub(crate) aspect_ratio: Option<String>,
    pub(crate) resolution: Option<String>,
    pub(crate) quality: Option<String>,
}

impl ProviderModelDiscoveryView {
    fn from_draft(draft: ProviderModelDraft) -> Self {
        Self {
            model_id: draft.model_id,
            capabilities: draft
                .capabilities
                .into_iter()
                .map(provider_model_capability_name)
                .collect(),
            context_window: draft.context_window,
            max_tokens: draft.max_tokens,
            timeout_ms: draft.timeout_ms,
            aspect_ratio: draft.aspect_ratio,
            resolution: draft.resolution,
            quality: draft.quality,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectableProviderModelView {
    pub(crate) model: ProviderModelView,
    pub(crate) selection_id: String,
    pub(crate) model_references: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProviderModelSelection {
    pub(crate) view: ProviderModelView,
    pub(crate) selection_id: String,
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
pub enum ProviderModelDiscoverOutcome {
    Discovered(Vec<ProviderModelDiscoveryView>),
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderModelReplaceOutcome {
    /// The desired catalog is durable. Configuration projection is a separate private effect,
    /// never runtime acceptance, health, or observation.
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Unavailable,
}

pub(crate) struct ProviderModelOwner {
    private_resolver: Resolver,
    openclaw: Option<std::sync::Arc<crate::runtime::adapters::openclaw::OpenClawInstance>>,
}

impl ProviderModelOwner {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            private_resolver: Resolver::disabled(),
            openclaw: None,
        }
    }

    pub(crate) fn with_openclaw(
        openclaw: std::sync::Arc<crate::runtime::adapters::openclaw::OpenClawInstance>,
    ) -> Self {
        Self {
            private_resolver: Resolver::disabled(),
            openclaw: Some(openclaw),
        }
    }

    pub(crate) fn set_private_resolver(&mut self, private_resolver: Resolver) {
        self.private_resolver = private_resolver;
    }

    pub(crate) fn resolve_selection(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        selection_id: &str,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(cascade, capability, |model, _account| {
            model.selection_id() == selection_id
        })
    }

    pub(crate) fn resolve_matcha_runtime(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        model_id: &str,
        model_selection_id: Option<&str>,
        provider_fingerprint: Option<&str>,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(cascade, capability, |model, account| {
            model.model_id() == model_id
                && model_selection_id.is_none_or(|id| model.selection_id() == id)
                && provider_fingerprint
                    .is_none_or(|fingerprint| matcha_provider_fingerprint(account) == fingerprint)
        })
    }

    pub(crate) fn resolve_runtime_model_ref(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        runtime_model_ref: &str,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        let identities = provider_runtime_identities(cascade.accounts()).map_err(|_| ())?;
        self.resolve_matching(cascade, capability, |model, account| {
            runtime_model_ref_for(&identities, account, model).as_deref() == Some(runtime_model_ref)
        })
    }

    /// Answers every ref from one pass over the selectable catalog, so a session list costs one
    /// catalog scan however many distinct models it holds.
    pub(crate) fn accept_runtime_model_refs(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        runtime_model_refs: &[String],
    ) -> Result<Vec<bool>, ()> {
        let identities = provider_runtime_identities(cascade.accounts()).map_err(|_| ())?;
        let accepted = cascade
            .catalog()
            .selectable_for(capability)
            .into_iter()
            .filter_map(|model| {
                runtime_model_ref_for(&identities, cascade.account(model.account_id())?, model)
            })
            .collect::<BTreeSet<_>>();
        Ok(runtime_model_refs
            .iter()
            .map(|runtime_model_ref| accepted.contains(runtime_model_ref))
            .collect())
    }

    pub(crate) fn resolve_routing_default(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderRoutingCapability,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        let Some(route) = cascade
            .routing()
            .and_then(|routing| routing.route(capability))
        else {
            return Ok(None);
        };
        for reference in std::iter::once(route.primary()).chain(route.fallbacks()) {
            let Some(selection) = self.resolve_routing_reference(cascade, capability, reference)?
            else {
                continue;
            };
            return Ok(Some(selection));
        }
        Ok(None)
    }

    fn resolve_routing_reference(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderRoutingCapability,
        reference: &ProviderModelReference,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(
            cascade,
            provider_routing_model_capability(capability),
            |model, _account| {
                provider_model_matches_routing_reference(model, capability, reference)
            },
        )
    }

    fn resolve_matching(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        mut matches_selection: impl FnMut(&ProviderModel, &ProviderAccount) -> bool,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        for model in cascade.catalog().selectable_for(capability) {
            let Some(account) = cascade.account(model.account_id()) else {
                continue;
            };
            if !matches_selection(model, account) {
                continue;
            }
            let view = view_for(account, model);
            return Ok(Some(ResolvedProviderModelSelection {
                view,
                selection_id: model.selection_id(),
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
        cascade: &ProviderCascade,
        selection: &ResolvedProviderModelSelection,
    ) -> Result<String, ()> {
        let account_id =
            ProviderAccountId::try_new(selection.view.account_id.clone()).map_err(|_| ())?;
        let account = cascade.account(&account_id).ok_or(())?;
        let identities = provider_runtime_identities(cascade.accounts()).map_err(|_| ())?;
        let identity = identities.get(account.id().as_str()).ok_or(())?;
        Ok(identity.runtime_model_ref(account.configuration().kind(), &selection.view.model_id))
    }

    pub(crate) fn matcha_model_binding(
        &self,
        cascade: &ProviderCascade,
        selection: &ResolvedProviderModelSelection,
    ) -> Result<ResolvedMatchaProviderModelBinding, ()> {
        let account_id =
            ProviderAccountId::try_new(selection.view.account_id.clone()).map_err(|_| ())?;
        let account = cascade.account(&account_id).ok_or(())?;
        Ok(ResolvedMatchaProviderModelBinding {
            model: selection.view.model_id.clone(),
            provider_fingerprint: matcha_provider_fingerprint(account),
            provider_runtime: matcha_provider_runtime_config(account, &self.private_resolver)?,
        })
    }

    pub(crate) async fn discover(
        &self,
        cascade: &mut ProviderCascade,
        account_id: &ProviderAccountId,
    ) -> ProviderModelDiscoverOutcome {
        if cascade.reload().is_err() {
            return ProviderModelDiscoverOutcome::Unavailable;
        }
        let Some(account) = cascade.account(account_id).cloned() else {
            return ProviderModelDiscoverOutcome::Rejected;
        };
        if matches!(
            account.configuration().auth_mode(),
            ProviderAccountAuthMode::CliReuse
                | ProviderAccountAuthMode::OAuthBrowser
                | ProviderAccountAuthMode::OAuthDevice
        ) || matches!(
            account.provider().as_str(),
            "provider:qianfan"
                | "provider:stepfun"
                | "provider:tencent-tokenhub"
                | "provider:tencent-tokenplan"
                | "provider:xiaomi"
                | "provider:xiaomi-token-plan"
                | "provider:qwen"
                | "provider:qwen-token-plan"
                | "provider:kimi"
                | "provider:volcengine-plan"
                | "provider:opencode"
                | "provider:opencode-go"
                | "provider:github-copilot"
        ) {
            let Some(openclaw) = &self.openclaw else {
                return ProviderModelDiscoverOutcome::Unavailable;
            };
            let Ok(identity) = provider_runtime_identity(&account) else {
                return ProviderModelDiscoverOutcome::Rejected;
            };
            let Ok(models) = openclaw
                .discover_provider_models(identity.provider_key())
                .await
            else {
                return ProviderModelDiscoverOutcome::Unavailable;
            };
            let mut drafts = Vec::new();
            let mut seen = BTreeSet::new();
            for model in models {
                let before = drafts.len();
                push_discovered_chat_model(account.id(), &mut seen, &mut drafts, &model.id);
                if drafts.len() > before {
                    let draft = drafts.last_mut().expect("model was appended");
                    draft.context_window = model.context_window.or(draft.context_window);
                    if model.input.iter().any(|input| input == "image")
                        && !draft
                            .capabilities
                            .contains(&ProviderModelCapability::ImageUnderstand)
                    {
                        draft
                            .capabilities
                            .push(ProviderModelCapability::ImageUnderstand);
                    }
                }
            }
            return ProviderModelDiscoverOutcome::Discovered(discovery_views(drafts));
        }
        let private_resolver = self.private_resolver.clone();
        tokio::task::spawn_blocking(move || {
            match discover_provider_models(&account, &private_resolver) {
                Ok(models) => ProviderModelDiscoverOutcome::Discovered(discovery_views(models)),
                Err(ProviderModelDiscoveryError::Rejected) => {
                    ProviderModelDiscoverOutcome::Rejected
                }
                Err(ProviderModelDiscoveryError::Unavailable) => {
                    ProviderModelDiscoverOutcome::Unavailable
                }
            }
        })
        .await
        .unwrap_or(ProviderModelDiscoverOutcome::Unavailable)
    }

    pub(super) fn replace_for_account(
        &mut self,
        cascade: &mut ProviderCascade,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> (ProviderModelReplaceOutcome, Option<ProviderAccountId>) {
        let Ok(account_id) = ProviderAccountId::try_new(account_id) else {
            return (ProviderModelReplaceOutcome::Rejected, None);
        };
        let outcome = self.replace(cascade, account_id.clone(), drafts);
        (outcome, Some(account_id))
    }

    pub(super) fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        account_id: ProviderAccountId,
        drafts: Vec<ProviderModelDraft>,
    ) -> ProviderModelReplaceOutcome {
        if cascade.reload().is_err() {
            return ProviderModelReplaceOutcome::Unavailable;
        }
        let Some(account) = cascade.account(&account_id) else {
            return ProviderModelReplaceOutcome::Rejected;
        };
        let runtime_provider_key = if account.configuration().enabled() {
            match provider_runtime_identities(cascade.accounts()) {
                Ok(identities) => identities
                    .get(account_id.as_str())
                    .map(|identity| identity.provider_key().to_owned()),
                Err(_) => return ProviderModelReplaceOutcome::Rejected,
            }
        } else {
            None
        };
        let models = match drafts
            .into_iter()
            .map(|draft| draft.materialize(account_id.clone(), runtime_provider_key.as_deref()))
            .collect::<Result<Vec<_>, InvalidProviderModel>>()
        {
            Ok(models) => models,
            Err(_) => return ProviderModelReplaceOutcome::Rejected,
        };
        let stored = models.clone();
        if let Err(fault) = cascade.replace_models(&account_id, models) {
            return replace_fault(fault);
        }
        let readback = cascade
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
            native: ProviderNativeConfigurationView::unavailable(),
            commit: if confirmed {
                ProviderCommitOutcome::Committed
            } else {
                ProviderCommitOutcome::CommitOutcomeUnknown
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderModelDiscoveryError {
    Rejected,
    Unavailable,
}

fn discovery_views(drafts: Vec<ProviderModelDraft>) -> Vec<ProviderModelDiscoveryView> {
    drafts
        .into_iter()
        .map(ProviderModelDiscoveryView::from_draft)
        .collect()
}

fn discover_provider_models(
    account: &ProviderAccount,
    private_resolver: &Resolver,
) -> Result<Vec<ProviderModelDraft>, ProviderModelDiscoveryError> {
    let configuration = account.configuration();
    let provider = account.provider().as_str();
    if provider == "provider:github-copilot" {
        return Err(ProviderModelDiscoveryError::Rejected);
    }
    let base_url =
        provider_discovery_endpoint(account).ok_or(ProviderModelDiscoveryError::Rejected)?;
    let api_key = match configuration.auth_mode() {
        ProviderAccountAuthMode::Local => None,
        ProviderAccountAuthMode::ApiKey | ProviderAccountAuthMode::Token => Some(
            provider_api_key(account, private_resolver)
                .map_err(|_| ProviderModelDiscoveryError::Unavailable)?,
        ),
        ProviderAccountAuthMode::CliReuse
        | ProviderAccountAuthMode::OAuthBrowser
        | ProviderAccountAuthMode::OAuthDevice => {
            return Err(ProviderModelDiscoveryError::Rejected);
        }
    };
    if provider == "provider:ollama" {
        return discover_ollama_models(account.id(), base_url);
    }
    match configuration
        .protocol()
        .or_else(|| default_discovery_protocol(provider))
        .ok_or(ProviderModelDiscoveryError::Rejected)?
    {
        ProviderApiProtocol::AnthropicMessages => {
            discover_anthropic_models(account.id(), base_url, api_key, configuration.auth_mode())
        }
        ProviderApiProtocol::GoogleGenerativeAi => {
            discover_google_models(account.id(), base_url, api_key)
        }
        ProviderApiProtocol::OpenAiCompletions | ProviderApiProtocol::OpenAiResponses => {
            discover_openai_compatible_models(account.id(), base_url, api_key)
        }
    }
}

fn discover_openai_compatible_models(
    account_id: &ProviderAccountId,
    base_url: &str,
    api_key: Option<String>,
) -> Result<Vec<ProviderModelDraft>, ProviderModelDiscoveryError> {
    let url = format!("{}/models", openai_models_base_url(base_url)?);
    let mut request = discovery_client()?.get(url);
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let value = discovery_json(request)?;
    let models = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or(ProviderModelDiscoveryError::Unavailable)?;
    let mut drafts = Vec::new();
    let mut seen = BTreeSet::new();
    for model in models {
        let Some(model_id) = model.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        push_discovered_chat_model(account_id, &mut seen, &mut drafts, model_id);
    }
    Ok(drafts)
}

fn discover_anthropic_models(
    account_id: &ProviderAccountId,
    base_url: &str,
    api_key: Option<String>,
    auth_mode: ProviderAccountAuthMode,
) -> Result<Vec<ProviderModelDraft>, ProviderModelDiscoveryError> {
    let api_key = api_key.ok_or(ProviderModelDiscoveryError::Rejected)?;
    let url = format!("{}/models", anthropic_models_base_url(base_url)?);
    let request = discovery_client()?
        .get(url)
        .header("anthropic-version", "2023-06-01");
    let request = if auth_mode == ProviderAccountAuthMode::Token {
        request
            .bearer_auth(api_key)
            .header("anthropic-beta", "oauth-2025-04-20")
    } else {
        request.header("x-api-key", api_key)
    };
    let value = discovery_json(request)?;
    let models = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or(ProviderModelDiscoveryError::Unavailable)?;
    let mut drafts = Vec::new();
    let mut seen = BTreeSet::new();
    for model in models {
        let Some(model_id) = model.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        push_discovered_chat_model(account_id, &mut seen, &mut drafts, model_id);
    }
    Ok(drafts)
}

fn discover_google_models(
    account_id: &ProviderAccountId,
    base_url: &str,
    api_key: Option<String>,
) -> Result<Vec<ProviderModelDraft>, ProviderModelDiscoveryError> {
    let api_key = api_key.ok_or(ProviderModelDiscoveryError::Rejected)?;
    let url = format!("{}/models", normalized_base_url(base_url)?);
    let value = discovery_json(
        discovery_client()?
            .get(url)
            .query(&[("pageSize", "1000"), ("key", api_key.as_str())]),
    )?;
    let models = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or(ProviderModelDiscoveryError::Unavailable)?;
    let mut drafts = Vec::new();
    let mut seen = BTreeSet::new();
    for model in models {
        if !supports_google_generate_content(model) {
            continue;
        }
        let Some(model_id) = model.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        push_discovered_chat_model(
            account_id,
            &mut seen,
            &mut drafts,
            google_model_id(model_id),
        );
    }
    Ok(drafts)
}

fn discover_ollama_models(
    account_id: &ProviderAccountId,
    base_url: &str,
) -> Result<Vec<ProviderModelDraft>, ProviderModelDiscoveryError> {
    let url = format!("{}/api/tags", ollama_base_url(base_url)?);
    let value = discovery_json(discovery_client()?.get(url))?;
    let models = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or(ProviderModelDiscoveryError::Unavailable)?;
    let mut drafts = Vec::new();
    let mut seen = BTreeSet::new();
    for model in models {
        let Some(model_id) = model.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        push_discovered_chat_model(account_id, &mut seen, &mut drafts, model_id);
    }
    Ok(drafts)
}

const MAX_DISCOVERY_RESPONSE_BYTES: u64 = 256 * 1024;

fn push_discovered_chat_model(
    account_id: &ProviderAccountId,
    seen: &mut BTreeSet<String>,
    drafts: &mut Vec<ProviderModelDraft>,
    model_id: &str,
) {
    let model_id = model_id
        .trim()
        .strip_prefix("models/")
        .unwrap_or(model_id.trim());
    if model_id.is_empty() || !seen.insert(model_id.to_owned()) {
        return;
    }
    let reference = model_reference::find(model_id);
    let draft = ProviderModelDraft {
        model_id: model_id.to_owned(),
        capabilities: reference
            .map(model_reference::ModelReference::capabilities)
            .unwrap_or_else(|| vec![ProviderModelCapability::Chat]),
        context_window: reference.and_then(model_reference::ModelReference::context_window),
        max_tokens: reference.and_then(model_reference::ModelReference::max_tokens),
        timeout_ms: None,
        aspect_ratio: None,
        resolution: None,
        quality: None,
    };
    if draft.clone().materialize(account_id.clone(), None).is_ok() {
        drafts.push(draft);
    }
}

fn supports_google_generate_content(model: &serde_json::Value) -> bool {
    model
        .get("supportedGenerationMethods")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|method| method.as_str() == Some("generateContent"))
        })
}

fn google_model_id(model_id: &str) -> &str {
    model_id.strip_prefix("models/").unwrap_or(model_id)
}

fn provider_discovery_endpoint(account: &ProviderAccount) -> Option<&str> {
    account
        .configuration()
        .endpoint()
        .map(|endpoint| endpoint.as_str())
        .or_else(|| default_discovery_endpoint(account.provider().as_str()))
}

fn default_discovery_endpoint(provider: &str) -> Option<&'static str> {
    match provider {
        "provider:anthropic" => Some(ANTHROPIC_DEFAULT_BASE_URL),
        "provider:google" => Some(GOOGLE_DEFAULT_BASE_URL),
        "provider:openai" => Some(OPENAI_DEFAULT_BASE_URL),
        "provider:ark" => Some(ARK_DEFAULT_BASE_URL),
        "provider:zai" => Some(ZAI_CN_DEFAULT_BASE_URL),
        "provider:zai-global" => Some(ZAI_GLOBAL_DEFAULT_BASE_URL),
        "provider:moonshot" => Some(MOONSHOT_CN_DEFAULT_BASE_URL),
        "provider:moonshot-global" => Some(MOONSHOT_GLOBAL_DEFAULT_BASE_URL),
        "provider:siliconflow" => Some(SILICONFLOW_DEFAULT_BASE_URL),
        "provider:deepseek" => Some(DEEPSEEK_DEFAULT_BASE_URL),
        "provider:openrouter" => Some(OPENROUTER_DEFAULT_BASE_URL),
        "provider:ollama" => Some(OLLAMA_DEFAULT_BASE_URL),
        _ => openclaw::projection::provider_models::default_provider_endpoint(provider),
    }
}

fn default_discovery_protocol(provider: &str) -> Option<ProviderApiProtocol> {
    match provider {
        "provider:anthropic" => Some(ProviderApiProtocol::AnthropicMessages),
        "provider:google" => Some(ProviderApiProtocol::GoogleGenerativeAi),
        "provider:openai" => Some(ProviderApiProtocol::OpenAiResponses),
        "provider:ark"
        | "provider:zai"
        | "provider:zai-global"
        | "provider:moonshot"
        | "provider:moonshot-global"
        | "provider:siliconflow"
        | "provider:deepseek"
        | "provider:openrouter"
        | "provider:ollama" => Some(ProviderApiProtocol::OpenAiCompletions),
        _ => openclaw::projection::provider_models::default_provider_protocol(provider),
    }
}

fn discovery_client() -> Result<reqwest::blocking::Client, ProviderModelDiscoveryError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| ProviderModelDiscoveryError::Unavailable)
}

fn discovery_json(
    request: reqwest::blocking::RequestBuilder,
) -> Result<serde_json::Value, ProviderModelDiscoveryError> {
    let response = request
        .send()
        .map_err(|_| ProviderModelDiscoveryError::Unavailable)?;
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
        return Err(ProviderModelDiscoveryError::Rejected);
    }
    if !response.status().is_success() {
        return Err(ProviderModelDiscoveryError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DISCOVERY_RESPONSE_BYTES)
    {
        return Err(ProviderModelDiscoveryError::Unavailable);
    }
    let mut reader = response.take(MAX_DISCOVERY_RESPONSE_BYTES + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| ProviderModelDiscoveryError::Unavailable)?;
    if bytes.len() > MAX_DISCOVERY_RESPONSE_BYTES as usize {
        return Err(ProviderModelDiscoveryError::Unavailable);
    }
    serde_json::from_slice(&bytes).map_err(|_| ProviderModelDiscoveryError::Rejected)
}

fn openai_models_base_url(base_url: &str) -> Result<String, ProviderModelDiscoveryError> {
    let mut base = normalized_base_url(base_url)?;
    for suffix in ["/chat/completions", "/responses", "/response"] {
        if let Some(prefix) = base.strip_suffix(suffix) {
            base = prefix.to_owned();
        }
    }
    Ok(base)
}

fn anthropic_models_base_url(base_url: &str) -> Result<String, ProviderModelDiscoveryError> {
    let mut base = normalized_base_url(base_url)?;
    if !base.ends_with("/v1") {
        base.push_str("/v1");
    }
    Ok(base)
}

fn ollama_base_url(base_url: &str) -> Result<String, ProviderModelDiscoveryError> {
    let base = normalized_base_url(base_url)?;
    Ok(base.strip_suffix("/v1").map(str::to_owned).unwrap_or(base))
}

fn normalized_base_url(base_url: &str) -> Result<String, ProviderModelDiscoveryError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() || base.contains('@') || base.contains('?') || base.contains('#') {
        return Err(ProviderModelDiscoveryError::Rejected);
    }
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(ProviderModelDiscoveryError::Rejected);
    }
    Ok(base.to_owned())
}

fn provider_api_key(account: &ProviderAccount, private_resolver: &Resolver) -> Result<String, ()> {
    let credential = account.configuration().credential().ok_or(())?;
    let reference =
        ConnectorSecretRef::try_new(credential.as_str()).map_err(|InvalidConnectorSecretRef| ())?;
    let resolved = private_resolver.resolve(&reference).map_err(|_| ())?;
    let ConnectorSecretResolution::Resolved { value, .. } = resolved else {
        return Err(());
    };
    connector_secret_to_string(&value)
}

fn model_id_without_current_runtime_provider_prefix(
    model_id: &str,
    provider_key: Option<&str>,
) -> String {
    let model_id = model_id.trim();
    provider_key
        .and_then(|key| {
            model_id
                .strip_prefix(key)
                .and_then(|suffix| suffix.strip_prefix('/'))
        })
        .unwrap_or(model_id)
        .to_owned()
}

fn matcha_provider_runtime_config(
    account: &ProviderAccount,
    private_resolver: &Resolver,
) -> Result<MatchaProviderRuntimeConfig, ()> {
    let configuration = account.configuration();
    let api_key = match configuration.auth_mode() {
        ProviderAccountAuthMode::Local => None,
        ProviderAccountAuthMode::ApiKey => {
            Some(matcha_provider_api_key(account, private_resolver)?)
        }
        ProviderAccountAuthMode::Token
        | ProviderAccountAuthMode::CliReuse
        | ProviderAccountAuthMode::OAuthBrowser
        | ProviderAccountAuthMode::OAuthDevice => {
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
    private_resolver: &Resolver,
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

fn runtime_model_ref_for(
    identities: &BTreeMap<String, ProviderRuntimeIdentity>,
    account: &ProviderAccount,
    model: &ProviderModel,
) -> Option<String> {
    identities.get(account.id().as_str()).map(|identity| {
        identity.runtime_model_ref(account.configuration().kind(), model.model_id())
    })
}

fn view_for(account: &ProviderAccount, model: &ProviderModel) -> ProviderModelView {
    ProviderModelView {
        account_id: account.id().as_str().to_owned(),
        label: account.configuration().label().to_owned(),
        model_id: model.model_id().to_owned(),
        capabilities: model
            .capabilities()
            .iter()
            .copied()
            .map(provider_model_capability_name)
            .collect(),
        context_window: model.context_window(),
        max_tokens: model.max_tokens(),
        timeout_ms: model.timeout_ms(),
        aspect_ratio: model.aspect_ratio().map(str::to_owned),
        resolution: model.resolution().map(str::to_owned),
        quality: model.quality().map(str::to_owned),
    }
}

pub(crate) const fn provider_model_capability_name(
    capability: ProviderModelCapability,
) -> &'static str {
    match capability {
        ProviderModelCapability::Chat => "chat",
        ProviderModelCapability::ImageUnderstand => "imageUnderstand",
        ProviderModelCapability::ImageGenerate => "imageGenerate",
        ProviderModelCapability::VideoGenerate => "videoGenerate",
        ProviderModelCapability::MusicGenerate => "musicGenerate",
        ProviderModelCapability::TextToSpeech => "tts",
        ProviderModelCapability::Transcribe => "transcribe",
    }
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
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cli_reuse",
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

fn replace_fault(fault: ProviderCascadeFault) -> ProviderModelReplaceOutcome {
    let ProviderCascadeFault::Models(fault) = fault else {
        return ProviderModelReplaceOutcome::Unavailable;
    };
    match fault {
        ProviderModelStoreFault::Catalog(_)
        | ProviderModelStoreFault::Decode
        | ProviderModelStoreFault::Encode
        | ProviderModelStoreFault::RecordTooLarge => ProviderModelReplaceOutcome::Rejected,
        ProviderModelStoreFault::CommitOutcomeUnknown(_)
        | ProviderModelStoreFault::RecoveryRequired => ProviderModelReplaceOutcome::DesiredStored {
            persisted: ProviderPersistedOutcome::Unknown,
            native: ProviderNativeConfigurationView::unavailable(),
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
        ProviderAccountRevision, ProviderAccountStore, ProviderEndpoint, ProviderReference,
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

    fn chat_draft(model_id: &str) -> ProviderModelDraft {
        ProviderModelDraft {
            model_id: model_id.to_owned(),
            capabilities: vec![ProviderModelCapability::Chat],
            context_window: None,
            max_tokens: None,
            timeout_ms: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
        }
    }

    /// A cascade holding one enabled account and whatever models the drafts produce. `root` stays
    /// with the caller: the cascade re-reads these files on every mutation.
    fn cascade_with_models(
        root: &tempfile::TempDir,
        model_ids: &[&str],
    ) -> (ProviderCascade, ProviderModelOwner) {
        let account = account(ProviderApiProtocol::OpenAiResponses);
        let account_id = account.id().clone();
        ProviderAccountStore::open(root.path().join("accounts.json"))
            .expect("accounts store")
            .persist(account)
            .expect("persist account");
        let mut models = ProviderModelOwner::new();
        let mut cascade = ProviderCascade::open(
            root.path().join("accounts.json"),
            root.path().join("models.json"),
            root.path().join("routing.json"),
            root.path().join("cascade.json"),
        )
        .expect("provider cascade");
        let outcome = models.replace(
            &mut cascade,
            account_id,
            model_ids.iter().copied().map(chat_draft).collect(),
        );
        assert!(
            matches!(outcome, ProviderModelReplaceOutcome::DesiredStored { .. }),
            "unexpected replace outcome: {outcome:?}"
        );
        (cascade, models)
    }

    #[test]
    fn runtime_model_refs_are_accepted_only_while_their_model_is_configured() {
        let root = tempfile::tempdir().expect("provider tempdir");
        let (cascade, models) = cascade_with_models(&root, &["glm-5.2", "llama-3.3"]);

        assert_eq!(
            models
                .accept_runtime_model_refs(
                    &cascade,
                    ProviderModelCapability::Chat,
                    &[
                        "test/glm-5.2".to_owned(),
                        "test/llama-3.3".to_owned(),
                        "test/glm-4.5".to_owned(),
                        "custom-cc367df7/glm-5.2".to_owned(),
                    ],
                )
                .unwrap(),
            vec![true, true, false, false]
        );
    }

    /// Deleting a model is exactly what invalidates a session's stored ref; the ref must stop
    /// being accepted, and the singular resolver must agree with the batch one.
    #[test]
    fn deleting_a_model_invalidates_its_runtime_ref_for_both_resolvers() {
        let root = tempfile::tempdir().expect("provider tempdir");
        let (mut cascade, mut models) = cascade_with_models(&root, &["glm-5.2", "llama-3.3"]);
        let account_id = ProviderAccountId::try_new("account-1").unwrap();
        let outcome = models.replace(&mut cascade, account_id, vec![chat_draft("llama-3.3")]);
        assert!(
            matches!(outcome, ProviderModelReplaceOutcome::DesiredStored { .. }),
            "unexpected replace outcome: {outcome:?}"
        );

        assert_eq!(
            models
                .accept_runtime_model_refs(
                    &cascade,
                    ProviderModelCapability::Chat,
                    &["test/glm-5.2".to_owned(), "test/llama-3.3".to_owned()],
                )
                .unwrap(),
            vec![false, true]
        );
        assert!(
            models
                .resolve_runtime_model_ref(&cascade, ProviderModelCapability::Chat, "test/glm-5.2")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            models
                .resolve_runtime_model_ref(
                    &cascade,
                    ProviderModelCapability::Chat,
                    "test/llama-3.3"
                )
                .unwrap()
                .unwrap()
                .view
                .model_id,
            "llama-3.3"
        );
    }

    #[test]
    fn materialize_removes_only_current_runtime_provider_prefix_once() {
        let account_id = ProviderAccountId::try_new("openai-main").unwrap();

        let current = ProviderModelDraft {
            model_id: "openai/openai/gpt-5.6".into(),
            capabilities: vec![ProviderModelCapability::Chat],
            context_window: None,
            max_tokens: None,
            timeout_ms: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
        }
        .materialize(account_id.clone(), Some("openai"))
        .unwrap();
        let other = ProviderModelDraft {
            model_id: "anthropic/claude-fable-5".into(),
            capabilities: vec![ProviderModelCapability::Chat],
            context_window: None,
            max_tokens: None,
            timeout_ms: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
        }
        .materialize(account_id, Some("openai"))
        .unwrap();

        assert_eq!(current.model_id(), "openai/gpt-5.6");
        assert_eq!(other.model_id(), "anthropic/claude-fable-5");
    }

    #[test]
    fn discovery_normalizes_provider_model_urls() {
        assert_eq!(
            openai_models_base_url("https://api.example/v1/chat/completions").unwrap(),
            "https://api.example/v1"
        );
        assert_eq!(
            openai_models_base_url("https://api.example/v1/responses/").unwrap(),
            "https://api.example/v1"
        );
        assert_eq!(
            anthropic_models_base_url("https://api.anthropic.com").unwrap(),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            ollama_base_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434"
        );
    }

    #[test]
    fn discovery_prefills_known_models_from_reference_catalog() {
        let mut drafts = Vec::new();
        let mut seen = BTreeSet::new();

        push_discovered_chat_model(
            &ProviderAccountId::try_new("account-1").unwrap(),
            &mut seen,
            &mut drafts,
            "deepseek-v4-flash",
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].model_id, "deepseek-v4-flash");
        assert_eq!(drafts[0].capabilities, vec![ProviderModelCapability::Chat]);
        assert_eq!(drafts[0].context_window, Some(1_048_576));
        assert_eq!(drafts[0].max_tokens, Some(393_216));
    }

    #[test]
    fn discovery_leaves_unknown_model_budget_empty() {
        let mut drafts = Vec::new();
        let mut seen = BTreeSet::new();

        push_discovered_chat_model(
            &ProviderAccountId::try_new("account-1").unwrap(),
            &mut seen,
            &mut drafts,
            "future-model",
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].model_id, "future-model");
        assert_eq!(drafts[0].capabilities, vec![ProviderModelCapability::Chat]);
        assert_eq!(drafts[0].context_window, None);
        assert_eq!(drafts[0].max_tokens, None);
    }

    #[test]
    fn matcha_runtime_config_keeps_protocols_distinct() {
        let resolver = Resolver::disabled();

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
