use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![integration_descriptor(), matcha_descriptor()]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    if id != "integration.channel" {
        return None;
    }
    listed()
        .into_iter()
        .find(|descriptor| descriptor.get("scope") == Some(scope))
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

fn matcha_descriptor() -> Value {
    json!({
        "id":"integration.channel", "kind":"integration-channel", "scopeKind":"runtime-instance",
        "scope":{"kind":"runtime-instance","endpoint":{"kind":"native-runtime","runtimeAdapterId":"matcha-agent","runtimeInstanceId":"local"}},
        "runtimeAdapterId":"matcha-agent", "runtimeInstanceId":"local",
        "targetKinds":["channel","channel-account","channel-config","channel-login","channel-pairing","channel-status","channel-snapshot"],
        "supportLevel":"native", "availability":"available", "supportedChannels":["weixin"],
        "operations":[
            operation("channels.catalog.read", "Read native WeChat binding catalog", "channel"),
            operation("channels.configure", "Configure Agent/session binding for next launch", "channel-config"),
            operation("channels.config.read", "Read channel binding", "channel-config"),
            operation("channels.config.delete", "Close consumer, clear native account and delete binding", "channel-config"),
            {"id":"channels.runtime.control","title":"Disconnect bound session consumer","targetKind":"channel-account","targetRequired":true,"actions":["disconnect"],"unsupportedActions":["connect"]},
            {"id":"channels.login","title":"Native WeChat login","targetKind":"channel-login","targetRequired":true,"actions":["start","wait","cancel","logout"],"qrRefreshObservable":false},
            operation("channels.pairing.approve", "Approve native WeChat pairing code", "channel-pairing"),
            operation("channels.status.read", "Read consumer observations; account health unknown", "channel-status"),
            operation("channels.snapshot.read", "Read configured binding and consumer snapshot", "channel-snapshot")
        ],
        "unsupportedOperations":["channels.credentials.validate","channels.pairing.list"],
        "policyScope":"integration.channel", "ownerModuleId":"integration", "routeOwnerId":"matcha-agent"
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
