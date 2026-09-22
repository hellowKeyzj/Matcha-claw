use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![integration_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "integration.channel" => integration_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn integration_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "integration.channel",
        "kind": "integration-channel",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(identity),
        "targetKinds": ["channel", "channel-account", "channel-config", "channel-credentials", "channel-login", "channel-pairing", "channel-status", "channel-snapshot"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("channels.catalog.read", "Read channel catalog", "channel"),
            operation("channels.configure", "Configure channel account", "channel-config"),
            operation("channels.config.read", "Read channel configuration", "channel-config"),
            operation("channels.credentials.validate", "Validate channel credentials", "channel-credentials"),
            operation("channels.config.delete", "Delete channel configuration", "channel-config"),
            operation("channels.runtime.control", "Control channel account", "channel-account"),
            operation("channels.login", "Start channel login", "channel-login"),
            operation("channels.pairing.list", "List channel pairings", "channel-pairing"),
            operation("channels.pairing.approve", "Approve channel pairing", "channel-pairing"),
            operation("channels.status.read", "Read channel account status", "channel-status"),
            operation("channels.snapshot.read", "Read channel snapshot", "channel-snapshot"),
        ],
        "policyScope": "integration.channel",
        "ownerModuleId": "integration",
        "routeOwnerId": "openclaw",
    })
}

fn native_runtime_instance_scope(identity: runtime_directory::RuntimeDriverIdentity) -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": identity.runtime_adapter_id(),
            "runtimeInstanceId": identity.runtime_instance_id(),
        },
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
