mod capability;
mod eligibility;
mod endpoint;
mod model;
mod selection;

pub use model::{
    CapabilityFreshness, CapabilityObservation, EndpointHealth, EndpointHealthStatus,
    EndpointPlacementCandidate, EndpointPlacementExclusion, EndpointPlacementExclusionReason,
    EndpointPlacementReason, EndpointPlacementRequest, EndpointPlacementRequirements,
    EndpointPlacementSelection, LeaseCapacity, LeaseObservation, LeaseObservationState,
    PlacementEndpoint, PlacementOutcome, RuntimeKind, RuntimeObservation,
};
pub use selection::{EndpointPlacementError, select_endpoint_placement};

#[cfg(test)]
mod tests;
