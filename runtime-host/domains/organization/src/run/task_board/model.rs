use serde::{Deserialize, Serialize};
use std::fmt;

use crate::{GraphRunId, TeamId};

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TaskId(String);

impl TaskId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, TaskBoardError> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > 256 {
            return Err(TaskBoardError::InvalidIdentity);
        }
        Ok(Self(value))
    }
    pub fn new(value: impl Into<String>) -> Self {
        Self::try_new(value).expect("valid task id")
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("TaskId").field(&self.0).finish()
    }
}
impl fmt::Display for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TaskStatus {
    Todo,
    Claimed,
    Running,
    Blocked,
    Done,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunnerStatus {
    Active,
    Paused,
    Closed,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TaskRecord {
    team_id: TeamId,
    run_id: GraphRunId,
    task_id: TaskId,
    title: String,
    instruction: String,
    depends_on: Vec<TaskId>,
    status: TaskStatus,
    owner_agent_id: Option<String>,
    claim_session: Option<String>,
    claimed_at: Option<u64>,
    lease_until: Option<u64>,
    attempt: u32,
    result_summary: Option<String>,
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
    command_fingerprint: String,
}

impl fmt::Debug for TaskRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TaskRecord")
            .field("team_id", &self.team_id)
            .field("run_id", &self.run_id)
            .field("task_id", &self.task_id)
            .field("title", &self.title)
            .field("status", &self.status)
            .field("owner_agent_id", &self.owner_agent_id)
            .field("attempt", &self.attempt)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("instruction", &"<redacted>")
            .field(
                "result_summary",
                &self.result_summary.as_deref().map(|_| "<redacted>"),
            )
            .field("error", &self.error.as_deref().map(|_| "<redacted>"))
            .finish()
    }
}

impl TaskRecord {
    pub fn new(
        input: TaskPlanInput,
        now: u64,
        fingerprint: impl Into<String>,
    ) -> Result<Self, TaskBoardError> {
        let fingerprint = fingerprint.into();
        if input.title.trim().is_empty()
            || input.instruction.trim().is_empty()
            || fingerprint.trim().is_empty()
        {
            return Err(TaskBoardError::InvalidTask);
        }
        let task_id = input.task_id;
        if input.depends_on.iter().any(|id| id == &task_id) {
            return Err(TaskBoardError::DependencyCycle);
        }
        Ok(Self {
            team_id: input.team_id,
            run_id: input.run_id,
            task_id,
            title: input.title,
            instruction: input.instruction,
            depends_on: input.depends_on,
            status: TaskStatus::Todo,
            owner_agent_id: None,
            claim_session: None,
            claimed_at: None,
            lease_until: None,
            attempt: 0,
            result_summary: None,
            error: None,
            created_at: now,
            updated_at: now,
            command_fingerprint: fingerprint,
        })
    }
    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }
    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn instruction(&self) -> &str {
        &self.instruction
    }
    pub fn depends_on(&self) -> &[TaskId] {
        &self.depends_on
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn owner_agent_id(&self) -> Option<&str> {
        self.owner_agent_id.as_deref()
    }
    pub fn claim_session(&self) -> Option<&str> {
        self.claim_session.as_deref()
    }
    pub fn claimed_at(&self) -> Option<u64> {
        self.claimed_at
    }
    pub fn lease_until(&self) -> Option<u64> {
        self.lease_until
    }
    pub fn attempt(&self) -> u32 {
        self.attempt
    }
    pub fn result_summary(&self) -> Option<&str> {
        self.result_summary.as_deref()
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
    pub fn command_fingerprint(&self) -> &str {
        &self.command_fingerprint
    }
    pub(crate) fn status_mut(&mut self) -> &mut TaskStatus {
        &mut self.status
    }
    pub(crate) fn owner_mut(
        &mut self,
    ) -> (
        &mut Option<String>,
        &mut Option<String>,
        &mut Option<u64>,
        &mut Option<u64>,
    ) {
        (
            &mut self.owner_agent_id,
            &mut self.claim_session,
            &mut self.claimed_at,
            &mut self.lease_until,
        )
    }
    pub(crate) fn attempt_mut(&mut self) -> &mut u32 {
        &mut self.attempt
    }
    pub(crate) fn result_mut(&mut self) -> (&mut Option<String>, &mut Option<String>) {
        (&mut self.result_summary, &mut self.error)
    }
    pub(crate) fn updated_mut(&mut self) -> &mut u64 {
        &mut self.updated_at
    }
    pub(crate) fn restore(input: TaskRestoreInput) -> Result<Self, TaskBoardError> {
        let mut record = Self::new(
            TaskPlanInput {
                team_id: input.team_id,
                run_id: input.run_id,
                task_id: input.task_id,
                title: input.title,
                instruction: input.instruction,
                depends_on: input.depends_on,
            },
            input.created_at,
            input.command_fingerprint,
        )?;
        record.status = input.status;
        record.owner_agent_id = input.owner_agent_id;
        record.claim_session = input.claim_session;
        record.claimed_at = input.claimed_at;
        record.lease_until = input.lease_until;
        record.attempt = input.attempt;
        record.result_summary = input.result_summary;
        record.error = input.error;
        record.updated_at = input.updated_at;
        if matches!(
            record.status,
            TaskStatus::Todo | TaskStatus::Blocked | TaskStatus::Done | TaskStatus::Failed
        ) && (record.owner_agent_id.is_some()
            || record.claim_session.is_some()
            || record.lease_until.is_some())
        {
            return Err(TaskBoardError::InvalidFacts);
        }
        if record.owner_agent_id.is_some() != record.claim_session.is_some() {
            return Err(TaskBoardError::InvalidFacts);
        }
        if matches!(record.status, TaskStatus::Claimed | TaskStatus::Running)
            && (record.owner_agent_id.is_none()
                || record.claim_session.is_none()
                || record.claimed_at.is_none()
                || record.lease_until.is_none()
                || record.lease_until <= record.claimed_at)
        {
            return Err(TaskBoardError::InvalidFacts);
        }
        Ok(record)
    }
}

pub struct TaskPlanInput {
    pub team_id: TeamId,
    pub run_id: GraphRunId,
    pub task_id: TaskId,
    pub title: String,
    pub instruction: String,
    pub depends_on: Vec<TaskId>,
}
pub(crate) struct TaskRestoreInput {
    pub team_id: TeamId,
    pub run_id: GraphRunId,
    pub task_id: TaskId,
    pub title: String,
    pub instruction: String,
    pub depends_on: Vec<TaskId>,
    pub status: TaskStatus,
    pub owner_agent_id: Option<String>,
    pub claim_session: Option<String>,
    pub claimed_at: Option<u64>,
    pub lease_until: Option<u64>,
    pub attempt: u32,
    pub result_summary: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub command_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AutoRunnerFacts {
    team_id: TeamId,
    run_id: GraphRunId,
    runner_id: String,
    session: String,
    status: RunnerStatus,
    updated_at: u64,
}
impl AutoRunnerFacts {
    pub fn new(
        team_id: TeamId,
        run_id: GraphRunId,
        runner_id: String,
        session: String,
        now: u64,
    ) -> Result<Self, TaskBoardError> {
        if runner_id.trim().is_empty() || session.trim().is_empty() {
            return Err(TaskBoardError::InvalidIdentity);
        }
        Ok(Self {
            team_id,
            run_id,
            runner_id,
            session,
            status: RunnerStatus::Paused,
            updated_at: now,
        })
    }
    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }
    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }
    pub fn runner_id(&self) -> &str {
        &self.runner_id
    }
    pub fn session(&self) -> &str {
        &self.session
    }
    pub fn status(&self) -> RunnerStatus {
        self.status
    }
    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
    pub(crate) fn set_status(&mut self, status: RunnerStatus, now: u64) {
        self.status = status;
        self.updated_at = now
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct MailboxMessage {
    team_id: TeamId,
    run_id: GraphRunId,
    msg_id: String,
    from_agent_id: String,
    to: String,
    related_task_id: Option<TaskId>,
    reply_to_msg_id: Option<String>,
    kind: MailboxKind,
    content: String,
    created_at: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailboxKind {
    Question,
    Proposal,
    Decision,
    Report,
}
impl fmt::Debug for MailboxMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailboxMessage")
            .field("team_id", &self.team_id)
            .field("run_id", &self.run_id)
            .field("msg_id", &self.msg_id)
            .field("from_agent_id", &self.from_agent_id)
            .field("to", &self.to)
            .field("kind", &self.kind)
            .field("created_at", &self.created_at)
            .field("content", &"<redacted>")
            .finish()
    }
}
impl MailboxMessage {
    pub fn new(
        team_id: TeamId,
        run_id: GraphRunId,
        msg_id: String,
        from_agent_id: String,
        to: String,
        related_task_id: Option<TaskId>,
        reply_to_msg_id: Option<String>,
        kind: MailboxKind,
        content: String,
        created_at: u64,
    ) -> Result<Self, TaskBoardError> {
        if msg_id.trim().is_empty()
            || from_agent_id.trim().is_empty()
            || to.trim().is_empty()
            || content.trim().is_empty()
        {
            return Err(TaskBoardError::InvalidMailbox);
        }
        Ok(Self {
            team_id,
            run_id,
            msg_id,
            from_agent_id,
            to,
            related_task_id,
            reply_to_msg_id,
            kind,
            content,
            created_at,
        })
    }
    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }
    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }
    pub fn msg_id(&self) -> &str {
        &self.msg_id
    }
    pub fn from_agent_id(&self) -> &str {
        &self.from_agent_id
    }
    pub fn to(&self) -> &str {
        &self.to
    }
    pub fn related_task_id(&self) -> Option<&TaskId> {
        self.related_task_id.as_ref()
    }
    pub fn reply_to_msg_id(&self) -> Option<&str> {
        self.reply_to_msg_id.as_deref()
    }
    pub fn kind(&self) -> MailboxKind {
        self.kind
    }
    pub fn content(&self) -> &str {
        &self.content
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct TaskBoardFacts {
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) runners: Vec<AutoRunnerFacts>,
    pub(crate) mailbox: Vec<MailboxMessage>,
}
impl TaskBoardFacts {
    pub fn tasks(&self) -> impl Iterator<Item = &TaskRecord> {
        self.tasks.iter()
    }
    pub fn runners(&self) -> impl Iterator<Item = &AutoRunnerFacts> {
        self.runners.iter()
    }
    pub fn mailbox(&self) -> impl Iterator<Item = &MailboxMessage> {
        self.mailbox.iter()
    }
    pub fn task(&self, team: &TeamId, run: &GraphRunId, id: &TaskId) -> Option<&TaskRecord> {
        self.tasks
            .iter()
            .find(|t| t.team_id() == team && t.run_id() == run && t.task_id() == id)
    }
    pub fn scoped(&self, team: &TeamId, run: &GraphRunId) -> Self {
        Self {
            tasks: self.scoped_tasks(team, run).cloned().collect(),
            runners: self.scoped_runners(team, run).cloned().collect(),
            mailbox: self.scoped_mailbox(team, run).cloned().collect(),
        }
    }
    pub fn scoped_tasks(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &TaskRecord> {
        self.tasks
            .iter()
            .filter(move |task| task.team_id() == team && task.run_id() == run)
    }
    pub fn scoped_runners(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &AutoRunnerFacts> {
        self.runners
            .iter()
            .filter(move |runner| runner.team_id() == team && runner.run_id() == run)
    }
    pub fn scoped_mailbox(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &MailboxMessage> {
        self.mailbox
            .iter()
            .filter(move |message| message.team_id() == team && message.run_id() == run)
    }
    pub(crate) fn tasks_mut(&mut self) -> &mut Vec<TaskRecord> {
        &mut self.tasks
    }
    pub(crate) fn runners_mut(&mut self) -> &mut Vec<AutoRunnerFacts> {
        &mut self.runners
    }
    pub(crate) fn mailbox_mut(&mut self) -> &mut Vec<MailboxMessage> {
        &mut self.mailbox
    }
    pub(crate) fn retain_without_run(&mut self, run: &GraphRunId) {
        self.tasks.retain(|task| task.run_id() != run);
        self.runners.retain(|runner| runner.run_id() != run);
        self.mailbox.retain(|message| message.run_id() != run);
    }
    pub(crate) fn restore(
        tasks: Vec<TaskRecord>,
        runners: Vec<AutoRunnerFacts>,
        mailbox: Vec<MailboxMessage>,
    ) -> Result<Self, TaskBoardError> {
        let board = Self {
            tasks,
            runners,
            mailbox,
        };
        board.validate()?;
        Ok(board)
    }
    pub fn validate(&self) -> Result<(), TaskBoardError> {
        for (i, a) in self.tasks.iter().enumerate() {
            if self.tasks[..i].iter().any(|b| {
                b.team_id() == a.team_id() && b.run_id() == a.run_id() && b.task_id() == a.task_id()
            }) {
                return Err(TaskBoardError::DuplicateTask);
            }
            if a.depends_on().iter().any(|d| d == a.task_id()) {
                return Err(TaskBoardError::DependencyCycle);
            }
        }
        for (i, a) in self.mailbox.iter().enumerate() {
            if self.mailbox[..i].iter().any(|b| {
                b.team_id() == a.team_id() && b.run_id() == a.run_id() && b.msg_id() == a.msg_id()
            }) {
                return Err(TaskBoardError::DuplicateMessage);
            }
        }
        for (i, runner) in self.runners.iter().enumerate() {
            if self.runners[..i].iter().any(|previous| {
                previous.team_id() == runner.team_id()
                    && previous.run_id() == runner.run_id()
                    && previous.runner_id() == runner.runner_id()
            }) {
                return Err(TaskBoardError::DuplicateRunner);
            }
        }
        for task in &self.tasks {
            if task.depends_on().iter().any(|dependency| {
                self.tasks.iter().any(|candidate| {
                    candidate.team_id() == task.team_id()
                        && candidate.run_id() == task.run_id()
                        && candidate.task_id() == dependency
                }) == false
            }) {
                return Err(TaskBoardError::UnknownDependency);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskBoardError {
    InvalidIdentity,
    InvalidTask,
    InvalidMailbox,
    InvalidFacts,
    DuplicateTask,
    DuplicateMessage,
    DuplicateRunner,
    UnknownDependency,
    UnknownTask,
    UnknownRunner,
    InvalidTransition,
    NotOwner,
    LeaseExpired,
    ClaimConflict,
    DependencyCycle,
    ConflictingCommand,
    ConflictingMessage,
    CursorInvalid,
    RunnerClosed,
}
impl fmt::Display for TaskBoardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "task board operation rejected: {self:?}")
    }
}
impl std::error::Error for TaskBoardError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_preserves_one_team_run_and_excludes_other_facts() {
        let team_one = TeamId::try_new("team:one").unwrap();
        let run_one = GraphRunId::new("run:one");
        let team_two = TeamId::try_new("team:two").unwrap();
        let run_two = GraphRunId::new("run:two");
        let task_one = TaskRecord::new(
            TaskPlanInput {
                team_id: team_one.clone(),
                run_id: run_one.clone(),
                task_id: TaskId::new("task:one"),
                title: "One".into(),
                instruction: "Do one".into(),
                depends_on: Vec::new(),
            },
            7,
            "fingerprint:one",
        )
        .unwrap();
        let task_two = TaskRecord::new(
            TaskPlanInput {
                team_id: team_two.clone(),
                run_id: run_two.clone(),
                task_id: TaskId::new("task:two"),
                title: "Two".into(),
                instruction: "Do two".into(),
                depends_on: Vec::new(),
            },
            8,
            "fingerprint:two",
        )
        .unwrap();
        let runner_one = AutoRunnerFacts::new(
            team_one.clone(),
            run_one.clone(),
            "runner:one".into(),
            "session:one".into(),
            7,
        )
        .unwrap();
        let runner_two = AutoRunnerFacts::new(
            team_two.clone(),
            run_two.clone(),
            "runner:two".into(),
            "session:two".into(),
            8,
        )
        .unwrap();
        let message_one = MailboxMessage::new(
            team_one.clone(),
            run_one.clone(),
            "message:one".into(),
            "agent:one".into(),
            "agent:two".into(),
            None,
            None,
            MailboxKind::Report,
            "one".into(),
            7,
        )
        .unwrap();
        let message_two = MailboxMessage::new(
            team_two.clone(),
            run_two.clone(),
            "message:two".into(),
            "agent:two".into(),
            "agent:one".into(),
            None,
            None,
            MailboxKind::Report,
            "two".into(),
            8,
        )
        .unwrap();
        let board = TaskBoardFacts::restore(
            vec![task_one.clone(), task_two],
            vec![runner_one.clone(), runner_two],
            vec![message_one.clone(), message_two],
        )
        .unwrap();

        let scoped = board.scoped(&team_one, &run_one);
        assert_eq!(scoped.tasks().collect::<Vec<_>>(), vec![&task_one]);
        assert_eq!(scoped.runners().collect::<Vec<_>>(), vec![&runner_one]);
        assert_eq!(scoped.mailbox().collect::<Vec<_>>(), vec![&message_one]);
    }
}
