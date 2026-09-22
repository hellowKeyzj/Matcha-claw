use std::time::{Duration, UNIX_EPOCH};

use crate::{
    domain::connection::ConnectionId,
    domain::environment::{EnvironmentId, ManagedResourceId},
};
use platform::{
    capability::{CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability},
    endpoint::{EndpointId, NativeAgentId},
};

use super::{
    AgentObservation, EndpointHealth, EndpointObservation, FleetTopologyFacts, NodeHealth, NodeId,
    NodeObservation, ObservationFreshness, ObservationMetadata, ObservationSource, RuntimeId,
    RuntimeKind, RuntimeObservation, RuntimeState, TopologyAssociation, TopologyError,
    TopologyMutation, TopologyMutationError, TopologyOracle, WorkloadId, WorkloadObservation,
    WorkloadState,
};

const OBSERVED_AT: std::time::SystemTime = UNIX_EPOCH;

fn metadata(freshness: ObservationFreshness) -> ObservationMetadata {
    ObservationMetadata::new(ObservationSource::Discovery, OBSERVED_AT, freshness)
}

fn node(id: &str) -> NodeObservation {
    NodeObservation::new(
        NodeId::try_new(id).unwrap(),
        NodeHealth::Online {
            last_seen_at: OBSERVED_AT,
        },
        metadata(ObservationFreshness::Current),
    )
}

fn workload(id: &str, node_id: Option<&str>) -> WorkloadObservation {
    WorkloadObservation::new(
        WorkloadId::try_new(id).unwrap(),
        node_id.map(|value| NodeId::try_new(value).unwrap()),
        WorkloadState::Ready,
        metadata(ObservationFreshness::Current),
    )
}

fn runtime(id: &str, node_id: &str, agent_id: Option<&str>) -> RuntimeObservation {
    RuntimeObservation::new(
        RuntimeId::try_new(id).unwrap(),
        NodeId::try_new(node_id).unwrap(),
        agent_id.map(|value| NativeAgentId::try_new(value).unwrap()),
        RuntimeKind::OpenClaw,
        RuntimeState::Running {
            started_at: OBSERVED_AT,
        },
        metadata(ObservationFreshness::Current),
    )
}

fn endpoint(id: &str, node_id: &str, runtime_id: &str) -> EndpointObservation {
    EndpointObservation::new(
        EndpointId::try_new(id).unwrap(),
        NodeId::try_new(node_id).unwrap(),
        RuntimeId::try_new(runtime_id).unwrap(),
        EndpointHealth::Ready,
        vec![SupportedCapability::new(
            CapabilityId::try_new("session.prompt").unwrap(),
            CapabilityScope::Endpoint,
        )],
        vec![CapabilityAvailability::Available],
        metadata(ObservationFreshness::Current),
    )
}

#[test]
fn observations_preserve_independent_state_and_metadata() {
    let node = NodeObservation::new(
        NodeId::try_new("node-a").unwrap(),
        NodeHealth::Offline {
            last_seen_at: Some(OBSERVED_AT + Duration::from_secs(1)),
        },
        ObservationMetadata::new(
            ObservationSource::HealthProbe,
            OBSERVED_AT + Duration::from_secs(2),
            ObservationFreshness::Stale,
        ),
    );
    let runtime = runtime("runtime-a", "node-a", Some("agent-a"));
    let endpoint = endpoint("endpoint-a", "node-a", "runtime-a");

    assert!(matches!(node.health(), NodeHealth::Offline { .. }));
    assert_eq!(node.metadata().source(), ObservationSource::HealthProbe);
    assert_eq!(node.metadata().freshness(), ObservationFreshness::Stale);
    assert_eq!(
        node.metadata().observed_at(),
        OBSERVED_AT + Duration::from_secs(2)
    );
    assert!(matches!(runtime.state(), RuntimeState::Running { .. }));
    assert_eq!(runtime.agent_id().unwrap().as_str(), "agent-a");
    assert_eq!(endpoint.id().as_str(), "endpoint-a");
    assert_eq!(endpoint.node_id().as_str(), "node-a");
    let capability = &endpoint.supported_capabilities()[0];
    assert_eq!(capability.id().as_str(), "session.prompt");
    assert!(
        endpoint
            .availability_observation(capability)
            .unwrap()
            .authorizes_use()
    );
    assert!(endpoint.metadata().freshness().is_current());
}

#[test]
fn all_freshness_states_preserve_the_observation_time() {
    for freshness in [
        ObservationFreshness::Current,
        ObservationFreshness::Stale,
        ObservationFreshness::Unknown,
        ObservationFreshness::Pruned,
    ] {
        let metadata = ObservationMetadata::new(
            ObservationSource::RuntimeAgent,
            OBSERVED_AT + Duration::from_secs(3),
            freshness,
        );

        assert_eq!(metadata.source(), ObservationSource::RuntimeAgent);
        assert_eq!(metadata.observed_at(), OBSERVED_AT + Duration::from_secs(3));
        assert_eq!(metadata.freshness(), freshness);
        assert_eq!(
            metadata.freshness().is_current(),
            freshness == ObservationFreshness::Current
        );
    }
}

#[test]
fn capability_support_is_static_while_availability_is_a_source_backed_observation() {
    let support = SupportedCapability::new(
        CapabilityId::try_new("session.prompt").unwrap(),
        CapabilityScope::Session,
    );

    for (availability, source, freshness, authorizes_use) in [
        (
            CapabilityAvailability::Available,
            ObservationSource::RuntimeAgent,
            ObservationFreshness::Current,
            true,
        ),
        (
            CapabilityAvailability::Available,
            ObservationSource::HealthProbe,
            ObservationFreshness::Stale,
            false,
        ),
        (
            CapabilityAvailability::Unknown,
            ObservationSource::Discovery,
            ObservationFreshness::Unknown,
            false,
        ),
    ] {
        let endpoint = EndpointObservation::new(
            EndpointId::try_new("endpoint-a").unwrap(),
            NodeId::try_new("node-a").unwrap(),
            RuntimeId::try_new("runtime-a").unwrap(),
            EndpointHealth::Ready,
            vec![support.clone()],
            vec![availability],
            ObservationMetadata::new(source, OBSERVED_AT, freshness),
        );
        let observation = endpoint.availability_observation(&support).unwrap();

        assert_eq!(support.id().as_str(), "session.prompt");
        assert_eq!(support.scope(), CapabilityScope::Session);
        assert_eq!(observation.availability(), availability);
        assert_eq!(observation.metadata().source(), source);
        assert_eq!(observation.metadata().freshness(), freshness);
        assert_eq!(observation.authorizes_use(), authorizes_use);
    }
}

#[test]
fn stale_and_unknown_observations_remain_source_backed_topology_facts() {
    let node = NodeObservation::new(
        NodeId::try_new("node-a").unwrap(),
        NodeHealth::Unknown,
        ObservationMetadata::new(
            ObservationSource::HealthProbe,
            OBSERVED_AT + Duration::from_secs(4),
            ObservationFreshness::Stale,
        ),
    );
    let workload = WorkloadObservation::new(
        WorkloadId::try_new("workload-a").unwrap(),
        Some(NodeId::try_new("node-a").unwrap()),
        WorkloadState::Observed,
        ObservationMetadata::new(
            ObservationSource::RuntimeAgent,
            OBSERVED_AT + Duration::from_secs(5),
            ObservationFreshness::Unknown,
        ),
    );
    let runtime = RuntimeObservation::new(
        RuntimeId::try_new("runtime-a").unwrap(),
        NodeId::try_new("node-a").unwrap(),
        None,
        RuntimeKind::Plugin,
        RuntimeState::Discovered,
        ObservationMetadata::new(
            ObservationSource::RuntimeAgent,
            OBSERVED_AT + Duration::from_secs(6),
            ObservationFreshness::Unknown,
        ),
    );
    let endpoint = EndpointObservation::new(
        EndpointId::try_new("endpoint-a").unwrap(),
        NodeId::try_new("node-a").unwrap(),
        RuntimeId::try_new("runtime-a").unwrap(),
        EndpointHealth::Unknown,
        Vec::new(),
        Vec::new(),
        ObservationMetadata::new(
            ObservationSource::Discovery,
            OBSERVED_AT + Duration::from_secs(7),
            ObservationFreshness::Stale,
        ),
    );

    assert_eq!(node.metadata().source(), ObservationSource::HealthProbe);
    assert_eq!(
        workload.metadata().source(),
        ObservationSource::RuntimeAgent
    );
    assert_eq!(runtime.metadata().source(), ObservationSource::RuntimeAgent);
    assert_eq!(endpoint.metadata().source(), ObservationSource::Discovery);
    TopologyOracle
        .validate(&[node], &[workload], &[runtime], &[endpoint])
        .unwrap();

    let unlinked_runtime = RuntimeObservation::new(
        RuntimeId::try_new("runtime-unlinked").unwrap(),
        NodeId::try_new("node-missing").unwrap(),
        None,
        RuntimeKind::Plugin,
        RuntimeState::Discovered,
        ObservationMetadata::new(
            ObservationSource::RuntimeAgent,
            OBSERVED_AT + Duration::from_secs(8),
            ObservationFreshness::Unknown,
        ),
    );
    assert_eq!(
        TopologyOracle.validate(&[], &[], &[unlinked_runtime], &[]),
        Err(TopologyError::UnknownRuntimeNode)
    );
}

#[test]
fn topology_owned_identities_reject_blank_values_without_echoing_them() {
    let node = NodeId::try_new(" \t").unwrap_err();
    let workload = WorkloadId::try_new("\n").unwrap_err();
    let runtime = RuntimeId::try_new("\u{2003}").unwrap_err();

    assert_eq!(node.to_string(), "node ID must not be empty");
    assert_eq!(workload.to_string(), "workload ID must not be empty");
    assert_eq!(runtime.to_string(), "runtime ID must not be empty");
}

#[test]
fn oracle_accepts_consistent_topology() {
    TopologyOracle
        .validate(
            &[node("node-a")],
            &[workload("workload-a", Some("node-a"))],
            &[runtime("runtime-a", "node-a", Some("agent-a"))],
            &[endpoint("endpoint-a", "node-a", "runtime-a")],
        )
        .unwrap();
}

#[test]
fn oracle_rejects_unknown_relationships() {
    assert_eq!(
        TopologyOracle
            .validate(&[], &[], &[runtime("runtime-a", "node-missing", None)], &[],)
            .unwrap_err(),
        TopologyError::UnknownRuntimeNode
    );
    assert_eq!(
        TopologyOracle
            .validate(
                &[],
                &[workload("workload-a", Some("node-missing"))],
                &[],
                &[],
            )
            .unwrap_err(),
        TopologyError::UnknownWorkloadNode
    );
    assert_eq!(
        TopologyOracle
            .validate(
                &[node("node-a")],
                &[],
                &[],
                &[endpoint("endpoint-a", "node-a", "runtime-missing")],
            )
            .unwrap_err(),
        TopologyError::UnknownEndpointRuntime
    );
}

#[test]
fn oracle_rejects_an_endpoint_on_another_node_than_its_runtime() {
    assert_eq!(
        TopologyOracle.validate(
            &[node("node-a"), node("node-b")],
            &[],
            &[runtime("runtime-a", "node-a", None)],
            &[endpoint("endpoint-a", "node-b", "runtime-a")],
        ),
        Err(TopologyError::MismatchedEndpointNode)
    );
}

#[test]
fn oracle_rejects_duplicate_topology_identities() {
    assert_eq!(
        TopologyOracle.validate(&[node("node-a"), node("node-a")], &[], &[], &[]),
        Err(TopologyError::DuplicateNode)
    );
    assert_eq!(
        TopologyOracle.validate(
            &[node("node-a")],
            &[workload("workload-a", None), workload("workload-a", None)],
            &[],
            &[],
        ),
        Err(TopologyError::DuplicateWorkload)
    );
    assert_eq!(
        TopologyOracle.validate(
            &[node("node-a")],
            &[],
            &[
                runtime("runtime-a", "node-a", None),
                runtime("runtime-a", "node-a", None),
            ],
            &[],
        ),
        Err(TopologyError::DuplicateRuntime)
    );
    assert_eq!(
        TopologyOracle.validate(
            &[node("node-a")],
            &[],
            &[runtime("runtime-a", "node-a", None)],
            &[
                endpoint("endpoint-a", "node-a", "runtime-a"),
                endpoint("endpoint-a", "node-a", "runtime-a"),
            ],
        ),
        Err(TopologyError::DuplicateEndpoint)
    );
}

#[test]
fn agent_aware_oracle_rejects_an_unknown_or_mismatched_runtime_agent() {
    let agent = AgentObservation::new(
        NativeAgentId::try_new("agent-a").unwrap(),
        NodeId::try_new("node-a").unwrap(),
        metadata(ObservationFreshness::Current),
    );

    assert_eq!(
        TopologyOracle.validate_with_agents(
            &[node("node-a")],
            std::slice::from_ref(&agent),
            &[],
            &[runtime("runtime-a", "node-a", Some("agent-missing"))],
            &[],
        ),
        Err(TopologyError::UnknownRuntimeAgent)
    );
    assert_eq!(
        TopologyOracle.validate_with_agents(
            &[node("node-a"), node("node-b")],
            &[agent],
            &[],
            &[runtime("runtime-a", "node-b", Some("agent-a"))],
            &[],
        ),
        Err(TopologyError::MismatchedRuntimeAgentNode)
    );
}

#[test]
fn durable_topology_rejects_a_runtime_with_an_unobserved_agent() {
    assert_eq!(
        FleetTopologyFacts::restore(
            vec![node("node-a")],
            Vec::new(),
            vec![runtime("runtime-a", "node-a", Some("agent-a"))],
            Vec::new(),
        ),
        Err(TopologyError::UnknownRuntimeAgent)
    );
}

#[test]
fn endpoint_identity_is_distinct_from_its_runtime_and_agent() {
    let runtime = runtime("runtime-a", "node-a", Some("agent-a"));
    let endpoint = endpoint("endpoint-a", "node-a", "runtime-a");

    assert_ne!(endpoint.id().as_str(), endpoint.runtime_id().as_str());
    assert_eq!(runtime.agent_id().unwrap().as_str(), "agent-a");
    TopologyOracle
        .validate(&[node("node-a")], &[], &[runtime], &[endpoint])
        .unwrap();
}
