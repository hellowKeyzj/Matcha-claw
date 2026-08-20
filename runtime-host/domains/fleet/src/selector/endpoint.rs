use std::collections::{BTreeMap, BTreeSet};

use super::eligibility::normalize;
use super::{
    EndpointHealth, EndpointHealthStatus, EndpointPlacementExclusionReason, LeaseCapacity,
    PlacementEndpoint, RuntimeKind,
};

pub(super) fn exclusion(
    endpoint: &PlacementEndpoint,
    required_labels: &[String],
    required_runtime_kind: Option<RuntimeKind>,
    runtime_kind: Option<RuntimeKind>,
    active_lease_count: usize,
    max_active_lease_count: Option<usize>,
) -> Vec<EndpointPlacementExclusionReason> {
    let mut reasons = missing_labels(endpoint, required_labels);
    reasons.extend(runtime_kind_exclusion(required_runtime_kind, runtime_kind));
    reasons.extend(health_exclusion(
        &endpoint.health,
        active_lease_count,
        max_active_lease_count,
    ));
    reasons
}

pub(super) fn active_lease_count(
    endpoint: &PlacementEndpoint,
    active_leases: &BTreeMap<String, usize>,
) -> usize {
    let observed = active_leases
        .get(&endpoint.endpoint_id)
        .copied()
        .unwrap_or_default();
    match endpoint.health {
        EndpointHealth::Busy {
            active_lease_count, ..
        } => observed.max(active_lease_count),
        _ => observed,
    }
}

pub(super) fn max_active_lease_count(
    endpoint: &PlacementEndpoint,
    lease_capacity: Option<&LeaseCapacity>,
) -> Option<usize> {
    if let Some(LeaseCapacity::Uniform(capacity)) = lease_capacity {
        return Some(*capacity);
    }
    if let Some(LeaseCapacity::PerEndpoint(capacity)) = lease_capacity
        && let Some(capacity) = capacity.get(&endpoint.endpoint_id)
    {
        return Some(*capacity);
    }
    match endpoint.health {
        EndpointHealth::Busy {
            max_lease_count, ..
        } => max_lease_count,
        _ => None,
    }
}

pub(super) fn health_rank(health: &EndpointHealth) -> usize {
    match health {
        EndpointHealth::Ready => 0,
        EndpointHealth::Busy { .. } => 1,
        _ => 2,
    }
}

fn missing_labels(
    endpoint: &PlacementEndpoint,
    required_labels: &[String],
) -> Vec<EndpointPlacementExclusionReason> {
    let labels: BTreeSet<_> = normalize(endpoint.labels.clone()).into_iter().collect();
    let missing: Vec<_> = required_labels
        .iter()
        .filter(|label| !labels.contains(*label))
        .cloned()
        .collect();
    (!missing.is_empty())
        .then_some(EndpointPlacementExclusionReason::MissingLabels { labels: missing })
        .into_iter()
        .collect()
}

fn runtime_kind_exclusion(
    required: Option<RuntimeKind>,
    actual: Option<RuntimeKind>,
) -> Vec<EndpointPlacementExclusionReason> {
    match (required, actual) {
        (None, _) => Vec::new(),
        (Some(expected), Some(actual)) if expected == actual => Vec::new(),
        (Some(expected), None) => {
            vec![EndpointPlacementExclusionReason::RuntimeKindUnavailable { expected }]
        }
        (Some(expected), Some(actual)) => {
            vec![EndpointPlacementExclusionReason::RuntimeKindMismatch { expected, actual }]
        }
    }
}

fn health_exclusion(
    health: &EndpointHealth,
    active_lease_count: usize,
    max_active_lease_count: Option<usize>,
) -> Vec<EndpointPlacementExclusionReason> {
    match health {
        EndpointHealth::Draining { message } => {
            vec![EndpointPlacementExclusionReason::EndpointDraining {
                message: message.clone(),
            }]
        }
        EndpointHealth::Retired { .. } => {
            vec![EndpointPlacementExclusionReason::EndpointRetired]
        }
        EndpointHealth::Unknown => vec![EndpointPlacementExclusionReason::EndpointHealthNotReady {
            status: EndpointHealthStatus::Unknown,
            message: None,
        }],
        EndpointHealth::Unhealthy { message } => {
            vec![EndpointPlacementExclusionReason::EndpointHealthNotReady {
                status: EndpointHealthStatus::Unhealthy,
                message: message.clone(),
            }]
        }
        EndpointHealth::Ready | EndpointHealth::Busy { .. } => match max_active_lease_count {
            Some(max_active_lease_count) if active_lease_count >= max_active_lease_count => {
                vec![EndpointPlacementExclusionReason::LeaseCapacityExhausted {
                    active_lease_count,
                    max_active_lease_count,
                }]
            }
            Some(_) => Vec::new(),
            None => matches!(health, EndpointHealth::Busy { .. })
                .then_some(EndpointPlacementExclusionReason::EndpointBusy { active_lease_count })
                .into_iter()
                .collect(),
        },
    }
}
