use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::session_permission::{
        NativeEndpoint, SessionPermissionAction, SessionPermissionCommand, SessionPermissionMode,
        SessionPermissionOutcome,
    },
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "session.management";
const OPERATION_GET: &str = "sessions.permission.get";
const OPERATION_SET: &str = "sessions.permission.set";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/permission";
const AUTHORIZATION_SCOPE_READ: &str = "sessions:read";
const AUTHORIZATION_SCOPE_WRITE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-permission";
const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_AGENT_ID_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operation {
    Get,
    Set,
}

impl Operation {
    const fn authorization_scope(self) -> &'static str {
        match self {
            Self::Get => AUTHORIZATION_SCOPE_READ,
            Self::Set => AUTHORIZATION_SCOPE_WRITE,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionPermissionRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Value,
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

struct ParsedInput {
    session_key: String,
    session_identity: SessionIdentity,
    action: SessionPermissionAction,
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

impl SessionIdentity {
    fn valid(&self) -> bool {
        self.endpoint.parse().is_some()
            && valid_identity(&self.agent_id, MAX_AGENT_ID_BYTES)
            && valid_identity(&self.session_key, MAX_SESSION_KEY_BYTES)
    }
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

impl SessionPermissionRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        let operation = operation_from_value(&value).ok_or(DecodeError::Invalid)?;
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                operation.authorization_scope(),
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

    fn operation(&self) -> Result<Operation, RequestError> {
        match self.operation_id.as_str() {
            OPERATION_GET => Ok(Operation::Get),
            OPERATION_SET => Ok(Operation::Set),
            _ => Err(RequestError::Invalid),
        }
    }

    fn input(&self) -> Result<ParsedInput, RequestError> {
        let operation = self.operation()?;
        let object = self.input.as_object().ok_or(RequestError::Invalid)?;
        let expected_keys = match operation {
            Operation::Get => &["sessionKey", "sessionIdentity"][..],
            Operation::Set => &["sessionKey", "sessionIdentity", "permissionMode"][..],
        };
        if object.len() != expected_keys.len()
            || !expected_keys.iter().all(|key| object.contains_key(*key))
        {
            return Err(RequestError::Invalid);
        }
        let session_key = object
            .get("sessionKey")
            .and_then(Value::as_str)
            .ok_or(RequestError::Invalid)?
            .to_owned();
        let session_identity = serde_json::from_value::<SessionIdentity>(
            object
                .get("sessionIdentity")
                .ok_or(RequestError::Invalid)?
                .clone(),
        )
        .map_err(|_| RequestError::Invalid)?;
        let action = match operation {
            Operation::Get => SessionPermissionAction::Get,
            Operation::Set => {
                let permission_mode = match object.get("permissionMode") {
                    Some(Value::Null) => None,
                    Some(value) => Some(
                        serde_json::from_value::<SessionPermissionMode>(value.clone())
                            .map_err(|_| RequestError::Invalid)?,
                    ),
                    None => return Err(RequestError::Invalid),
                };
                SessionPermissionAction::Set { permission_mode }
            }
        };
        Ok(ParsedInput {
            session_key,
            session_identity,
            action,
        })
    }

    fn validate(&self) -> Result<(), RequestError> {
        let input = self.input()?;
        (self.id == CAPABILITY_ID
            && self.operation().is_ok()
            && self.scope.kind == "session"
            && self.target.kind == "session"
            && self.scope.identity.valid()
            && self.scope.identity == self.target.identity
            && self.scope.identity == input.session_identity
            && self.scope.identity.session_key == input.session_key)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<SessionPermissionCommand, RequestError> {
        let input = self.input()?;
        SessionPermissionCommand::try_new(
            self.scope
                .identity
                .endpoint
                .parse()
                .ok_or(RequestError::Invalid)?,
            self.scope.identity.agent_id,
            input.session_key,
            input.action,
        )
        .map_err(|_| RequestError::Invalid)
    }
}

fn operation_from_value(value: &Value) -> Option<Operation> {
    match value.get("operationId").and_then(Value::as_str)? {
        OPERATION_GET => Some(Operation::Get),
        OPERATION_SET => Some(Operation::Set),
        _ => None,
    }
}

pub(crate) enum SessionPermissionDelivery {
    Outcome(SessionPermissionOutcome),
    Unavailable,
}

impl From<SessionPermissionOutcome> for SessionPermissionDelivery {
    fn from(outcome: SessionPermissionOutcome) -> Self {
        match outcome {
            SessionPermissionOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SessionPermissionDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(SessionPermissionOutcome::Projection(projection)) => {
                serde_json::to_value(projection)
                    .expect("Session permission public response is serializable")
            }
            Self::Outcome(SessionPermissionOutcome::Unavailable) | Self::Unavailable => {
                serde_json::json!({
                    "success": false,
                    "error": "Session permission is unavailable",
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn identity(adapter: &str) -> Value {
        json!({
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": adapter,
                "runtimeInstanceId": "local",
            },
            "agentId": "main",
            "sessionKey": "agent:main:demo",
        })
    }

    fn request(operation_id: &str, input: Value) -> Value {
        json!({
            "id": "session.management",
            "operationId": operation_id,
            "scope": { "kind": "session", "identity": identity("openclaw") },
            "target": { "kind": "session", "identity": identity("openclaw") },
            "input": input,
        })
    }

    fn get_request() -> Value {
        request(
            "sessions.permission.get",
            json!({
                "sessionKey": "agent:main:demo",
                "sessionIdentity": identity("openclaw"),
            }),
        )
    }

    fn set_request(permission_mode: Value) -> Value {
        request(
            "sessions.permission.set",
            json!({
                "sessionKey": "agent:main:demo",
                "sessionIdentity": identity("openclaw"),
                "permissionMode": permission_mode,
            }),
        )
    }

    #[test]
    fn accepts_get_without_permission_mode_and_set_with_null() {
        let get = SessionPermissionRequest::decode_semantics(get_request())
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(get.action(), SessionPermissionAction::Get);

        let set = SessionPermissionRequest::decode_semantics(set_request(json!(null)))
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(
            set.action(),
            SessionPermissionAction::Set {
                permission_mode: None,
            }
        );
    }

    #[test]
    fn accepts_openclaw_modes_and_unsupported_runtime_identity() {
        let set = SessionPermissionRequest::decode_semantics(set_request(json!("workspace")))
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(
            set.action(),
            SessionPermissionAction::Set {
                permission_mode: Some(SessionPermissionMode::Workspace),
            }
        );

        let mut value = get_request();
        value["scope"]["identity"] = identity("other-runtime");
        value["target"]["identity"] = identity("other-runtime");
        value["input"]["sessionIdentity"] = identity("other-runtime");
        let command = SessionPermissionRequest::decode_semantics(value)
            .unwrap()
            .into_command()
            .unwrap();
        assert_eq!(command.endpoint, NativeEndpoint::Unsupported);
    }

    #[test]
    fn rejects_identity_mismatch_and_operation_field_drift() {
        for value in [
            {
                let mut value = get_request();
                value["target"]["identity"]["sessionKey"] = json!("agent:main:other");
                value
            },
            {
                let mut value = get_request();
                value["input"]["sessionKey"] = json!("agent:main:other");
                value
            },
            {
                let mut value = get_request();
                value["input"]["permissionMode"] = json!(null);
                value
            },
            {
                let mut value = set_request(json!(null));
                value["input"]
                    .as_object_mut()
                    .unwrap()
                    .remove("permissionMode");
                value
            },
            set_request(json!("default")),
        ] {
            assert_eq!(
                SessionPermissionRequest::decode_semantics(value).map(|_| ()),
                Err(RequestError::Invalid)
            );
        }
    }
}
