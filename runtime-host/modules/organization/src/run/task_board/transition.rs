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
    let mut candidate = board.clone();
    let mut ids = Vec::new();
    for input in plan {
        let id = input.task_id.clone();
        if let Some(old) = candidate.tasks_mut().iter_mut().find(|t| {
            t.team_id() == &input.team_id && t.run_id() == &input.run_id && t.task_id() == &id
        }) {
            if old.command_fingerprint() != fingerprint {
                return Err(TaskBoardError::ConflictingCommand);
            }
            ids.push(id);
            continue;
        }
        let task = TaskRecord::new(input, now, fingerprint.to_owned())?;
        candidate.tasks_mut().push(task);
        ids.push(id);
    }
    candidate.validate()?;
    *board = candidate;
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
    let index = board.tasks().enumerate().find_map(|(i, t)| {
        (t.team_id() == team
            && t.run_id() == run
            && t.status() == TaskStatus::Todo
            && t.depends_on().iter().all(|d| done.contains(d)))
        .then_some(i)
    });
    if agent.trim().is_empty() || session.trim().is_empty() {
        return Err(TaskBoardError::InvalidIdentity);
    }
    let Some(index) = index else { return Ok(None) };
    let until = lease(now, lease_seconds)?;
    let task = &mut board.tasks_mut()[index];
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
        .tasks_mut()
        .iter_mut()
        .find(|t| t.team_id() == team && t.run_id() == run && t.task_id() == task_id)
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
        .tasks_mut()
        .iter_mut()
        .find(|t| t.team_id() == team && t.run_id() == run && t.task_id() == task_id)
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
        .tasks_mut()
        .iter_mut()
        .find(|t| t.team_id() == team && t.run_id() == run && t.task_id() == task_id)
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
    let r = board
        .runners_mut()
        .iter_mut()
        .find(|r| r.team_id() == team && r.run_id() == run && r.runner_id() == runner);
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
    board.runners_mut().push(r);
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
        .runners_mut()
        .iter_mut()
        .find(|r| r.team_id() == team && r.run_id() == run && r.runner_id() == runner)
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
    let mut count = 0;
    for task in board.tasks_mut() {
        if reclaim_expired_task(task, now) {
            count += 1;
        }
    }
    count
}

pub fn reclaim_expired_for_run(
    board: &mut TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    now: u64,
) -> usize {
    let mut count = 0;
    for task in board.tasks_mut() {
        if task.team_id() == team && task.run_id() == run && reclaim_expired_task(task, now) {
            count += 1;
        }
    }
    count
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
