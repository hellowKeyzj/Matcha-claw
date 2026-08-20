use std::collections::BTreeMap;

use super::{
    AgentEnrollment, CapabilityFreshness, EndpointHealth, FleetReconcileInput,
    FleetReconcilePolicy, LeaseState, ObservedCapability, ObservedEndpoint, ObservedRuntime,
    RuntimeLifecycle,
};
use super::{
    CapabilityStaleReason, FleetReconcileAction, FleetReconcilePlan, ProbeAgentReason,
    RunningRuntimeProbeReason,
};

pub fn plan_reconciliation(
    input: FleetReconcileInput<'_>,
    policy: FleetReconcilePolicy,
) -> FleetReconcilePlan {
    if input
        .applied()
        .is_none_or(|applied| applied.revision() != input.desired().revision())
    {
        return FleetReconcilePlan::new(
            input.now(),
            vec![FleetReconcileAction::ApplyDesiredRevision {
                revision: input.desired().revision(),
            }],
        );
    }

    let endpoints = input
        .observed()
        .endpoints()
        .iter()
        .map(|endpoint| (endpoint.endpoint_id().as_str(), endpoint))
        .collect::<BTreeMap<_, _>>();
    let mut actions = Vec::new();

    for capability in input.observed().capabilities() {
        let endpoint = endpoints.get(capability.endpoint_id().as_str()).copied();
        match capability_reconciliation(capability, endpoint, input.now(), policy) {
            CapabilityReconciliation::Restore { endpoint } => {
                actions.push(FleetReconcileAction::RestoreDescriptors {
                    node_id: capability.node_id().unwrap_or(endpoint.node_id()).clone(),
                    runtime_id: capability
                        .runtime_id()
                        .unwrap_or(endpoint.runtime_id())
                        .clone(),
                    endpoint_id: capability.endpoint_id().clone(),
                    capability_id: capability.capability_id().clone(),
                    descriptor_count: capability.descriptor_count(),
                });
            }
            CapabilityReconciliation::MarkStale {
                reason,
                observed_at,
            } => {
                actions.push(FleetReconcileAction::MarkCapabilityStale {
                    node_id: capability
                        .node_id()
                        .cloned()
                        .or_else(|| endpoint.map(|value| value.node_id().clone())),
                    runtime_id: capability
                        .runtime_id()
                        .cloned()
                        .or_else(|| endpoint.map(|value| value.runtime_id().clone())),
                    endpoint_id: capability.endpoint_id().clone(),
                    capability_id: capability.capability_id().clone(),
                    reason,
                    observed_at,
                });
            }
            CapabilityReconciliation::Ignore => {}
        }
    }

    for agent in input.observed().agents() {
        let reason = match agent.enrollment() {
            AgentEnrollment::Enrolled => ProbeAgentReason::EnrolledAfterRestore,
            AgentEnrollment::Installed => ProbeAgentReason::InstalledNeedsEnrollment,
            AgentEnrollment::Other => continue,
        };
        actions.push(FleetReconcileAction::ProbeAgent {
            node_id: agent.node_id().clone(),
            agent_id: agent.agent_id().clone(),
            reason,
        });
    }

    for lease in input.observed().leases() {
        if let LeaseState::Active { expires_at } = lease.state()
            && expires_at <= input.now()
        {
            actions.push(FleetReconcileAction::ReapExpiredLease {
                endpoint_id: lease.endpoint_id().clone(),
                lease_id: lease.lease_id().clone(),
                expires_at,
            });
        }
    }

    for endpoint in input.observed().endpoints() {
        if endpoint.health() == EndpointHealth::Retired {
            actions.push(FleetReconcileAction::PruneRetiredEndpoint {
                node_id: endpoint.node_id().clone(),
                runtime_id: endpoint.runtime_id().clone(),
                endpoint_id: endpoint.endpoint_id().clone(),
            });
        }
    }

    for runtime in input.observed().runtimes() {
        if runtime.lifecycle() == RuntimeLifecycle::Running {
            let endpoint = runtime
                .endpoint_id()
                .and_then(|endpoint_id| endpoints.get(endpoint_id.as_str()).copied());
            actions.push(FleetReconcileAction::ProbeRunningRuntime {
                node_id: runtime.node_id().clone(),
                agent_id: runtime.agent_id().cloned(),
                runtime_id: runtime.runtime_id().clone(),
                endpoint_id: runtime.endpoint_id().cloned(),
                reason: running_runtime_probe_reason(runtime, endpoint),
            });
        }
    }

    actions.sort_by(reconciliation_action_order);
    FleetReconcilePlan::new(input.now(), actions)
}

enum CapabilityReconciliation<'a> {
    Restore {
        endpoint: &'a ObservedEndpoint,
    },
    MarkStale {
        reason: CapabilityStaleReason,
        observed_at: Option<u64>,
    },
    Ignore,
}

fn capability_reconciliation<'a>(
    capability: &ObservedCapability,
    endpoint: Option<&'a ObservedEndpoint>,
    now: u64,
    policy: FleetReconcilePolicy,
) -> CapabilityReconciliation<'a> {
    let freshness = capability.freshness();
    let observed_at = match freshness {
        CapabilityFreshness::Current { observed_at }
        | CapabilityFreshness::Unknown { observed_at } => Some(observed_at),
        CapabilityFreshness::Unobserved => None,
        CapabilityFreshness::Stale | CapabilityFreshness::Pruned => {
            return CapabilityReconciliation::Ignore;
        }
    };

    match endpoint {
        None => {
            return CapabilityReconciliation::MarkStale {
                reason: CapabilityStaleReason::EndpointMissing,
                observed_at,
            };
        }
        Some(endpoint) if endpoint.health() == EndpointHealth::Retired => {
            return CapabilityReconciliation::MarkStale {
                reason: CapabilityStaleReason::EndpointRetired,
                observed_at,
            };
        }
        Some(_) => {}
    }

    if observed_at.is_some_and(|value| {
        now >= value && now - value >= policy.capability_stale_after().seconds()
    }) {
        return CapabilityReconciliation::MarkStale {
            reason: CapabilityStaleReason::ObservationExpired,
            observed_at,
        };
    }
    if !matches!(freshness, CapabilityFreshness::Current { .. })
        || capability.descriptor_count() == 0
    {
        return CapabilityReconciliation::Ignore;
    }

    CapabilityReconciliation::Restore {
        endpoint: endpoint.expect("non-retired endpoint was established before restoration"),
    }
}

fn running_runtime_probe_reason(
    runtime: &ObservedRuntime,
    endpoint: Option<&ObservedEndpoint>,
) -> RunningRuntimeProbeReason {
    match (runtime.endpoint_id(), endpoint) {
        (Some(_), Some(endpoint)) if endpoint.health() != EndpointHealth::Retired => {
            RunningRuntimeProbeReason::EndpointProbe
        }
        (Some(_), Some(_)) => RunningRuntimeProbeReason::EndpointRetired,
        _ => RunningRuntimeProbeReason::EndpointMissing,
    }
}

fn reconciliation_action_order(
    left: &FleetReconcileAction,
    right: &FleetReconcileAction,
) -> std::cmp::Ordering {
    reconciliation_action_key(left).cmp(&reconciliation_action_key(right))
}

fn reconciliation_action_key(action: &FleetReconcileAction) -> (u8, &str) {
    match action {
        FleetReconcileAction::RestoreDescriptors { capability_id, .. } => {
            (0, capability_id.as_str())
        }
        FleetReconcileAction::ProbeAgent { agent_id, .. } => (1, agent_id.as_str()),
        FleetReconcileAction::ReapExpiredLease { lease_id, .. } => (2, lease_id.as_str()),
        FleetReconcileAction::MarkCapabilityStale { capability_id, .. } => {
            (3, capability_id.as_str())
        }
        FleetReconcileAction::PruneRetiredEndpoint { endpoint_id, .. } => (4, endpoint_id.as_str()),
        FleetReconcileAction::ProbeRunningRuntime { runtime_id, .. } => (5, runtime_id.as_str()),
        FleetReconcileAction::ApplyDesiredRevision { .. } => (6, ""),
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        lease::LeaseId,
        topology::{NodeId, RuntimeId},
    };
    use platform::{
        capability::CapabilityId,
        endpoint::{EndpointId, NativeAgentId},
    };

    use super::super::{
        AgentEnrollment, CapabilityFreshness, CapabilityStaleAfter, DesiredFleetRevision,
        EndpointHealth, FleetApplied, FleetDesired, FleetReconcileInput, FleetReconcilePolicy,
        LeaseState, ObservedAgent, ObservedCapability, ObservedEndpoint, ObservedFleet,
        ObservedLease, ObservedRuntime, RuntimeLifecycle,
    };
    use super::*;

    fn identity<I, E: std::fmt::Debug>(
        value: &str,
        create: impl FnOnce(String) -> Result<I, E>,
    ) -> I {
        create(value.to_owned()).unwrap()
    }

    fn desired(revision: u64) -> FleetDesired {
        FleetDesired::new(DesiredFleetRevision::new(revision))
    }

    fn applied(revision: u64) -> FleetApplied {
        FleetApplied::new(DesiredFleetRevision::new(revision))
    }

    fn policy(stale_after_seconds: u64) -> FleetReconcilePolicy {
        FleetReconcilePolicy::new(CapabilityStaleAfter::from_seconds(stale_after_seconds))
    }

    fn input<'a>(
        desired: &'a FleetDesired,
        applied: Option<&'a FleetApplied>,
        observed: &'a ObservedFleet,
        now: u64,
    ) -> FleetReconcileInput<'a> {
        FleetReconcileInput::new(desired, applied, observed, now)
    }

    #[test]
    fn requires_current_apply_evidence_before_recovery() {
        let desired = desired(7);
        let observed =
            ObservedFleet::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

        let plan = plan_reconciliation(input(&desired, None, &observed, 100), policy(30));

        assert_eq!(plan.generated_at(), 100);
        assert_eq!(
            plan.actions(),
            [FleetReconcileAction::ApplyDesiredRevision {
                revision: DesiredFleetRevision::new(7),
            }]
        );
    }

    #[test]
    fn plans_restore_agent_probe_and_runtime_probe_in_stable_order() {
        let desired = desired(7);
        let applied = applied(7);
        let observed = ObservedFleet::new(
            vec![ObservedAgent::new(
                identity("agent-1", NativeAgentId::try_new),
                identity("node-1", NodeId::try_new),
                AgentEnrollment::Enrolled,
            )],
            vec![ObservedRuntime::new(
                identity("runtime-1", RuntimeId::try_new),
                identity("node-1", NodeId::try_new),
                Some(identity("agent-1", NativeAgentId::try_new)),
                Some(identity("endpoint-1", EndpointId::try_new)),
                RuntimeLifecycle::Running,
            )],
            vec![ObservedEndpoint::new(
                identity("endpoint-1", EndpointId::try_new),
                identity("node-1", NodeId::try_new),
                identity("runtime-1", RuntimeId::try_new),
                EndpointHealth::Other,
            )],
            vec![ObservedCapability::new(
                identity("capability-1", CapabilityId::try_new),
                identity("endpoint-1", EndpointId::try_new),
                None,
                None,
                2,
                CapabilityFreshness::Current { observed_at: 99 },
            )],
            Vec::new(),
        );

        let plan = plan_reconciliation(input(&desired, Some(&applied), &observed, 100), policy(30));

        assert!(matches!(
            plan.actions()[0],
            FleetReconcileAction::RestoreDescriptors { .. }
        ));
        assert!(matches!(
            plan.actions()[1],
            FleetReconcileAction::ProbeAgent {
                reason: ProbeAgentReason::EnrolledAfterRestore,
                ..
            }
        ));
        assert!(matches!(
            plan.actions()[2],
            FleetReconcileAction::ProbeRunningRuntime {
                reason: RunningRuntimeProbeReason::EndpointProbe,
                ..
            }
        ));
    }

    #[test]
    fn expires_current_capability_without_restoring_descriptors() {
        let desired = desired(7);
        let applied = applied(7);
        let observed = ObservedFleet::new(
            Vec::new(),
            Vec::new(),
            vec![ObservedEndpoint::new(
                identity("endpoint-1", EndpointId::try_new),
                identity("node-1", NodeId::try_new),
                identity("runtime-1", RuntimeId::try_new),
                EndpointHealth::Other,
            )],
            vec![ObservedCapability::new(
                identity("capability-1", CapabilityId::try_new),
                identity("endpoint-1", EndpointId::try_new),
                None,
                None,
                2,
                CapabilityFreshness::Current { observed_at: 70 },
            )],
            Vec::new(),
        );

        let plan = plan_reconciliation(input(&desired, Some(&applied), &observed, 100), policy(30));

        assert_eq!(
            plan.actions(),
            [FleetReconcileAction::MarkCapabilityStale {
                node_id: Some(identity("node-1", NodeId::try_new)),
                runtime_id: Some(identity("runtime-1", RuntimeId::try_new)),
                endpoint_id: identity("endpoint-1", EndpointId::try_new),
                capability_id: identity("capability-1", CapabilityId::try_new),
                reason: CapabilityStaleReason::ObservationExpired,
                observed_at: Some(70),
            }]
        );
    }

    #[test]
    fn reaps_expired_lease_and_classifies_retired_runtime_endpoint() {
        let desired = desired(7);
        let applied = applied(7);
        let observed = ObservedFleet::new(
            Vec::new(),
            vec![ObservedRuntime::new(
                identity("runtime-1", RuntimeId::try_new),
                identity("node-1", NodeId::try_new),
                None,
                Some(identity("endpoint-1", EndpointId::try_new)),
                RuntimeLifecycle::Running,
            )],
            vec![ObservedEndpoint::new(
                identity("endpoint-1", EndpointId::try_new),
                identity("node-1", NodeId::try_new),
                identity("runtime-1", RuntimeId::try_new),
                EndpointHealth::Retired,
            )],
            Vec::new(),
            vec![ObservedLease::new(
                identity("lease-1", LeaseId::try_new),
                identity("endpoint-1", EndpointId::try_new),
                LeaseState::Active { expires_at: 100 },
            )],
        );

        let plan = plan_reconciliation(input(&desired, Some(&applied), &observed, 100), policy(30));

        assert!(matches!(
            plan.actions()[0],
            FleetReconcileAction::ReapExpiredLease {
                expires_at: 100,
                ..
            }
        ));
        assert!(matches!(
            plan.actions()[1],
            FleetReconcileAction::PruneRetiredEndpoint { .. }
        ));
        assert!(matches!(
            plan.actions()[2],
            FleetReconcileAction::ProbeRunningRuntime {
                reason: RunningRuntimeProbeReason::EndpointRetired,
                ..
            }
        ));
    }
}
