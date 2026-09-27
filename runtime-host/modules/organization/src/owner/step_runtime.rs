use std::collections::BTreeSet;

use organization::{
    ActivityKind, ActivityPhase, ActivityRequest, ActivityTarget, AuthorizedGraphOutcome,
    ControlExecutionStep, DeliveryPhase, ExecutionFence, GraphDefinition, GraphEvent,
    GraphRunFacts, GraphRunId, GraphRunLifecycleState, GraphState, NodeId, OrganizationStore,
    RoleId, RoleSessionReceipt, RunStartGate, StoreFault, TeamNodeOutput,
};

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
        if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
            return Ok(TeamRunStepPlan {
                control_steps: Vec::new(),
                ready_activity_requests: Vec::new(),
            });
        }
        if !matches!(run.start_gate(), RunStartGate::Started) {
            return Ok(TeamRunStepPlan {
                control_steps: Vec::new(),
                ready_activity_requests: Vec::new(),
            });
        }

        let control_steps = organization::run::control::plan_ready_control_execution(
            run.graph().definition(),
            run.graph(),
            now,
        )
        .map_err(|_| StoreFault::InvalidFacts)?
        .into_steps();
        let planned_graph = graph_after_control_steps(run.graph(), &control_steps)?;
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
        .map_err(|_| StoreFault::InvalidFacts)?;
        let bindings = run
            .runtime()
            .map(|runtime| runtime.bindings())
            .unwrap_or(&[]);
        let mut reserved = active_session_slots;
        let mut activity_requests = Vec::new();

        for item in selected {
            let Some(node) = graph.definition().node(item.node_id()) else {
                continue;
            };
            let ActivityKind::AgentTask {
                role_id,
                session_ref,
                ..
            } = item.activity_kind()
            else {
                continue;
            };
            let Some(binding) =
                binding_for_node_executor(bindings, role_id, session_ref, item.node_id())
            else {
                continue;
            };
            if !reserved.insert(session_slot_key(
                binding.role().as_str(),
                binding.session_ref().as_str(),
            )) {
                continue;
            }
            let activity = compose_activity_prompt(
                self.store,
                run.run_id(),
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
        planned_graph = organization::reduce(planned_graph, graph_event_for_control_step(step))
            .map_err(|_| StoreFault::InvalidFacts)?;
    }
    Ok(planned_graph)
}

fn graph_event_for_control_step(step: &ControlExecutionStep) -> GraphEvent {
    match step {
        ControlExecutionStep::GraphEvent(event) => event.clone(),
        ControlExecutionStep::ControlResolution(resolution) => match resolution.outcome() {
            AuthorizedGraphOutcome::Completed => GraphEvent::NodeCompleted {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                completed_at: resolution.resolved_at(),
            },
            AuthorizedGraphOutcome::Failed => GraphEvent::NodeFailed {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                failed_at: resolution.resolved_at(),
            },
        },
    }
}

fn compose_activity_prompt(
    store: &OrganizationStore,
    run_id: &GraphRunId,
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
    let upstream = upstream_prompt_contexts(store, run_id, graph, &request, role_id);
    let prompt = organization::run::scheduler::compose_agent_task_prompt_with_upstream_context(
        graph.definition(),
        node,
        base_prompt(node).ok_or(StoreFault::InvalidFacts)?,
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

fn base_prompt(node: &organization::NodeDefinition) -> Option<&str> {
    match node.kind() {
        organization::NodeKind::Work => node.work_assignment().map(|work| work.prompt()),
        organization::NodeKind::Review => node.review_assignment().map(|review| review.prompt()),
        organization::NodeKind::Start
        | organization::NodeKind::HumanDecision
        | organization::NodeKind::ScriptReview
        | organization::NodeKind::Join
        | organization::NodeKind::End => None,
    }
}

fn upstream_prompt_contexts<'a>(
    store: &'a OrganizationStore,
    run_id: &GraphRunId,
    graph: &GraphState,
    request: &ActivityRequest,
    role_id: &str,
) -> Vec<organization::run::scheduler::UpstreamPromptContext<'a>> {
    let Some(attempt) = graph.current_attempt(&request.node_id) else {
        return Vec::new();
    };
    attempt
        .inputs()
        .iter()
        .filter(|input| {
            includes_upstream_result(graph.definition(), &request.node_id, input.edge_id())
        })
        .filter_map(|input| upstream_output(store, run_id, input.source_fence()))
        .map(
            |output| organization::run::scheduler::UpstreamPromptContext {
                summary: output.summary(),
                tasks: output
                    .dispatch()
                    .iter()
                    .filter(|dispatch| dispatch.role_id() == role_id)
                    .map(|dispatch| dispatch.task())
                    .collect(),
            },
        )
        .collect()
}

fn includes_upstream_result(
    definition: &GraphDefinition,
    node_id: &NodeId,
    edge_id: &organization::EdgeId,
) -> bool {
    definition
        .incoming_edges(node_id)
        .any(|edge| edge.id() == edge_id && edge.payload().include_upstream_result())
}

fn upstream_output<'a>(
    store: &'a OrganizationStore,
    run_id: &GraphRunId,
    source_fence: &ExecutionFence,
) -> Option<&'a TeamNodeOutput> {
    store
        .facts()
        .deliveries()
        .deliveries()
        .filter(|delivery| {
            delivery.facts().run_id == run_id.as_str()
                && delivery.facts().node_execution_id == source_fence.node_execution_id().as_str()
        })
        .filter_map(|delivery| match delivery.phase() {
            DeliveryPhase::TerminalObserved { observation } => match observation.resolution() {
                organization::run::delivery::TerminalObservationResolution::GraphResolved(_) => {
                    observation.output()
                }
                organization::run::delivery::TerminalObservationResolution::AwaitingAuthorizedGraphResolution
                | organization::run::delivery::TerminalObservationResolution::NodeCancelled => None,
            },
            DeliveryPhase::Pending
            | DeliveryPhase::Delivering(_)
            | DeliveryPhase::RetryScheduled { .. }
            | DeliveryPhase::Delivered { .. }
            | DeliveryPhase::Failed { .. }
            | DeliveryPhase::OutcomeUnknown { .. }
            | DeliveryPhase::Cancelled { .. } => None,
        })
        .next()
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
            GraphRunId::new("run:test"),
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
                        None,
                    ),
                ),
            ],
            vec![disabled, enabled],
        )
        .unwrap();

        assert!(!includes_upstream_result(
            &definition,
            &target,
            &EdgeId::new("disabled")
        ));
        assert!(includes_upstream_result(
            &definition,
            &target,
            &EdgeId::new("enabled")
        ));
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
