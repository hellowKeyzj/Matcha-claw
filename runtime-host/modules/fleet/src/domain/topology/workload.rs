use super::{NodeId, ObservationMetadata, WorkloadId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkloadState {
    Observed,
    Ready,
    Deleted,
    Conflict,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkloadObservation {
    id: WorkloadId,
    node_id: Option<NodeId>,
    state: WorkloadState,
    metadata: ObservationMetadata,
}

impl WorkloadObservation {
    pub fn new(
        id: WorkloadId,
        node_id: Option<NodeId>,
        state: WorkloadState,
        metadata: ObservationMetadata,
    ) -> Self {
        Self {
            id,
            node_id,
            state,
            metadata,
        }
    }

    pub fn id(&self) -> &WorkloadId {
        &self.id
    }

    pub const fn node_id(&self) -> Option<&NodeId> {
        self.node_id.as_ref()
    }

    pub const fn state(&self) -> WorkloadState {
        self.state
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }
}
