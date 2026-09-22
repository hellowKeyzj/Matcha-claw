use crate::{
    domain::lease::LeaseId,
    domain::topology::{NodeId, RuntimeId},
};
use platform::{
    capability::CapabilityId,
    endpoint::{EndpointId, NativeAgentId},
};

use super::DesiredFleetRevision;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FleetReconcileAction {
    ApplyDesiredRevision {
        revision: DesiredFleetRevision,
    },
    RestoreDescriptors {
        node_id: NodeId,
        runtime_id: RuntimeId,
        endpoint_id: EndpointId,
        capability_id: CapabilityId,
        descriptor_count: u32,
    },
    ProbeAgent {
        node_id: NodeId,
        agent_id: NativeAgentId,
        reason: ProbeAgentReason,
    },
    ReapExpiredLease {
        endpoint_id: EndpointId,
        lease_id: LeaseId,
        expires_at: u64,
    },
    MarkCapabilityStale {
        node_id: Option<NodeId>,
        runtime_id: Option<RuntimeId>,
        endpoint_id: EndpointId,
        capability_id: CapabilityId,
        reason: CapabilityStaleReason,
        observed_at: Option<u64>,
    },
    PruneRetiredEndpoint {
        node_id: NodeId,
        runtime_id: RuntimeId,
        endpoint_id: EndpointId,
    },
    ProbeRunningRuntime {
        node_id: NodeId,
        agent_id: Option<NativeAgentId>,
        runtime_id: RuntimeId,
        endpoint_id: Option<EndpointId>,
        reason: RunningRuntimeProbeReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeAgentReason {
    EnrolledAfterRestore,
    InstalledNeedsEnrollment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityStaleReason {
    ObservationExpired,
    EndpointMissing,
    EndpointRetired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunningRuntimeProbeReason {
    EndpointProbe,
    EndpointMissing,
    EndpointRetired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetReconcilePlan {
    generated_at: u64,
    actions: Vec<FleetReconcileAction>,
}

impl FleetReconcilePlan {
    pub(super) fn new(generated_at: u64, actions: Vec<FleetReconcileAction>) -> Self {
        Self {
            generated_at,
            actions,
        }
    }

    pub const fn generated_at(&self) -> u64 {
        self.generated_at
    }

    pub fn actions(&self) -> &[FleetReconcileAction] {
        &self.actions
    }
}
