use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![scheduler_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "scheduler.cron" => scheduler_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn scheduler_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "scheduler.cron",
        "kind": "scheduler-cron",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(identity),
        "targetKinds": ["cron-job"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("cron.trigger", "Trigger cron job", "cron-job"),
            operation("cron.create", "Create cron job", "cron-job"),
            operation("cron.update", "Update cron job", "cron-job"),
            operation("cron.delete", "Delete cron job", "cron-job"),
            operation("cron.toggle", "Toggle cron job", "cron-job"),
        ],
        "policyScope": "scheduler.cron",
        "ownerModuleId": "scheduler",
        "routeOwnerId": "operations",
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
