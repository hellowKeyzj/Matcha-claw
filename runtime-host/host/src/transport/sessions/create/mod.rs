use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::create::{SessionCreateAdmissionInput, SessionCreateOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "session.prompt";
const OPERATION_ID: &str = "sessions.create";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/create";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-create";
const RUNTIME_KIND: &str = "native-runtime";

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
pub(crate) struct SessionCreateRequest {
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
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    agent_id: String,
    endpoint_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn native_endpoint(&self) -> Option<RuntimeEndpoint> {
        if self.kind != RUNTIME_KIND {
            return None;
        }
        RuntimeEndpoint::try_new(&self.runtime_adapter_id, &self.runtime_instance_id).ok()
    }
}

impl SessionCreateRequest {
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
            && self.scope.kind == "agent"
            && self.target.kind == "agent"
            && self.scope.agent_id == self.target.agent_id
            && self.scope.agent_id == self.input.agent_id
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.native_endpoint().is_some())
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_admission_input(self) -> Result<SessionCreateAdmissionInput, RequestError> {
        let endpoint = self
            .input
            .endpoint
            .native_endpoint()
            .ok_or(RequestError::Invalid)?;
        Ok(SessionCreateAdmissionInput::new(
            endpoint,
            self.input.agent_id,
            self.input.endpoint_session_id,
        ))
    }
}

pub(crate) enum SessionCreateDelivery {
    Outcome(SessionCreateOutcome),
    Unavailable,
}

impl SessionCreateDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(SessionCreateOutcome::Unavailable) | Self::Unavailable => 503,
            Self::Outcome(_) => 200,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(SessionCreateOutcome::Unavailable) | Self::Unavailable => {
                serde_json::json!({
                    "success": false,
                    "error": "Session create is unavailable",
                })
            }
            Self::Outcome(SessionCreateOutcome::Succeeded(view)) => {
                crate::transport::sessions::presenter::session_view(view)
            }
            Self::Outcome(SessionCreateOutcome::TargetRejected) => {
                serde_json::json!({ "outcome": "target_rejected" })
            }
            Self::Outcome(SessionCreateOutcome::Unknown) => {
                serde_json::json!({ "outcome": "unknown" })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    fn endpoint() -> Value {
        json!({
            "kind": "native-runtime",
            "runtimeAdapterId": "openclaw",
            "runtimeInstanceId": "local",
        })
    }

    fn request() -> Value {
        json!({
            "id": "session.prompt",
            "operationId": "sessions.create",
            "scope": { "kind": "agent", "endpoint": endpoint(), "agentId": "main" },
            "target": { "kind": "agent", "agentId": "main" },
            "input": {
                "endpoint": endpoint(),
                "agentId": "main",
                "endpointSessionId": "session-1",
            },
        })
    }

    fn matcha_request() -> Value {
        let endpoint = json!({
            "kind": "native-runtime",
            "runtimeAdapterId": "matcha-agent",
            "runtimeInstanceId": "local",
        });
        json!({
            "id": "session.prompt",
            "operationId": "sessions.create",
            "scope": { "kind": "agent", "endpoint": endpoint, "agentId": "main" },
            "target": { "kind": "agent", "agentId": "main" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "matcha-agent",
                    "runtimeInstanceId": "local",
                },
                "agentId": "main",
                "endpointSessionId": "matcha-session-1",
            },
        })
    }

    fn request_without_endpoint_session_id() -> Value {
        let mut value = request();
        value["input"]
            .as_object_mut()
            .unwrap()
            .remove("endpointSessionId");
        value
    }

    fn matcha_request_without_endpoint_session_id() -> Value {
        let mut value = matcha_request();
        value["input"]
            .as_object_mut()
            .unwrap()
            .remove("endpointSessionId");
        value
    }

    fn decision(capability: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "test",
            "endpoint": "/api/sessions/create",
            "scope": "sessions:write",
            "capability": capability,
            "subject": "session-create",
            "expiresAt": 2,
            "correlation": format!("test:{capability}"),
            "revision": "1",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(
            SigningKey::from_bytes(&[7; 32])
                .sign(signed.as_bytes())
                .to_bytes(),
        );
        format!("{signed}.{signature}")
    }

    fn verifier() -> CapabilityDecisionVerifier {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let mut key = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        key.extend_from_slice(signing_key.verifying_key().as_bytes());
        CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(key)).unwrap()
    }

    #[test]
    fn verifies_the_capability_separately_from_the_operation() {
        let mut verifier = verifier();
        assert!(
            SessionCreateRequest::decode(request(), &decision("session.prompt"), &mut verifier, 1)
                .is_ok()
        );

        let mut verifier = self::verifier();
        assert!(matches!(
            SessionCreateRequest::decode(request(), &decision("sessions.create"), &mut verifier, 1),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn accepts_the_fixed_openclaw_local_agent_scope() {
        let input = SessionCreateRequest::decode_semantics(request())
            .unwrap()
            .into_admission_input()
            .unwrap();

        assert_eq!(input.endpoint().runtime_adapter_id(), "openclaw");
        assert_eq!(input.agent_id(), "main");
        assert_eq!(input.endpoint_session_id(), Some("session-1"));
    }

    #[test]
    fn accepts_the_fixed_matcha_local_agent_scope_with_native_session_identity() {
        let input = SessionCreateRequest::decode_semantics(matcha_request())
            .unwrap()
            .into_admission_input()
            .unwrap();

        assert_eq!(input.endpoint().runtime_adapter_id(), "matcha-agent");
        assert_eq!(input.agent_id(), "main");
        assert_eq!(input.endpoint_session_id(), Some("matcha-session-1"));
    }

    #[test]
    fn missing_endpoint_session_id_stays_an_admission_input() {
        let input = SessionCreateRequest::decode_semantics(request_without_endpoint_session_id())
            .unwrap()
            .into_admission_input()
            .unwrap();

        assert_eq!(input.endpoint().runtime_adapter_id(), "openclaw");
        assert_eq!(input.agent_id(), "main");
        assert_eq!(input.endpoint_session_id(), None);
    }

    #[test]
    fn missing_matcha_endpoint_session_id_stays_an_admission_input() {
        let input =
            SessionCreateRequest::decode_semantics(matcha_request_without_endpoint_session_id())
                .unwrap()
                .into_admission_input()
                .unwrap();

        assert_eq!(input.endpoint().runtime_adapter_id(), "matcha-agent");
        assert_eq!(input.agent_id(), "main");
        assert_eq!(input.endpoint_session_id(), None);
    }

    #[test]
    fn rejects_unknown_fields_and_scope_mismatches() {
        for value in [
            {
                let mut value = request();
                value["target"]["agentId"] = json!("other");
                value
            },
            {
                let mut value = request();
                value["input"]["endpoint"]["runtimeAdapterId"] = json!("matcha-agent");
                value
            },
            {
                let mut value = request();
                value["input"]["extra"] = json!("private");
                value
            },
        ] {
            assert_eq!(
                SessionCreateRequest::decode_semantics(value)
                    .and_then(SessionCreateRequest::into_admission_input),
                Err(RequestError::Invalid)
            );
        }
    }
}
