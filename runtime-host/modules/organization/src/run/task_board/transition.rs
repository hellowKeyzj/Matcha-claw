use super::model::*;
use crate::{GraphRunId, TeamId};

fn lease(now: u64, lease_seconds: u64) -> Result<u64, TaskBoardError> {
    now.checked_add(lease_seconds.max(1))
        .ok_or(TaskBoardError::InvalidTask)
}
fn owned(task: &TaskRecord, agent: &str, session: &str, now: u64) -> Result<(), TaskBoardError> {
    if task.owner_agent_id() != Some(agent) || task.claim_session() != Some(session) {
        return Err(TaskBoardError::NotOwner);
    }
    if task.lease_until().is_some_and(|until| until <= now) {
        return Err(TaskBoardError::LeaseExpired);
    }
    Ok(())
}

pub fn upsert_plan(
    board: &mut TaskBoardFacts,
    plan: Vec<TaskPlanInput>,
    now: u64,
    fingerprint: &str,
) -> Result<Vec<TaskId>, TaskBoardError> {
    if fingerprint.trim().is_empty() {
        return Err(TaskBoardError::ConflictingCommand);
    }
    let mut pending = std::collections::BTreeMap::new();
    let mut records = Vec::new();
    let mut ids = Vec::new();
    for input in plan {
        let id = input.task_id.clone();
        if let Some(old) = board.task(&input.team_id, &input.run_id, &id) {
            if old.command_fingerprint() != fingerprint {
                return Err(TaskBoardError::ConflictingCommand);
            }
        } else {
            let key = (
                input.team_id.as_str().to_owned(),
                input.run_id.as_str().to_owned(),
                id.clone(),
            );
            if let std::collections::btree_map::Entry::Vacant(entry) = pending.entry(key) {
                let task = TaskRecord::new(input, now, fingerprint.to_owned())?;
                entry.insert(records.len());
                records.push(task);
            }
        }
        ids.push(id);
    }
    for task in &records {
        if task.depends_on().iter().any(|dependency| {
            board
                .task(task.team_id(), task.run_id(), dependency)
                .is_none()
                && !pending.contains_key(&(
                    task.team_id().as_str().to_owned(),
                    task.run_id().as_str().to_owned(),
                    dependency.clone(),
                ))
        }) {
            return Err(TaskBoardError::UnknownDependency);
        }
    }
    board.append_tasks(records)?;
    Ok(ids)
}

pub fn claim_next(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    agent: &str,
    session: &str,
    lease_seconds: u64,
    now: u64,
) -> Result<Option<TaskId>, TaskBoardError> {
    let done: std::collections::BTreeSet<TaskId> = board
        .tasks()
        .filter(|t| t.team_id() == team && t.run_id() == run && t.status() == TaskStatus::Done)
        .map(|t| t.task_id().clone())
        .collect();
    let task_id = board.tasks().find_map(|t| {
        (t.team_id() == team
            && t.run_id() == run
            && t.status() == TaskStatus::Todo
            && t.depends_on().iter().all(|d| done.contains(d)))
        .then(|| t.task_id().clone())
    });
    if agent.trim().is_empty() || session.trim().is_empty() {
        return Err(TaskBoardError::InvalidIdentity);
    }
    let Some(task_id) = task_id else {
        return Ok(None);
    };
    let until = lease(now, lease_seconds)?;
    let task = board
        .task_mut(team.as_str(), run.as_str(), task_id.as_str())
        .unwrap();
    *task.status_mut() = TaskStatus::Claimed;
    let (owner, claim, claimed, expiry) = task.owner_mut();
    *owner = Some(agent.to_owned());
    *claim = Some(session.to_owned());
    *claimed = Some(now);
    *expiry = Some(until);
    *task.updated_mut() = now;
    Ok(Some(task.task_id().clone()))
}

pub fn heartbeat(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    task_id: &TaskId,
    agent: &str,
    session: &str,
    lease_seconds: u64,
    now: u64,
) -> Result<(), TaskBoardError> {
    let task = board
        .task_mut(team.as_str(), run.as_str(), task_id.as_str())
        .ok_or(TaskBoardError::UnknownTask)?;
    owned(task, agent, session, now)?;
    *task.owner_mut().3 = Some(lease(now, lease_seconds)?);
    *task.updated_mut() = now;
    Ok(())
}
pub fn release(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    task_id: &TaskId,
    agent: &str,
    session: &str,
    now: u64,
) -> Result<(), TaskBoardError> {
    let task = board
        .task_mut(team.as_str(), run.as_str(), task_id.as_str())
        .ok_or(TaskBoardError::UnknownTask)?;
    owned(task, agent, session, now)?;
    let (o, s, c, l) = task.owner_mut();
    *o = None;
    *s = None;
    *c = None;
    *l = None;
    if task.status() == TaskStatus::Claimed {
        *task.status_mut() = TaskStatus::Todo
    }
    *task.updated_mut() = now;
    Ok(())
}
pub fn transition(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    task_id: &TaskId,
    next: TaskStatus,
    agent: Option<(&str, &str)>,
    summary: Option<String>,
    error: Option<String>,
    now: u64,
) -> Result<(), TaskBoardError> {
    let task = board
        .task_mut(team.as_str(), run.as_str(), task_id.as_str())
        .ok_or(TaskBoardError::UnknownTask)?;
    if let Some((a, s)) = agent {
        owned(task, a, s, now)?
    }
    let previous = task.status();
    let allowed = matches!(
        (previous, next),
        (TaskStatus::Todo, TaskStatus::Claimed)
            | (TaskStatus::Claimed, TaskStatus::Running)
            | (TaskStatus::Claimed, TaskStatus::Todo)
            | (TaskStatus::Running, TaskStatus::Done)
            | (TaskStatus::Running, TaskStatus::Blocked)
            | (TaskStatus::Running, TaskStatus::Failed)
            | (TaskStatus::Blocked, TaskStatus::Todo)
            | (TaskStatus::Blocked, TaskStatus::Running)
            | (TaskStatus::Blocked, TaskStatus::Failed)
            | (TaskStatus::Failed, TaskStatus::Todo)
            | (TaskStatus::Failed, TaskStatus::Claimed)
    ) || previous == next;
    if !allowed {
        return Err(TaskBoardError::InvalidTransition);
    }
    *task.status_mut() = next;
    if next == TaskStatus::Running && previous != TaskStatus::Running {
        *task.attempt_mut() = task.attempt().saturating_add(1)
    }
    if summary.is_some() {
        *task.result_mut().0 = summary
    }
    if error.is_some() {
        *task.result_mut().1 = error
    }
    if matches!(
        next,
        TaskStatus::Todo | TaskStatus::Done | TaskStatus::Failed
    ) {
        let (o, s, c, l) = task.owner_mut();
        *o = None;
        *s = None;
        *c = None;
        *l = None
    }
    *task.updated_mut() = now;
    Ok(())
}
pub fn start_runner(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    runner: &str,
    session: &str,
    now: u64,
) -> Result<(), TaskBoardError> {
    let r = board.runner_mut(team.as_str(), run.as_str(), runner);
    if let Some(r) = r {
        if r.session() != session {
            return Err(TaskBoardError::NotOwner);
        }
        if r.status() == RunnerStatus::Closed {
            return Err(TaskBoardError::RunnerClosed);
        }
        r.set_status(RunnerStatus::Active, now);
        return Ok(());
    }
    let mut r = AutoRunnerFacts::new(
        team.clone(),
        run.clone(),
        runner.to_owned(),
        session.to_owned(),
        now,
    )?;
    r.set_status(RunnerStatus::Active, now);
    board.append_runner(r)?;
    Ok(())
}
pub fn pause_runner(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    runner: &str,
    session: &str,
    now: u64,
) -> Result<(), TaskBoardError> {
    runner_status(board, team, run, runner, session, RunnerStatus::Paused, now)
}
pub fn close_runner(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    runner: &str,
    session: &str,
    now: u64,
) -> Result<(), TaskBoardError> {
    runner_status(board, team, run, runner, session, RunnerStatus::Closed, now)
}
fn runner_status(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    runner: &str,
    session: &str,
    status: RunnerStatus,
    now: u64,
) -> Result<(), TaskBoardError> {
    let r = board
        .runner_mut(team.as_str(), run.as_str(), runner)
        .ok_or(TaskBoardError::UnknownRunner)?;
    if r.session() != session {
        return Err(TaskBoardError::NotOwner);
    }
    if r.status() == RunnerStatus::Closed {
        return Err(TaskBoardError::RunnerClosed);
    }
    r.set_status(status, now);
    Ok(())
}
pub fn reclaim_expired(board: &mut TaskBoardFacts, now: u64) -> usize {
    reclaim_matching(board, now, |_, _| true)
}

pub fn reclaim_expired_for_run(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    now: u64,
) -> usize {
    reclaim_matching(board, now, |task_team, task_run| {
        task_team == team && task_run == run
    })
}

fn reclaim_matching(
    board: &mut TaskBoardFacts,
    now: u64,
    matches_scope: impl Fn(&TeamId, &GraphRunId) -> bool,
) -> usize {
    let keys: Vec<_> = board
        .tasks()
        .filter(|task| {
            matches_scope(task.team_id(), task.run_id())
                && task.lease_until().is_some_and(|expiry| expiry <= now)
                && matches!(task.status(), TaskStatus::Claimed | TaskStatus::Running)
        })
        .map(|task| {
            (
                task.team_id().clone(),
                task.run_id().clone(),
                task.task_id().clone(),
            )
        })
        .collect();
    for (team, run, id) in &keys {
        reclaim_expired_task(
            board
                .task_mut(team.as_str(), run.as_str(), id.as_str())
                .unwrap(),
            now,
        );
    }
    keys.len()
}

fn reclaim_expired_task(task: &mut TaskRecord, now: u64) -> bool {
    if task.lease_until().is_some_and(|x| x <= now)
        && matches!(task.status(), TaskStatus::Claimed | TaskStatus::Running)
    {
        let (o, s, c, l) = task.owner_mut();
        *o = None;
        *s = None;
        *c = None;
        *l = None;
        *task.status_mut() = TaskStatus::Todo;
        *task.updated_mut() = now;
        true
    } else {
        false
    }
}
