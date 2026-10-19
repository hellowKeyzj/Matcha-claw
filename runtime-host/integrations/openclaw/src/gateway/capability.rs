use platform::module::CapabilityDescriptorProvider;
use serde_json::{Value, json};

pub const DESCRIPTOR_PROVIDER: CapabilityDescriptorProvider =
    CapabilityDescriptorProvider::new(listed_descriptors, describe_descriptor);

pub fn listed_descriptors() -> Vec<Value> {
    vec![browser_descriptor(), mcp_app_descriptor(), canvas_descriptor(), progress_card_descriptor(), question_descriptor()]
}

pub fn describe_descriptor(id: &str, scope: &Value) -> Option<Value> {
    if scope != &native_runtime_instance_scope() {
        return None;
    }
    match id {
        "openclaw.browser" => Some(browser_descriptor()),
        "openclaw.mcpApp" => Some(mcp_app_descriptor()),
        "openclaw.canvas" => Some(canvas_descriptor()),
        "openclaw.progress" => Some(progress_card_descriptor()),
        "openclaw.question" => Some(question_descriptor()),
        _ => None,
    }
}

pub fn browser_descriptor() -> Value {
    json!({
        "id": "openclaw.browser",
        "kind": "openclaw-browser",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("browser.request", "Request Browser runtime", "none"),
        ],
        "policyScope": "openclaw.browser",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

pub fn mcp_app_descriptor() -> Value {
    json!({
        "id": "openclaw.mcpApp",
        "kind": "openclaw-mcp-app",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("mcp.app.view", "View MCP app", "none"),
            operation("mcp.app.callTool", "Call MCP app tool", "none"),
            operation("mcp.app.listTools", "List MCP app tools", "none"),
            operation("mcp.app.listResources", "List MCP app resources", "none"),
            operation("mcp.app.listResourceTemplates", "List MCP app resource templates", "none"),
            operation("mcp.app.readResource", "Read MCP app resource", "none"),
            operation("mcp.app.updateModelContext", "Update MCP app model context", "none"),
        ],
        "policyScope": "openclaw.mcpApp",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

pub fn canvas_descriptor() -> Value {
    json!({
        "id": "openclaw.canvas",
        "kind": "openclaw-canvas",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [operation("canvas.document.view", "View Canvas document", "none")],
        "policyScope": "openclaw.canvas",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

pub fn progress_card_descriptor() -> Value {
    json!({
        "id": "openclaw.progress",
        "kind": "openclaw-progress",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [operation("progressCard.get", "Read session progress card", "none")],
        "policyScope": "openclaw.progress",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

pub fn question_descriptor() -> Value {
    json!({
        "id": "openclaw.question",
        "kind": "openclaw-question",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("question.list", "List pending OpenClaw questions", "none"),
            operation("question.resolve", "Resolve OpenClaw question", "none"),
        ],
        "policyScope": "openclaw.question",
        "ownerModuleId": "openclaw-gateway",
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

fn native_runtime_instance_scope() -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": "openclaw",
            "runtimeInstanceId": "local",
        },
    })
}
