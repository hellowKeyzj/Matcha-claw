use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::abort::{NativeEndpoint, SessionAbortCommand, SessionAbortOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "session.abort";
const OPERATION_ID: &str = "sessions.abort";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/abort";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-abort";
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
pub(crate) struct SessionAbortRequest {
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
    run_id: Option<String>,
    approval_ids: Option<Vec<String>>,
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

fn valid_endpoint_session_id(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !value.is_empty()
            && value.len() <= MAX_ENDPOINT_SESSION_ID_BYTES
            && value.trim() == value
            && !value.chars().any(char::is_control)
    })
}

impl SessionAbortRequest {
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
            && self.target.kind == "session"
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.parse().is_some()
            && self.scope.session_key == self.input.session_key
            && valid_endpoint_session_id(self.input.endpoint_session_id.as_deref())
            && self
                .input
                .approval_ids
                .as_ref()
                .is_none_or(|ids| !ids.is_empty()))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<SessionAbortCommand, RequestError> {
        let endpoint = self.scope.endpoint.parse().ok_or(RequestError::Invalid)?;
        SessionAbortCommand::try_new(
            endpoint,
            self.input.session_key,
            None,
            self.input.run_id,
            self.input.approval_ids,
        )
        .map_err(|_| RequestError::Invalid)
    }
}

pub(crate) enum SessionAbortDelivery {
    Outcome(SessionAbortOutcome),
    Unsupported,
    Unavailable,
}

impl From<SessionAbortOutcome> for SessionAbortDelivery {
    fn from(outcome: SessionAbortOutcome) -> Self {
        match outcome {
            SessionAbortOutcome::Unsupported => Self::Unsupported,
            SessionAbortOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SessionAbortDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unsupported => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(SessionAbortOutcome::Succeeded) => {
                serde_json::json!({ "outcome": "succeeded" })
            }
            Self::Outcome(SessionAbortOutcome::Rejected) => {
                serde_json::json!({ "outcome": "target_rejected" })
            }
            Self::Outcome(SessionAbortOutcome::Unknown) => {
                serde_json::json!({ "outcome": "unknown" })
            }
            Self::Outcome(SessionAbortOutcome::Unsupported | SessionAbortOutcome::Unavailable) => {
                unreachable!("availability outcomes are split before delivery")
            }
            Self::Unsupported => serde_json::json!({
                "success": false,
                "error": "Session abort endpoint is unsupported",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session abort is unavailable",
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
            "id": "session.abort",
            "operationId": "sessions.abort",
            "scope": {
                "kind": "session",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
            },
            "target": { "kind": "session" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "runId": "run-1",
            },
        })
    }

    #[test]
    fn parses_supported_and_unsupported_native_endpoint_commands() {
        let openclaw = SessionAbortRequest::decode_semantics(request("openclaw"))
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(openclaw.endpoint, NativeEndpoint::OpenClawLocal);

        let matcha = SessionAbortRequest::decode_semantics(request("matcha-agent"))
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(matcha.endpoint, NativeEndpoint::MatchaAgentLocal);

        let unsupported = SessionAbortRequest::decode_semantics(request("other-runtime"))
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(unsupported.endpoint, NativeEndpoint::Unsupported);
    }

    #[test]
    fn accepts_session_wide_abort_without_a_run_identifier() {
        let mut value = request("openclaw");
        value["input"].as_object_mut().unwrap().remove("runId");

        assert_eq!(
            SessionAbortRequest::decode_semantics(value)
                .unwrap()
                .into_command()
                .unwrap()
                .run_id,
            None,
        );
    }

    #[test]
    fn decodes_approval_ids_without_treating_them_as_run_identity() {
        let mut value = request("openclaw");
        value["input"].as_object_mut().unwrap().remove("runId");
        value["input"]["approvalIds"] = json!(["approval-1"]);
        let command = SessionAbortRequest::decode_semantics(value)
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(command.run_id, None);
        assert_eq!(command.approval_ids, Some(vec!["approval-1".into()]));
    }

    #[test]
    fn rejects_empty_approval_ids_without_treating_them_as_run_identity() {
        let mut empty = request("openclaw");
        empty["input"].as_object_mut().unwrap().remove("runId");
        empty["input"]["approvalIds"] = json!([]);

        assert!(SessionAbortRequest::decode_semantics(empty).is_err());
    }

    #[test]
    fn ignores_public_endpoint_session_binding_on_active_abort() {
        let mut value = request("openclaw");
        value["input"]["endpointSessionId"] = json!("native-session-1");

        let command = SessionAbortRequest::decode_semantics(value)
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(command.endpoint_session_id, None);
        assert_eq!(command.session_key, "agent:main:demo");
        assert_eq!(command.run_id.as_deref(), Some("run-1"));
    }

    #[test]
    fn rejects_legacy_session_identity_input() {
        let mut value = request("openclaw");
        value["input"]["sessionIdentity"] = json!({});
        assert_eq!(
            SessionAbortRequest::decode_semantics(value)
                .and_then(SessionAbortRequest::into_command),
            Err(RequestError::Invalid)
        );
    }
}
