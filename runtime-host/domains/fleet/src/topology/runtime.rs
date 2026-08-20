use std::time::SystemTime;

use platform::endpoint::NativeAgentId;

use super::{NodeId, ObservationMetadata, RuntimeId, TopologyAssociation};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeKind {
    OpenClaw,
    MatchaAgent,
    Plugin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeState {
    Discovered,
    Running { started_at: SystemTime },
    Stopped { stopped_at: Option<SystemTime> },
    Degraded,
    Retired { retired_at: SystemTime },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeObservation {
    id: RuntimeId,
    node_id: NodeId,
    agent_id: Option<NativeAgentId>,
    association: TopologyAssociation,
    kind: RuntimeKind,
    state: RuntimeState,
    metadata: ObservationMetadata,
}

impl RuntimeObservation {
    pub fn new(
        id: RuntimeId,
        node_id: NodeId,
        agent_id: Option<NativeAgentId>,
        kind: RuntimeKind,
        state: RuntimeState,
        metadata: ObservationMetadata,
    ) -> Self {
        Self::with_association(
            id,
            node_id,
            agent_id,
            TopologyAssociation::none(),
            kind,
            state,
            metadata,
        )
    }

    pub fn with_association(
        id: RuntimeId,
        node_id: NodeId,
        agent_id: Option<NativeAgentId>,
        association: TopologyAssociation,
        kind: RuntimeKind,
        state: RuntimeState,
        metadata: ObservationMetadata,
    ) -> Self {
        Self {
            id,
            node_id,
            agent_id,
            association,
            kind,
            state,
            metadata,
        }
    }

    pub fn id(&self) -> &RuntimeId {
        &self.id
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub const fn agent_id(&self) -> Option<&NativeAgentId> {
        self.agent_id.as_ref()
    }

    pub const fn association(&self) -> &TopologyAssociation {
        &self.association
    }

    pub const fn kind(&self) -> RuntimeKind {
        self.kind
    }

    pub const fn state(&self) -> RuntimeState {
        self.state
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }

    pub(crate) fn with_topology_association(&self, association: TopologyAssociation) -> Self {
        let mut observation = self.clone();
        observation.association = association;
        observation
    }

    pub(crate) fn set_state(&mut self, state: RuntimeState, metadata: ObservationMetadata) {
        self.state = state;
        self.metadata = metadata;
    }
}
