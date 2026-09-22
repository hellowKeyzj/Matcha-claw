use std::collections::BTreeSet;

use super::{
    EndpointPlacementExclusion, EndpointPlacementReason, EndpointPlacementRequest,
    EndpointPlacementSelection, PlacementOutcome,
    eligibility::{
        active_leases_by_endpoint, capabilities_by_endpoint, evaluate, normalize, runtime_kinds,
    },
    endpoint::health_rank,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointPlacementError {
    DuplicateEndpointId { endpoint_id: String },
    MultipleCurrentCapabilitySnapshots { endpoint_id: String },
}

pub fn select_endpoint_placement(
    request: &EndpointPlacementRequest,
) -> Result<EndpointPlacementSelection, EndpointPlacementError> {
    reject_duplicate_endpoint_ids(request)?;
    reject_multiple_current_capability_snapshots(request)?;

    let required_labels = normalize(request.requirements.labels.clone());
    let required_operation_ids = normalize(request.requirements.operation_ids.clone());
    let runtime_kinds = runtime_kinds(&request.runtimes);
    let capabilities = capabilities_by_endpoint(&request.capabilities);
    let active_leases = active_leases_by_endpoint(&request.leases, request.now);
    let mut eligible = Vec::new();
    let mut excluded_endpoints = Vec::new();

    for (index, endpoint) in request.endpoints.iter().cloned().enumerate() {
        let evaluation = evaluate(
            endpoint,
            index,
            &required_labels,
            request.requirements.runtime_kind,
            &required_operation_ids,
            &runtime_kinds,
            &capabilities,
            &active_leases,
            request.lease_capacity.as_ref(),
        );
        if evaluation.exclusion_reasons.is_empty() {
            eligible.push(evaluation);
        } else {
            excluded_endpoints.push(EndpointPlacementExclusion {
                endpoint: evaluation.endpoint,
                reasons: evaluation.exclusion_reasons,
            });
        }
    }

    eligible.sort_by(|left, right| {
        health_rank(&left.endpoint.health)
            .cmp(&health_rank(&right.endpoint.health))
            .then(left.active_lease_count.cmp(&right.active_lease_count))
            .then(left.index.cmp(&right.index))
    });
    let candidates: Vec<_> = eligible
        .into_iter()
        .map(|evaluation| evaluation.candidate())
        .collect();
    let primary = candidates.first().cloned();
    let fallback_chain = candidates.iter().skip(1).cloned().collect();

    Ok(EndpointPlacementSelection {
        primary: primary.clone(),
        fallback_chain,
        reason: EndpointPlacementReason {
            outcome: if primary.is_some() {
                PlacementOutcome::Selected
            } else {
                PlacementOutcome::NoEligibleEndpoint
            },
            required_labels,
            required_runtime_kind: request.requirements.runtime_kind,
            required_operation_ids,
            evaluated_endpoint_ids: request
                .endpoints
                .iter()
                .map(|endpoint| endpoint.endpoint_id.clone())
                .collect(),
            eligible_endpoint_ids: candidates
                .iter()
                .map(|candidate| candidate.endpoint.endpoint_id.clone())
                .collect(),
            primary_endpoint_id: primary.map(|candidate| candidate.endpoint.endpoint_id),
            fallback_endpoint_ids: candidates
                .iter()
                .skip(1)
                .map(|candidate| candidate.endpoint.endpoint_id.clone())
                .collect(),
            excluded_endpoints,
        },
    })
}

fn reject_duplicate_endpoint_ids(
    request: &EndpointPlacementRequest,
) -> Result<(), EndpointPlacementError> {
    let mut endpoint_ids = BTreeSet::new();
    for endpoint in &request.endpoints {
        if !endpoint_ids.insert(&endpoint.endpoint_id) {
            return Err(EndpointPlacementError::DuplicateEndpointId {
                endpoint_id: endpoint.endpoint_id.clone(),
            });
        }
    }
    Ok(())
}

fn reject_multiple_current_capability_snapshots(
    request: &EndpointPlacementRequest,
) -> Result<(), EndpointPlacementError> {
    let mut current_snapshot_endpoints = BTreeSet::new();
    for capability in &request.capabilities {
        if capability.freshness == super::CapabilityFreshness::Current
            && !current_snapshot_endpoints.insert(&capability.endpoint_id)
        {
            return Err(EndpointPlacementError::MultipleCurrentCapabilitySnapshots {
                endpoint_id: capability.endpoint_id.clone(),
            });
        }
    }
    Ok(())
}
