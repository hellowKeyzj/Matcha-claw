use std::time::SystemTime;

use super::{NodeId, ObservationMetadata, TopologyAssociation};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeHealth {
    Unknown,
    Online { last_seen_at: SystemTime },
    Offline { last_seen_at: Option<SystemTime> },
    Disabled,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeObservation {
    id: NodeId,
    association: TopologyAssociation,
    health: NodeHealth,
    metadata: ObservationMetadata,
}

impl NodeObservation {
    pub fn new(id: NodeId, health: NodeHealth, metadata: ObservationMetadata) -> Self {
        Self::with_association(id, TopologyAssociation::none(), health, metadata)
    }

    pub fn with_association(
        id: NodeId,
        association: TopologyAssociation,
        health: NodeHealth,
        metadata: ObservationMetadata,
    ) -> Self {
        Self {
            id,
            association,
            health,
            metadata,
        }
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }

    pub const fn association(&self) -> &TopologyAssociation {
        &self.association
    }

    pub const fn health(&self) -> NodeHealth {
        self.health
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }

    pub(crate) fn with_topology_association(&self, association: TopologyAssociation) -> Self {
        let mut observation = self.clone();
        observation.association = association;
        observation
    }

    pub(crate) fn set_health(&mut self, health: NodeHealth, metadata: ObservationMetadata) {
        self.health = health;
        self.metadata = metadata;
    }
}
