use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::{
    runtime::peers::Directory, transport::common::authorization::CapabilityDecisionVerifier,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const AUTHORIZATION_ENDPOINT: &str = "/api/runtime-endpoints/list";
const AUTHORIZATION_SCOPE: &str = "runtime:endpoints:read";
const CAPABILITY_ID: &str = "runtime.endpoints.directory";
const AUTHORIZATION_SUBJECT: &str = "runtime-endpoint-directory";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
}

pub(crate) fn decode_authorization(
    headers: &[(String, String)],
    verifier: &mut CapabilityDecisionVerifier,
) -> Result<(), DecodeError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(DecodeError::Unauthorized)?;
    verifier
        .verify(
            authorization,
            now_millis(),
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            CAPABILITY_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    Ok(())
}

pub(crate) enum Delivery {
    Ok(Directory),
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
        }
    }

    pub(crate) fn body(&self) -> Value {
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

fn project_endpoint(endpoint: &crate::runtime::peers::Endpoint) -> Value {
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

fn project_endpoint_ref(endpoint_ref: &crate::runtime::peers::NativeEndpointRef) -> Value {
    json!({
        "kind": endpoint_ref.kind(),
        "runtimeAdapterId": endpoint_ref.runtime_adapter_id(),
        "runtimeInstanceId": endpoint_ref.runtime_instance_id(),
    })
}

fn project_source(source: &crate::runtime::peers::Source) -> Value {
    json!({
        "kind": source.kind(),
        "runtimeAdapterId": source.runtime_adapter_id(),
        "runtimeInstanceId": source.runtime_instance_id(),
    })
}

fn project_lifecycle(lifecycle: &crate::runtime::peers::Lifecycle) -> Value {
    json!({
        "phase": lifecycle.phase(),
        "connected": lifecycle.connected(),
        "ready": lifecycle.is_ready(),
        "updatedAt": lifecycle.updated_at(),
    })
}

fn project_agent(agent: &crate::runtime::peers::Agent) -> Value {
    json!({
        "agentId": agent.agent_id(),
        "source": agent.source(),
        "capabilities": project_capabilities(agent.capabilities()),
    })
}

fn project_capabilities(capabilities: &crate::runtime::peers::Capabilities) -> Value {
    json!({
        "chat": capabilities.chat(),
        "streaming": capabilities.streaming(),
        "tools": capabilities.tools(),
        "approvals": capabilities.approvals(),
        "replay": capabilities.replay(),
        "modelSelection": capabilities.model_selection(),
    })
}

fn project_capability_family(family: &crate::runtime::peers::CapabilityFamily) -> Value {
    json!({
        "family": family.family(),
        "availability": family.availability(),
    })
}

fn project_control_state(control_state: &crate::runtime::peers::ControlState) -> Value {
    json!({
        "connection": control_state.connection(),
        "readiness": control_state.readiness().map(project_readiness),
        "capabilities": control_state.capabilities(),
        "updatedAt": control_state.updated_at(),
    })
}

fn project_readiness(readiness: &crate::runtime::peers::Readiness) -> Value {
    json!({
        "ready": readiness.ready(),
        "phase": readiness.phase(),
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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
                        "agents": [{ "agentId": "main", "source": "discovered", "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true } }],
                        "acceptsDynamicAgents": true,
                        "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true },
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
                        "agents": [{ "agentId": "matcha", "source": "discovered", "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true } }],
                        "acceptsDynamicAgents": true,
                        "capabilities": { "chat": true, "streaming": true, "tools": true, "approvals": true, "replay": true, "modelSelection": true },
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

pub(crate) mod handler {
    use super::{AUTHORIZATION_HEADER, BEARER_PREFIX, Delivery};
    use crate::{
        composition::PeerHandle, transport::common::authorization::CapabilityDecisionVerifier,
    };
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    pub(crate) struct Response {
        pub(crate) status: u16,
        pub(crate) body: Value,
    }

    pub(crate) async fn handle(
        headers: &[(String, String)],
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        peer: PeerHandle,
    ) -> Response {
        let authorization_present = headers
            .iter()
            .find(|(name, _)| name == AUTHORIZATION_HEADER)
            .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX));
        if authorization_present.is_none() {
            return Response::unauthorized();
        }
        let mut verifier = verifier.lock().await;
        if super::decode_authorization(headers, &mut verifier).is_err() {
            return Response::unauthorized();
        }
        drop(verifier);

        let directory = match peer.runtime_endpoint_directory().await {
            Ok(directory) => directory,
            Err(_) => return Response::unavailable(),
        };
        Response::from_delivery(Delivery::Ok(directory))
    }

    impl Response {
        fn unauthorized() -> Self {
            Self::fixed(401, "Runtime endpoint directory authorization is invalid")
        }

        fn unavailable() -> Self {
            Self::fixed(503, "Runtime endpoint directory is unavailable")
        }

        fn fixed(status: u16, error: &'static str) -> Self {
            Self {
                status,
                body: serde_json::json!({ "success": false, "error": error }),
            }
        }

        fn from_delivery(delivery: Delivery) -> Self {
            Self {
                status: delivery.status_code(),
                body: delivery.body(),
            }
        }
    }
}
