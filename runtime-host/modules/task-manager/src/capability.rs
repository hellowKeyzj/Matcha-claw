use serde_json::{Value, json};

pub fn listed() -> Vec<Value> {
    Vec::new()
}

pub fn describe(id: &str, scope: &Value) -> Option<Value> {
    if id != "task.management" || scope.get("kind").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let identity = runtime_identity_for_scope(scope)?;
    runtime_directory::RuntimeCapabilitySurface::for_identity(identity)
        .supports(runtime_directory::RuntimeCapabilityFamily::Task)
        .then(|| management_descriptor(scope.clone(), identity))
}

pub fn management_descriptor(
    scope: Value,
    identity: runtime_directory::RuntimeDriverIdentity,
) -> Value {
    json!({
        "id": "task.management",
        "kind": "task-management",
        "scopeKind": "session",
        "scope": scope,
        "targetKinds": ["task-manager"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("tasks.list", "List tasks", "task-manager"),
            operation("tasks.get", "Get task", "task-manager"),
            operation("tasks.create", "Create task", "task-manager"),
            operation("tasks.update", "Update task", "task-manager"),
            operation("todos.get", "Get todos", "task-manager"),
            operation("todos.write", "Write todos", "task-manager"),
        ],
        "policyScope": "task.management",
        "ownerModuleId": "task-management",
        "routeOwnerId": identity.runtime_adapter_id(),
    })
}

fn runtime_identity_for_scope(scope: &Value) -> Option<runtime_directory::RuntimeDriverIdentity> {
    if scope.get("kind").and_then(Value::as_str)? != "session" {
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

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}
