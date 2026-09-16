use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::matcha_session_catalog::Outcome,
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "session.management";
const OPERATION_ID: &str = "sessions.list";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "matcha-agent";
const RUNTIME_INSTANCE_ID: &str = "local";
const SCOPE_KIND: &str = "runtime-instance";
const TARGET_KIND: &str = "runtime-endpoint";
const AUTHORIZATION_ENDPOINT: &str = "/api/matcha/sessions";
const AUTHORIZATION_SCOPE: &str = "sessions:read";
const AUTHORIZATION_SUBJECT: &str = "matcha-session-catalog";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl Request {
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

    fn decode_semantics(value: Value) -> Result<Self, ()> {
        let request: Self = serde_json::from_value(value).map_err(|_| ())?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), ()> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION_ID
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.is_matcha_local())
        .then_some(())
        .ok_or(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn matcha_local() -> Self {
        Self {
            kind: RUNTIME_KIND.into(),
            runtime_adapter_id: RUNTIME_ADAPTER_ID.into(),
            runtime_instance_id: RUNTIME_INSTANCE_ID.into(),
        }
    }

    fn is_matcha_local(&self) -> bool {
        self == &Self::matcha_local()
    }
}

pub(crate) enum Delivery {
    Listed(Response),
    Unavailable,
}

impl From<Outcome> for Delivery {
    fn from(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Listed(sessions) => Self::Listed(Response {
                sessions: sessions
                    .into_iter()
                    .map(|session| Session {
                        endpoint: Endpoint::matcha_local(),
                        native_session_handle: session.endpoint_session_id,
                        updated_at: session.updated_at,
                    })
                    .collect(),
            }),
            Outcome::Unavailable => Self::Unavailable,
        }
    }
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Listed(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Listed(response) => serde_json::json!({
                "sessions": response.sessions.iter().map(|session| {
                    let mut value = serde_json::json!({
                        "endpoint": endpoint_value(&session.endpoint),
                        "nativeSessionHandle": &session.native_session_handle,
                    });
                    if let Some(updated_at) = session.updated_at {
                        value["updatedAt"] = serde_json::json!(updated_at);
                    }
                    value
                }).collect::<Vec<_>>(),
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Matcha session catalog is unavailable",
            }),
        }
    }
}

pub(crate) struct Response {
    sessions: Vec<Session>,
}

struct Session {
    endpoint: Endpoint,
    native_session_handle: String,
    updated_at: Option<u64>,
}

fn endpoint_value(endpoint: &Endpoint) -> Value {
    serde_json::json!({
        "kind": &endpoint.kind,
        "runtimeAdapterId": &endpoint.runtime_adapter_id,
        "runtimeInstanceId": &endpoint.runtime_instance_id,
    })
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    fn request() -> Value {
        json!({
            "id": "session.management",
            "operationId": "sessions.list",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "matcha-agent",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "runtime-endpoint" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "matcha-agent",
                    "runtimeInstanceId": "local",
                },
            },
        })
    }

    #[test]
    fn accepts_only_the_exact_matcha_local_request() {
        assert!(Request::decode_semantics(request()).is_ok());

        for value in [
            json!({}),
            {
                let mut value = request();
                value["scope"]["endpoint"]["runtimeAdapterId"] = json!("openclaw");
                value
            },
            {
                let mut value = request();
                value["input"]["endpoint"]["runtimeInstanceId"] = json!("remote");
                value
            },
            {
                let mut value = request();
                value["input"]["endpoint"] = json!({
                    "kind": "native-runtime",
                    "runtimeAdapterId": "matcha-agent",
                    "runtimeInstanceId": "local",
                    "private": "do-not-leak",
                });
                value
            },
            {
                let mut value = request();
                value["private"] = json!("do-not-leak");
                value
            },
        ] {
            assert!(Request::decode_semantics(value).is_err());
        }
    }

    #[test]
    fn accepts_only_a_signed_catalog_decision_bound_to_the_matcha_endpoint() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(
            Request::decode(
                request(),
                &decision("/api/matcha/sessions"),
                &mut verifier,
                1
            )
            .is_ok()
        );

        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(matches!(
            Request::decode(request(), &decision("/api/sessions"), &mut verifier, 1),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn projects_only_the_catalog_dto() {
        let delivery = Delivery::from(Outcome::Listed(vec![
            crate::sessions::matcha_session_catalog::Session {
                endpoint_session_id: "session-private-handle".into(),
                updated_at: Some(42),
            },
            crate::sessions::matcha_session_catalog::Session {
                endpoint_session_id: "session-without-time".into(),
                updated_at: None,
            },
        ]));

        let body = delivery.body();
        assert_eq!(
            body,
            json!({
                "sessions": [
                    {
                        "endpoint": {
                            "kind": "native-runtime",
                            "runtimeAdapterId": "matcha-agent",
                            "runtimeInstanceId": "local",
                        },
                        "nativeSessionHandle": "session-private-handle",
                        "updatedAt": 42,
                    },
                    {
                        "endpoint": {
                            "kind": "native-runtime",
                            "runtimeAdapterId": "matcha-agent",
                            "runtimeInstanceId": "local",
                        },
                        "nativeSessionHandle": "session-without-time",
                    },
                ],
            })
        );
        let rendered = body.to_string();
        for forbidden in [
            "agentId",
            "title",
            "model",
            "cwd",
            "transcriptRef",
            "worker",
            "state",
        ] {
            assert!(!rendered.contains(forbidden));
        }
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(endpoint: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "test",
            "endpoint": endpoint,
            "scope": "sessions:read",
            "capability": "sessions.list",
            "subject": "matcha-session-catalog",
            "expiresAt": 2,
            "correlation": "catalog-test",
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
