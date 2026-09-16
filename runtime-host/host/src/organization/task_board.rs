use organization::{GraphRunId, OrganizationStore, StoreFault, TeamId};

pub(crate) type Operation = TaskBoardMutation;

pub(crate) enum TaskBoardMutation {
    ClaimNext {
        agent_id: String,
        session: String,
        lease_seconds: u64,
        now: u64,
    },
    Heartbeat {
        task_id: organization::run::task_board::TaskId,
        agent_id: String,
        session: String,
        lease_seconds: u64,
        now: u64,
    },
    Release {
        task_id: organization::run::task_board::TaskId,
        agent_id: String,
        session: String,
        now: u64,
    },
    Transition {
        task_id: organization::run::task_board::TaskId,
        next: organization::run::task_board::TaskStatus,
        agent: Option<(String, String)>,
        summary: Option<String>,
        error: Option<String>,
        now: u64,
    },
    StartRunner {
        runner_id: String,
        session: String,
        now: u64,
    },
    PauseRunner {
        runner_id: String,
        session: String,
        now: u64,
    },
    CloseRunner {
        runner_id: String,
        session: String,
        now: u64,
    },
    ReclaimExpired {
        now: u64,
    },
    PostMailbox {
        message: organization::run::task_board::MailboxMessage,
    },
    PullMailbox {
        cursor: Option<String>,
        limit: usize,
    },
    UpsertPlan {
        plan: Vec<organization::run::task_board::TaskPlanInput>,
        now: u64,
        fingerprint: String,
    },
}

#[derive(Debug)]
pub(crate) enum MutationResult {
    ClaimNext {
        task_id: Option<organization::run::task_board::TaskId>,
    },
    Reclaimed {
        count: usize,
    },
    Posted {
        posted: bool,
    },
    Messages {
        messages: Vec<organization::run::task_board::MailboxMessage>,
        next_cursor: Option<String>,
    },
    Plan {
        task_ids: Vec<organization::run::task_board::TaskId>,
    },
    Changed,
}

pub(crate) fn mutate(
    store: &mut OrganizationStore,
    team_id: TeamId,
    run_id: GraphRunId,
    operation: TaskBoardMutation,
) -> Result<MutationResult, StoreFault> {
    store
        .task_board_mutate(|board| match operation {
            TaskBoardMutation::ClaimNext {
                agent_id,
                session,
                lease_seconds,
                now,
            } => organization::run::task_board::claim_next(
                board,
                &team_id,
                &run_id,
                &agent_id,
                &session,
                lease_seconds,
                now,
            )
            .map(|task_id| MutationResult::ClaimNext { task_id }),
            TaskBoardMutation::Heartbeat {
                task_id,
                agent_id,
                session,
                lease_seconds,
                now,
            } => organization::run::task_board::heartbeat(
                board,
                &team_id,
                &run_id,
                &task_id,
                &agent_id,
                &session,
                lease_seconds,
                now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::Release {
                task_id,
                agent_id,
                session,
                now,
            } => organization::run::task_board::release(
                board, &team_id, &run_id, &task_id, &agent_id, &session, now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::Transition {
                task_id,
                next,
                agent,
                summary,
                error,
                now,
            } => organization::run::task_board::transition(
                board,
                &team_id,
                &run_id,
                &task_id,
                next,
                agent
                    .as_ref()
                    .map(|(agent_id, session)| (agent_id.as_str(), session.as_str())),
                summary,
                error,
                now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::StartRunner {
                runner_id,
                session,
                now,
            } => organization::run::task_board::start_runner(
                board, &team_id, &run_id, &runner_id, &session, now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::PauseRunner {
                runner_id,
                session,
                now,
            } => organization::run::task_board::pause_runner(
                board, &team_id, &run_id, &runner_id, &session, now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::CloseRunner {
                runner_id,
                session,
                now,
            } => organization::run::task_board::close_runner(
                board, &team_id, &run_id, &runner_id, &session, now,
            )
            .map(|_| MutationResult::Changed),
            TaskBoardMutation::ReclaimExpired { now } => Ok(MutationResult::Reclaimed {
                count: organization::run::task_board::reclaim_expired_for_run(
                    board, &team_id, &run_id, now,
                ),
            }),
            TaskBoardMutation::PostMailbox { message } => {
                if message.team_id() != &team_id || message.run_id() != &run_id {
                    return Err(organization::run::task_board::TaskBoardError::InvalidIdentity);
                }
                organization::run::task_board::post(board, message)
                    .map(|posted| MutationResult::Posted { posted })
            }
            TaskBoardMutation::PullMailbox { cursor, limit } => {
                organization::run::task_board::pull(
                    board,
                    &team_id,
                    &run_id,
                    cursor.as_deref(),
                    limit,
                )
                .map(|(messages, next_cursor)| MutationResult::Messages {
                    messages,
                    next_cursor,
                })
            }
            TaskBoardMutation::UpsertPlan {
                plan,
                now,
                fingerprint,
            } => {
                if plan
                    .iter()
                    .any(|entry| entry.team_id != team_id || entry.run_id != run_id)
                {
                    return Err(organization::run::task_board::TaskBoardError::InvalidIdentity);
                }
                organization::run::task_board::upsert_plan(board, plan, now, &fingerprint)
                    .map(|task_ids| MutationResult::Plan { task_ids })
            }
        })
        .map_err(|_| StoreFault::InvalidFacts)
}
