use std::{
    collections::{BTreeMap, BTreeSet},
    time::SystemTime,
};

use super::{
    CapabilityObservation, EndpointPlacementCandidate, EndpointPlacementExclusionReason,
    LeaseCapacity, LeaseObservation, LeaseObservationState, PlacementEndpoint, RuntimeKind,
    RuntimeObservation, capability, endpoint,
};

#[derive(Debug, Clone)]
pub(super) struct Evaluation {
    pub(super) endpoint: PlacementEndpoint,
    pub(super) index: usize,
    pub(super) active_lease_count: usize,
    pub(super) exclusion_reasons: Vec<EndpointPlacementExclusionReason>,
    runtime_kind: Option<RuntimeKind>,
    max_active_lease_count: Option<usize>,
    matched_operation_ids: Vec<String>,
}

impl Evaluation {
    pub(super) fn candidate(self) -> EndpointPlacementCandidate {
        EndpointPlacementCandidate {
            endpoint: self.endpoint,
            runtime_kind: self.runtime_kind,
            active_lease_count: self.active_lease_count,
            max_active_lease_count: self.max_active_lease_count,
            matched_operation_ids: self.matched_operation_ids,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn evaluate(
    endpoint_value: PlacementEndpoint,
    index: usize,
    required_labels: &[String],
    required_runtime_kind: Option<RuntimeKind>,
    required_operation_ids: &[String],
    runtime_kinds: &BTreeMap<String, RuntimeKind>,
    capabilities: &BTreeMap<String, Vec<&CapabilityObservation>>,
    active_leases: &BTreeMap<String, usize>,
    lease_capacity: Option<&LeaseCapacity>,
) -> Evaluation {
    let runtime_kind = runtime_kinds.get(&endpoint_value.runtime_id).copied();
    let active_lease_count = endpoint::active_lease_count(&endpoint_value, active_leases);
    let max_active_lease_count = endpoint::max_active_lease_count(&endpoint_value, lease_capacity);
    let endpoint_capabilities = capabilities
        .get(&endpoint_value.endpoint_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let matched_operation_ids = capability::operation_ids(endpoint_capabilities);
    let mut exclusion_reasons = endpoint::exclusion(
        &endpoint_value,
        required_labels,
        required_runtime_kind,
        runtime_kind,
        active_lease_count,
        max_active_lease_count,
    );
    exclusion_reasons.extend(capability::exclusion(
        required_operation_ids,
        endpoint_capabilities,
    ));

    Evaluation {
        endpoint: endpoint_value,
        index,
        runtime_kind,
        active_lease_count,
        max_active_lease_count,
        matched_operation_ids,
        exclusion_reasons,
    }
}

pub(super) fn runtime_kinds(runtimes: &[RuntimeObservation]) -> BTreeMap<String, RuntimeKind> {
    runtimes
        .iter()
        .map(|runtime| (runtime.runtime_id.clone(), runtime.kind))
        .collect()
}

pub(super) fn capabilities_by_endpoint(
    capabilities: &[CapabilityObservation],
) -> BTreeMap<String, Vec<&CapabilityObservation>> {
    let mut grouped = BTreeMap::new();
    for capability in capabilities {
        grouped
            .entry(capability.endpoint_id.clone())
            .or_insert_with(Vec::new)
            .push(capability);
    }
    grouped
}

pub(super) fn active_leases_by_endpoint(
    leases: &[LeaseObservation],
    now: SystemTime,
) -> BTreeMap<String, usize> {
    let mut active = BTreeMap::new();
    for lease in leases {
        if matches!(&lease.state, LeaseObservationState::Active { expires_at } if *expires_at > now)
        {
            *active.entry(lease.endpoint_id.clone()).or_default() += 1;
        }
    }
    active
}

pub(super) fn normalize(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
