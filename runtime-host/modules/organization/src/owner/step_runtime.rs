use std::collections::BTreeSet;

use organization::{
    ActivityKind, ActivityPhase, ActivityRequest, ActivityTarget, ControlExecutionStep,
    GraphRunFacts, GraphRunId, GraphRunLifecycleState, GraphState, NodeId,
    OrganizationStore, RoleId, RoleSessionReceipt, RunStartGate, StoreFault,
};

use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;

const MAX_ACTIVE_ROLE_PROMPTS: usize = 2;

pub(crate) struct TeamRunStepPlan {
    control_steps: Vec<ControlExecutionStep>,
    ready_activity_requests: Vec<ActivityRequest>,
}

impl TeamRunStepPlan {
    pub(crate) fn into_parts(self) -> (Vec<ControlExecutionStep>, Vec<ActivityRequest>) {
        (self.control_steps, self.ready_activity_requests)
    }
}

pub(crate) struct TeamRunStepPlanner<'a> {
    store: &'a OrganizationStore,
}

impl<'a> TeamRunStepPlanner<'a> {
    pub(crate) fn new(store: &'a OrganizationStore) -> Self {
        Self { store }
    }

    pub(crate) fn plan(
        &self,
        run: &GraphRunFacts,
        now: u64,
    ) -> Result<TeamRunStepPlan, StoreFault> {
        runtime_trace("runtime.team_run.schedule.plan.input", || json!({
            "runHash": identifier_hash(run.run_id().as_str()),
            "now": now,
            "lifecycle": match run.lifecycle().state() {
                GraphRunLifecycleState::Active => "active",
                GraphRunLifecycleState::Cancelling { .. } => "cancelling",
                GraphRunLifecycleState::Cancelled { .. } => "cancelled",
                GraphRunLifecycleState::OutcomeUnknown { .. } => "outcome_unknown",
                GraphRunLifecycleState::Tombstoned { .. } => "tombstoned",
            },
            "startGate": match run.start_gate() {
                RunStartGate::Intake => "intake",
                RunStartGate::Designing { .. } => "designing",
                RunStartGate::Started => "started",
            },
            "graph": crate::trace::graph(run.graph()),
            "readyQueueCount": run.graph().ready_queue().len(),
            "bindingCount": run.runtime().map_or(0, |runtime| runtime.bindings().len()),
            "latestAttemptCreatedAt": run.graph().executions().values()
                .map(|history| history.current().created_at()).max(),
            "latestAttemptUpdatedAt": run.graph().executions().values()
                .map(|history| history.current().updated_at()).max(),
        }));
        if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
            runtime_trace("runtime.team_run.schedule.plan.skip", || json!({
                "runHash": identifier_hash(run.run_id().as_str()), "reason": "lifecycle_not_active",
            }));
            return Ok(TeamRunStepPlan {
                control_steps: Vec::new(),
                ready_activity_requests: Vec::new(),
            });
        }
        if !matches!(run.start_gate(), RunStartGate::Started) {
            runtime_trace("runtime.team_run.schedule.plan.skip", || json!({
                "runHash": identifier_hash(run.run_id().as_str()), "reason": "start_gate_not_started",
            }));
            return Ok(TeamRunStepPlan {
                control_steps: Vec::new(),
                ready_activity_requests: Vec::new(),
            });
        }

        let (control_plan, planned_graph) = crate::run::control::plan_ready_control_execution_state(
            run.graph().definition(),
            run.graph(),
            self.store.facts().evidence(),
            now,
        )
        .map_err(|error| {
            runtime_trace("runtime.team_run.schedule.control.plan.error", || {
                use organization::run::control::ControlExecutionError;
                json!({
                    "runHash": identifier_hash(run.run_id().as_str()),
                    "nodeHash": match &error {
                        ControlExecutionError::OutputPortDoesNotMatchEdge { node_id }
                        | ControlExecutionError::UnknownReadyNode(node_id)
                        | ControlExecutionError::StaleReadyQueue(node_id) => Some(identifier_hash(node_id.as_str())),
                        _ => None,
                    },
                    "errorKind": match &error {
                        ControlExecutionError::GraphDefinitionMismatch => "GraphDefinitionMismatch",
                        ControlExecutionError::InvalidDefinition(_) => "InvalidDefinition",
                        ControlExecutionError::UnknownReadyNode(_) => "UnknownReadyNode",
                        ControlExecutionError::StaleReadyQueue(_) => "StaleReadyQueue",
                        ControlExecutionError::OutputPortDoesNotMatchEdge { .. } => "OutputPortDoesNotMatchEdge",
                        ControlExecutionError::ControlResolution(_) => "ControlResolution",
                        ControlExecutionError::Reduce(_) => "Reduce",
                    },
                })
            });
            StoreFault::ControlExecution(error)
        })?;
        let control_steps = control_plan.into_steps();
        runtime_trace("runtime.team_run.schedule.control.plan.end", || json!({
            "runHash": identifier_hash(run.run_id().as_str()), "controlCount": control_steps.len(),
        }));
        let ready_activity_requests =
            self.plan_ready_activity_requests(run, &planned_graph, now)?;

        Ok(TeamRunStepPlan {
            control_steps,
            ready_activity_requests,
        })
    }

    fn plan_ready_activity_requests(
        &self,
        run: &GraphRunFacts,
        graph: &GraphState,
        now: u64,
    ) -> Result<Vec<ActivityRequest>, StoreFault> {
        let mut reserved = active_run_session_slots(self.store, run.run_id());
        let active_session_count = reserved.len();
        let bindings = run
            .runtime()
            .map(|runtime| runtime.bindings())
            .unwrap_or(&[]);
        let selected = organization::run::scheduler::schedule_ready_nodes_with(
            graph,
            MAX_ACTIVE_ROLE_PROMPTS,
            active_session_count.min(MAX_ACTIVE_ROLE_PROMPTS),
            |item| {
                let trace_skip = |reason: &'static str| {
                    runtime_trace("runtime.team_run.schedule.activity.skip", || json!({
                        "runHash": identifier_hash(run.run_id().as_str()),
                        "nodeHash": identifier_hash(item.node_id().as_str()),
                        "reason": reason,
                    }));
                };
                let ActivityKind::AgentTask {
                    role_id,
                    session_ref,
                    ..
                } = item.activity_kind()
                else {
                    trace_skip("not_agent_task");
                    return None;
                };
                let Some(binding) =
                    binding_for_node_executor(bindings, role_id, session_ref, item.node_id())
                else {
                    trace_skip("binding_missing");
                    return None;
                };
                if !reserved.insert(session_slot_key(
                    binding.role().as_str(),
                    binding.session_ref().as_str(),
                )) {
                    trace_skip("session_slot_reserved");
                    return None;
                }
                Some((item, binding))
            },
        )
        .map_err(|error| {
            runtime_trace("runtime.team_run.schedule.activity.plan.error", || {
                use organization::run::scheduler::ReadyScheduleError;
                json!({
                    "runHash": identifier_hash(run.run_id().as_str()),
                    "errorKind": match &error {
                        ReadyScheduleError::ZeroParallelLimit => "ZeroParallelLimit",
                        ReadyScheduleError::ActiveParallelExceedsLimit => "ActiveParallelExceedsLimit",
                        ReadyScheduleError::StaleReadyQueue(_) => "StaleReadyQueue",
                    },
                })
            });
            StoreFault::ReadySchedule(error)
        })?;
        runtime_trace("runtime.team_run.schedule.activity.selected", || json!({
            "runHash": identifier_hash(run.run_id().as_str()),
            "activeSessionCount": active_session_count,
            "parallelLimit": MAX_ACTIVE_ROLE_PROMPTS,
            "readyQueueCount": graph.ready_queue().len(),
            "selectedCount": selected.len(),
        }));
        let mut activity_requests = Vec::new();

        for (item, binding) in selected {
            let activity = item.bind_activity_target(
                    ActivityTarget::new(binding.session_ref().as_str().to_owned())
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    now,
                    organization::run::delivery::DELIVERY_MAX_ATTEMPTS,
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
            activity_requests.push(activity);
        }

        Ok(activity_requests)
    }
}

pub(crate) fn active_run_session_slots(
    store: &OrganizationStore,
    run_id: &GraphRunId,
) -> BTreeSet<String> {
    let Some(run) = store.facts().run(run_id) else {
        return BTreeSet::new();
    };
    store
        .facts()
        .activities_for_run(run_id.as_str())
        .filter(|activity| match activity.phase() {
            ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. } => {
                !run.graph().is_rework_blocked(&activity.facts().node_id)
            }
            ActivityPhase::Claimed(_)
            | ActivityPhase::Dispatched(_)
            | ActivityPhase::OutcomeUnknown { .. }
            | ActivityPhase::TerminalObserved { .. } => true,
            _ => false,
        })
        .filter_map(|activity| match &activity.facts().activity_kind {
            ActivityKind::AgentTask { role_id, .. } => {
                Some(session_slot_key(role_id, activity.facts().target.as_str()))
            }
            _ => None,
        })
        .collect()
}

fn session_slot_key(role_id: &str, session_ref: &str) -> String {
    format!("{role_id}:{session_ref}")
}

fn binding_for_node_executor<'a>(
    bindings: &'a [RoleSessionReceipt],
    role_id: &str,
    session_ref: &str,
    node_id: &NodeId,
) -> Option<&'a RoleSessionReceipt> {
    let role = RoleId::try_new(role_id.to_owned()).ok()?;
    let mut role_bindings = bindings
        .iter()
        .filter(|binding| binding.role() == &role)
        .collect::<Vec<_>>();
    if role_bindings.len() <= 1 {
        return role_bindings.pop();
    }
    let session_ref = if session_ref.trim().is_empty() {
        node_session_ref(node_id)
    } else {
        session_ref.to_owned()
    };
    role_bindings
        .into_iter()
        .find(|binding| binding.session_ref().as_str() == session_ref)
}

fn node_session_ref(node_id: &NodeId) -> String {
    let digits = node_id
        .as_str()
        .rsplit(|value: char| !value.is_ascii_digit())
        .find(|value| !value.is_empty())
        .unwrap_or("0");
    format!("rs{digits}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use organization::EndpointSessionId;
    use organization::{
        ManagedAgentReference, RuntimeEndpointReference, TeamId,
    };

    #[test]
    fn node_executor_prefers_explicit_session_ref_for_same_role() {
        let run_id = GraphRunId::new("run:test");
        let first = binding(&run_id, "worker", "rs0", "agent:0");
        let second = binding(&run_id, "worker", "rs1", "agent:1");
        let bindings = vec![first, second.clone()];

        let selected =
            binding_for_node_executor(&bindings, "worker", "rs1", &NodeId::new("work-0")).unwrap();

        assert_eq!(selected, &second);
    }

    fn binding(
        run_id: &GraphRunId,
        role: &str,
        session_ref: &str,
        agent: &str,
    ) -> RoleSessionReceipt {
        RoleSessionReceipt::with_endpoint_session_id(
            TeamId::try_new("team:test").unwrap(),
            run_id.clone(),
            RoleId::try_new(role).unwrap(),
            organization::RoleSessionRef::try_new(session_ref).unwrap(),
            EndpointSessionId::try_new(format!("endpoint:{agent}")).unwrap(),
            ManagedAgentReference::try_new(agent).unwrap(),
            RuntimeEndpointReference::try_new("runtime:test").unwrap(),
        )
    }
}
