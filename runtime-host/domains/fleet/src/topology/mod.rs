mod agent;
mod association;
mod authority;
mod endpoint;
mod facts;
mod identity;
mod mutation;
mod node;
mod observation;
mod oracle;
mod runtime;
mod workload;

pub use agent::AgentObservation;
pub use association::TopologyAssociation;
pub use authority::{
    CredentialHash, EnrollmentRecord, EnrollmentRestoreError, EnrollmentUse, FleetAccessFacts,
    FleetAccessFactsError, IngressCredentialIssue, IngressCredentialRecord,
    IngressCredentialRestoreError, IngressCredentialRevocation, InvalidCredentialHash,
};
pub use endpoint::{CapabilityAvailabilityObservation, EndpointHealth, EndpointObservation};
pub use facts::FleetTopologyFacts;
pub use identity::{
    InvalidNodeId, InvalidRuntimeId, InvalidWorkloadId, NodeId, RuntimeId, WorkloadId,
};
pub use mutation::{CapabilitySync, TopologyMutation, TopologyMutationError};
pub(crate) use mutation::{
    PendingEndpointCommand, PendingEndpointCommandKind, PendingRuntimeCommand,
    PendingRuntimeCommandKind,
};
pub use node::{NodeHealth, NodeObservation};
pub use observation::{ObservationFreshness, ObservationMetadata, ObservationSource};
pub use oracle::{TopologyError, TopologyOracle};
pub use runtime::{RuntimeKind, RuntimeObservation, RuntimeState};
pub use workload::{WorkloadObservation, WorkloadState};

#[cfg(test)]
mod tests;
