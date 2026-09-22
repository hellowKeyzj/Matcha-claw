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
        ("session.prompt", Some("agent")) => Some(prompt_agent_descriptor(scope.clone())),
        ("session.prompt", Some("session")) => Some(prompt_session_descriptor(scope.clone())),
        ("session.management", Some("runtime-instance")) => {
            Some(management_runtime_descriptor(scope.clone()))
        }
        ("session.management", Some("session")) => {
            Some(management_session_descriptor(scope.clone()))
        }
        ("session.approval", Some("session")) => Some(approval_descriptor(scope.clone())),
        ("session.modelSelection", Some("session")) => {
            Some(model_selection_descriptor(scope.clone()))
        }
        _ => None,
    }
}

pub fn prompt_agent_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.prompt",
        "session",
        scope,
        vec![operation("sessions.create", "Create session", "agent")],
    )
}

pub fn prompt_session_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.prompt",
        "session",
        scope,
        vec![
            operation("sessions.prompt", "Prompt session", "session"),
            operation(
                "sessions.sendWithMedia",
                "Send session prompt with media",
                "session",
            ),
            operation("sessions.abort", "Abort session", "session"),
            operation("sessions.load", "Load session", "session"),
        ],
    )
}

pub fn management_runtime_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.management",
        "session-management",
        scope,
        vec![operation(
            "sessions.list",
            "List sessions",
            "runtime-endpoint",
        )],
    )
}

pub fn management_session_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.management",
        "session-management",
        scope,
        vec![
            operation("sessions.window", "Get session window", "session"),
            operation("sessions.content.load", "Load session content", "session"),
            operation("sessions.delete", "Delete session", "session"),
            operation("sessions.rename", "Rename session", "session"),
            operation("sessions.archive", "Archive session", "session"),
            operation("sessions.unarchive", "Unarchive session", "session"),
            operation("sessions.updateStatus", "Update session status", "session"),
            operation("sessions.switch", "Switch session", "session"),
            operation("sessions.resume", "Resume session", "session"),
            operation("sessions.state", "Get session state", "session"),
            operation("sessions.load", "Load session", "session"),
        ],
    )
}

pub fn approval_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.approval",
        "session-approval",
        scope,
        vec![
            operation("approvals.list", "List approvals", "session"),
            operation("approvals.resolve", "Resolve approval", "approval"),
        ],
    )
}

pub fn model_selection_descriptor(scope: Value) -> Value {
    scoped_descriptor(
        "session.modelSelection",
        "session-model-selection",
        scope,
        vec![operation(
            "sessions.patchModel",
            "Patch session model",
            "model-selection",
        )],
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
    match (id, scope.get("kind").and_then(Value::as_str)?) {
        ("session.prompt" | "session.approval" | "session.modelSelection", "agent" | "session")
        | ("session.management", "session") => {
            runtime_identity_for_endpoint(scope.get("identity")?.get("endpoint")?)
        }
        ("session.management", "runtime-instance") => {
            runtime_identity_for_endpoint(scope.get("endpoint")?)
        }
        _ => None,
    }
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
