use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::delete::{SessionDeleteCommand, SessionDeleteOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "session.management";
const OPERATION_ID: &str = "sessions.delete";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/delete";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-delete";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";

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
pub(crate) struct SessionDeleteRequest {
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

impl SessionDeleteRequest {
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
            && self.scope.identity == self.target.identity
            && self.scope.identity == self.input.session_identity
            && self.scope.identity.endpoint.is_openclaw_local())
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<SessionDeleteCommand, RequestError> {
        let command = SessionDeleteCommand::new(
            self.input.session_identity.agent_id,
            self.input.session_identity.session_key,
        );
        command
            .clone()
            .into_openclaw_params()
            .map_err(|_| RequestError::Invalid)?;
        Ok(command)
    }
}

pub(crate) enum SessionDeleteDelivery {
    Outcome(SessionDeleteOutcome),
    Unavailable,
}

impl SessionDeleteDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(SessionDeleteOutcome::Succeeded) => {
                serde_json::json!({ "outcome": "succeeded" })
            }
            Self::Outcome(SessionDeleteOutcome::TargetRejected) => {
                serde_json::json!({ "outcome": "target_rejected" })
            }
            Self::Outcome(SessionDeleteOutcome::Unknown) => {
                serde_json::json!({ "outcome": "unknown" })
            }
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session delete is unavailable",
            }),
        }
    }
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
            "operationId": "sessions.delete",
            "scope": { "kind": "session", "identity": identity() },
            "target": { "kind": "session", "identity": identity() },
            "input": { "sessionIdentity": identity() },
        })
    }

    #[test]
    fn accepts_only_the_fixed_openclaw_local_identity() {
        let command = SessionDeleteRequest::decode_semantics(request())
            .unwrap()
            .into_command()
            .unwrap();

        assert_eq!(command.agent_id, "main");
        assert_eq!(command.session_key, "agent:main:session-1");
    }

    #[test]
    fn rejects_bare_keys_unknown_fields_and_identity_mismatches() {
        for value in [
            {
                let mut value = request();
                value["input"] = json!({ "sessionKey": "agent:main:session-1" });
                value
            },
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
                value["input"]["extra"] = json!("private");
                value
            },
        ] {
            assert_eq!(
                SessionDeleteRequest::decode_semantics(value)
                    .and_then(SessionDeleteRequest::into_command),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn serializes_only_the_fixed_outcomes() {
        for (outcome, expected) in [
            (SessionDeleteOutcome::Succeeded, "succeeded"),
            (SessionDeleteOutcome::TargetRejected, "target_rejected"),
            (SessionDeleteOutcome::Unknown, "unknown"),
        ] {
            assert_eq!(
                SessionDeleteDelivery::Outcome(outcome).body(),
                json!({ "outcome": expected })
            );
        }
        assert_eq!(
            SessionDeleteDelivery::Unavailable.body(),
            json!({ "success": false, "error": "Session delete is unavailable" })
        );
    }
}
