use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![routing_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "provider.routing" => routing_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn routing_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "provider.routing",
        "kind": "provider-routing",
        "scopeKind": "provider-routing",
        "scope": { "kind": "provider-routing" },
        "targetKinds": ["provider-routing"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("providerRouting.list", "List provider routing", "provider-routing"),
            operation("providerRouting.replace", "Replace provider routing", "provider-routing"),
        ],
        "policyScope": "provider.routing",
        "ownerModuleId": "environment",
        "routeOwnerId": "provider-routing",
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
