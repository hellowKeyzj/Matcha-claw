use serde_json::{Value, json};

use crate::Directory;

pub enum Delivery {
    Ok(Directory),
}

impl Delivery {
    pub fn body(&self) -> Value {
        match self {
            Self::Ok(directory) => project_directory(directory),
        }
    }
}

fn project_directory(directory: &Directory) -> Value {
    json!({
        "endpoints": directory.endpoints().iter().map(project_endpoint).collect::<Vec<_>>(),
    })
}

fn project_endpoint(endpoint: &crate::Endpoint) -> Value {
    json!({
        "id": endpoint.id(),
        "protocolId": endpoint.protocol_id(),
        "runtimeAdapterId": endpoint.runtime_adapter_id(),
        "runtimeInstanceId": endpoint.runtime_instance_id(),
        "endpointRef": project_endpoint_ref(endpoint.endpoint_ref()),
        "source": project_source(endpoint.source()),
        "location": { "kind": endpoint.location().kind() },
        "lifecycle": project_lifecycle(endpoint.lifecycle()),
        "displayName": endpoint.display_name(),
        "agentIds": endpoint.agent_ids(),
        "defaultAgentId": endpoint.default_agent_id(),
        "agents": endpoint.agents().iter().map(project_agent).collect::<Vec<_>>(),
        "acceptsDynamicAgents": endpoint.accepts_dynamic_agents(),
        "capabilities": project_capabilities(endpoint.capabilities()),
        "capabilityFamilies": endpoint
            .capability_families()
            .iter()
            .map(project_capability_family)
            .collect::<Vec<_>>(),
        "controlState": project_control_state(endpoint.control_state()),
    })
}

fn project_endpoint_ref(endpoint_ref: &crate::NativeEndpointRef) -> Value {
    json!({
        "kind": endpoint_ref.kind(),
        "runtimeAdapterId": endpoint_ref.runtime_adapter_id(),
        "runtimeInstanceId": endpoint_ref.runtime_instance_id(),
    })
}

fn project_source(source: &crate::Source) -> Value {
    json!({
        "kind": source.kind(),
        "runtimeAdapterId": source.runtime_adapter_id(),
        "runtimeInstanceId": source.runtime_instance_id(),
    })
}

fn project_lifecycle(lifecycle: &crate::Lifecycle) -> Value {
    json!({
        "phase": lifecycle.phase(),
        "connected": lifecycle.connected(),
        "ready": lifecycle.is_ready(),
        "updatedAt": lifecycle.updated_at(),
    })
}

fn project_agent(agent: &crate::Agent) -> Value {
    json!({
        "agentId": agent.agent_id(),
        "source": agent.source(),
        "capabilities": project_capabilities(agent.capabilities()),
    })
}

fn project_capabilities(capabilities: &crate::Capabilities) -> Value {
    json!({
        "chat": capabilities.chat(),
        "streaming": capabilities.streaming(),
        "tools": capabilities.tools(),
        "approvals": capabilities.approvals(),
        "replay": capabilities.replay(),
        "modelSelection": capabilities.model_selection(),
        "supportsGoal": capabilities.supports_goal(),
    })
}

fn project_capability_family(family: &crate::CapabilityFamily) -> Value {
    json!({
        "family": family.family(),
        "availability": family.availability(),
    })
}

fn project_control_state(control_state: &crate::ControlState) -> Value {
    json!({
        "connection": control_state.connection(),
        "readiness": control_state.readiness().map(project_readiness),
        "capabilities": control_state.capabilities(),
        "updatedAt": control_state.updated_at(),
    })
}

fn project_readiness(readiness: &crate::Readiness) -> Value {
    json!({
        "ready": readiness.ready(),
        "phase": readiness.phase(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::RuntimeLifecycle;

    #[test]
    fn delivery_projects_runtime_endpoint_directory_with_explicit_public_allowlist() {
        let body = Delivery::Ok(Directory::from_lifecycles(
            RuntimeLifecycle::Running,
            RuntimeLifecycle::Running,
        ))
        .body();

        assert_eq!(
            body,
            json!({
                "endpoints": [
                    {
                        "id": "openclaw-local",
                        "protocolId": "openclaw-v4",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "local",
                        "endpointRef": { "kind": "native-runtime", "runtimeAdapterId": "openclaw", "runtimeInstanceId": "local" },
                        "source": { "kind": "runtime-adapter", "runtimeAdapterId": "openclaw", "runtimeInstanceId": "local" },
                        "location": { "kind": "local" },
                        "lifecycle": { "phase": "ready", "connected": true, "ready": true, "updatedAt": null },
                        "displayName": "OpenClaw",
                        "agentIds": ["main"],
                        "defaultAgentId": "main",
                        "agents": [{ "agentId": "main", "source": "discovered", "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true, "supportsGoal": false } }],
                        "acceptsDynamicAgents": true,
                        "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true, "supportsGoal": false },
                        "capabilityFamilies": [
                            { "family": "session", "availability": "supported" },
                            { "family": "task", "availability": "supported" },
                            { "family": "subagent", "availability": "supported" },
                            { "family": "team", "availability": "supported" },
                            { "family": "cron", "availability": "supported" },
                            { "family": "workspace", "availability": "supported" },
                            { "family": "skill", "availability": "supported" },
                            { "family": "channel", "availability": "supported" },
                            { "family": "lifecycle", "availability": "supported" }
                        ],
                        "controlState": { "connection": null, "readiness": { "ready": true, "phase": "ready" }, "capabilities": null, "updatedAt": null }
                    },
                    {
                        "id": "matcha-agent-local",
                        "protocolId": "matcha-agent-app-server",
                        "runtimeAdapterId": "matcha-agent",
                        "runtimeInstanceId": "local",
                        "endpointRef": { "kind": "native-runtime", "runtimeAdapterId": "matcha-agent", "runtimeInstanceId": "local" },
                        "source": { "kind": "runtime-adapter", "runtimeAdapterId": "matcha-agent", "runtimeInstanceId": "local" },
                        "location": { "kind": "local" },
                        "lifecycle": { "phase": "ready", "connected": true, "ready": true, "updatedAt": null },
                        "displayName": "Matcha Agent",
                        "agentIds": ["matcha"],
                        "defaultAgentId": "matcha",
                        "agents": [{ "agentId": "matcha", "source": "discovered", "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true, "supportsGoal": false } }],
                        "acceptsDynamicAgents": true,
                        "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true, "supportsGoal": false },
                        "capabilityFamilies": [
                            { "family": "session", "availability": "supported" },
                            { "family": "task", "availability": "unsupported" },
                            { "family": "subagent", "availability": "unsupported" },
                            { "family": "team", "availability": "supported" },
                            { "family": "cron", "availability": "unsupported" },
                            { "family": "workspace", "availability": "unsupported" },
                            { "family": "skill", "availability": "unsupported" },
                            { "family": "channel", "availability": "unsupported" },
                            { "family": "lifecycle", "availability": "supported" }
                        ],
                        "controlState": { "connection": null, "readiness": { "ready": true, "phase": "ready" }, "capabilities": null, "updatedAt": null }
                    }
                ]
            })
        );

        let rendered = body.to_string();
        for private in ["pid", "failure", "startupDiagnostic", "UnexpectedExit"] {
            assert!(!rendered.contains(private));
        }
    }
}
