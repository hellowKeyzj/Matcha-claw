use std::{collections::BTreeMap, time::SystemTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPlacementRequest {
    pub endpoints: Vec<PlacementEndpoint>,
    pub runtimes: Vec<RuntimeObservation>,
    pub capabilities: Vec<CapabilityObservation>,
    pub leases: Vec<LeaseObservation>,
    pub requirements: EndpointPlacementRequirements,
    pub lease_capacity: Option<LeaseCapacity>,
    pub now: SystemTime,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EndpointPlacementRequirements {
    pub labels: Vec<String>,
    pub runtime_kind: Option<RuntimeKind>,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementEndpoint {
    pub endpoint_id: String,
    pub runtime_id: String,
    pub labels: Vec<String>,
    pub health: EndpointHealth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointHealth {
    Unknown,
    Ready,
    Busy {
        active_lease_count: usize,
        max_lease_count: Option<usize>,
    },
    Draining {
        message: Option<String>,
    },
    Unhealthy {
        message: Option<String>,
    },
    Retired {
        retired_at: SystemTime,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeKind {
    OpenClaw,
    MatchaAgent,
    PluginRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeObservation {
    pub runtime_id: String,
    pub kind: RuntimeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityObservation {
    pub snapshot_id: String,
    pub endpoint_id: String,
    pub operation_ids: Vec<String>,
    pub freshness: CapabilityFreshness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityFreshness {
    Unknown,
    Current,
    Stale,
    Pruned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseObservation {
    pub endpoint_id: String,
    pub state: LeaseObservationState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseObservationState {
    Active { expires_at: SystemTime },
    Released,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseCapacity {
    Uniform(usize),
    PerEndpoint(BTreeMap<String, usize>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPlacementSelection {
    pub primary: Option<EndpointPlacementCandidate>,
    pub fallback_chain: Vec<EndpointPlacementCandidate>,
    pub reason: EndpointPlacementReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPlacementCandidate {
    pub endpoint: PlacementEndpoint,
    pub runtime_kind: Option<RuntimeKind>,
    pub active_lease_count: usize,
    pub max_active_lease_count: Option<usize>,
    pub matched_operation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPlacementReason {
    pub outcome: PlacementOutcome,
    pub required_labels: Vec<String>,
    pub required_runtime_kind: Option<RuntimeKind>,
    pub required_operation_ids: Vec<String>,
    pub evaluated_endpoint_ids: Vec<String>,
    pub eligible_endpoint_ids: Vec<String>,
    pub primary_endpoint_id: Option<String>,
    pub fallback_endpoint_ids: Vec<String>,
    pub excluded_endpoints: Vec<EndpointPlacementExclusion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementOutcome {
    Selected,
    NoEligibleEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPlacementExclusion {
    pub endpoint: PlacementEndpoint,
    pub reasons: Vec<EndpointPlacementExclusionReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointPlacementExclusionReason {
    MissingLabels {
        labels: Vec<String>,
    },
    RuntimeKindUnavailable {
        expected: RuntimeKind,
    },
    RuntimeKindMismatch {
        expected: RuntimeKind,
        actual: RuntimeKind,
    },
    EndpointDraining {
        message: Option<String>,
    },
    EndpointRetired,
    EndpointHealthNotReady {
        status: EndpointHealthStatus,
        message: Option<String>,
    },
    EndpointBusy {
        active_lease_count: usize,
    },
    LeaseCapacityExhausted {
        active_lease_count: usize,
        max_active_lease_count: usize,
    },
    CapabilitySnapshotMissing {
        required_operation_ids: Vec<String>,
    },
    CapabilityStale {
        snapshot_ids: Vec<String>,
    },
    CapabilityPruned {
        snapshot_ids: Vec<String>,
    },
    CapabilityNotCurrent {
        snapshot_ids: Vec<String>,
        statuses: Vec<CapabilityFreshness>,
    },
    CapabilityMissing {
        operation_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointHealthStatus {
    Unknown,
    Unhealthy,
}
