use crate::{
    domain::lease::LeaseId,
    domain::topology::{NodeId, RuntimeId},
};
use platform::{
    capability::CapabilityId,
    endpoint::{EndpointId, NativeAgentId},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedFleet {
    agents: Vec<ObservedAgent>,
    runtimes: Vec<ObservedRuntime>,
    endpoints: Vec<ObservedEndpoint>,
    capabilities: Vec<ObservedCapability>,
    leases: Vec<ObservedLease>,
}

impl ObservedFleet {
    pub fn new(
        agents: Vec<ObservedAgent>,
        runtimes: Vec<ObservedRuntime>,
        endpoints: Vec<ObservedEndpoint>,
        capabilities: Vec<ObservedCapability>,
        leases: Vec<ObservedLease>,
    ) -> Self {
        Self {
            agents,
            runtimes,
            endpoints,
            capabilities,
            leases,
        }
    }

    pub fn agents(&self) -> &[ObservedAgent] {
        &self.agents
    }

    pub fn runtimes(&self) -> &[ObservedRuntime] {
        &self.runtimes
    }

    pub fn endpoints(&self) -> &[ObservedEndpoint] {
        &self.endpoints
    }

    pub fn capabilities(&self) -> &[ObservedCapability] {
        &self.capabilities
    }

    pub fn leases(&self) -> &[ObservedLease] {
        &self.leases
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedAgent {
    agent_id: NativeAgentId,
    node_id: NodeId,
    enrollment: AgentEnrollment,
}

impl ObservedAgent {
    pub const fn new(
        agent_id: NativeAgentId,
        node_id: NodeId,
        enrollment: AgentEnrollment,
    ) -> Self {
        Self {
            agent_id,
            node_id,
            enrollment,
        }
    }

    pub const fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub const fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub const fn enrollment(&self) -> AgentEnrollment {
        self.enrollment
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentEnrollment {
    Installed,
    Enrolled,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedRuntime {
    runtime_id: RuntimeId,
    node_id: NodeId,
    agent_id: Option<NativeAgentId>,
    endpoint_id: Option<EndpointId>,
    lifecycle: RuntimeLifecycle,
}

impl ObservedRuntime {
    pub const fn new(
        runtime_id: RuntimeId,
        node_id: NodeId,
        agent_id: Option<NativeAgentId>,
        endpoint_id: Option<EndpointId>,
        lifecycle: RuntimeLifecycle,
    ) -> Self {
        Self {
            runtime_id,
            node_id,
            agent_id,
            endpoint_id,
            lifecycle,
        }
    }

    pub const fn runtime_id(&self) -> &RuntimeId {
        &self.runtime_id
    }

    pub const fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub const fn agent_id(&self) -> Option<&NativeAgentId> {
        self.agent_id.as_ref()
    }

    pub const fn endpoint_id(&self) -> Option<&EndpointId> {
        self.endpoint_id.as_ref()
    }

    pub const fn lifecycle(&self) -> RuntimeLifecycle {
        self.lifecycle
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeLifecycle {
    Running,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedEndpoint {
    endpoint_id: EndpointId,
    node_id: NodeId,
    runtime_id: RuntimeId,
    health: EndpointHealth,
}

impl ObservedEndpoint {
    pub const fn new(
        endpoint_id: EndpointId,
        node_id: NodeId,
        runtime_id: RuntimeId,
        health: EndpointHealth,
    ) -> Self {
        Self {
            endpoint_id,
            node_id,
            runtime_id,
            health,
        }
    }

    pub const fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }

    pub const fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub const fn runtime_id(&self) -> &RuntimeId {
        &self.runtime_id
    }

    pub const fn health(&self) -> EndpointHealth {
        self.health
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointHealth {
    Retired,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedCapability {
    capability_id: CapabilityId,
    endpoint_id: EndpointId,
    node_id: Option<NodeId>,
    runtime_id: Option<RuntimeId>,
    descriptor_count: u32,
    freshness: CapabilityFreshness,
}

impl ObservedCapability {
    pub const fn new(
        capability_id: CapabilityId,
        endpoint_id: EndpointId,
        node_id: Option<NodeId>,
        runtime_id: Option<RuntimeId>,
        descriptor_count: u32,
        freshness: CapabilityFreshness,
    ) -> Self {
        Self {
            capability_id,
            endpoint_id,
            node_id,
            runtime_id,
            descriptor_count,
            freshness,
        }
    }

    pub const fn capability_id(&self) -> &CapabilityId {
        &self.capability_id
    }

    pub const fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }

    pub const fn node_id(&self) -> Option<&NodeId> {
        self.node_id.as_ref()
    }

    pub const fn runtime_id(&self) -> Option<&RuntimeId> {
        self.runtime_id.as_ref()
    }

    pub const fn descriptor_count(&self) -> u32 {
        self.descriptor_count
    }

    pub const fn freshness(&self) -> CapabilityFreshness {
        self.freshness
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityFreshness {
    Current { observed_at: u64 },
    Unknown { observed_at: u64 },
    Unobserved,
    Stale,
    Pruned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedLease {
    lease_id: LeaseId,
    endpoint_id: EndpointId,
    state: LeaseState,
}

impl ObservedLease {
    pub const fn new(lease_id: LeaseId, endpoint_id: EndpointId, state: LeaseState) -> Self {
        Self {
            lease_id,
            endpoint_id,
            state,
        }
    }

    pub const fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }

    pub const fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }

    pub const fn state(&self) -> LeaseState {
        self.state
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseState {
    Active { expires_at: u64 },
    Other,
}
