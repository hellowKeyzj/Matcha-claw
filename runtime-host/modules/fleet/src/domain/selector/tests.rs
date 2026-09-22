use std::time::{Duration, UNIX_EPOCH};

use super::{
    CapabilityFreshness, CapabilityObservation, EndpointHealth, EndpointPlacementError,
    EndpointPlacementExclusionReason, EndpointPlacementRequest, EndpointPlacementRequirements,
    LeaseCapacity, LeaseObservation, LeaseObservationState, PlacementEndpoint, RuntimeKind,
    RuntimeObservation, select_endpoint_placement,
};

const NOW: Duration = Duration::from_secs(1_000);

fn request(endpoints: Vec<PlacementEndpoint>) -> EndpointPlacementRequest {
    EndpointPlacementRequest {
        endpoints,
        runtimes: Vec::new(),
        capabilities: Vec::new(),
        leases: Vec::new(),
        requirements: EndpointPlacementRequirements::default(),
        lease_capacity: None,
        now: UNIX_EPOCH + NOW,
    }
}

fn endpoint(endpoint_id: &str, health: EndpointHealth) -> PlacementEndpoint {
    PlacementEndpoint {
        endpoint_id: endpoint_id.into(),
        runtime_id: format!("{endpoint_id}:runtime"),
        labels: Vec::new(),
        health,
    }
}

fn capability(
    snapshot_id: &str,
    endpoint_id: &str,
    operation_ids: &[&str],
    freshness: CapabilityFreshness,
) -> CapabilityObservation {
    CapabilityObservation {
        snapshot_id: snapshot_id.into(),
        endpoint_id: endpoint_id.into(),
        operation_ids: operation_ids.iter().map(ToString::to_string).collect(),
        freshness,
    }
}

#[test]
fn selects_ready_endpoint_after_normalizing_requirements_and_capabilities() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.endpoints[0].labels = vec![" linux ".into(), "gpu".into(), "linux".into()];
    request.runtimes = vec![RuntimeObservation {
        runtime_id: "endpoint-a:runtime".into(),
        kind: RuntimeKind::OpenClaw,
    }];
    request.capabilities = vec![capability(
        "endpoint-a:capabilities",
        "endpoint-a",
        &[" sessions.prompt ", "sessions.prompt", "tools.invoke"],
        CapabilityFreshness::Current,
    )];
    request.requirements = EndpointPlacementRequirements {
        labels: vec!["linux".into(), " linux ".into()],
        runtime_kind: Some(RuntimeKind::OpenClaw),
        operation_ids: vec!["sessions.prompt".into(), " sessions.prompt ".into()],
    };
    request.lease_capacity = Some(LeaseCapacity::Uniform(2));
    request.leases = vec![LeaseObservation {
        endpoint_id: "endpoint-a".into(),
        state: LeaseObservationState::Active {
            expires_at: UNIX_EPOCH + NOW + Duration::from_secs(1),
        },
    }];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(
        selection.primary.unwrap().endpoint.endpoint_id,
        "endpoint-a"
    );
    assert_eq!(selection.reason.required_labels, ["linux"]);
    assert_eq!(selection.reason.required_operation_ids, ["sessions.prompt"]);
}

#[test]
fn excludes_endpoint_when_capacity_observation_is_full_without_mutating_lease() {
    let mut request = request(vec![endpoint(
        "endpoint-full",
        EndpointHealth::Busy {
            active_lease_count: 2,
            max_lease_count: Some(2),
        },
    )]);
    request.leases = vec![LeaseObservation {
        endpoint_id: "endpoint-full".into(),
        state: LeaseObservationState::Active {
            expires_at: UNIX_EPOCH + NOW + Duration::from_secs(1),
        },
    }];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary, None);
    assert_eq!(
        selection.reason.excluded_endpoints[0].reasons,
        [EndpointPlacementExclusionReason::LeaseCapacityExhausted {
            active_lease_count: 2,
            max_active_lease_count: 2,
        }]
    );
}

#[test]
fn ignores_expired_lease_observations_when_choosing_capacity() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.lease_capacity = Some(LeaseCapacity::Uniform(1));
    request.leases = vec![LeaseObservation {
        endpoint_id: "endpoint-a".into(),
        state: LeaseObservationState::Active {
            expires_at: UNIX_EPOCH + NOW - Duration::from_secs(1),
        },
    }];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary.unwrap().active_lease_count, 0);
}

#[test]
fn treats_lease_expiry_deadline_as_not_active() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.lease_capacity = Some(LeaseCapacity::Uniform(1));
    request.leases = vec![LeaseObservation {
        endpoint_id: "endpoint-a".into(),
        state: LeaseObservationState::Active {
            expires_at: UNIX_EPOCH + NOW,
        },
    }];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary.unwrap().active_lease_count, 0);
}

#[test]
fn reads_lease_observations_without_reserving_or_releasing_them() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.lease_capacity = Some(LeaseCapacity::Uniform(2));
    request.leases = vec![LeaseObservation {
        endpoint_id: "endpoint-a".into(),
        state: LeaseObservationState::Active {
            expires_at: UNIX_EPOCH + NOW + Duration::from_secs(1),
        },
    }];
    let observed_request = request.clone();

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary.unwrap().active_lease_count, 1);
    assert_eq!(request, observed_request);
}

#[test]
fn falls_back_to_busy_capacity_when_per_endpoint_capacity_is_not_configured() {
    let mut request = request(vec![endpoint(
        "endpoint-a",
        EndpointHealth::Busy {
            active_lease_count: 0,
            max_lease_count: Some(2),
        },
    )]);
    request.lease_capacity = Some(LeaseCapacity::PerEndpoint(Default::default()));

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary.unwrap().max_active_lease_count, Some(2));
}

#[test]
fn excludes_unknown_capabilities_when_an_operation_is_required() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.requirements.operation_ids = vec!["sessions.prompt".into()];
    request.capabilities = vec![capability(
        "unknown-capability",
        "endpoint-a",
        &["sessions.prompt"],
        CapabilityFreshness::Unknown,
    )];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary, None);
    assert_eq!(
        selection.reason.excluded_endpoints[0].reasons,
        [EndpointPlacementExclusionReason::CapabilityNotCurrent {
            snapshot_ids: vec!["unknown-capability".into()],
            statuses: vec![CapabilityFreshness::Unknown],
        }]
    );
}

#[test]
fn rejects_stale_and_pruned_capabilities() {
    let mut request = request(vec![
        endpoint("endpoint-stale", EndpointHealth::Ready),
        endpoint("endpoint-pruned", EndpointHealth::Ready),
    ]);
    request.requirements.operation_ids = vec!["sessions.prompt".into()];
    request.capabilities = vec![
        capability(
            "stale-capability",
            "endpoint-stale",
            &["sessions.prompt"],
            CapabilityFreshness::Stale,
        ),
        capability(
            "pruned-capability",
            "endpoint-pruned",
            &["sessions.prompt"],
            CapabilityFreshness::Pruned,
        ),
    ];

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(selection.primary, None);
    assert_eq!(
        selection.reason.excluded_endpoints[0].reasons,
        [EndpointPlacementExclusionReason::CapabilityStale {
            snapshot_ids: vec!["stale-capability".into()],
        }]
    );
    assert_eq!(
        selection.reason.excluded_endpoints[1].reasons,
        [EndpointPlacementExclusionReason::CapabilityPruned {
            snapshot_ids: vec!["pruned-capability".into()],
        }]
    );
}

#[test]
fn orders_fallbacks_by_health_then_active_leases_then_input_order() {
    let mut request = request(vec![
        endpoint(
            "endpoint-busy-a",
            EndpointHealth::Busy {
                active_lease_count: 1,
                max_lease_count: Some(3),
            },
        ),
        endpoint("endpoint-ready-a", EndpointHealth::Ready),
        endpoint("endpoint-ready-b", EndpointHealth::Ready),
        endpoint(
            "endpoint-busy-b",
            EndpointHealth::Busy {
                active_lease_count: 0,
                max_lease_count: Some(3),
            },
        ),
    ]);
    request.lease_capacity = Some(LeaseCapacity::Uniform(3));

    let selection = select_endpoint_placement(&request).unwrap();

    assert_eq!(
        selection.primary.unwrap().endpoint.endpoint_id,
        "endpoint-ready-a"
    );
    assert_eq!(
        selection
            .fallback_chain
            .iter()
            .map(|candidate| candidate.endpoint.endpoint_id.as_str())
            .collect::<Vec<_>>(),
        ["endpoint-ready-b", "endpoint-busy-b", "endpoint-busy-a"]
    );
}

#[test]
fn rejects_duplicate_endpoint_ids_before_selecting() {
    let request = request(vec![
        endpoint("endpoint-a", EndpointHealth::Ready),
        endpoint("endpoint-a", EndpointHealth::Ready),
    ]);

    let result = select_endpoint_placement(&request);

    assert_eq!(
        result,
        Err(EndpointPlacementError::DuplicateEndpointId {
            endpoint_id: "endpoint-a".into(),
        })
    );
}

#[test]
fn rejects_multiple_current_capability_snapshots_for_an_endpoint() {
    let mut request = request(vec![endpoint("endpoint-a", EndpointHealth::Ready)]);
    request.capabilities = vec![
        capability(
            "capabilities-a",
            "endpoint-a",
            &["sessions.prompt"],
            CapabilityFreshness::Current,
        ),
        capability(
            "capabilities-b",
            "endpoint-a",
            &["tools.invoke"],
            CapabilityFreshness::Current,
        ),
    ];

    let result = select_endpoint_placement(&request);

    assert_eq!(
        result,
        Err(EndpointPlacementError::MultipleCurrentCapabilitySnapshots {
            endpoint_id: "endpoint-a".into(),
        })
    );
}
