use std::collections::BTreeSet;

use organization::{
    ActivityId, ActivityKind, ActivityPhase, ActivityRequest, ActivityTarget, DeliveryPhase,
    GraphRunFacts, GraphRunId, GraphRunLifecycleState, NodeId, OrganizationStore, RoleId,
    RoleSessionReceipt, RunStartGate, StoreFault, TeamNodeOutput,
};

use runtime_directory::RuntimeDriverIdentity;

use crate::owner::team_run::{TeamRunActivityTarget, TeamRunOwner};

pub(crate) fn schedule_ready_nodes(
    team_run: &TeamRunOwner,
    store: &mut OrganizationStore,
    run_id: GraphRunId,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    const MAX_ACTIVE_ROLE_PROMPTS: usize = 2;
    let Some(run) = store.facts().run(&run_id).cloned() else {
        return Ok(Vec::new());
    };
    if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
        return Ok(Vec::new());
    }
    if !matches!(run.start_gate(), RunStartGate::Started) {
        return Ok(Vec::new());
    }

    let control = organization::run::control::plan_ready_control_execution(
        run.graph().definition(),
        run.graph(),
        now,
    )
    .map_err(|_| StoreFault::InvalidFacts)?;
    for step in control.into_steps() {
        team_run.apply_control_execution_step(store, &run_id, step)?;
    }
    let run = store
        .facts()
        .run(&run_id)
        .cloned()
        .ok_or(StoreFault::InvalidFacts)?;
    let active_session_slots = active_run_session_slots(store, &run_id);
    let selected = organization::run::scheduler::schedule_ready_nodes(
        run.graph(),
        MAX_ACTIVE_ROLE_PROMPTS,
        active_session_slots.len().min(MAX_ACTIVE_ROLE_PROMPTS),
    )
    .map_err(|_| StoreFault::InvalidFacts)?;
    let bindings = run
        .runtime()
        .map(|runtime| runtime.bindings())
        .unwrap_or(&[]);
    let mut reserved = active_session_slots;
    let mut activity_ids = Vec::new();

    for item in selected {
        let Some(node) = run.graph().definition().node(item.node_id()) else {
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
            store,
            &run,
            item.bind_activity_target(
                ActivityTarget::new(binding.session_ref().as_str().to_owned())
                    .map_err(|_| StoreFault::InvalidFacts)?,
                now,
                node.max_attempts().get(),
            )
            .map_err(|_| StoreFault::InvalidFacts)?,
        )?;
        match store.register_activity_and_start_attempt(activity, now)? {
            organization::ActivityRegistrationOutcome::Recorded(activity)
            | organization::ActivityRegistrationOutcome::Replayed(activity) => {
                activity_ids.push(activity.facts().activity_id.clone());
            }
            organization::ActivityRegistrationOutcome::ConflictingIdempotencyKey
            | organization::ActivityRegistrationOutcome::ConflictingActivityId { .. } => {
                return Err(StoreFault::InvalidFacts);
            }
        }
    }
    Ok(activity_ids)
}

fn compose_activity_prompt(
    store: &OrganizationStore,
    run: &GraphRunFacts,
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
    let node = run
        .graph()
        .definition()
        .node(&request.node_id)
        .ok_or(StoreFault::InvalidFacts)?;
    let upstream = upstream_prompt_contexts(store, run, &request, role_id);
    let prompt = organization::run::scheduler::compose_agent_task_prompt_with_upstream_context(
        run.graph().definition(),
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
    run: &GraphRunFacts,
    request: &ActivityRequest,
    role_id: &str,
) -> Vec<organization::run::scheduler::UpstreamPromptContext<'a>> {
    let Some(attempt) = run.graph().current_attempt(&request.node_id) else {
        return Vec::new();
    };
    attempt
        .inputs()
        .iter()
        .filter(|input| {
            includes_upstream_result(run.graph().definition(), &request.node_id, input.edge_id())
        })
        .filter_map(|input| upstream_output(store, run, input.source_fence()))
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
    definition: &organization::GraphDefinition,
    node_id: &NodeId,
    edge_id: &organization::EdgeId,
) -> bool {
    definition
        .incoming_edges(node_id)
        .any(|edge| edge.id() == edge_id && edge.payload().include_upstream_result())
}

fn upstream_output<'a>(
    store: &'a OrganizationStore,
    run: &GraphRunFacts,
    source_fence: &organization::ExecutionFence,
) -> Option<&'a TeamNodeOutput> {
    store
        .facts()
        .deliveries()
        .deliveries()
        .filter(|delivery| {
            delivery.facts().run_id == run.run_id().as_str()
                && delivery.facts().node_execution_id == source_fence.node_execution_id().as_str()
        })
        .filter_map(|delivery| match delivery.phase() {
            DeliveryPhase::TerminalObserved { observation } => match observation.resolution() {
                organization::run::delivery::TerminalObservationResolution::GraphResolved(_) => observation.output(),
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

pub(crate) fn binding_for_activity_target<'a>(
    bindings: &'a [RoleSessionReceipt],
    role_id: &str,
    target: &ActivityTarget,
) -> Option<&'a RoleSessionReceipt> {
    let role = RoleId::try_new(role_id.to_owned()).ok()?;
    bindings.iter().find(|binding| {
        binding.role() == &role && binding.session_ref().as_str() == target.as_str()
    })
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

pub(crate) fn pending_run_activity_ids(
    store: &OrganizationStore,
    run_id: &GraphRunId,
    now: u64,
) -> Vec<ActivityId> {
    if !run_allows_activity_execution(store, run_id) {
        return Vec::new();
    }
    store
        .facts()
        .activities()
        .activities()
        .filter(|activity| activity.facts().run_id == *run_id)
        .filter_map(|activity| match activity.phase() {
            ActivityPhase::Pending => Some(activity.facts().activity_id.clone()),
            ActivityPhase::RetryScheduled { retry_at, .. } if *retry_at <= now => {
                Some(activity.facts().activity_id.clone())
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn run_allows_activity_execution(
    store: &OrganizationStore,
    run_id: &GraphRunId,
) -> bool {
    store.facts().run(run_id).is_some_and(|run| {
        matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
            && matches!(run.start_gate(), RunStartGate::Started)
    })
}

pub(crate) fn activity_belongs_to(
    store: &OrganizationStore,
    run_id: &GraphRunId,
    activity_id: &ActivityId,
) -> bool {
    store
        .facts()
        .activities()
        .activity(activity_id)
        .is_some_and(|activity| activity.facts().run_id == *run_id)
}

pub(crate) fn activity_target(
    store: &OrganizationStore,
    activity_id: &ActivityId,
) -> Option<TeamRunActivityTarget> {
    let activity = store.facts().activities().activity(activity_id)?;
    let run_id = activity.facts().run_id.clone();
    let run = store.facts().run(&run_id)?;
    let ActivityKind::AgentTask { role_id, .. } = &activity.facts().activity_kind else {
        return None;
    };
    let binding =
        binding_for_activity_target(run.runtime()?.bindings(), role_id, &activity.facts().target)?;
    if binding.endpoint().as_str()
        == RuntimeDriverIdentity::open_claw().runtime_endpoint_reference()
    {
        Some(TeamRunActivityTarget::OpenClaw { run_id })
    } else if binding.endpoint().as_str()
        == RuntimeDriverIdentity::matcha_agent().runtime_endpoint_reference()
    {
        Some(TeamRunActivityTarget::Matcha { run_id })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use organization::EndpointSessionId;
    use organization::{
        EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutorPolicy, GraphDefinition,
        GraphRunId, ManagedAgentReference, NodeDefinition, NodeId, RoleId, RoleSessionRef,
        RuntimeEndpointReference, TeamId, WorkAssignment,
    };

    #[test]
    fn binding_lookup_uses_role_and_session_ref() {
        let run_id = GraphRunId::new("run:test");
        let first = binding(&run_id, "worker", "rs0", "agent:0");
        let second = binding(&run_id, "worker", "rs1", "agent:1");
        let bindings = vec![first, second.clone()];

        let selected =
            binding_for_activity_target(&bindings, "worker", &ActivityTarget::new("rs1").unwrap())
                .unwrap();

        assert_eq!(selected, &second);
    }

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
            RoleSessionRef::try_new(session_ref).unwrap(),
            EndpointSessionId::try_new(format!("endpoint:{agent}")).unwrap(),
            ManagedAgentReference::try_new(agent).unwrap(),
            RuntimeEndpointReference::try_new("runtime:test").unwrap(),
        )
    }
}
