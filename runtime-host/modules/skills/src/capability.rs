use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![management_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "skill.management" => management_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn management_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "skill.management",
        "kind": "skill-management",
        "scopeKind": "runtime-instance",
        "scope": {
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        },
        "targetKinds": ["none", "skill", "skill-bundle"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("skills.refreshStatus", "Refresh skill status", "none"),
            operation("skills.updateConfig", "Update skill configuration", "skill"),
            operation("skills.updateState", "Update skill state", "skill"),
            operation("skills.updateBatchState", "Update skill state batch", "skill"),
            operation("skills.exportBundles", "Export skill bundles", "skill-bundle"),
            operation("skills.importBundles", "Import skill bundles", "skill-bundle"),
            operation("clawhub.openReadme", "Open skill readme", "skill"),
            operation("clawhub.openPath", "Open skill location", "skill"),
        ],
        "policyScope": "skill.management",
        "ownerModuleId": "skills",
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
