use serde::Serialize;

use crate::{
    HostState, RuntimeLifecycle,
    runtime_driver::{RuntimeCapabilityFamily, RuntimeDriverIdentity},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeEndpointReadiness {
    Ready,
    Starting,
    Unavailable,
}

impl RuntimeEndpointReadiness {
    pub(crate) fn from_lifecycle(lifecycle: RuntimeLifecycle) -> Self {
        match lifecycle {
            RuntimeLifecycle::Running => Self::Ready,
            RuntimeLifecycle::Starting | RuntimeLifecycle::WaitingToRestart => Self::Starting,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostRuntimeDirectory {
    records: [RuntimeEndpointRecord; 2],
}

impl HostRuntimeDirectory {
    pub(crate) fn from_host_state(state: &HostState) -> Self {
        Self::from_lifecycles(state.matcha().lifecycle(), state.open_claw().lifecycle())
    }

    pub(crate) fn from_readiness(
        state: &HostState,
        matcha: RuntimeEndpointReadiness,
        open_claw: RuntimeEndpointReadiness,
    ) -> Self {
        Self {
            records: [
                RuntimeEndpointRecord::open_claw(state.open_claw().lifecycle(), open_claw),
                RuntimeEndpointRecord::matcha(state.matcha().lifecycle(), matcha),
            ],
        }
    }

    fn from_lifecycles(matcha: RuntimeLifecycle, open_claw: RuntimeLifecycle) -> Self {
        Self {
            records: [
                RuntimeEndpointRecord::open_claw(
                    open_claw,
                    RuntimeEndpointReadiness::from_lifecycle(open_claw),
                ),
                RuntimeEndpointRecord::matcha(
                    matcha,
                    RuntimeEndpointReadiness::from_lifecycle(matcha),
                ),
            ],
        }
    }

    pub(crate) const fn declared_driver_identities() -> [RuntimeDriverIdentity; 2] {
        [
            RuntimeDriverIdentity::open_claw(),
            RuntimeDriverIdentity::matcha_agent(),
        ]
    }

    pub(crate) fn into_public_directory(self) -> Directory {
        Directory {
            endpoints: self.records.map(RuntimeEndpointRecord::into_endpoint),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct Directory {
    endpoints: [Endpoint; 2],
}

impl Directory {
    pub(crate) fn from_host_state(state: &HostState) -> Self {
        HostRuntimeDirectory::from_host_state(state).into_public_directory()
    }

    pub(crate) fn from_readiness(
        state: &HostState,
        matcha: RuntimeEndpointReadiness,
        open_claw: RuntimeEndpointReadiness,
    ) -> Self {
        HostRuntimeDirectory::from_readiness(state, matcha, open_claw).into_public_directory()
    }

    fn from_lifecycles(matcha: RuntimeLifecycle, open_claw: RuntimeLifecycle) -> Self {
        HostRuntimeDirectory::from_lifecycles(matcha, open_claw).into_public_directory()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeEndpointRecord {
    identity: RuntimeDriverIdentity,
    lifecycle: RuntimeLifecycle,
    readiness: RuntimeEndpointReadiness,
}

impl RuntimeEndpointRecord {
    fn open_claw(runtime_lifecycle: RuntimeLifecycle, readiness: RuntimeEndpointReadiness) -> Self {
        Self::new(
            RuntimeDriverIdentity::open_claw(),
            runtime_lifecycle,
            readiness,
        )
    }

    fn matcha(runtime_lifecycle: RuntimeLifecycle, readiness: RuntimeEndpointReadiness) -> Self {
        Self::new(
            RuntimeDriverIdentity::matcha_agent(),
            runtime_lifecycle,
            readiness,
        )
    }

    const fn new(
        identity: RuntimeDriverIdentity,
        lifecycle: RuntimeLifecycle,
        readiness: RuntimeEndpointReadiness,
    ) -> Self {
        Self {
            identity,
            lifecycle,
            readiness,
        }
    }

    fn into_endpoint(self) -> Endpoint {
        Endpoint::new(self.identity, self.lifecycle, self.readiness)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    id: String,
    protocol_id: &'static str,
    runtime_adapter_id: String,
    runtime_instance_id: String,
    endpoint_ref: NativeEndpointRef,
    source: Source,
    location: Location,
    lifecycle: Lifecycle,
    display_name: &'static str,
    agent_ids: [&'static str; 1],
    default_agent_id: &'static str,
    agents: [Agent; 1],
    accepts_dynamic_agents: bool,
    capabilities: Capabilities,
    capability_families: [CapabilityFamily; 9],
    control_state: ControlState,
}

impl Endpoint {
    fn open_claw(runtime_lifecycle: RuntimeLifecycle, readiness: RuntimeEndpointReadiness) -> Self {
        Self::new(
            RuntimeDriverIdentity::open_claw(),
            runtime_lifecycle,
            readiness,
        )
    }

    fn matcha(runtime_lifecycle: RuntimeLifecycle, readiness: RuntimeEndpointReadiness) -> Self {
        Self::new(
            RuntimeDriverIdentity::matcha_agent(),
            runtime_lifecycle,
            readiness,
        )
    }

    fn new(
        identity: RuntimeDriverIdentity,
        runtime_lifecycle: RuntimeLifecycle,
        readiness: RuntimeEndpointReadiness,
    ) -> Self {
        let endpoint = identity.endpoint();
        let runtime_adapter_id = endpoint.runtime_adapter_id().to_owned();
        let runtime_instance_id = endpoint.runtime_instance_id().to_owned();
        let endpoint_ref = NativeEndpointRef {
            kind: "native-runtime",
            runtime_adapter_id: runtime_adapter_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
        };
        let surface = identity.capability_surface();
        let capabilities = Capabilities::from_surface(surface);
        let lifecycle = Lifecycle::from_runtime(runtime_lifecycle, readiness);
        Self {
            id: identity.endpoint_id(),
            protocol_id: identity.protocol_id(),
            runtime_adapter_id: runtime_adapter_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
            endpoint_ref: endpoint_ref.clone(),
            source: Source {
                kind: "runtime-adapter",
                runtime_adapter_id,
                runtime_instance_id,
            },
            location: Location { kind: "local" },
            lifecycle: lifecycle.clone(),
            display_name: identity.display_name(),
            agent_ids: [identity.default_agent_id()],
            default_agent_id: identity.default_agent_id(),
            agents: [Agent {
                agent_id: identity.default_agent_id(),
                source: if lifecycle.ready {
                    "discovered"
                } else {
                    "declared"
                },
                capabilities: capabilities.clone(),
            }],
            accepts_dynamic_agents: true,
            capabilities,
            capability_families: CapabilityFamily::from_surface(surface),
            control_state: ControlState::from_lifecycle(lifecycle),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEndpointRef {
    kind: &'static str,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    kind: &'static str,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct Location {
    kind: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Lifecycle {
    phase: &'static str,
    connected: bool,
    ready: bool,
    updated_at: Option<u64>,
}

impl Lifecycle {
    fn from_runtime(lifecycle: RuntimeLifecycle, readiness: RuntimeEndpointReadiness) -> Self {
        match readiness {
            RuntimeEndpointReadiness::Ready => Self::ready(),
            RuntimeEndpointReadiness::Starting => Self::connecting(),
            RuntimeEndpointReadiness::Unavailable => match lifecycle {
                RuntimeLifecycle::Idle => Self::declared(),
                RuntimeLifecycle::Stopping | RuntimeLifecycle::ShutDown => Self::disconnected(),
                _ => Self::unavailable(),
            },
        }
    }

    fn declared() -> Self {
        Self {
            phase: "declared",
            connected: false,
            ready: false,
            updated_at: None,
        }
    }

    fn connecting() -> Self {
        Self {
            phase: "connecting",
            connected: false,
            ready: false,
            updated_at: None,
        }
    }

    fn ready() -> Self {
        Self {
            phase: "ready",
            connected: true,
            ready: true,
            updated_at: None,
        }
    }

    fn unavailable() -> Self {
        Self {
            phase: "unavailable",
            connected: false,
            ready: false,
            updated_at: None,
        }
    }

    fn disconnected() -> Self {
        Self {
            phase: "disconnected",
            connected: false,
            ready: false,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    agent_id: &'static str,
    source: &'static str,
    capabilities: Capabilities,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    chat: bool,
    streaming: bool,
    tools: bool,
    approvals: bool,
    replay: bool,
    model_selection: bool,
}

impl Capabilities {
    fn from_surface(surface: crate::runtime_driver::RuntimeCapabilitySurface) -> Self {
        let session_supported = surface.supports(RuntimeCapabilityFamily::Session);
        Self {
            chat: session_supported,
            streaming: session_supported,
            tools: session_supported,
            approvals: session_supported,
            replay: session_supported,
            model_selection: session_supported,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityFamily {
    family: &'static str,
    availability: &'static str,
}

impl CapabilityFamily {
    fn from_surface(surface: crate::runtime_driver::RuntimeCapabilitySurface) -> [Self; 9] {
        [
            Self::new(
                "session",
                surface.supports(RuntimeCapabilityFamily::Session),
            ),
            Self::new("task", surface.supports(RuntimeCapabilityFamily::Task)),
            Self::new(
                "subagent",
                surface.supports(RuntimeCapabilityFamily::Subagent),
            ),
            Self::new("team", surface.supports(RuntimeCapabilityFamily::Team)),
            Self::new("cron", surface.supports(RuntimeCapabilityFamily::Cron)),
            Self::new(
                "workspace",
                surface.supports(RuntimeCapabilityFamily::Workspace),
            ),
            Self::new("skill", surface.supports(RuntimeCapabilityFamily::Skill)),
            Self::new(
                "channel",
                surface.supports(RuntimeCapabilityFamily::Channel),
            ),
            Self::new(
                "lifecycle",
                surface.supports(RuntimeCapabilityFamily::Lifecycle),
            ),
        ]
    }

    fn new(family: &'static str, supported: bool) -> Self {
        Self {
            family,
            availability: if supported {
                "supported"
            } else {
                "unsupported"
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlState {
    connection: Option<()>,
    readiness: Option<Readiness>,
    capabilities: Option<()>,
    updated_at: Option<u64>,
}

impl ControlState {
    fn from_lifecycle(lifecycle: Lifecycle) -> Self {
        let readiness = match lifecycle.phase {
            "ready" => Some(Readiness {
                ready: true,
                phase: "ready",
            }),
            "connecting" => Some(Readiness {
                ready: false,
                phase: "starting",
            }),
            "unavailable" | "disconnected" => Some(Readiness {
                ready: false,
                phase: "unavailable",
            }),
            "declared" => None,
            _ => unreachable!("peer directory lifecycle is fixed"),
        };
        Self {
            connection: None,
            readiness,
            capabilities: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct Readiness {
    ready: bool,
    phase: &'static str,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn lists_only_fixed_local_peers_with_chat_scopes() {
        let body = serde_json::to_value(Directory::from_lifecycles(
            RuntimeLifecycle::Running,
            RuntimeLifecycle::Running,
        ))
        .unwrap();

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
    }

    #[test]
    fn runtime_readiness_overrides_running_supervisor_for_session_capabilities() {
        let body = serde_json::to_value(Endpoint::open_claw(
            RuntimeLifecycle::Running,
            RuntimeEndpointReadiness::Unavailable,
        ))
        .unwrap();

        assert_eq!(body["lifecycle"]["phase"], "unavailable");
        assert_eq!(body["lifecycle"]["ready"], false);
        assert_eq!(body["controlState"]["readiness"]["phase"], "unavailable");
    }

    #[test]
    fn projects_supervisor_lifecycles_without_private_runtime_state() {
        let cases = [
            (RuntimeLifecycle::Idle, "declared", None),
            (RuntimeLifecycle::Starting, "connecting", Some("starting")),
            (
                RuntimeLifecycle::WaitingToRestart,
                "connecting",
                Some("starting"),
            ),
            (RuntimeLifecycle::Running, "ready", Some("ready")),
            (
                RuntimeLifecycle::Unavailable,
                "unavailable",
                Some("unavailable"),
            ),
            (RuntimeLifecycle::Failed, "unavailable", Some("unavailable")),
            (
                RuntimeLifecycle::Stopping,
                "disconnected",
                Some("unavailable"),
            ),
            (
                RuntimeLifecycle::ShutDown,
                "disconnected",
                Some("unavailable"),
            ),
        ];

        for (lifecycle, phase, readiness_phase) in cases {
            let body = serde_json::to_value(Directory::from_lifecycles(
                lifecycle,
                RuntimeLifecycle::Running,
            ))
            .unwrap();
            let endpoint = &body["endpoints"][1];
            assert_eq!(endpoint["lifecycle"]["phase"], phase);
            assert_eq!(
                endpoint["controlState"]["readiness"]
                    .get("phase")
                    .and_then(Value::as_str),
                readiness_phase,
            );
        }

        let rendered = serde_json::to_string(&Directory::from_lifecycles(
            RuntimeLifecycle::Failed,
            RuntimeLifecycle::Failed,
        ))
        .unwrap();
        for private in [
            "55",
            "66",
            "Readiness",
            "UnexpectedExit",
            "pid",
            "failure",
            "startupDiagnostic",
        ] {
            assert!(!rendered.contains(private));
        }
    }
}
