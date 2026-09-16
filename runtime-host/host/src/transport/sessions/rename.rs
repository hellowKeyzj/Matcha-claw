use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    sessions::rename::{SessionRenameCommand, SessionRenameOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

const CAPABILITY_ID: &str = "session.management";
const OPERATION_ID: &str = "sessions.rename";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/rename";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-rename";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
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
    identity: SessionIdentity,
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
    session_identity: SessionIdentity,
    label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIdentity {
    endpoint: Endpoint,
    agent_id: String,
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn is_openclaw_local(&self) -> bool {
        self.kind == RUNTIME_KIND
            && self.runtime_adapter_id == RUNTIME_ADAPTER_ID
            && self.runtime_instance_id == RUNTIME_INSTANCE_ID
    }
}

impl Request {
    fn decode(
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
            && self.scope.identity == self.target.identity
            && self.scope.identity == self.input.session_identity
            && self.scope.identity.endpoint.is_openclaw_local())
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    fn into_command(self) -> Result<SessionRenameCommand, RequestError> {
        let command = SessionRenameCommand::new(
            self.input.session_identity.agent_id,
            self.input.session_identity.session_key,
            self.input.label,
        );
        command
            .clone()
            .into_openclaw_params()
            .map_err(|_| RequestError::Invalid)?;
        Ok(command)
    }
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

pub(crate) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Response {
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match Request::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    let command = match request.into_command() {
        Ok(command) => command,
        Err(_) => return Response::bad_request(),
    };
    drop(verifier);
    match session.rename_session(command).await {
        Ok(outcome) => Response::outcome(outcome),
        Err(_) => Response::unavailable(),
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session rename request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session rename authorization is invalid")
    }

    fn unavailable() -> Self {
        Self::fixed(503, "Session rename is unavailable")
    }

    fn outcome(outcome: SessionRenameOutcome) -> Self {
        Self {
            status: 200,
            body: match outcome {
                SessionRenameOutcome::Succeeded => serde_json::json!({ "outcome": "succeeded" }),
                SessionRenameOutcome::TargetRejected => {
                    serde_json::json!({ "outcome": "target_rejected" })
                }
                SessionRenameOutcome::Unknown => serde_json::json!({ "outcome": "unknown" }),
            },
        }
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn identity() -> Value {
        json!({
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
            "agentId": "main",
            "sessionKey": "agent:main:session-1",
        })
    }

    fn request() -> Value {
        json!({
            "id": "session.management",
            "operationId": "sessions.rename",
            "scope": { "kind": "session", "identity": identity() },
            "target": { "kind": "session", "identity": identity() },
            "input": { "sessionIdentity": identity(), "label": "Renamed" },
        })
    }

    #[test]
    fn accepts_only_an_identity_bound_openclaw_local_rename() {
        let command = Request::decode_semantics(request())
            .unwrap()
            .into_command()
            .unwrap();

        assert_eq!(command.agent_id, "main");
        assert_eq!(command.session_key, "agent:main:session-1");
        assert_eq!(command.label, "Renamed");
    }

    #[test]
    fn rejects_unknown_fields_wrong_runtime_and_identity_mismatches() {
        for value in [
            {
                let mut value = request();
                value["target"]["identity"]["agentId"] = json!("other");
                value
            },
            {
                let mut value = request();
                value["scope"]["identity"]["endpoint"]["runtimeAdapterId"] = json!("matcha-agent");
                value["target"]["identity"]["endpoint"]["runtimeAdapterId"] = json!("matcha-agent");
                value["input"]["sessionIdentity"]["endpoint"]["runtimeAdapterId"] =
                    json!("matcha-agent");
                value
            },
            {
                let mut value = request();
                value["input"]["label"] = json!("");
                value
            },
            {
                let mut value = request();
                value["input"]["extra"] = json!("private");
                value
            },
        ] {
            assert_eq!(
                Request::decode_semantics(value).and_then(Request::into_command),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn projects_only_semantic_outcomes() {
        for (outcome, expected) in [
            (SessionRenameOutcome::Succeeded, "succeeded"),
            (SessionRenameOutcome::TargetRejected, "target_rejected"),
            (SessionRenameOutcome::Unknown, "unknown"),
        ] {
            assert_eq!(Response::outcome(outcome).status, 200);
            assert_eq!(
                Response::outcome(outcome).body,
                json!({ "outcome": expected })
            );
        }
    }
}
