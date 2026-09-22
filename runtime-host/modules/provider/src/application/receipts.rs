use crate::{
    InvalidProviderModel, ProviderAccount, ProviderAccountAuthMode, ProviderAccountId,
    ProviderAccountKind, ProviderApiProtocol, ProviderAppliedStatus, ProviderCascadeFault,
    ProviderMediaApiProtocol, ProviderModel, ProviderModelCapability, ProviderModelReference,
    ProviderModelStoreFault, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEffect, ProviderObservedStatus, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingStoreFault,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderCommitOutcome {
    Committed,
    CommitOutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderPersistedOutcome {
    Confirmed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAccountMutationKind {
    Stored,
    Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationView {
    pub changed: bool,
    pub applied: &'static str,
    pub observed: &'static str,
    pub diagnostic: Option<ProviderNativeConfigurationDiagnosticView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationDiagnosticView {
    pub phase: String,
    pub reason: String,
    pub config_path: String,
    pub method: Option<String>,
    pub expected_path: Option<String>,
    pub detail: Option<String>,
}

impl ProviderNativeConfigurationView {
    pub const fn unavailable() -> Self {
        Self {
            changed: false,
            applied: "unknown",
            observed: "unavailable",
            diagnostic: None,
        }
    }

    pub fn from_effect(effect: &ProviderNativeConfigurationEffect) -> Self {
        match effect {
            ProviderNativeConfigurationEffect::Evidence(evidence) => Self {
                changed: evidence.changed(),
                applied: applied_status(evidence.applied()),
                observed: observed_status(evidence.observed()),
                diagnostic: evidence
                    .diagnostic()
                    .map(ProviderNativeConfigurationDiagnosticView::from_diagnostic),
            },
            ProviderNativeConfigurationEffect::Unavailable => Self::unavailable(),
        }
    }
}

impl ProviderNativeConfigurationDiagnosticView {
    fn from_diagnostic(diagnostic: &ProviderNativeConfigurationDiagnostic) -> Self {
        Self {
            phase: diagnostic.phase().to_owned(),
            reason: diagnostic.reason().to_owned(),
            config_path: diagnostic.config_path().to_owned(),
            method: diagnostic.method().map(str::to_owned),
            expected_path: diagnostic.expected_path().map(str::to_owned),
            detail: diagnostic.detail().map(str::to_owned),
        }
    }
}

const fn applied_status(status: ProviderAppliedStatus) -> &'static str {
    match status {
        ProviderAppliedStatus::Confirmed => "confirmed",
        ProviderAppliedStatus::Unknown => "unknown",
    }
}

const fn observed_status(status: ProviderObservedStatus) -> &'static str {
    match status {
        ProviderObservedStatus::Matches => "matches",
        ProviderObservedStatus::Mismatch => "mismatch",
        ProviderObservedStatus::Unavailable => "unavailable",
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAccountView {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub enabled: bool,
    pub kind: &'static str,
    pub endpoint: Option<String>,
    pub protocol: Option<&'static str>,
    pub media_protocol: Option<&'static str>,
    pub auth_mode: &'static str,
    pub revision: u64,
}

impl ProviderAccountView {
    pub fn from_account(account: &ProviderAccount) -> Self {
        let configuration = account.configuration();
        Self {
            id: account.id().as_str().to_owned(),
            provider: account
                .provider()
                .as_str()
                .strip_prefix("provider:")
                .expect("ProviderAccount provider references are canonical")
                .to_owned(),
            label: configuration.label().to_owned(),
            enabled: configuration.enabled(),
            kind: provider_account_kind_name(configuration.kind()),
            endpoint: configuration
                .endpoint()
                .map(|endpoint| endpoint.as_str().to_owned()),
            protocol: configuration.protocol().map(provider_api_protocol_name),
            media_protocol: configuration
                .media_protocol()
                .map(provider_media_api_protocol_name),
            auth_mode: provider_account_auth_mode_name(configuration.auth_mode()),
            revision: account.revision().get(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderAccountsDelivery {
    List(Vec<ProviderAccountView>),
    Account(ProviderAccountView),
    Stored {
        account: ProviderAccountView,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Deleted {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Missing,
    Unknown {
        desired: ProviderAccountMutationKind,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Unavailable,
}

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
    pub account_id: String,
    pub label: String,
    pub model_id: String,
    pub capabilities: Vec<&'static str>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
}

impl ProviderModelView {
    pub fn from_model(account: &ProviderAccount, model: &ProviderModel) -> Self {
        Self {
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelDiscoveryView {
    pub model_id: String,
    pub capabilities: Vec<&'static str>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
}

impl ProviderModelDiscoveryView {
    pub fn from_draft(draft: ProviderModelDraft) -> Self {
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
    pub model: ProviderModelView,
    pub selection_id: String,
    pub model_references: Vec<String>,
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
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingListOutcome {
    Desired(Option<ProviderRoutingView>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRoutingView {
    pub revision: u64,
    pub routes: Vec<ProviderRouteView>,
}

impl ProviderRoutingView {
    pub fn from_routing(routing: &ProviderRouting) -> Self {
        Self {
            revision: routing.revision().get(),
            routes: routing
                .routes()
                .iter()
                .map(|(capability, route)| ProviderRouteView::from_route(*capability, route))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRouteView {
    pub capability: &'static str,
    pub primary: ProviderModelReferenceView,
    pub fallbacks: Vec<ProviderModelReferenceView>,
    pub timeout_ms: Option<u64>,
}

impl ProviderRouteView {
    fn from_route(capability: ProviderRoutingCapability, route: &ProviderRoute) -> Self {
        Self {
            capability: provider_routing_capability_name(capability),
            primary: ProviderModelReferenceView::from_reference(route.primary()),
            fallbacks: route
                .fallbacks()
                .iter()
                .map(ProviderModelReferenceView::from_reference)
                .collect(),
            timeout_ms: route.timeout_ms(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelReferenceView {
    pub account_id: String,
    pub model_id: String,
}

impl ProviderModelReferenceView {
    fn from_reference(reference: &ProviderModelReference) -> Self {
        Self {
            account_id: reference.account_id().as_str().to_owned(),
            model_id: reference.model_id().to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingReplaceOutcome {
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderSessionModelSelection {
    pub endpoint: ProviderSessionEndpoint,
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub model_selection_id: String,
    pub account_id: String,
    pub model_id: String,
    pub runtime_model_ref: String,
    pub provider_fingerprint: String,
    pub account_endpoint: Option<String>,
    pub credential_ref: Option<String>,
    pub protocol: Option<&'static str>,
    pub auth_mode: &'static str,
    pub trace_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderSessionEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderSessionModelSelectionOutcome {
    Selected(ProviderSessionModelSelection),
    Unsupported,
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderSessionRuntimeModelsOutcome {
    Accepted(Vec<bool>),
    Unsupported,
    Unavailable,
}

pub fn model_replace_fault(fault: ProviderCascadeFault) -> ProviderModelReplaceOutcome {
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

pub fn routing_replace_fault(fault: ProviderCascadeFault) -> ProviderRoutingReplaceOutcome {
    let ProviderCascadeFault::Routing(fault) = fault else {
        return ProviderRoutingReplaceOutcome::Unavailable;
    };
    match fault {
        ProviderRoutingStoreFault::Decode
        | ProviderRoutingStoreFault::Encode
        | ProviderRoutingStoreFault::InitialRevisionRequired
        | ProviderRoutingStoreFault::RecordTooLarge
        | ProviderRoutingStoreFault::RevisionConflict
        | ProviderRoutingStoreFault::RevisionMustFollowCurrent
        | ProviderRoutingStoreFault::StaleRevision => ProviderRoutingReplaceOutcome::Rejected,
        ProviderRoutingStoreFault::CommitOutcomeUnknown(_)
        | ProviderRoutingStoreFault::RecoveryRequired => {
            ProviderRoutingReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: ProviderNativeConfigurationView::unavailable(),
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            }
        }
        ProviderRoutingStoreFault::Commit(_) | ProviderRoutingStoreFault::WriterBusy => {
            ProviderRoutingReplaceOutcome::Unavailable
        }
    }
}

pub const fn provider_model_capability_name(capability: ProviderModelCapability) -> &'static str {
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

const fn provider_routing_capability_name(capability: ProviderRoutingCapability) -> &'static str {
    match capability {
        ProviderRoutingCapability::Chat => "chat",
        ProviderRoutingCapability::ImageUnderstand => "imageUnderstand",
        ProviderRoutingCapability::ImageGenerate => "imageGenerate",
        ProviderRoutingCapability::VideoGenerate => "videoGenerate",
        ProviderRoutingCapability::MusicGenerate => "musicGenerate",
        ProviderRoutingCapability::Tts => "tts",
    }
}

fn provider_account_kind_name(value: ProviderAccountKind) -> &'static str {
    match value {
        ProviderAccountKind::Chat => "chat",
        ProviderAccountKind::Media => "media",
    }
}

fn provider_api_protocol_name(value: ProviderApiProtocol) -> &'static str {
    match value {
        ProviderApiProtocol::AnthropicMessages => "anthropicMessages",
        ProviderApiProtocol::GoogleGenerativeAi => "googleGenerativeAi",
        ProviderApiProtocol::OpenAiCompletions => "openAiCompletions",
        ProviderApiProtocol::OpenAiResponses => "openAiResponses",
    }
}

fn provider_media_api_protocol_name(value: ProviderMediaApiProtocol) -> &'static str {
    match value {
        ProviderMediaApiProtocol::Google => "google",
        ProviderMediaApiProtocol::OpenAi => "openAi",
        ProviderMediaApiProtocol::OpenRouter => "openRouter",
    }
}

fn provider_account_auth_mode_name(value: ProviderAccountAuthMode) -> &'static str {
    match value {
        ProviderAccountAuthMode::ApiKey => "apiKey",
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cliReuse",
        ProviderAccountAuthMode::OAuthBrowser => "oauthBrowser",
        ProviderAccountAuthMode::OAuthDevice => "oauthDevice",
        ProviderAccountAuthMode::Local => "local",
    }
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
