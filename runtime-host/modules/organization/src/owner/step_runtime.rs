use std::collections::{BTreeMap, BTreeSet};

use organization::{
    ActivityKind, ActivityPhase, ActivityRequest, ActivityTarget, ControlExecutionStep,
    DeliveryPhase, GraphRunFacts, GraphRunId, GraphRunLifecycleState, GraphState, NodeId,
    NodeKind, OrganizationStore, RoleId, RoleSessionReceipt, RunStartGate, StoreFault,
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

        let control_steps = organization::run::control::plan_ready_control_execution(
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
        })?
        .into_steps();
        runtime_trace("runtime.team_run.schedule.control.plan.end", || json!({
            "runHash": identifier_hash(run.run_id().as_str()), "controlCount": control_steps.len(),
        }));
        let planned_graph = graph_after_control_steps(run.graph(), &control_steps).inspect_err(|_| {
            runtime_trace("runtime.team_run.schedule.control.reduce.error", || json!({
                "runHash": identifier_hash(run.run_id().as_str()), "reason": "graph_reduce",
            }));
        })?;
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
        let active_session_slots = active_run_session_slots(self.store, run.run_id());
        let selected = organization::run::scheduler::schedule_ready_nodes(
            graph,
            MAX_ACTIVE_ROLE_PROMPTS,
            active_session_slots.len().min(MAX_ACTIVE_ROLE_PROMPTS),
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
            "activeSessionCount": active_session_slots.len(),
            "parallelLimit": MAX_ACTIVE_ROLE_PROMPTS,
            "readyQueueCount": graph.ready_queue().len(),
            "selectedCount": selected.len(),
        }));
        let bindings = run
            .runtime()
            .map(|runtime| runtime.bindings())
            .unwrap_or(&[]);
        let mut reserved = active_session_slots;
        let mut activity_requests = Vec::new();

        for item in selected {
            let trace_skip = |reason: &'static str| {
                runtime_trace("runtime.team_run.schedule.activity.skip", || json!({
                    "runHash": identifier_hash(run.run_id().as_str()),
                    "nodeHash": identifier_hash(item.node_id().as_str()),
                    "reason": reason,
                }));
            };
            let Some(node) = graph.definition().node(item.node_id()) else {
                trace_skip("node_missing");
                continue;
            };
            let ActivityKind::AgentTask {
                role_id,
                session_ref,
                ..
            } = item.activity_kind()
            else {
                trace_skip("not_agent_task");
                continue;
            };
            let Some(binding) =
                binding_for_node_executor(bindings, role_id, session_ref, item.node_id())
            else {
                trace_skip("binding_missing");
                continue;
            };
            if !reserved.insert(session_slot_key(
                binding.role().as_str(),
                binding.session_ref().as_str(),
            )) {
                trace_skip("session_slot_reserved");
                continue;
            }
            let activity = compose_activity_prompt(
                self.store,
                run,
                graph,
                item.bind_activity_target(
                    ActivityTarget::new(binding.session_ref().as_str().to_owned())
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    now,
                    node.max_attempts().get(),
                )
                .map_err(|_| StoreFault::InvalidFacts)?,
            )?;
            activity_requests.push(activity);
        }

        Ok(activity_requests)
    }
}

fn graph_after_control_steps(
    graph: &GraphState,
    control_steps: &[ControlExecutionStep],
) -> Result<GraphState, StoreFault> {
    let mut planned_graph = graph.clone();
    for step in control_steps {
        planned_graph = organization::reduce(
            planned_graph,
            crate::run::control::graph_event_for_step(step),
        )
        .map_err(StoreFault::GraphReduce)?;
    }
    Ok(planned_graph)
}

fn compose_activity_prompt(
    store: &OrganizationStore,
    run: &GraphRunFacts,
    graph: &GraphState,
    request: ActivityRequest,
) -> Result<ActivityRequest, StoreFault> {
    let ActivityKind::AgentTask {
        task_id,
        role_id,
        session_ref,
        prompt: _,
    } = &request.activity_kind
    else {
        return Ok(request);
    };
    let node = graph
        .definition()
        .node(&request.node_id)
        .ok_or(StoreFault::InvalidFacts)?;
    let upstream = upstream_prompt_contexts(store, run.run_id(), graph, &request);
    let prompt = organization::run::scheduler::compose_agent_task_prompt_with_upstream_context(
        run.team(),
        node,
        &request,
        &upstream,
    )
    .ok_or(StoreFault::InvalidFacts)?;
    Ok(ActivityRequest {
        activity_kind: ActivityKind::AgentTask {
            task_id: task_id.clone(),
            role_id: role_id.clone(),
            session_ref: session_ref.clone(),
            prompt,
        },
        ..request
    })
}

fn upstream_prompt_contexts<'a>(
    store: &'a OrganizationStore,
    run_id: &GraphRunId,
    graph: &GraphState,
    request: &ActivityRequest,
) -> Vec<organization::run::scheduler::UpstreamPromptContext<'a>> {
    let Some(attempt) = graph.current_attempt(&request.node_id) else {
        return Vec::new();
    };
    if attempt.inputs().is_empty() {
        return Vec::new();
    }
    let edges = graph
        .definition()
        .edges()
        .iter()
        .map(|edge| (edge.id(), edge))
        .collect::<BTreeMap<_, _>>();
    let attempts = graph
        .executions()
        .values()
        .flat_map(|history| history.attempts())
        .map(|attempt| ((attempt.node_id().as_str(), attempt.fence()), attempt))
        .collect::<BTreeMap<_, _>>();
    let mut outputs = BTreeMap::new();
    for delivery in store.facts().deliveries().deliveries() {
        if delivery.facts().run_id != run_id.as_str() {
            continue;
        }
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            continue;
        };
        if matches!(
            observation.resolution(),
            organization::run::delivery::TerminalObservationResolution::GraphResolved(_)
        ) {
            if let Some(output) = observation.output() {
                outputs
                    .entry((observation.node_id(), observation.fence()))
                    .or_insert(output);
            }
        }
    }
    let mut pending = attempt
        .inputs()
        .iter()
        .rev()
        .map(|input| (attempt.node_id(), input))
        .collect::<Vec<_>>();
    let mut visited_joins = BTreeSet::new();
    let mut included_executions = BTreeSet::new();
    let mut contexts = Vec::new();
    while let Some((target_node_id, input)) = pending.pop() {
        let Some(edge) = edges.get(input.edge_id()) else {
            continue;
        };
        if edge.target_node_id() != target_node_id || !edge.payload().include_upstream_result() {
            continue;
        }
        let source_key = (input.source_node_id().as_str(), input.source_fence());
        let Some(source) = attempts.get(&source_key) else {
            continue;
        };
        if source.node_kind() == NodeKind::Join {
            if visited_joins.insert(source.fence()) {
                pending.extend(
                    source.inputs().iter().rev().map(|input| (source.node_id(), input)),
                );
            }
        } else if included_executions.insert(source.fence().node_execution_id()) {
            if let Some(output) = outputs.get(&source_key) {
                contexts.push(organization::run::scheduler::UpstreamPromptContext {
                    summary: output.summary(),
                });
            }
        }
    }
    contexts
}

pub(crate) fn active_run_session_slots(
    store: &OrganizationStore,
    run_id: &GraphRunId,
) -> BTreeSet<String> {
    store
        .facts()
        .activities()
        .activities()
        .filter(|activity| activity.facts().run_id == *run_id)
        .filter(|activity| {
            matches!(
                activity.phase(),
                ActivityPhase::Pending
                    | ActivityPhase::RetryScheduled { .. }
                    | ActivityPhase::Claimed(_)
                    | ActivityPhase::Dispatched(_)
            )
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
        EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutorPolicy, GraphDefinition,
        GraphRunId, ManagedAgentReference, NodeDefinition, RuntimeEndpointReference, TeamId,
        WorkAssignment,
    };

    #[test]
    fn upstream_context_respects_edge_payload_policy() {
        let source = NodeId::new("source");
        let target = NodeId::new("target");
        let disabled = EdgeDefinition::new(
            EdgeId::new("disabled"),
            source.clone(),
            "completed",
            target.clone(),
            "input",
            EdgeAction::Activate,
        )
        .with_payload(EdgePayloadPolicy::new(false));
        let enabled = EdgeDefinition::new(
            EdgeId::new("enabled"),
            source.clone(),
            "completed",
            target.clone(),
            "input",
            EdgeAction::Activate,
        );
        let definition = GraphDefinition::new(
            "graph:test",
            "plan:test",
            GraphRunId::new("run:one"),
            "upstream filter",
            vec![
                NodeDefinition::work(
                    source,
                    "source",
                    std::num::NonZeroU32::new(1).unwrap(),
                    WorkAssignment::typed(
                        "task:source",
                        "source prompt",
                        ExecutorPolicy::team_role("leader"),
                        None,
                    ),
                ),
                NodeDefinition::work(
                    target.clone(),
                    "target",
                    std::num::NonZeroU32::new(1).unwrap(),
                    WorkAssignment::typed(
                        "task:target",
                        "target prompt",
                        ExecutorPolicy::team_role("leader"),
                        None,
                    ),
                ),
            ],
            vec![disabled, enabled],
        )
        .unwrap();

        for (edge_id, expected) in [("disabled", Vec::new()), ("enabled", vec!["source result"])] {
            let definition = GraphDefinition::new(
                definition.graph_id(), definition.workflow_plan_id(), definition.run_id().clone(), definition.title(),
                definition.nodes().to_vec(),
                definition.edges().iter().filter(|edge| edge.id().as_str() == edge_id).cloned().collect(),
            ).unwrap();
            let (_temp, mut store) = crate::owner::actor::tests::store_with_graph(
                GraphState::initialize(definition, 1),
            );
            let (_claim, delivery_id, session) =
                crate::owner::actor::tests::claim_native_activity(&mut store, 3);
            store.accept_native_terminal_context(&delivery_id, session, "native:source".into()).unwrap();
            crate::owner::actor::tests::settle_native_output(
                &mut store,
                &delivery_id,
                organization::NativeTerminalStatus::Completed,
                Some(r#"<team_message>{"summary":"source result","decision":"completed"}</team_message>"#.into()),
                5,
            );
            let run_id = GraphRunId::new("run:one");
            let graph = store.facts().run(&run_id).unwrap().graph();
            let scheduled = organization::run::scheduler::schedule_ready_nodes(graph, 1, 0).unwrap();
            let request = scheduled[0].bind_activity_target(ActivityTarget::new("rs0").unwrap(), 6, 1).unwrap();
            let contexts = upstream_prompt_contexts(&store, &run_id, graph, &request);
            assert_eq!(contexts.iter().map(|context| context.summary).collect::<Vec<_>>(), expected);
        }
    }

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
