use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity},
    loopback::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    api::SecurityHandle,
    native_policy::{Operation, PolicyTarget},
};

pub(super) const ENDPOINT: &str = "/api/security/native-policy";
pub(super) const RESULT_ENDPOINT: &str = "/api/security/native-policy/result";
const SCOPE: &str = "security:native-policy";
const SUBJECT: &str = "native-policy";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    id: String,
    operation_id: String,
    scope: AgentScope,
    target: Target,
    input: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentScope {
    kind: String,
    endpoint: Endpoint,
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn into_endpoint(self) -> Option<RuntimeEndpoint> {
        (self.kind == "native-runtime")
            .then(|| {
                RuntimeEndpoint::try_new(self.runtime_adapter_id, self.runtime_instance_id).ok()
            })
            .flatten()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    endpoint: Endpoint,
    agent_id: String,
    session_key: String,
}

impl Identity {
    fn into_identity(self) -> Option<SessionIdentity> {
        SessionIdentity::try_new(
            self.endpoint.into_endpoint()?,
            self.agent_id,
            self.session_key,
        )
        .ok()
    }
}

pub(super) async fn handle(
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> Response {
    let Some(token) = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
    else {
        return Response::error(401, "Native policy authorization is invalid");
    };
    let Ok(envelope) = serde_json::from_slice::<Envelope>(body) else {
        return invalid();
    };
    if envelope.id != "security.nativePolicy"
        || envelope.scope.kind != "agent"
        || envelope.target.kind != "native-policy"
        || !matches!(
            envelope.operation_id.as_str(),
            "nativePermissions.get"
                | "nativePermissions.set"
                | "nativeHooks.get"
                | "nativeHooks.set"
                | "nativeSandbox.status"
                | "nativeSandbox.set"
                | "nativePolicy.result"
        )
        || (path == RESULT_ENDPOINT) != (envelope.operation_id == "nativePolicy.result")
    {
        return invalid();
    }
    let Some(endpoint) = envelope.scope.endpoint.into_endpoint() else {
        return invalid();
    };
    let Some(mut input) = envelope.input.as_object().cloned() else {
        return invalid();
    };
    let session_identity = match input.remove("sessionIdentity") {
        Some(identity) => match serde_json::from_value::<Identity>(identity)
            .ok()
            .and_then(Identity::into_identity)
        {
            Some(identity) => Some(identity),
            None => return invalid(),
        },
        None => None,
    };
    let target = PolicyTarget {
        endpoint,
        agent_id: envelope.scope.agent_id,
        session_identity,
    };
    if !target.is_valid() {
        return invalid();
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(u128::from(u64::MAX)) as u64);
    let decision =
        match verifier
            .lock()
            .await
            .verify(token, now, path, SCOPE, &envelope.operation_id, SUBJECT)
        {
            Ok(decision) => decision,
            Err(_) => return Response::error(401, "Native policy authorization is invalid"),
        };
    if path == RESULT_ENDPOINT {
        if input.len() != 1 {
            return invalid();
        }
        let Some(call_id) = input
            .remove("callId")
            .and_then(|value| serde_json::from_value(value).ok())
        else {
            return invalid();
        };
        return match security
            .native_policy_result(target, decision.principal().into(), call_id)
            .await
        {
            Ok(Some(result)) => outcome(result),
            Ok(None) => Response::error(404, "Native policy result is not available"),
            Err(_) => Response::error(503, "Native policy is unavailable"),
        };
    }
    let operation = match operation(&envelope.operation_id, input) {
        Some(operation) => operation,
        None => return invalid(),
    };
    if operation.is_mutation() {
        match security
            .native_policy_set(target, decision.principal().into(), operation)
            .await
        {
            Ok(receipt) => Response::json(202, json!(receipt)),
            Err(error) => outcome(json!(error)),
        }
    } else {
        match security.native_policy_get(target, operation).await {
            Ok(result) => outcome(result),
            Err(_) => Response::error(503, "Native policy is unavailable"),
        }
    }
}

fn operation(name: &str, mut input: serde_json::Map<String, Value>) -> Option<Operation> {
    if matches!(
        name,
        "nativePermissions.get" | "nativeHooks.get" | "nativeSandbox.status"
    ) {
        if !input.is_empty() {
            return None;
        }
        return Some(match name {
            "nativePermissions.get" => Operation::PermissionsGet,
            "nativeHooks.get" => Operation::HooksGet,
            _ => Operation::SandboxStatus,
        });
    }
    if input.len() != 1 {
        return None;
    }
    let field = match name {
        "nativePermissions.set" => "permissions",
        "nativeHooks.set" => "hooks",
        "nativeSandbox.set" => "sandbox",
        _ => return None,
    };
    let patch = input.remove(field)?;
    if !patch.as_object().is_some_and(|fields| !fields.is_empty()) || has_null(&patch) {
        return None;
    }
    Some(match name {
        "nativePermissions.set" => Operation::PermissionsSet(serde_json::from_value(patch).ok()?),
        "nativeHooks.set" => Operation::HooksSet(serde_json::from_value(patch).ok()?),
        _ => Operation::SandboxSet(serde_json::from_value(patch).ok()?),
    })
}

fn has_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(fields) => fields.values().any(has_null),
        Value::Array(values) => values.iter().any(has_null),
        _ => false,
    }
}

fn invalid() -> Response {
    Response::error(400, "Native policy request is invalid")
}

fn outcome(result: Value) -> Response {
    let status = match result.get("outcome").and_then(Value::as_str) {
        Some("available" | "confirmed") => 200,
        Some("rejected") => 422,
        Some("unsupported") => 501,
        _ => 503,
    };
    Response::json(status, result)
}
