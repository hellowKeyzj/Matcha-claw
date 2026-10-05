use platform::capability::CapabilityDecisionVerifier;

use serde::Deserialize;
use serde_json::Value;

use crate::{
    adapters::loopback::key::is_cron_session_key,
    send::{Attachment, SessionSendCommand, SessionSendOutcome},
    state::{SessionIdentity, SessionProvider},
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "session.prompt";
const OPERATION_ID: &str = "sessions.send";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/send";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-send";
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
pub(crate) struct SessionSendRequest {
    id: String,
    operation_id: String,
    scope: Target,
    target: Target,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    identity: SessionIdentity,
    endpoint_session_id: Option<String>,
    message: String,
    intent: Option<crate::goal::SessionSendIntent>,
    run_id: Option<String>,
    idempotency_key: Option<String>,
    deliver: Option<bool>,
    attachments: Vec<AttachmentRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentRequest {
    mime_type: String,
    file_name: String,
    content: String,
}

fn valid_endpoint_session_id(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !value.is_empty()
            && value.len() <= MAX_ENDPOINT_SESSION_ID_BYTES
            && value.trim() == value
            && !value.chars().any(char::is_control)
    })
}

fn is_openclaw_cron_session_key(identity: &SessionIdentity) -> bool {
    identity.provider() == SessionProvider::OpenClaw && is_cron_session_key(identity.session_key())
}

impl SessionSendRequest {
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
                CAPABILITY_ID,
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
            && self.scope.identity == self.target.identity
            && self.scope.identity == self.input.identity
            && self.scope.identity.validate().is_ok()
            && !is_openclaw_cron_session_key(&self.scope.identity)
            && valid_endpoint_session_id(self.input.endpoint_session_id.as_deref()))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(
        self,
        trace_id: Option<String>,
    ) -> Result<SessionSendCommand, RequestError> {
        let attachments = self
            .input
            .attachments
            .into_iter()
            .map(|attachment| Attachment {
                mime_type: attachment.mime_type,
                file_name: attachment.file_name,
                content: attachment.content,
            })
            .collect();
        let command = SessionSendCommand::try_new(
            self.input.identity,
            self.input.endpoint_session_id,
            self.input.message,
            self.input.run_id,
            self.input.idempotency_key,
            self.input.deliver,
            attachments,
            trace_id,
        )
        .map_err(|_| RequestError::Invalid)?;
        match self.input.intent {
            Some(intent) => command.with_intent(intent).map_err(|_| RequestError::Invalid),
            None => Ok(command),
        }
    }
}

pub(crate) enum SessionSendDelivery {
    Outcome(SessionSendOutcome),
    Unsupported,
    Unavailable,
}

impl From<SessionSendOutcome> for SessionSendDelivery {
    fn from(outcome: SessionSendOutcome) -> Self {
        match outcome {
            SessionSendOutcome::Unsupported => Self::Unsupported,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SessionSendDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(SessionSendOutcome::Queued { .. }) => 202,
            Self::Outcome(_) => 200,
            Self::Unsupported => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => {
                serde_json::to_value(outcome).expect("Session send public response is serializable")
            }
            Self::Unsupported => serde_json::json!({
                "success": false,
                "error": "Session send endpoint is unsupported",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session send is unavailable",
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
            "id": "session.prompt",
            "operationId": "sessions.send",
            "scope": {
                "kind": "session",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "routeKey": "renderer-route:test",
            },
            "target": { "kind": "session" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": adapter,
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "message": "describe this",
                "runId": "run-1",
                "deliver": true,
                "attachments": [{
                    "mimeType": "image/png",
                    "fileName": "image.png",
                    "content": "aGVsbG8=",
                }],
            },
        })
    }

    #[test]
    fn parses_supported_and_unsupported_native_endpoint_commands() {
        let openclaw = SessionSendRequest::decode_semantics(request("openclaw"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(openclaw.endpoint, NativeEndpoint::OpenClawLocal);
        assert_eq!(openclaw.endpoint_session_id, None);
        assert_eq!(openclaw.deliver, Some(true));

        let matcha = SessionSendRequest::decode_semantics(request("matcha-agent"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(matcha.endpoint, NativeEndpoint::MatchaAgentLocal);

        let unsupported = SessionSendRequest::decode_semantics(request("other-runtime"))
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(unsupported.endpoint, NativeEndpoint::Unsupported);
    }

    #[test]
    fn preserves_public_endpoint_session_binding_on_active_send() {
        let mut value = request("openclaw");
        value["input"]["endpointSessionId"] = json!("endpoint-session-1");

        let command = SessionSendRequest::decode_semantics(value)
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(
            command.endpoint_session_id.as_deref(),
            Some("endpoint-session-1")
        );
        assert_eq!(command.session_key, "agent:main:demo");
        assert_eq!(command.run_id.as_deref(), Some("run-1"));
    }

    #[test]
    fn rejects_openclaw_cron_session_prompt_requests() {
        for session_key in [
            "agent:main:cron:heartbeat-main",
            "agent:main:cron:heartbeat-main:run:run-1",
            "cron:heartbeat-main",
        ] {
            let mut value = request("openclaw");
            value["scope"]["sessionKey"] = json!(session_key);
            value["input"]["sessionKey"] = json!(session_key);

            assert_eq!(
                SessionSendRequest::decode_semantics(value)
                    .and_then(|request| SessionSendRequest::into_command(request, None)),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn preserves_host_private_trace_id_through_command_resolution() {
        let command = SessionSendRequest::decode_semantics(request("openclaw"))
            .unwrap()
            .into_command(Some("trace-1".into()))
            .unwrap();
        assert_eq!(command.trace_id(), Some("trace-1"));

        let cloned = command.clone();
        assert_eq!(cloned.trace_id(), Some("trace-1"));

        let command = command.with_resolved_run_id("resolved-run".into()).unwrap();
        assert_eq!(command.trace_id(), Some("trace-1"));
        assert_eq!(command.requested_run_id(), Some("resolved-run"));
    }

    #[test]
    fn rejects_model_selection_on_prompt_send() {
        let mut value = request("openclaw");
        value["input"]["modelSelectionId"] = json!("account-1/model-1");

        assert_eq!(
            SessionSendRequest::decode_semantics(value)
                .and_then(|request| SessionSendRequest::into_command(request, None)),
            Err(RequestError::Invalid)
        );
    }

    #[test]
    fn accepts_text_requests_without_attachments() {
        let mut value = request("openclaw");
        value["input"]["attachments"] = json!([]);

        let command = SessionSendRequest::decode_semantics(value)
            .unwrap()
            .into_command(None)
            .unwrap();
        assert!(command.attachments.is_empty());
    }

    #[test]
    fn accepts_legacy_prompt_without_run_id_and_with_idempotency_key() {
        let mut value = request("openclaw");
        value["input"].as_object_mut().unwrap().remove("runId");
        value["input"]["idempotencyKey"] = json!("idem-1");

        let command = SessionSendRequest::decode_semantics(value)
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(command.run_id, None);
        assert_eq!(command.idempotency_key.as_deref(), Some("idem-1"));
        assert_eq!(command.requested_run_id(), None);
        assert_eq!(command.request_run_identity(), Some("idem-1"));
    }

    #[test]
    fn accepts_main_materialized_generic_attachments() {
        let mut value = request("openclaw");
        value["input"]["attachments"] = json!([{
            "mimeType": "text/plain",
            "fileName": "fixed-profile.txt",
            "content": "Zml4ZWQtcHJvZmlsZSBhdHRhY2htZW50IHJlY2VpcHQ=",
        }]);

        let command = SessionSendRequest::decode_semantics(value)
            .unwrap()
            .into_command(None)
            .unwrap();
        assert_eq!(command.attachments.len(), 1);
        assert_eq!(command.attachments[0].mime_type, "text/plain");
        assert_eq!(command.attachments[0].file_name, "fixed-profile.txt");
    }

    #[test]
    fn rejects_malformed_requests_without_validating_peer_media_grammar() {
        for value in [
            {
                let mut value = request("openclaw");
                value["input"]["attachments"][0]["filePath"] = json!("C:/private/image.png");
                value
            },
            {
                let mut value = request("openclaw");
                value["scope"]["sessionKey"] = json!("agent:main:other");
                value
            },
        ] {
            assert_eq!(
                SessionSendRequest::decode_semantics(value)
                    .and_then(|request| SessionSendRequest::into_command(request, None)),
                Err(RequestError::Invalid)
            );
        }
    }
}
