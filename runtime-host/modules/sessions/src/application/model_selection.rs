use serde::{Serialize, Serializer};

use crate::state::SessionModelState;

pub use super::endpoint::NativeEndpoint;

const MAX_MODEL_SELECTION_ID_BYTES: usize = 4096;
const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_MATCHA_MODEL_BYTES: usize = 4096;
const MAX_PROVIDER_FINGERPRINT_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionModelSelectionCommand {
    pub endpoint: NativeEndpoint,
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub model_selection_id: String,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedSessionModelSelection {
    pub endpoint: NativeEndpoint,
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub model_selection_id: String,
    pub binding: SessionModelSelectionBinding,
    pub diagnostic: Option<SessionModelSelectionDiagnostic>,
    pub trace_id: Option<String>,
}

impl ResolvedSessionModelSelection {
    pub fn openclaw_model_ref(&self) -> Option<&str> {
        match &self.binding {
            SessionModelSelectionBinding::OpenClaw(ref_model) => Some(ref_model.as_str()),
            SessionModelSelectionBinding::Matcha { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchaSessionModelRuntimeCommand {
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub model: String,
    pub model_selection_id: Option<String>,
    pub provider_fingerprint: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRuntimeModelFacts {
    pub current_model: Option<String>,
    pub model_state: Option<SessionModelState>,
    pub agent_id: Option<String>,
    pub model_override_source: Option<SessionRuntimeModelSource>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionRuntimeModelSource {
    User,
    Auto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRuntimeModelCommand {
    pub endpoint: NativeEndpoint,
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub current_model: Option<String>,
    pub default_model: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionModelSelectionDiagnostic {
    account_id: String,
    model_id: String,
    protocol: Option<&'static str>,
    auth_mode: &'static str,
}

impl SessionModelSelectionDiagnostic {
    pub fn new(
        account_id: String,
        model_id: String,
        protocol: Option<&'static str>,
        auth_mode: &'static str,
    ) -> Self {
        Self {
            account_id,
            model_id,
            protocol,
            auth_mode,
        }
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn protocol(&self) -> Option<&'static str> {
        self.protocol
    }

    pub fn auth_mode(&self) -> &'static str {
        self.auth_mode
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaProviderSecret(String);

impl MatchaProviderSecret {
    pub fn new(value: String) -> Result<Self, InvalidCommand> {
        if value.trim().is_empty() || value.as_bytes().contains(&0) {
            return Err(InvalidCommand);
        }
        Ok(Self(value))
    }

    pub fn into_private_string(self) -> String {
        self.0
    }
}

impl std::fmt::Debug for MatchaProviderSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaProviderRuntimeConfig {
    AnthropicMessages {
        base_url: Option<String>,
        api_key: Option<MatchaProviderSecret>,
    },
    GoogleGenerativeAi {
        base_url: Option<String>,
        api_key: Option<MatchaProviderSecret>,
    },
    OpenAiChatCompletions {
        base_url: Option<String>,
        api_key: Option<MatchaProviderSecret>,
    },
    OpenAiResponses {
        base_url: Option<String>,
        api_key: Option<MatchaProviderSecret>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionModelSelectionBinding {
    OpenClaw(String),
    Matcha {
        model: String,
        provider_fingerprint: String,
        provider_runtime: MatchaProviderRuntimeConfig,
    },
}

impl MatchaSessionModelRuntimeCommand {
    pub fn try_new(
        session_key: String,
        endpoint_session_id: Option<String>,
        model: String,
        model_selection_id: Option<String>,
        provider_fingerprint: Option<String>,
    ) -> Result<Self, InvalidCommand> {
        if session_key.is_empty()
            || session_key.len() > MAX_SESSION_KEY_BYTES
            || session_key.as_bytes().contains(&0)
            || endpoint_session_id
                .as_deref()
                .is_some_and(|endpoint_session_id| !valid_endpoint_session_id(endpoint_session_id))
            || !valid_model_value(&model, MAX_MATCHA_MODEL_BYTES)
            || model_selection_id
                .as_deref()
                .is_some_and(|value| !valid_model_value(value, MAX_MODEL_SELECTION_ID_BYTES))
            || provider_fingerprint
                .as_deref()
                .is_some_and(|value| !valid_model_value(value, MAX_PROVIDER_FINGERPRINT_BYTES))
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            session_key,
            endpoint_session_id,
            model,
            model_selection_id,
            provider_fingerprint,
            trace_id: None,
        })
    }

    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }
}

impl SessionRuntimeModelCommand {
    pub fn try_new(
        endpoint: NativeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        current_model: Option<String>,
        default_model: Option<String>,
    ) -> Result<Self, InvalidCommand> {
        if session_key.is_empty()
            || session_key.len() > MAX_SESSION_KEY_BYTES
            || session_key.as_bytes().contains(&0)
            || endpoint_session_id
                .as_deref()
                .is_some_and(|endpoint_session_id| !valid_endpoint_session_id(endpoint_session_id))
            || current_model
                .as_deref()
                .is_some_and(|value| !valid_model_value(value, MAX_MATCHA_MODEL_BYTES))
            || default_model
                .as_deref()
                .is_some_and(|value| !valid_model_value(value, MAX_MATCHA_MODEL_BYTES))
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            endpoint,
            session_key,
            endpoint_session_id,
            current_model,
            default_model,
            trace_id: None,
        })
    }

    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }
}

impl SessionModelSelectionCommand {
    pub fn try_new(
        endpoint: NativeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_selection_id: String,
    ) -> Result<Self, InvalidCommand> {
        if session_key.is_empty()
            || session_key.len() > MAX_SESSION_KEY_BYTES
            || session_key.as_bytes().contains(&0)
            || endpoint_session_id
                .as_deref()
                .is_some_and(|endpoint_session_id| !valid_endpoint_session_id(endpoint_session_id))
            || model_selection_id.trim().is_empty()
            || model_selection_id.len() > MAX_MODEL_SELECTION_ID_BYTES
            || model_selection_id.as_bytes().contains(&0)
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            endpoint,
            session_key,
            endpoint_session_id,
            model_selection_id,
            trace_id: None,
        })
    }

    pub fn with_endpoint_session_id(mut self, session_id: String) -> Result<Self, InvalidCommand> {
        if !valid_endpoint_session_id(&session_id) {
            return Err(InvalidCommand);
        }
        self.endpoint_session_id = Some(session_id);
        Ok(self)
    }

    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }
}

fn valid_endpoint_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ENDPOINT_SESSION_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_model_value(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.as_bytes().contains(&0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommand;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawPatchRejection {
    code: String,
    message: String,
}

impl OpenClawPatchRejection {
    pub fn new(code: String, message: String) -> Self {
        Self { code, message }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionModelSelectionRejection {
    InvalidSessionKey,
    BindingMismatch,
    InvalidModel,
    ModelSelectionNotFound,
    OpenClawModelRefInvalid,
    MatchaProviderRuntimeUnavailable,
    SessionNotFound,
    RuntimeTargetRejected,
    OpenClawRuntimeTargetRejected(OpenClawPatchRejection),
}

impl SessionModelSelectionRejection {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidSessionKey => "invalid_session_key",
            Self::BindingMismatch => "binding_mismatch",
            Self::InvalidModel => "invalid_model",
            Self::ModelSelectionNotFound => "model_selection_not_found",
            Self::OpenClawModelRefInvalid => "openclaw_model_ref_invalid",
            Self::MatchaProviderRuntimeUnavailable => "matcha_provider_runtime_unavailable",
            Self::SessionNotFound => "session_not_found",
            Self::RuntimeTargetRejected => "runtime_target_rejected",
            Self::OpenClawRuntimeTargetRejected(_) => "openclaw_runtime_target_rejected",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionModelSelectionOutcome {
    Succeeded {
        model_state: SessionModelState,
    },
    TargetRejected {
        reason: SessionModelSelectionRejection,
        diagnostic: Option<SessionModelSelectionDiagnostic>,
    },
    OutcomeUnknown,
    Unsupported,
    Unavailable,
}

impl SessionModelSelectionOutcome {
    pub fn target_rejected(reason: SessionModelSelectionRejection) -> Self {
        Self::TargetRejected {
            reason,
            diagnostic: None,
        }
    }

    pub fn target_rejected_with_diagnostic(
        reason: SessionModelSelectionRejection,
        diagnostic: Option<SessionModelSelectionDiagnostic>,
    ) -> Self {
        Self::TargetRejected { reason, diagnostic }
    }

    pub fn with_diagnostic(self, diagnostic: Option<SessionModelSelectionDiagnostic>) -> Self {
        match self {
            Self::TargetRejected {
                reason,
                diagnostic: None,
            } => Self::TargetRejected { reason, diagnostic },
            outcome => outcome,
        }
    }

    pub fn rejection_reason(&self) -> Option<&'static str> {
        match self {
            Self::TargetRejected { reason, .. } => Some(reason.as_str()),
            _ => None,
        }
    }

    pub fn diagnostic(&self) -> Option<&SessionModelSelectionDiagnostic> {
        match self {
            Self::TargetRejected { diagnostic, .. } => diagnostic.as_ref(),
            _ => None,
        }
    }

    pub fn openclaw_patch_rejection(&self) -> Option<&OpenClawPatchRejection> {
        match self {
            Self::TargetRejected {
                reason: SessionModelSelectionRejection::OpenClawRuntimeTargetRejected(rejection),
                ..
            } => Some(rejection),
            _ => None,
        }
    }
}

impl Serialize for SessionModelSelectionOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Succeeded { model_state } => {
                SucceededOutcomeTag::new(model_state).serialize(serializer)
            }
            Self::TargetRejected { .. } => OutcomeTag::TargetRejected.serialize(serializer),
            Self::OutcomeUnknown => OutcomeTag::OutcomeUnknown.serialize(serializer),
            Self::Unsupported => OutcomeTag::Unsupported.serialize(serializer),
            Self::Unavailable => OutcomeTag::Unavailable.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SucceededOutcomeTag<'a> {
    #[serde(rename = "outcome")]
    outcome: SucceededOutcome,
    model_state: &'a SessionModelState,
}

impl<'a> SucceededOutcomeTag<'a> {
    fn new(model_state: &'a SessionModelState) -> Self {
        Self {
            outcome: SucceededOutcome::Succeeded,
            model_state,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum SucceededOutcome {
    Succeeded,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum OutcomeTag {
    TargetRejected,
    OutcomeUnknown,
    Unsupported,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        MatchaProviderRuntimeConfig, MatchaProviderSecret, SessionModelSelectionBinding,
        SessionModelSelectionOutcome,
    };

    #[test]
    fn matcha_provider_runtime_debug_redacts_secret() {
        let binding = SessionModelSelectionBinding::Matcha {
            model: "ark-code-latest".to_owned(),
            provider_fingerprint: "matcha-provider:v1:test".to_owned(),
            provider_runtime: MatchaProviderRuntimeConfig::OpenAiChatCompletions {
                base_url: Some("https://ark.example/v1".to_owned()),
                api_key: Some(MatchaProviderSecret::new("secret-canary".to_owned()).unwrap()),
            },
        };

        let debug = format!("{binding:?}");
        assert!(debug.contains("ark-code-latest"));
        assert!(!debug.contains("secret-canary"));
    }

    #[test]
    fn serializes_outcome_unknown_without_peer_details() {
        assert_eq!(
            serde_json::to_value(SessionModelSelectionOutcome::OutcomeUnknown).unwrap(),
            json!({ "outcome": "outcome_unknown" })
        );
    }
}
