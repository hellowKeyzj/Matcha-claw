use crate::{
    HostState, RuntimeLifecycle,
    runtime::driver::{RuntimeCapabilityFamily, RuntimeDriverIdentity},
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

#[derive(Clone, Debug, Eq, PartialEq)]
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

    pub(crate) fn from_lifecycles(matcha: RuntimeLifecycle, open_claw: RuntimeLifecycle) -> Self {
        HostRuntimeDirectory::from_lifecycles(matcha, open_claw).into_public_directory()
    }

    pub(crate) fn endpoints(&self) -> &[Endpoint; 2] {
        &self.endpoints
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Endpoint {
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

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn protocol_id(&self) -> &'static str {
        self.protocol_id
    }

    pub(crate) fn runtime_adapter_id(&self) -> &str {
        &self.runtime_adapter_id
    }

    pub(crate) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub(crate) fn endpoint_ref(&self) -> &NativeEndpointRef {
        &self.endpoint_ref
    }

    pub(crate) fn source(&self) -> &Source {
        &self.source
    }

    pub(crate) fn location(&self) -> &Location {
        &self.location
    }

    pub(crate) fn lifecycle(&self) -> &Lifecycle {
        &self.lifecycle
    }

    pub(crate) fn display_name(&self) -> &'static str {
        self.display_name
    }

    pub(crate) fn agent_ids(&self) -> &[&'static str; 1] {
        &self.agent_ids
    }

    pub(crate) fn default_agent_id(&self) -> &'static str {
        self.default_agent_id
    }

    pub(crate) fn agents(&self) -> &[Agent; 1] {
        &self.agents
    }

    pub(crate) fn accepts_dynamic_agents(&self) -> bool {
        self.accepts_dynamic_agents
    }

    pub(crate) fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    pub(crate) fn capability_families(&self) -> &[CapabilityFamily; 9] {
        &self.capability_families
    }

    pub(crate) fn control_state(&self) -> &ControlState {
        &self.control_state
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeEndpointRef {
    kind: &'static str,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl NativeEndpointRef {
    pub(crate) fn kind(&self) -> &'static str {
        self.kind
    }

    pub(crate) fn runtime_adapter_id(&self) -> &str {
        &self.runtime_adapter_id
    }

    pub(crate) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Source {
    kind: &'static str,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Source {
    pub(crate) fn kind(&self) -> &'static str {
        self.kind
    }

    pub(crate) fn runtime_adapter_id(&self) -> &str {
        &self.runtime_adapter_id
    }

    pub(crate) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Location {
    kind: &'static str,
}

impl Location {
    pub(crate) fn kind(&self) -> &'static str {
        self.kind
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Lifecycle {
    phase: &'static str,
    connected: bool,
    ready: bool,
    updated_at: Option<u64>,
}

impl Lifecycle {
    pub(crate) fn phase(&self) -> &'static str {
        self.phase
    }

    pub(crate) fn connected(&self) -> bool {
        self.connected
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready
    }

    pub(crate) fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Agent {
    agent_id: &'static str,
    source: &'static str,
    capabilities: Capabilities,
}

impl Agent {
    pub(crate) fn agent_id(&self) -> &'static str {
        self.agent_id
    }

    pub(crate) fn source(&self) -> &'static str {
        self.source
    }

    pub(crate) fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Capabilities {
    chat: bool,
    streaming: bool,
    tools: bool,
    approvals: bool,
    replay: bool,
    model_selection: bool,
}

impl Capabilities {
    pub(crate) fn chat(&self) -> bool {
        self.chat
    }

    pub(crate) fn streaming(&self) -> bool {
        self.streaming
    }

    pub(crate) fn tools(&self) -> bool {
        self.tools
    }

    pub(crate) fn approvals(&self) -> bool {
        self.approvals
    }

    pub(crate) fn replay(&self) -> bool {
        self.replay
    }

    pub(crate) fn model_selection(&self) -> bool {
        self.model_selection
    }

    fn from_surface(surface: crate::runtime::driver::RuntimeCapabilitySurface) -> Self {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CapabilityFamily {
    family: &'static str,
    availability: &'static str,
}

impl CapabilityFamily {
    pub(crate) fn family(&self) -> &'static str {
        self.family
    }

    pub(crate) fn availability(&self) -> &'static str {
        self.availability
    }

    fn from_surface(surface: crate::runtime::driver::RuntimeCapabilitySurface) -> [Self; 9] {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ControlState {
    connection: Option<()>,
    readiness: Option<Readiness>,
    capabilities: Option<()>,
    updated_at: Option<u64>,
}

impl ControlState {
    pub(crate) fn connection(&self) -> Option<()> {
        self.connection
    }

    pub(crate) fn readiness(&self) -> Option<&Readiness> {
        self.readiness.as_ref()
    }

    pub(crate) fn capabilities(&self) -> Option<()> {
        self.capabilities
    }

    pub(crate) fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Readiness {
    ready: bool,
    phase: &'static str,
}

impl Readiness {
    pub(crate) fn ready(&self) -> bool {
        self.ready
    }

    pub(crate) fn phase(&self) -> &'static str {
        self.phase
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_fixed_local_peers_with_chat_scopes() {
        let directory =
            Directory::from_lifecycles(RuntimeLifecycle::Running, RuntimeLifecycle::Running);
        let [open_claw, matcha] = directory.endpoints();

        assert_eq!(open_claw.id(), "openclaw-local");
        assert_eq!(open_claw.protocol_id(), "openclaw-v4");
        assert_eq!(open_claw.runtime_adapter_id(), "openclaw");
        assert_eq!(open_claw.runtime_instance_id(), "local");
        assert_eq!(open_claw.display_name(), "OpenClaw");
        assert_eq!(open_claw.default_agent_id(), "main");
        assert_eq!(open_claw.agent_ids(), &["main"]);
        assert!(open_claw.accepts_dynamic_agents());
        assert!(open_claw.capabilities().chat());
        assert!(open_claw.capabilities().tools());
        assert_eq!(open_claw.capability_families()[0].family(), "session");
        assert_eq!(
            open_claw.capability_families()[1].availability(),
            "supported"
        );
        assert_eq!(open_claw.lifecycle().phase(), "ready");
        assert_eq!(
            open_claw.control_state().readiness().unwrap().phase(),
            "ready"
        );

        assert_eq!(matcha.id(), "matcha-agent-local");
        assert_eq!(matcha.protocol_id(), "matcha-agent-app-server");
        assert_eq!(matcha.runtime_adapter_id(), "matcha-agent");
        assert_eq!(matcha.runtime_instance_id(), "local");
        assert_eq!(matcha.display_name(), "Matcha Agent");
        assert_eq!(matcha.default_agent_id(), "matcha");
        assert_eq!(matcha.agent_ids(), &["matcha"]);
        assert!(matcha.capabilities().chat());
        assert_eq!(matcha.capability_families()[1].family(), "task");
        assert_eq!(
            matcha.capability_families()[1].availability(),
            "unsupported"
        );
        assert_eq!(matcha.capability_families()[3].family(), "team");
        assert_eq!(matcha.capability_families()[3].availability(), "supported");
    }

    #[test]
    fn runtime_readiness_overrides_running_supervisor_for_session_capabilities() {
        let endpoint = Endpoint::open_claw(
            RuntimeLifecycle::Running,
            RuntimeEndpointReadiness::Unavailable,
        );

        assert_eq!(endpoint.lifecycle().phase(), "unavailable");
        assert!(!endpoint.lifecycle().is_ready());
        assert_eq!(
            endpoint.control_state().readiness().unwrap().phase(),
            "unavailable"
        );
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
            let directory = Directory::from_lifecycles(lifecycle, RuntimeLifecycle::Running);
            let endpoint = &directory.endpoints()[1];
            assert_eq!(endpoint.lifecycle().phase(), phase);
            assert_eq!(
                endpoint
                    .control_state()
                    .readiness()
                    .map(crate::runtime::peers::Readiness::phase),
                readiness_phase,
            );
        }
    }
}
