use platform::endpoint::NativeAgentId;

use super::{NodeId, ObservationMetadata, TopologyAssociation};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentObservation {
    id: NativeAgentId,
    node_id: NodeId,
    association: TopologyAssociation,
    metadata: ObservationMetadata,
}

impl AgentObservation {
    pub fn new(id: NativeAgentId, node_id: NodeId, metadata: ObservationMetadata) -> Self {
        Self::with_association(id, node_id, TopologyAssociation::none(), metadata)
    }

    pub fn with_association(
        id: NativeAgentId,
        node_id: NodeId,
        association: TopologyAssociation,
        metadata: ObservationMetadata,
    ) -> Self {
        Self {
            id,
            node_id,
            association,
            metadata,
        }
    }

    pub const fn id(&self) -> &NativeAgentId {
        &self.id
    }

    pub const fn association(&self) -> &TopologyAssociation {
        &self.association
    }

    pub const fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub(crate) fn with_topology_association(&self, association: TopologyAssociation) -> Self {
        let mut observation = self.clone();
        observation.association = association;
        observation
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }
}
