use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![runtime_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "plugin.runtime" => runtime_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn runtime_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "plugin.runtime",
        "kind": "plugin-runtime",
        "scopeKind": "runtime-instance",
        "scope": {
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        },
        "targetKinds": ["plugin"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("plugins.setEnabled", "Set runtime plugin enabled state", "plugin"),
        ],
        "policyScope": "plugin.runtime",
        "ownerModuleId": "plugins",
        "routeOwnerId": "openclaw",
    })
}

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}
