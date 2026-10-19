use serde_json::{Value, json};

use crate::model::BoardMethod;

pub fn listed() -> Vec<Value> {
    Vec::new()
}

pub fn describe(id: &str, scope: &Value) -> Option<Value> {
    if id != "board.runtime" || scope.get("kind")?.as_str()? != "session" {
        return None;
    }
    let object = scope.as_object()?;
    if object.len() != 2 {
        return None;
    }
    let identity = crate::adapters::loopback::decode_identity(scope.get("identity")?.clone())?;
    Some(json!({
        "id": "board.runtime",
        "kind": "board-runtime",
        "scopeKind": "session",
        "scope": scope,
        "targetKinds": ["session"],
        "runtimeAdapterId": identity.endpoint().runtime_adapter_id(),
        "runtimeInstanceId": identity.endpoint().runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": BoardMethod::ALL.map(|method| json!({
            "id": method.as_str(),
            "title": method.as_str(),
            "targetKind": "session",
            "targetRequired": true,
        })),
        "policyScope": "board.runtime",
        "ownerModuleId": "board",
        "routeOwnerId": "board",
    }))
}
