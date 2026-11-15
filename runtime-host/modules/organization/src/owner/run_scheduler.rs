use organization::{
    ActivityId, ActivityKind, ActivityPhase, ActivityRequest, ActivityTarget, GraphRunFacts, GraphRunId,
    OrganizationStore, RoleId, RoleSessionReceipt, StoreFault,
};

use platform::trace::{identifier_hash, runtime_trace};
#[cfg(test)]
use runtime_directory::RuntimeDriverIdentity;
use serde_json::json;

use super::step_runtime::{TeamRunStepPlan, TeamRunStepPlanner};

pub(crate) fn schedule_run_activities(
    store: &mut OrganizationStore,
    run_id: GraphRunId,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    schedule_ready_nodes(store, run_id.clone(), now)?;
    Ok(pending_run_activity_ids(store, &run_id, now))
}

pub(crate) fn schedule_ready_nodes(
    store: &mut OrganizationStore,
    run_id: GraphRunId,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    let Some(run) = store.facts().run(&run_id).cloned() else {
        runtime_trace("runtime.team_run.schedule.plan.skip", || json!({
            "runHash": identifier_hash(run_id.as_str()), "reason": "run_missing",
        }));
        return Ok(Vec::new());
    };
    let plan = TeamRunStepPlanner::new(store).plan(&run, now).inspect_err(|error| {
        runtime_trace("runtime.team_run.schedule.plan.error", || json!({
            "runHash": identifier_hash(run_id.as_str()),
            "errorKind": super::actor::store_fault_label(error),
        }));
    })?;
    commit_team_run_step_plan(store, &run_id, plan, now)
}

fn commit_team_run_step_plan(
    store: &mut OrganizationStore,
    run_id: &GraphRunId,
    plan: TeamRunStepPlan,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    let (control_steps, ready_activity_requests) = plan.into_parts();
    runtime_trace("runtime.team_run.schedule.plan.end", || json!({
        "runHash": identifier_hash(run_id.as_str()),
        "controlCount": control_steps.len(), "readyCount": ready_activity_requests.len(),
    }));
    for (step_index, step) in control_steps.into_iter().enumerate() {
        let node_hash = platform::trace::enabled().then(|| identifier_hash(step.node_id().as_str()));
        let outcome = store.apply_control_execution_step(run_id, step);
        runtime_trace("runtime.team_run.schedule.control.commit", || json!({
            "runHash": identifier_hash(run_id.as_str()), "stepIndex": step_index,
            "nodeHash": node_hash,
            "outcome": outcome.as_ref().map_or_else(super::actor::store_fault_label, |_| "committed"),
        }));
        outcome?;
    }

    let mut activity_ids = Vec::new();
    for (activity_index, activity) in ready_activity_requests.into_iter().enumerate() {
        let outcome = store.register_activity_and_start_attempt(activity, now);
        runtime_trace("runtime.team_run.schedule.activity.register", || json!({
            "runHash": identifier_hash(run_id.as_str()), "activityIndex": activity_index,
            "outcome": match &outcome {
                Ok(Some(organization::ActivityRegistrationOutcome::Recorded(_))) => "recorded",
                Ok(Some(organization::ActivityRegistrationOutcome::Replayed(_))) => "replayed",
                Ok(Some(organization::ActivityRegistrationOutcome::ConflictingIdempotencyKey)) => "conflicting_idempotency_key",
                Ok(Some(organization::ActivityRegistrationOutcome::ConflictingActivityId { .. })) => "conflicting_activity_id",
                Ok(None) => "not_scheduled",
                Err(error) => super::actor::store_fault_label(error),
            },
        }));
        match outcome? {
            Some(organization::ActivityRegistrationOutcome::Recorded(activity))
            | Some(organization::ActivityRegistrationOutcome::Replayed(activity)) => {
                activity_ids.push(activity.facts().activity_id.clone());
            }
            Some(organization::ActivityRegistrationOutcome::ConflictingIdempotencyKey)
            | Some(organization::ActivityRegistrationOutcome::ConflictingActivityId { .. }) => {
                return Err(StoreFault::InvalidFacts);
            }
            None => {}
        }
    }
    Ok(activity_ids)
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

pub(crate) fn pending_run_activity_ids(
    store: &OrganizationStore,
    run_id: &GraphRunId,
    now: u64,
) -> Vec<ActivityId> {
    if !run_allows_activity_execution(store, run_id) {
        return Vec::new();
    }
    let Some(run) = store.facts().run(run_id) else {
        return Vec::new();
    };
    store
        .facts()
        .activities_for_run(run_id.as_str())
        .filter(|activity| !run.graph().is_rework_blocked(&activity.facts().node_id))
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
        matches!(
            run.lifecycle().state(),
            organization::GraphRunLifecycleState::Active
        ) && matches!(run.start_gate(), organization::RunStartGate::Started)
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

pub(crate) fn activity_target<'a>(
    store: &'a OrganizationStore,
    activity: &ActivityRequest,
) -> Option<(&'a GraphRunFacts, &'a RoleSessionReceipt)> {
    let run = store.facts().run(&activity.run_id)?;
    let ActivityKind::AgentTask { role_id, .. } = &activity.activity_kind else {
        return None;
    };
    let binding = binding_for_activity_target(run.runtime()?.bindings(), role_id, &activity.target)?;
    Some((run, binding))
}

#[cfg(test)]
mod tests {
    use super::*;
    use organization::{
        GraphRunId, ManagedAgentReference, RoleId, RoleSessionRef, RuntimeEndpointReference, TeamId,
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

    fn binding(
        run_id: &GraphRunId,
        role_id: &str,
        session_ref: &str,
        agent_id: &str,
    ) -> RoleSessionReceipt {
        RoleSessionReceipt::new(
            TeamId::try_new("team:test").unwrap(),
            run_id.clone(),
            RoleId::try_new(role_id.to_owned()).unwrap(),
            RoleSessionRef::try_new(session_ref.to_owned()).unwrap(),
            ManagedAgentReference::try_new(agent_id.to_owned()).unwrap(),
            RuntimeEndpointReference::try_new(
                RuntimeDriverIdentity::open_claw().runtime_endpoint_reference(),
            )
            .unwrap(),
        )
    }
}
