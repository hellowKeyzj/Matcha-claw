use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::model_selection::{
        NativeEndpoint, OpenClawPatchRejection, SessionModelSelectionCommand,
        SessionModelSelectionOutcome,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "session.modelSelection";
const OPERATION_ID: &str = "sessions.patchModel";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/model";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-model-selection";
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionModelSelectionRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    session_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    session_key: String,
    endpoint_session_id: Option<String>,
    model_selection_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn parse(&self) -> Option<NativeEndpoint> {
        NativeEndpoint::parse(
            &self.kind,
            &self.runtime_adapter_id,
            &self.runtime_instance_id,
        )
    }
}

fn valid_endpoint_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ENDPOINT_SESSION_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

impl SessionModelSelectionRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        Self::decode_semantics(value).map_err(|_| DecodeError::Invalid)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION_ID
            && self.scope.kind == "session"
            && self.target.kind == "model-selection"
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.parse().is_some()
            && self.scope.session_key == self.input.session_key
            && self
                .input
                .endpoint_session_id
                .as_deref()
                .is_none_or(valid_endpoint_session_id))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(
        self,
        trace_id: Option<String>,
    ) -> Result<SessionModelSelectionCommand, RequestError> {
        SessionModelSelectionCommand::try_new(
            self.scope.endpoint.parse().ok_or(RequestError::Invalid)?,
            self.input.session_key,
            None,
            self.input.model_selection_id,
        )
        .map(|command| command.with_trace_id(trace_id))
        .map_err(|_| RequestError::Invalid)
    }
}

pub(crate) enum SessionModelSelectionDelivery {
    Outcome(SessionModelSelectionOutcome),
    Unsupported,
    Unavailable,
}

impl From<SessionModelSelectionOutcome> for SessionModelSelectionDelivery {
    fn from(outcome: SessionModelSelectionOutcome) -> Self {
        match outcome {
            SessionModelSelectionOutcome::Unsupported => Self::Unsupported,
            SessionModelSelectionOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SessionModelSelectionDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unsupported => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn rejection_reason(&self) -> Option<&'static str> {
        match self {
            Self::Outcome(outcome) => outcome.rejection_reason(),
            Self::Unsupported | Self::Unavailable => None,
        }
    }

    pub(crate) fn openclaw_patch_rejection(&self) -> Option<&OpenClawPatchRejection> {
        match self {
            Self::Outcome(outcome) => outcome.openclaw_patch_rejection(),
            Self::Unsupported | Self::Unavailable => None,
        }
    }

    pub(crate) fn diagnostic(
        &self,
    ) -> Option<&crate::sessions::model_selection::SessionModelSelectionDiagnostic> {
        match self {
            Self::Outcome(outcome) => outcome.diagnostic(),
            Self::Unsupported | Self::Unavailable => None,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => serde_json::to_value(outcome)
                .expect("Session model selection public response is serializable"),
            Self::Unsupported => serde_json::json!({
                "success": false,
                "error": "Session model selection endpoint is unsupported",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session model selection is unavailable",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(adapter: &str) -> Value {
        json!({
            "id": "session.modelSelection",
            "operationId": "sessions.patchModel",
            "scope": {
                "kind": "session",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
            },
            "target": { "kind": "model-selection" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "modelSelectionId": "anthropic/claude-sonnet-4-6",
            },
        })
    }

    #[test]
    fn parses_supported_and_unsupported_native_endpoint_commands() {
        let openclaw = SessionModelSelectionRequest::decode_semantics(request("openclaw"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(openclaw.endpoint, NativeEndpoint::OpenClawLocal);
        assert_eq!(openclaw.endpoint_session_id, None);

        let matcha = SessionModelSelectionRequest::decode_semantics(request("matcha-agent"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(matcha.endpoint, NativeEndpoint::MatchaAgentLocal);

        let unsupported = SessionModelSelectionRequest::decode_semantics(request("other-runtime"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(unsupported.endpoint, NativeEndpoint::Unsupported);
    }

    #[test]
    fn ignores_public_endpoint_session_binding_on_active_model_selection() {
        let mut value = request("matcha-agent");
        value["input"]["endpointSessionId"] = json!("native-session-1");

        let command = SessionModelSelectionRequest::decode_semantics(value)
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(command.session_key, "agent:main:demo");
        assert_eq!(command.endpoint_session_id, None);
    }

    #[test]
    fn rejects_cross_session_unknown_and_empty_model_selection_id() {
        for value in [
            {
                let mut value = request("openclaw");
                value["scope"]["sessionKey"] = json!("agent:main:other");
                value
            },
            {
                let mut value = request("openclaw");
                value["input"]["model"] = json!("anthropic/claude-sonnet-4-6");
                value
            },
            {
                let mut value = request("openclaw");
                value["input"]["runtimeModelRef"] = json!("anthropic/claude-sonnet-4-6");
                value
            },
            {
                let mut value = request("openclaw");
                value["input"]["modelSelectionId"] = json!("");
                value
            },
        ] {
            assert_eq!(
                SessionModelSelectionRequest::decode_semantics(value)
                    .and_then(|request| request.into_command(None)),
                Err(RequestError::Invalid)
            );
        }
    }
}
