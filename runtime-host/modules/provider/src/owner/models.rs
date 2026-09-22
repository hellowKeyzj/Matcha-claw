use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    io::Read as _,
    time::Duration,
};

use connectors::{
    ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort,
    ConnectorSecretValue, InvalidConnectorSecretRef,
};
use sha2::{Digest, Sha256};

use crate::{
    InvalidProviderModel, ProviderAccount, ProviderAccountAuthMode, ProviderAccountId,
    ProviderApiProtocol, ProviderCascade, ProviderCascadeFault, ProviderModel,
    ProviderModelCapability, ProviderModelReference, ProviderModelStoreFault,
    ProviderRoutingCapability, Resolver,
    application::{model_reference, receipts::*},
    ports::{ProviderModelDiscoveryPortOutcome, ProviderRuntimeDirectory},
    provider_model_matches_routing_reference, provider_routing_model_capability,
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
const MAX_DISCOVERY_RESPONSE_BYTES: u64 = 256 * 1024;

pub(crate) struct ProviderModelOwner {
    private_resolver: Resolver,
}

impl ProviderModelOwner {
    pub(crate) fn new() -> Self {
        Self {
            private_resolver: Resolver::disabled(),
        }
    }

    pub(crate) fn set_private_resolver(&mut self, private_resolver: Resolver) {
        self.private_resolver = private_resolver;
    }

    pub(super) fn select_session_model(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_selection_id: String,
        trace_id: Option<String>,
    ) -> ProviderSessionModelSelectionOutcome {
        let Some(capability) = session_model_capability(endpoint) else {
            return ProviderSessionModelSelectionOutcome::Unsupported;
        };
        match self.resolve_selection(runtime, cascade, capability, &model_selection_id) {
            Ok(Some(selection)) => ProviderSessionModelSelectionOutcome::Selected(
                selection.into_receipt(endpoint, session_key, endpoint_session_id, trace_id),
            ),
            Ok(None) => ProviderSessionModelSelectionOutcome::Rejected,
            Err(()) => ProviderSessionModelSelectionOutcome::Unavailable,
        }
    }

    pub(super) fn select_matcha_session_model_runtime(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_id: String,
        model_selection_id: Option<String>,
        provider_fingerprint: Option<String>,
        trace_id: Option<String>,
    ) -> ProviderSessionModelSelectionOutcome {
        match self.resolve_matcha_runtime(
            runtime,
            cascade,
            ProviderModelCapability::Chat,
            &model_id,
            model_selection_id.as_deref(),
            provider_fingerprint.as_deref(),
        ) {
            Ok(Some(selection)) => {
                ProviderSessionModelSelectionOutcome::Selected(selection.into_receipt(
                    ProviderSessionEndpoint::MatchaAgentLocal,
                    session_key,
                    endpoint_session_id,
                    trace_id,
                ))
            }
            Ok(None) => ProviderSessionModelSelectionOutcome::Rejected,
            Err(()) => ProviderSessionModelSelectionOutcome::Unavailable,
        }
    }

    pub(super) fn accept_runtime_model_refs(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        endpoint: ProviderSessionEndpoint,
        runtime_model_refs: &[String],
    ) -> ProviderSessionRuntimeModelsOutcome {
        if endpoint != ProviderSessionEndpoint::OpenClawLocal {
            return ProviderSessionRuntimeModelsOutcome::Unsupported;
        }
        let Some(capability) = session_model_capability(endpoint) else {
            return ProviderSessionRuntimeModelsOutcome::Unsupported;
        };
        match self.accept_runtime_models(runtime, cascade, capability, runtime_model_refs) {
            Ok(accepted) => ProviderSessionRuntimeModelsOutcome::Accepted(accepted),
            Err(()) => ProviderSessionRuntimeModelsOutcome::Unavailable,
        }
    }

    pub(super) fn select_session_model_rebound(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        current_model: Option<String>,
        default_model: Option<String>,
        trace_id: Option<String>,
    ) -> ProviderSessionModelSelectionOutcome {
        if endpoint != ProviderSessionEndpoint::OpenClawLocal {
            return ProviderSessionModelSelectionOutcome::Unsupported;
        }
        let Some(capability) = session_model_capability(endpoint) else {
            return ProviderSessionModelSelectionOutcome::Unsupported;
        };
        let default = match default_model
            .as_deref()
            .map(|default_model| {
                self.resolve_runtime_model_ref(runtime, cascade, capability, default_model)
            })
            .transpose()
        {
            Ok(default) => default.flatten(),
            Err(()) => return ProviderSessionModelSelectionOutcome::Unavailable,
        };
        let selection = match default {
            Some(selection) => selection,
            None => match self.resolve_routing_default(
                cascade,
                ProviderRoutingCapability::Chat,
                runtime,
            ) {
                Ok(Some(selection)) => selection,
                Ok(None) => return ProviderSessionModelSelectionOutcome::Rejected,
                Err(()) => return ProviderSessionModelSelectionOutcome::Unavailable,
            },
        };
        let _ = current_model;
        ProviderSessionModelSelectionOutcome::Selected(selection.into_receipt(
            endpoint,
            session_key,
            endpoint_session_id,
            trace_id,
        ))
    }

    fn resolve_selection(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        selection_id: &str,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(runtime, cascade, capability, |model, _account| {
            model.selection_id() == selection_id
        })
    }

    fn resolve_matcha_runtime(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        model_id: &str,
        model_selection_id: Option<&str>,
        provider_fingerprint: Option<&str>,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(runtime, cascade, capability, |model, account| {
            model.model_id() == model_id
                && model_selection_id.is_none_or(|id| model.selection_id() == id)
                && provider_fingerprint
                    .is_none_or(|fingerprint| matcha_provider_fingerprint(account) == fingerprint)
        })
    }

    fn resolve_runtime_model_ref(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        runtime_model_ref: &str,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        let identity_ops = runtime.provider_runtime_identity_ops().ok_or(())?;
        let identities = provider_runtime_identities(identity_ops, cascade.accounts())?;
        self.resolve_matching(runtime, cascade, capability, |model, account| {
            runtime_model_ref_for(identity_ops, &identities, account, model).as_deref()
                == Some(runtime_model_ref)
        })
    }

    fn accept_runtime_models(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        runtime_model_refs: &[String],
    ) -> Result<Vec<bool>, ()> {
        let identity_ops = runtime.provider_runtime_identity_ops().ok_or(())?;
        let identities = provider_runtime_identities(identity_ops, cascade.accounts())?;
        let accepted = cascade
            .catalog()
            .selectable_for(capability)
            .into_iter()
            .filter_map(|model| {
                runtime_model_ref_for(
                    identity_ops,
                    &identities,
                    cascade.account(model.account_id())?,
                    model,
                )
            })
            .collect::<BTreeSet<_>>();
        Ok(runtime_model_refs
            .iter()
            .map(|runtime_model_ref| accepted.contains(runtime_model_ref))
            .collect())
    }

    fn resolve_routing_default(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderRoutingCapability,
        runtime: &dyn ProviderRuntimeDirectory,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        let Some(route) = cascade
            .routing()
            .and_then(|routing| routing.route(capability))
        else {
            return Ok(None);
        };
        for reference in std::iter::once(route.primary()).chain(route.fallbacks()) {
            let Some(selection) =
                self.resolve_routing_reference(cascade, capability, reference, runtime)?
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
        runtime: &dyn ProviderRuntimeDirectory,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        self.resolve_matching(
            runtime,
            cascade,
            provider_routing_model_capability(capability),
            |model, _account| {
                provider_model_matches_routing_reference(model, capability, reference)
            },
        )
    }

    fn resolve_matching(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &ProviderCascade,
        capability: ProviderModelCapability,
        mut matches_selection: impl FnMut(&ProviderModel, &ProviderAccount) -> bool,
    ) -> Result<Option<ResolvedProviderModelSelection>, ()> {
        let identity_ops = runtime.provider_runtime_identity_ops().ok_or(())?;
        let identities = provider_runtime_identities(identity_ops, cascade.accounts())?;
        for model in cascade.catalog().selectable_for(capability) {
            let Some(account) = cascade.account(model.account_id()) else {
                continue;
            };
            if !matches_selection(model, account) {
                continue;
            }
            let runtime_model_ref =
                runtime_model_ref_for(identity_ops, &identities, account, model).ok_or(())?;
            return Ok(Some(ResolvedProviderModelSelection {
                view: ProviderModelView::from_model(account, model),
                selection_id: model.selection_id(),
                runtime_model_ref,
                provider_fingerprint: matcha_provider_fingerprint(account),
                account_endpoint: account
                    .configuration()
                    .endpoint()
                    .map(|endpoint| endpoint.as_str().to_owned()),
                credential_ref: account
                    .configuration()
                    .credential()
                    .map(|credential| credential.as_str().to_owned()),
                protocol: account
                    .configuration()
                    .protocol()
                    .map(provider_api_protocol_label),
                auth_mode: provider_auth_mode_label(account.configuration().auth_mode()),
            }));
        }
        Ok(None)
    }

    pub(crate) async fn discover(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &mut ProviderCascade,
        account_id: &ProviderAccountId,
    ) -> ProviderModelDiscoverOutcome {
        if cascade.reload().is_err() {
            return ProviderModelDiscoverOutcome::Unavailable;
        }
        let Some(account) = cascade.account(account_id).cloned() else {
            return ProviderModelDiscoverOutcome::Rejected;
        };
        if runtime_discovery_provider(&account) {
            let Some(identity_ops) = runtime.provider_runtime_identity_ops() else {
                return ProviderModelDiscoverOutcome::Unavailable;
            };
            let Ok(identity) = identity_ops.runtime_identity(&account) else {
                return ProviderModelDiscoverOutcome::Rejected;
            };
            let Some(discovery_ops) = runtime.provider_model_discovery_ops() else {
                return ProviderModelDiscoverOutcome::Unavailable;
            };
            let models = match discovery_ops
                .discover_provider_models(&account, &identity)
                .await
            {
                ProviderModelDiscoveryPortOutcome::Discovered(models) => models,
                ProviderModelDiscoveryPortOutcome::Rejected => {
                    return ProviderModelDiscoverOutcome::Rejected;
                }
                ProviderModelDiscoveryPortOutcome::Unavailable => {
                    return ProviderModelDiscoverOutcome::Unavailable;
                }
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
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &mut ProviderCascade,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> (ProviderModelReplaceOutcome, Option<ProviderAccountId>) {
        let Ok(account_id) = ProviderAccountId::try_new(account_id) else {
            return (ProviderModelReplaceOutcome::Rejected, None);
        };
        let outcome = self.replace(runtime, cascade, account_id.clone(), drafts);
        (outcome, Some(account_id))
    }

    fn replace(
        &mut self,
        runtime: &dyn ProviderRuntimeDirectory,
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
            let Some(identity_ops) = runtime.provider_runtime_identity_ops() else {
                return ProviderModelReplaceOutcome::Rejected;
            };
            match identity_ops.runtime_identities(cascade.accounts()) {
                Ok(identities) => identities
                    .into_iter()
                    .find(|identity| identity.account_id() == account_id.as_str())
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

struct ResolvedProviderModelSelection {
    view: ProviderModelView,
    selection_id: String,
    runtime_model_ref: String,
    provider_fingerprint: String,
    account_endpoint: Option<String>,
    credential_ref: Option<String>,
    protocol: Option<&'static str>,
    auth_mode: &'static str,
}

impl ResolvedProviderModelSelection {
    fn into_receipt(
        self,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        trace_id: Option<String>,
    ) -> ProviderSessionModelSelection {
        ProviderSessionModelSelection {
            endpoint,
            session_key,
            endpoint_session_id,
            model_selection_id: self.selection_id,
            account_id: self.view.account_id,
            model_id: self.view.model_id,
            runtime_model_ref: self.runtime_model_ref,
            provider_fingerprint: self.provider_fingerprint,
            account_endpoint: self.account_endpoint,
            credential_ref: self.credential_ref,
            protocol: self.protocol,
            auth_mode: self.auth_mode,
            trace_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderModelDiscoveryError {
    Rejected,
    Unavailable,
}

fn session_model_capability(endpoint: ProviderSessionEndpoint) -> Option<ProviderModelCapability> {
    match endpoint {
        ProviderSessionEndpoint::OpenClawLocal | ProviderSessionEndpoint::MatchaAgentLocal => {
            Some(ProviderModelCapability::Chat)
        }
    }
}

fn provider_runtime_identities(
    identity_ops: &dyn crate::ProviderRuntimeIdentityOps,
    accounts: &[ProviderAccount],
) -> Result<BTreeMap<String, String>, ()> {
    identity_ops.runtime_identities(accounts).map(|identities| {
        identities
            .into_iter()
            .map(|identity| {
                (
                    identity.account_id().to_owned(),
                    identity.provider_key().to_owned(),
                )
            })
            .collect()
    })
}

fn runtime_model_ref_for(
    identity_ops: &dyn crate::ProviderRuntimeIdentityOps,
    identities: &BTreeMap<String, String>,
    account: &ProviderAccount,
    model: &ProviderModel,
) -> Option<String> {
    identities.get(account.id().as_str()).map(|provider_key| {
        let identity =
            crate::ProviderRuntimeIdentity::new(account.id().as_str(), provider_key.as_str());
        identity_ops.runtime_model_ref(&identity, account.configuration().kind(), model.model_id())
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
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cli_reuse",
        ProviderAccountAuthMode::OAuthBrowser => "oauth_browser",
        ProviderAccountAuthMode::OAuthDevice => "oauth_device",
        ProviderAccountAuthMode::Local => "local",
    }
}

fn runtime_discovery_provider(account: &ProviderAccount) -> bool {
    matches!(
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
    )
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
        _ => runtime_default_provider_endpoint(provider),
    }
}

fn default_discovery_protocol(provider: &str) -> Option<ProviderApiProtocol> {
    match provider {
        "provider:anthropic" | "provider:kimi" => Some(ProviderApiProtocol::AnthropicMessages),
        "provider:google" => Some(ProviderApiProtocol::GoogleGenerativeAi),
        "provider:openai" | "provider:github-copilot" => Some(ProviderApiProtocol::OpenAiResponses),
        "provider:qianfan"
        | "provider:stepfun"
        | "provider:tencent-tokenhub"
        | "provider:tencent-tokenplan"
        | "provider:xiaomi"
        | "provider:xiaomi-token-plan"
        | "provider:qwen"
        | "provider:qwen-token-plan"
        | "provider:volcengine-plan"
        | "provider:opencode"
        | "provider:opencode-go"
        | "provider:ark"
        | "provider:zai"
        | "provider:zai-global"
        | "provider:moonshot"
        | "provider:moonshot-global"
        | "provider:siliconflow"
        | "provider:deepseek"
        | "provider:openrouter"
        | "provider:ollama" => Some(ProviderApiProtocol::OpenAiCompletions),
        _ => None,
    }
}

fn runtime_default_provider_endpoint(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "provider:qianfan" => "https://qianfan.baidubce.com/v2",
        "provider:stepfun" => "https://api.stepfun.ai/v1",
        "provider:tencent-tokenhub" => "https://tokenhub.tencentmaas.com/v1",
        "provider:tencent-tokenplan" => "https://api.lkeap.cloud.tencent.com/plan/v3",
        "provider:xiaomi" => "https://api.xiaomimimo.com/v1",
        "provider:xiaomi-token-plan" => "https://token-plan-sgp.xiaomimimo.com/v1",
        "provider:qwen" => "https://coding-intl.dashscope.aliyuncs.com/v1",
        "provider:qwen-token-plan" => {
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
        }
        "provider:kimi" => "https://api.kimi.com/coding/",
        "provider:volcengine-plan" => "https://ark.cn-beijing.volces.com/api/coding/v3",
        "provider:opencode" => "https://opencode.ai/zen/v1",
        "provider:opencode-go" => "https://opencode.ai/zen/go/v1",
        "provider:github-copilot" => "https://api.individual.githubcopilot.com",
        _ => return None,
    })
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

fn connector_secret_to_string(value: &ConnectorSecretValue) -> Result<String, ()> {
    let mut secret = None;
    value.with_private_bytes(|bytes| {
        secret = std::str::from_utf8(bytes).ok().map(str::to_owned);
    });
    secret.ok_or(())
}

pub(super) fn matcha_provider_fingerprint(account: &ProviderAccount) -> String {
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
