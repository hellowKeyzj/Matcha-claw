use crate::{
    domain::lease::LeaseId,
    domain::topology::{NodeId, RuntimeId},
};
use platform::{
    capability::CapabilityId,
    endpoint::{EndpointId, NativeAgentId},
};

use super::*;

fn node(value: &str) -> NodeId {
    NodeId::try_new(value).unwrap()
}

fn agent(value: &str) -> NativeAgentId {
    NativeAgentId::try_new(value).unwrap()
}

fn runtime(value: &str) -> RuntimeId {
    RuntimeId::try_new(value).unwrap()
}

fn endpoint(value: &str) -> EndpointId {
    EndpointId::try_new(value).unwrap()
}

fn capability(value: &str) -> CapabilityId {
    CapabilityId::try_new(value).unwrap()
}

fn lease(value: &str) -> LeaseId {
    LeaseId::try_new(value).unwrap()
}

fn desired(revision: u64) -> FleetDesired {
    FleetDesired::new(DesiredFleetRevision::new(revision))
}

fn applied(revision: u64) -> FleetApplied {
    FleetApplied::new(DesiredFleetRevision::new(revision))
}

fn input<'a>(
    desired: &'a FleetDesired,
    applied: Option<&'a FleetApplied>,
    observed: &'a ObservedFleet,
) -> FleetReconcileInput<'a> {
    FleetReconcileInput::new(desired, applied, observed, 100)
}

fn policy() -> FleetReconcilePolicy {
    FleetReconcilePolicy::new(CapabilityStaleAfter::from_seconds(30))
}

#[test]
fn requires_apply_evidence_before_recovery_actions() {
    let desired = desired(7);
    let observed = ObservedFleet::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

    let plan = plan_reconciliation(input(&desired, None, &observed), policy());

    assert_eq!(plan.generated_at(), 100);
    assert_eq!(
        plan.actions(),
        [FleetReconcileAction::ApplyDesiredRevision {
            revision: DesiredFleetRevision::new(7),
        }]
    );
}

#[test]
fn stale_apply_evidence_blocks_recovery_actions() {
    let desired = desired(7);
    let applied = applied(6);
    let observed = ObservedFleet::new(
        vec![ObservedAgent::new(
            agent("agent-1"),
            node("node-1"),
            AgentEnrollment::Enrolled,
        )],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [FleetReconcileAction::ApplyDesiredRevision {
            revision: DesiredFleetRevision::new(7),
        }]
    );
}

#[test]
fn restores_current_descriptors_and_probes_enrolled_agent_and_running_runtime() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        vec![ObservedAgent::new(
            agent("agent-1"),
            node("node-1"),
            AgentEnrollment::Enrolled,
        )],
        vec![ObservedRuntime::new(
            runtime("runtime-1"),
            node("node-1"),
            Some(agent("agent-1")),
            Some(endpoint("endpoint-1")),
            RuntimeLifecycle::Running,
        )],
        vec![ObservedEndpoint::new(
            endpoint("endpoint-1"),
            node("node-1"),
            runtime("runtime-1"),
            EndpointHealth::Other,
        )],
        vec![ObservedCapability::new(
            capability("capability-1"),
            endpoint("endpoint-1"),
            None,
            None,
            2,
            CapabilityFreshness::Current { observed_at: 99 },
        )],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [
            FleetReconcileAction::RestoreDescriptors {
                node_id: node("node-1"),
                runtime_id: runtime("runtime-1"),
                endpoint_id: endpoint("endpoint-1"),
                capability_id: capability("capability-1"),
                descriptor_count: 2,
            },
            FleetReconcileAction::ProbeAgent {
                node_id: node("node-1"),
                agent_id: agent("agent-1"),
                reason: ProbeAgentReason::EnrolledAfterRestore,
            },
            FleetReconcileAction::ProbeRunningRuntime {
                node_id: node("node-1"),
                agent_id: Some(agent("agent-1")),
                runtime_id: runtime("runtime-1"),
                endpoint_id: Some(endpoint("endpoint-1")),
                reason: RunningRuntimeProbeReason::EndpointProbe,
            },
        ]
    );
}

#[test]
fn marks_missing_retired_or_expired_current_capabilities_without_restoring_them() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        Vec::new(),
        vec![
            ObservedEndpoint::new(
                endpoint("endpoint-fresh"),
                node("node-3"),
                runtime("runtime-3"),
                EndpointHealth::Other,
            ),
            ObservedEndpoint::new(
                endpoint("endpoint-retired"),
                node("node-2"),
                runtime("runtime-2"),
                EndpointHealth::Retired,
            ),
        ],
        vec![
            ObservedCapability::new(
                capability("capability-missing"),
                endpoint("endpoint-missing"),
                Some(node("node-1")),
                Some(runtime("runtime-1")),
                1,
                CapabilityFreshness::Current { observed_at: 99 },
            ),
            ObservedCapability::new(
                capability("capability-retired"),
                endpoint("endpoint-retired"),
                None,
                None,
                1,
                CapabilityFreshness::Current { observed_at: 99 },
            ),
            ObservedCapability::new(
                capability("capability-expired"),
                endpoint("endpoint-fresh"),
                None,
                None,
                1,
                CapabilityFreshness::Current { observed_at: 70 },
            ),
        ],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-3")),
                runtime_id: Some(runtime("runtime-3")),
                endpoint_id: endpoint("endpoint-fresh"),
                capability_id: capability("capability-expired"),
                reason: CapabilityStaleReason::ObservationExpired,
                observed_at: Some(70),
            },
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-1")),
                runtime_id: Some(runtime("runtime-1")),
                endpoint_id: endpoint("endpoint-missing"),
                capability_id: capability("capability-missing"),
                reason: CapabilityStaleReason::EndpointMissing,
                observed_at: Some(99),
            },
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-2")),
                runtime_id: Some(runtime("runtime-2")),
                endpoint_id: endpoint("endpoint-retired"),
                capability_id: capability("capability-retired"),
                reason: CapabilityStaleReason::EndpointRetired,
                observed_at: Some(99),
            },
            FleetReconcileAction::PruneRetiredEndpoint {
                node_id: node("node-2"),
                runtime_id: runtime("runtime-2"),
                endpoint_id: endpoint("endpoint-retired"),
            },
        ]
    );
}

#[test]
fn reaps_expired_leases_and_classifies_missing_and_retired_runtime_endpoints() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        vec![
            ObservedRuntime::new(
                runtime("runtime-missing"),
                node("node-1"),
                None,
                None,
                RuntimeLifecycle::Running,
            ),
            ObservedRuntime::new(
                runtime("runtime-retired"),
                node("node-2"),
                None,
                Some(endpoint("endpoint-retired")),
                RuntimeLifecycle::Running,
            ),
        ],
        vec![ObservedEndpoint::new(
            endpoint("endpoint-retired"),
            node("node-2"),
            runtime("runtime-retired"),
            EndpointHealth::Retired,
        )],
        Vec::new(),
        vec![ObservedLease::new(
            lease("lease-1"),
            endpoint("endpoint-retired"),
            LeaseState::Active { expires_at: 100 },
        )],
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [
            FleetReconcileAction::ReapExpiredLease {
                endpoint_id: endpoint("endpoint-retired"),
                lease_id: lease("lease-1"),
                expires_at: 100,
            },
            FleetReconcileAction::PruneRetiredEndpoint {
                node_id: node("node-2"),
                runtime_id: runtime("runtime-retired"),
                endpoint_id: endpoint("endpoint-retired"),
            },
            FleetReconcileAction::ProbeRunningRuntime {
                node_id: node("node-1"),
                agent_id: None,
                runtime_id: runtime("runtime-missing"),
                endpoint_id: None,
                reason: RunningRuntimeProbeReason::EndpointMissing,
            },
            FleetReconcileAction::ProbeRunningRuntime {
                node_id: node("node-2"),
                agent_id: None,
                runtime_id: runtime("runtime-retired"),
                endpoint_id: Some(endpoint("endpoint-retired")),
                reason: RunningRuntimeProbeReason::EndpointRetired,
            },
        ]
    );
}

#[test]
fn ignores_non_current_capabilities_and_non_active_leases() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        vec![ObservedAgent::new(
            agent("agent-1"),
            node("node-1"),
            AgentEnrollment::Other,
        )],
        vec![ObservedRuntime::new(
            runtime("runtime-1"),
            node("node-1"),
            None,
            None,
            RuntimeLifecycle::Other,
        )],
        Vec::new(),
        vec![ObservedCapability::new(
            capability("capability-1"),
            endpoint("endpoint-1"),
            None,
            None,
            1,
            CapabilityFreshness::Stale,
        )],
        vec![ObservedLease::new(
            lease("lease-1"),
            endpoint("endpoint-1"),
            LeaseState::Other,
        )],
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert!(plan.actions().is_empty());
}

#[test]
fn marks_timestamped_unknown_capabilities_stale_when_their_endpoints_are_missing_or_retired() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        Vec::new(),
        vec![ObservedEndpoint::new(
            endpoint("endpoint-retired"),
            node("node-2"),
            runtime("runtime-2"),
            EndpointHealth::Retired,
        )],
        vec![
            ObservedCapability::new(
                capability("capability-missing"),
                endpoint("endpoint-missing"),
                Some(node("node-1")),
                Some(runtime("runtime-1")),
                2,
                CapabilityFreshness::Unknown { observed_at: 99 },
            ),
            ObservedCapability::new(
                capability("capability-retired"),
                endpoint("endpoint-retired"),
                None,
                None,
                2,
                CapabilityFreshness::Unknown { observed_at: 98 },
            ),
        ],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-1")),
                runtime_id: Some(runtime("runtime-1")),
                endpoint_id: endpoint("endpoint-missing"),
                capability_id: capability("capability-missing"),
                reason: CapabilityStaleReason::EndpointMissing,
                observed_at: Some(99),
            },
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-2")),
                runtime_id: Some(runtime("runtime-2")),
                endpoint_id: endpoint("endpoint-retired"),
                capability_id: capability("capability-retired"),
                reason: CapabilityStaleReason::EndpointRetired,
                observed_at: Some(98),
            },
            FleetReconcileAction::PruneRetiredEndpoint {
                node_id: node("node-2"),
                runtime_id: runtime("runtime-2"),
                endpoint_id: endpoint("endpoint-retired"),
            },
        ]
    );
}

#[test]
fn expires_timestamped_unknown_capabilities_without_restoring_descriptors() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        Vec::new(),
        vec![ObservedEndpoint::new(
            endpoint("endpoint-1"),
            node("node-1"),
            runtime("runtime-1"),
            EndpointHealth::Other,
        )],
        vec![ObservedCapability::new(
            capability("capability-1"),
            endpoint("endpoint-1"),
            None,
            None,
            2,
            CapabilityFreshness::Unknown { observed_at: 70 },
        )],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [FleetReconcileAction::MarkCapabilityStale {
            node_id: Some(node("node-1")),
            runtime_id: Some(runtime("runtime-1")),
            endpoint_id: endpoint("endpoint-1"),
            capability_id: capability("capability-1"),
            reason: CapabilityStaleReason::ObservationExpired,
            observed_at: Some(70),
        }]
    );
}

#[test]
fn marks_unobserved_capabilities_stale_when_their_endpoints_are_missing_or_retired() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        Vec::new(),
        vec![ObservedEndpoint::new(
            endpoint("endpoint-retired"),
            node("node-2"),
            runtime("runtime-2"),
            EndpointHealth::Retired,
        )],
        vec![
            ObservedCapability::new(
                capability("capability-missing"),
                endpoint("endpoint-missing"),
                Some(node("node-1")),
                Some(runtime("runtime-1")),
                1,
                CapabilityFreshness::Unobserved,
            ),
            ObservedCapability::new(
                capability("capability-retired"),
                endpoint("endpoint-retired"),
                None,
                None,
                1,
                CapabilityFreshness::Unobserved,
            ),
        ],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert_eq!(
        plan.actions(),
        [
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-1")),
                runtime_id: Some(runtime("runtime-1")),
                endpoint_id: endpoint("endpoint-missing"),
                capability_id: capability("capability-missing"),
                reason: CapabilityStaleReason::EndpointMissing,
                observed_at: None,
            },
            FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(node("node-2")),
                runtime_id: Some(runtime("runtime-2")),
                endpoint_id: endpoint("endpoint-retired"),
                capability_id: capability("capability-retired"),
                reason: CapabilityStaleReason::EndpointRetired,
                observed_at: None,
            },
            FleetReconcileAction::PruneRetiredEndpoint {
                node_id: node("node-2"),
                runtime_id: runtime("runtime-2"),
                endpoint_id: endpoint("endpoint-retired"),
            },
        ]
    );
}

#[test]
fn ignores_unobserved_capabilities_at_healthy_endpoints() {
    let desired = desired(7);
    let applied = applied(7);
    let observed = ObservedFleet::new(
        Vec::new(),
        Vec::new(),
        vec![ObservedEndpoint::new(
            endpoint("endpoint-1"),
            node("node-1"),
            runtime("runtime-1"),
            EndpointHealth::Other,
        )],
        vec![ObservedCapability::new(
            capability("capability-1"),
            endpoint("endpoint-1"),
            None,
            None,
            1,
            CapabilityFreshness::Unobserved,
        )],
        Vec::new(),
    );

    let plan = plan_reconciliation(input(&desired, Some(&applied), &observed), policy());

    assert!(plan.actions().is_empty());
}

#[test]
fn identifiers_reject_blank_values_without_echoing_them() {
    let error = CapabilityId::try_new(" \t").unwrap_err();

    assert_eq!(error.to_string(), "capability ID must not be empty");
}
