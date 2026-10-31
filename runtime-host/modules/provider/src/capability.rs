use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![routing_descriptor(), media_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "provider.routing" => routing_descriptor(),
        "provider.media" => media_descriptor(),
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

fn media_descriptor() -> Value {
    json!({
        "id": "provider.media",
        "kind": "provider-media",
        "scopeKind": "provider-media",
        "scope": { "kind": "provider-media" },
        "targetKinds": ["provider-media"],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("providerMedia.generate", "Generate media", "provider-media"),
            operation("providerMedia.list", "List media models", "provider-media"),
            operation("providerMedia.submitVideo", "Submit video", "provider-media"),
            operation("providerMedia.queryVideo", "Query video", "provider-media"),
            operation("providerMedia.collectVideo", "Collect video", "provider-media"),
        ],
        "policyScope": "provider.media",
        "ownerModuleId": "provider",
        "routeOwnerId": "runtime-host",
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
