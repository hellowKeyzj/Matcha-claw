use serde_json::{Value, json};

pub fn listed() -> Vec<serde_json::Value> {
    vec![
        management_descriptor(),
        skills_descriptor(),
        tools_descriptor(),
    ]
}

pub fn describe(id: &str, scope: &serde_json::Value) -> Option<serde_json::Value> {
    let descriptor = match id {
        "subagent.management" => management_descriptor(),
        "subagent.skills" => skills_descriptor(),
        "subagent.tools" => tools_descriptor(),
        _ => return None,
    };
    (descriptor.get("scope") == Some(scope)).then_some(descriptor)
}

pub fn skills_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "subagent.skills",
        "kind": "subagent-skills",
        "scopeKind": "agent",
        "scope": native_agent_scope(identity),
        "targetKinds": ["subagent"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "targetAgentIds": [identity.default_agent_id()],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagentSkills.get", "Get subagent skills", "subagent"),
            operation("subagentSkills.set", "Set subagent skills", "subagent"),
        ],
        "policyScope": "subagent.skills",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

pub fn tools_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "subagent.tools",
        "kind": "subagent-tools",
        "scopeKind": "agent",
        "scope": native_agent_scope(identity),
        "targetKinds": ["subagent"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "targetAgentIds": [identity.default_agent_id()],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagentTools.get", "Get subagent tools", "subagent"),
            operation("subagentTools.set", "Set subagent tools", "subagent"),
        ],
        "policyScope": "subagent.tools",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

pub fn management_descriptor() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "id": "subagent.management",
        "kind": "subagent-management",
        "scopeKind": "agent",
        "scope": native_agent_scope(identity),
        "targetKinds": ["agent", "subagent"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "targetAgentIds": [identity.default_agent_id()],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagents.list", "List subagents", "agent"),
            operation("subagents.displayConfig.get", "Get subagent display configuration", "agent"),
            operation("subagents.description.set", "Set subagent description", "subagent"),
            operation("subagents.model.set", "Set subagent model", "subagent"),
            operation("subagents.skills.set", "Set subagent skills", "subagent"),
            operation("subagents.create", "Create subagent", "subagent"),
            operation("subagents.update", "Update subagent", "subagent"),
            operation("subagents.delete", "Delete subagent", "subagent"),
            operation("subagents.files.get", "Get subagent file", "subagent"),
            operation("subagents.files.set", "Set subagent file", "subagent"),
            operation("subagents.files.list", "List subagent files", "subagent"),
        ],
        "policyScope": "subagent.management",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

fn native_agent_scope(identity: runtime_directory::RuntimeDriverIdentity) -> Value {
    json!({
        "kind": "agent",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": identity.runtime_adapter_id(),
            "runtimeInstanceId": identity.runtime_instance_id(),
        },
        "agentId": identity.default_agent_id(),
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
