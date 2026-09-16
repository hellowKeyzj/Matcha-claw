use std::collections::BTreeSet;

use organization::{
    ActivityId, ActivityKind, ActivityPhase, ActivityTarget, GraphRunId, GraphRunLifecycleState,
    OrganizationStore, StoreFault,
};

use crate::runtime::driver::RuntimeDriverIdentity;

use super::team_run::{TeamRunActivityTarget, TeamRunOwner};

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
    let active_local_sessions = active_run_local_sessions(store, &run_id);
    let selected = organization::run::scheduler::schedule_ready_nodes(
        run.graph(),
        MAX_ACTIVE_ROLE_PROMPTS,
        active_local_sessions.len().min(MAX_ACTIVE_ROLE_PROMPTS),
    )
    .map_err(|_| StoreFault::InvalidFacts)?;
    let bindings = run
        .runtime()
        .map(|runtime| runtime.bindings())
        .unwrap_or(&[]);
    let mut reserved = active_local_sessions;
    let mut activity_ids = Vec::new();

    for item in selected {
        let Some(node) = run.graph().definition().node(item.node_id()) else {
            continue;
        };
        let ActivityKind::AgentTask { role_id, .. } = item.activity_kind() else {
            continue;
        };
        let Some(binding) = bindings
            .iter()
            .find(|binding| binding.role().as_str() == role_id)
        else {
            continue;
        };
        if !reserved.insert(binding.local_session().as_str().to_owned()) {
            continue;
        }
        let activity = item
            .bind_activity_target(
                ActivityTarget::new(binding.local_session().as_str().to_owned())
                    .map_err(|_| StoreFault::InvalidFacts)?,
                now,
                node.max_attempts().get(),
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
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

pub(crate) fn active_run_local_sessions(
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
        .map(|activity| activity.facts().target.as_str().to_owned())
        .collect()
}

pub(crate) fn pending_run_activity_ids(
    store: &OrganizationStore,
    run_id: &GraphRunId,
    now: u64,
) -> Vec<ActivityId> {
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
    let role = organization::RoleId::try_new(role_id.clone()).ok()?;
    let binding = run
        .runtime()?
        .bindings()
        .iter()
        .find(|binding| binding.role() == &role)?;
    if binding.local_session().as_str() != activity.facts().target.as_str() {
        return None;
    }
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
