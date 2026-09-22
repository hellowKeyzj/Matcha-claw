use serde_json::{Value, json};

pub fn listed() -> Vec<Value> {
    Vec::new()
}

pub fn describe(id: &str, scope: &Value) -> Option<Value> {
    let identity = runtime_identity_for_scope(id, scope)?;
    if !runtime_directory::RuntimeCapabilitySurface::for_identity(identity)
        .supports(runtime_directory::RuntimeCapabilityFamily::Session)
    {
        return None;
    }
    match (id, scope.get("kind").and_then(Value::as_str)) {
        ("tool.invoke", Some("session")) => Some(tool_invoke_descriptor(scope.clone())),
        _ => None,
    }
}

pub fn tool_invoke_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "tool.invoke",
        "tool",
        scope,
        vec![operation("tools.invoke", "Invoke tool", "tool")],
    )
}

fn scoped_descriptor(id: &str, kind: &str, scope: Value, operations: Vec<Value>) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "scopeKind": scope.get("kind").and_then(Value::as_str).unwrap_or("unknown"),
        "scope": scope,
        "targetKinds": target_kinds(&operations),
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": operations,
        "policyScope": id,
        "ownerModuleId": kind,
        "routeOwnerId": "openclaw",
    })
}

fn runtime_identity_for_scope(
    id: &str,
    scope: &Value,
) -> Option<runtime_directory::RuntimeDriverIdentity> {
    if id != "tool.invoke" || scope.get("kind").and_then(Value::as_str)? != "session" {
        return None;
    }
    runtime_identity_for_endpoint(scope.get("identity")?.get("endpoint")?)
}

fn runtime_identity_for_endpoint(
    endpoint: &Value,
) -> Option<runtime_directory::RuntimeDriverIdentity> {
    let object = endpoint.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "native-runtime" {
        return None;
    }
    let adapter = object.get("runtimeAdapterId").and_then(Value::as_str)?;
    let instance = object.get("runtimeInstanceId").and_then(Value::as_str)?;
    for identity in [
        runtime_directory::RuntimeDriverIdentity::open_claw(),
        runtime_directory::RuntimeDriverIdentity::matcha_agent(),
    ] {
        if adapter == identity.runtime_adapter_id() && instance == identity.runtime_instance_id() {
            return Some(identity);
        }
    }
    None
}

fn target_kinds(operations: &[Value]) -> Vec<&str> {
    let mut kinds = operations
        .iter()
        .filter_map(|operation| operation.get("targetKind").and_then(Value::as_str))
        .collect::<Vec<_>>();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}
