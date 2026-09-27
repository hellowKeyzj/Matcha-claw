use organization::{
    ActivityId, ActivityKind, ActivityPhase, ActivityTarget, GraphRunId, OrganizationStore, RoleId,
    RoleSessionReceipt, StoreFault,
};

use runtime_directory::RuntimeDriverIdentity;

use crate::owner::team_run::{TeamRunActivityTarget, TeamRunOwner};

use super::step_runtime::{TeamRunStepPlan, TeamRunStepPlanner};

pub(crate) fn schedule_ready_nodes(
    team_run: &TeamRunOwner,
    store: &mut OrganizationStore,
    run_id: GraphRunId,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    let Some(run) = store.facts().run(&run_id).cloned() else {
        return Ok(Vec::new());
    };
    let plan = TeamRunStepPlanner::new(store).plan(&run, now)?;
    commit_team_run_step_plan(team_run, store, &run_id, plan, now)
}

fn commit_team_run_step_plan(
    team_run: &TeamRunOwner,
    store: &mut OrganizationStore,
    run_id: &GraphRunId,
    plan: TeamRunStepPlan,
    now: u64,
) -> Result<Vec<ActivityId>, StoreFault> {
    let (control_steps, ready_activity_requests) = plan.into_parts();
    for step in control_steps {
        team_run.apply_control_execution_step(store, run_id, step)?;
    }

    let mut activity_ids = Vec::new();
    for activity in ready_activity_requests {
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
