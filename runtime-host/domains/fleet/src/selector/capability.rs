use std::collections::BTreeSet;

use super::eligibility::normalize;
use super::{CapabilityFreshness, CapabilityObservation, EndpointPlacementExclusionReason};

pub(super) fn exclusion(
    required_operation_ids: &[String],
    capabilities: &[&CapabilityObservation],
) -> Vec<EndpointPlacementExclusionReason> {
    if required_operation_ids.is_empty() {
        return Vec::new();
    }
    if capabilities.is_empty() {
        return vec![
            EndpointPlacementExclusionReason::CapabilitySnapshotMissing {
                required_operation_ids: required_operation_ids.to_vec(),
            },
        ];
    }
    let current: Vec<_> = capabilities
        .iter()
        .copied()
        .filter(|capability| capability.freshness == CapabilityFreshness::Current)
        .collect();
    if current.is_empty() {
        return non_current_exclusion(capabilities);
    }
    let current_operations: BTreeSet<_> = operation_ids(&current).into_iter().collect();
    let missing: Vec<_> = required_operation_ids
        .iter()
        .filter(|operation_id| !current_operations.contains(*operation_id))
        .cloned()
        .collect();
    (!missing.is_empty())
        .then_some(EndpointPlacementExclusionReason::CapabilityMissing {
            operation_ids: missing,
        })
        .into_iter()
        .collect()
}

pub(super) fn operation_ids(capabilities: &[&CapabilityObservation]) -> Vec<String> {
    let operation_ids = capabilities
        .iter()
        .filter(|capability| capability.freshness == CapabilityFreshness::Current)
        .flat_map(|capability| capability.operation_ids.clone())
        .collect();
    normalize(operation_ids)
}

fn non_current_exclusion(
    capabilities: &[&CapabilityObservation],
) -> Vec<EndpointPlacementExclusionReason> {
    let snapshot_ids = |freshness| {
        capabilities
            .iter()
            .filter(|capability| capability.freshness == freshness)
            .map(|capability| capability.snapshot_id.clone())
            .collect::<Vec<_>>()
    };
    let pruned = snapshot_ids(CapabilityFreshness::Pruned);
    if !pruned.is_empty() {
        return vec![EndpointPlacementExclusionReason::CapabilityPruned {
            snapshot_ids: pruned,
        }];
    }
    let stale = snapshot_ids(CapabilityFreshness::Stale);
    if !stale.is_empty() {
        return vec![EndpointPlacementExclusionReason::CapabilityStale {
            snapshot_ids: stale,
        }];
    }
    vec![EndpointPlacementExclusionReason::CapabilityNotCurrent {
        snapshot_ids: capabilities
            .iter()
            .map(|capability| capability.snapshot_id.clone())
            .collect(),
        statuses: capabilities
            .iter()
            .map(|capability| capability.freshness)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    }]
}
