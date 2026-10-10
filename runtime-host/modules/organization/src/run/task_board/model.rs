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

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum TaskBoardKey {
    Task {
        team: String,
        run: String,
        id: String,
    },
    Runner {
        team: String,
        run: String,
        id: String,
    },
    Mailbox {
        team: String,
        run: String,
        id: String,
    },
}

#[derive(Clone, Debug)]
enum PreviousRecord {
    Task(Option<(u64, TaskRecord)>),
    Runner(Option<(u64, AutoRunnerFacts)>),
    Mailbox(Option<(u64, MailboxMessage)>),
}

type Identity = (String, String, String);
fn identity(team: &str, run: &str, id: &str) -> Identity {
    (team.to_owned(), run.to_owned(), id.to_owned())
}

#[derive(Clone, Debug, Default)]
pub struct TaskBoardFacts {
    tasks: std::collections::BTreeMap<u64, TaskRecord>,
    runners: std::collections::BTreeMap<u64, AutoRunnerFacts>,
    mailbox: std::collections::BTreeMap<u64, MailboxMessage>,
    task_index: std::collections::BTreeMap<Identity, u64>,
    runner_index: std::collections::BTreeMap<Identity, u64>,
    mailbox_index: std::collections::BTreeMap<Identity, u64>,
    journal: Option<std::collections::BTreeMap<TaskBoardKey, PreviousRecord>>,
}

impl PartialEq for TaskBoardFacts {
    fn eq(&self, other: &Self) -> bool {
        self.tasks().eq(other.tasks())
            && self.runners().eq(other.runners())
            && self.mailbox().eq(other.mailbox())
    }
}
impl Eq for TaskBoardFacts {}
impl TaskBoardFacts {
    pub fn tasks(&self) -> impl Iterator<Item = &TaskRecord> {
        self.tasks.values()
    }
    pub fn runners(&self) -> impl Iterator<Item = &AutoRunnerFacts> {
        self.runners.values()
    }
    pub fn mailbox(&self) -> impl Iterator<Item = &MailboxMessage> {
        self.mailbox.values()
    }
    pub fn task(&self, team: &TeamId, run: &GraphRunId, id: &TaskId) -> Option<&TaskRecord> {
        self.task_record(team.as_str(), run.as_str(), id.as_str())
            .map(|(_, record)| record)
    }
    pub fn scoped(&self, team: &TeamId, run: &GraphRunId) -> Self {
        Self::restore_ordered(
            self.ordered_tasks()
                .filter(|(_, r)| r.team_id() == team && r.run_id() == run)
                .map(|(o, r)| (o, r.clone()))
                .collect(),
            self.ordered_runners()
                .filter(|(_, r)| r.team_id() == team && r.run_id() == run)
                .map(|(o, r)| (o, r.clone()))
                .collect(),
            self.ordered_mailbox()
                .filter(|(_, r)| r.team_id() == team && r.run_id() == run)
                .map(|(o, r)| (o, r.clone()))
                .collect(),
        )
        .expect("valid scoped task board")
    }
    pub fn scoped_tasks(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &TaskRecord> {
        self.tasks()
            .filter(move |task| task.team_id() == team && task.run_id() == run)
    }
    pub fn scoped_runners(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &AutoRunnerFacts> {
        self.runners()
            .filter(move |runner| runner.team_id() == team && runner.run_id() == run)
    }
    pub fn scoped_mailbox(
        &self,
        team: &TeamId,
        run: &GraphRunId,
    ) -> impl Iterator<Item = &MailboxMessage> {
        self.mailbox()
            .filter(move |message| message.team_id() == team && message.run_id() == run)
    }
    pub(crate) fn begin_transaction(&mut self) {
        debug_assert!(self.journal.is_none());
        self.journal = Some(Default::default());
    }
    pub(crate) fn commit_transaction(&mut self) {
        self.journal = None;
    }
    pub(crate) fn changed_keys(&self) -> impl Iterator<Item = &TaskBoardKey> {
        self.journal.iter().flat_map(|journal| journal.keys())
    }
    pub(crate) fn rollback_transaction(&mut self) {
        let Some(journal) = self.journal.take() else {
            return;
        };
        for key in journal.keys() {
            match key {
                TaskBoardKey::Task { team, run, id } => self.remove_task(team, run, id),
                TaskBoardKey::Runner { team, run, id } => self.remove_runner(team, run, id),
                TaskBoardKey::Mailbox { team, run, id } => self.remove_mailbox(team, run, id),
            }
        }
        for previous in journal.into_values() {
            match previous {
                PreviousRecord::Task(Some((ordinal, record))) => self
                    .restore_task(ordinal, record)
                    .expect("rollback task ordinal"),
                PreviousRecord::Runner(Some((ordinal, record))) => self
                    .restore_runner(ordinal, record)
                    .expect("rollback runner ordinal"),
                PreviousRecord::Mailbox(Some((ordinal, record))) => self
                    .restore_mailbox(ordinal, record)
                    .expect("rollback mailbox ordinal"),
                _ => (),
            }
        }
    }
    pub(crate) fn ordered_tasks(&self) -> impl Iterator<Item = (u64, &TaskRecord)> {
        self.tasks
            .iter()
            .map(|(ordinal, record)| (*ordinal, record))
    }
    pub(crate) fn task_record(
        &self,
        team: &str,
        run: &str,
        id: &str,
    ) -> Option<(u64, &TaskRecord)> {
        let ordinal = *self.task_index.get(&identity(team, run, id))?;
        self.tasks.get(&ordinal).map(|record| (ordinal, record))
    }
    fn touch_task(&mut self, team: &str, run: &str, id: &str) {
        let key = TaskBoardKey::Task {
            team: team.to_owned(),
            run: run.to_owned(),
            id: id.to_owned(),
        };
        if self
            .journal
            .as_ref()
            .is_some_and(|journal| !journal.contains_key(&key))
        {
            let previous = self
                .task_record(team, run, id)
                .map(|(ordinal, record)| (ordinal, record.clone()));
            self.journal
                .as_mut()
                .unwrap()
                .insert(key, PreviousRecord::Task(previous));
        }
    }
    pub(crate) fn restore_task(
        &mut self,
        ordinal: u64,
        record: TaskRecord,
    ) -> Result<(), TaskBoardError> {
        let key = identity(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.task_id().as_str(),
        );
        if self.tasks.get(&ordinal).is_some_and(|existing| {
            identity(
                existing.team_id().as_str(),
                existing.run_id().as_str(),
                existing.task_id().as_str(),
            ) != key
        }) {
            return Err(TaskBoardError::InvalidFacts);
        }
        if let Some(previous) = self.task_index.insert(key, ordinal) {
            if previous != ordinal {
                self.tasks.remove(&previous);
            }
        }
        self.tasks.insert(ordinal, record);
        Ok(())
    }
    pub(crate) fn remove_task(&mut self, team: &str, run: &str, id: &str) {
        self.touch_task(team, run, id);
        if let Some(ordinal) = self.task_index.remove(&identity(team, run, id)) {
            self.tasks.remove(&ordinal);
        }
    }
    pub(super) fn append_tasks(&mut self, records: Vec<TaskRecord>) -> Result<(), TaskBoardError> {
        let next = self
            .tasks
            .last_key_value()
            .map_or(Some(0), |(last, _)| last.checked_add(1))
            .ok_or(TaskBoardError::InvalidFacts)?;
        if !records.is_empty() && next.checked_add(records.len() as u64 - 1).is_none() {
            return Err(TaskBoardError::InvalidFacts);
        }
        for record in records {
            self.append_task(record)?;
        }
        Ok(())
    }
    pub(super) fn append_task(&mut self, record: TaskRecord) -> Result<(), TaskBoardError> {
        let ordinal = self
            .tasks
            .last_key_value()
            .map_or(Some(0), |(last, _)| last.checked_add(1))
            .ok_or(TaskBoardError::InvalidFacts)?;
        self.touch_task(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.task_id().as_str(),
        );
        self.restore_task(ordinal, record)
    }
    pub(super) fn task_mut(&mut self, team: &str, run: &str, id: &str) -> Option<&mut TaskRecord> {
        let ordinal = *self.task_index.get(&identity(team, run, id))?;
        self.touch_task(team, run, id);
        self.tasks.get_mut(&ordinal)
    }
    pub(crate) fn ordered_runners(&self) -> impl Iterator<Item = (u64, &AutoRunnerFacts)> {
        self.runners
            .iter()
            .map(|(ordinal, record)| (*ordinal, record))
    }
    pub(crate) fn runner_record(
        &self,
        team: &str,
        run: &str,
        id: &str,
    ) -> Option<(u64, &AutoRunnerFacts)> {
        let ordinal = *self.runner_index.get(&identity(team, run, id))?;
        self.runners.get(&ordinal).map(|record| (ordinal, record))
    }
    fn touch_runner(&mut self, team: &str, run: &str, id: &str) {
        let key = TaskBoardKey::Runner {
            team: team.to_owned(),
            run: run.to_owned(),
            id: id.to_owned(),
        };
        if self
            .journal
            .as_ref()
            .is_some_and(|journal| !journal.contains_key(&key))
        {
            let previous = self
                .runner_record(team, run, id)
                .map(|(ordinal, record)| (ordinal, record.clone()));
            self.journal
                .as_mut()
                .unwrap()
                .insert(key, PreviousRecord::Runner(previous));
        }
    }
    pub(crate) fn restore_runner(
        &mut self,
        ordinal: u64,
        record: AutoRunnerFacts,
    ) -> Result<(), TaskBoardError> {
        let key = identity(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.runner_id(),
        );
        if self.runners.get(&ordinal).is_some_and(|existing| {
            identity(
                existing.team_id().as_str(),
                existing.run_id().as_str(),
                existing.runner_id(),
            ) != key
        }) {
            return Err(TaskBoardError::InvalidFacts);
        }
        if let Some(previous) = self.runner_index.insert(key, ordinal) {
            if previous != ordinal {
                self.runners.remove(&previous);
            }
        }
        self.runners.insert(ordinal, record);
        Ok(())
    }
    pub(crate) fn remove_runner(&mut self, team: &str, run: &str, id: &str) {
        self.touch_runner(team, run, id);
        if let Some(ordinal) = self.runner_index.remove(&identity(team, run, id)) {
            self.runners.remove(&ordinal);
        }
    }
    pub(super) fn append_runner(&mut self, record: AutoRunnerFacts) -> Result<(), TaskBoardError> {
        let ordinal = self
            .runners
            .last_key_value()
            .map_or(Some(0), |(last, _)| last.checked_add(1))
            .ok_or(TaskBoardError::InvalidFacts)?;
        self.touch_runner(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.runner_id(),
        );
        self.restore_runner(ordinal, record)
    }
    pub(super) fn runner_mut(
        &mut self,
        team: &str,
        run: &str,
        id: &str,
    ) -> Option<&mut AutoRunnerFacts> {
        let ordinal = *self.runner_index.get(&identity(team, run, id))?;
        self.touch_runner(team, run, id);
        self.runners.get_mut(&ordinal)
    }
    pub(crate) fn ordered_mailbox(&self) -> impl Iterator<Item = (u64, &MailboxMessage)> {
        self.mailbox
            .iter()
            .map(|(ordinal, record)| (*ordinal, record))
    }
    pub(crate) fn mailbox_record(
        &self,
        team: &str,
        run: &str,
        id: &str,
    ) -> Option<(u64, &MailboxMessage)> {
        let ordinal = *self.mailbox_index.get(&identity(team, run, id))?;
        self.mailbox.get(&ordinal).map(|record| (ordinal, record))
    }
    fn touch_mailbox(&mut self, team: &str, run: &str, id: &str) {
        let key = TaskBoardKey::Mailbox {
            team: team.to_owned(),
            run: run.to_owned(),
            id: id.to_owned(),
        };
        if self
            .journal
            .as_ref()
            .is_some_and(|journal| !journal.contains_key(&key))
        {
            let previous = self
                .mailbox_record(team, run, id)
                .map(|(ordinal, record)| (ordinal, record.clone()));
            self.journal
                .as_mut()
                .unwrap()
                .insert(key, PreviousRecord::Mailbox(previous));
        }
    }
    pub(crate) fn restore_mailbox(
        &mut self,
        ordinal: u64,
        record: MailboxMessage,
    ) -> Result<(), TaskBoardError> {
        let key = identity(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.msg_id(),
        );
        if self.mailbox.get(&ordinal).is_some_and(|existing| {
            identity(
                existing.team_id().as_str(),
                existing.run_id().as_str(),
                existing.msg_id(),
            ) != key
        }) {
            return Err(TaskBoardError::InvalidFacts);
        }
        if let Some(previous) = self.mailbox_index.insert(key, ordinal) {
            if previous != ordinal {
                self.mailbox.remove(&previous);
            }
        }
        self.mailbox.insert(ordinal, record);
        Ok(())
    }
    pub(crate) fn remove_mailbox(&mut self, team: &str, run: &str, id: &str) {
        self.touch_mailbox(team, run, id);
        if let Some(ordinal) = self.mailbox_index.remove(&identity(team, run, id)) {
            self.mailbox.remove(&ordinal);
        }
    }
    pub(super) fn append_mailbox(&mut self, record: MailboxMessage) -> Result<(), TaskBoardError> {
        let ordinal = self
            .mailbox
            .last_key_value()
            .map_or(Some(0), |(last, _)| last.checked_add(1))
            .ok_or(TaskBoardError::InvalidFacts)?;
        self.touch_mailbox(
            record.team_id().as_str(),
            record.run_id().as_str(),
            record.msg_id(),
        );
        self.restore_mailbox(ordinal, record)
    }
    pub(super) fn sort_mailbox(&mut self) {
        let mut order: Vec<_> = self
            .mailbox
            .iter()
            .map(|(ordinal, record)| (*ordinal, record.created_at(), record.msg_id().to_owned()))
            .collect();
        order.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
        let mut moved = Vec::new();
        for (next, (previous, _, _)) in order.into_iter().enumerate() {
            let next = next as u64;
            if next == previous {
                continue;
            }
            let record = self.mailbox.get(&previous).unwrap();
            let key = identity(
                record.team_id().as_str(),
                record.run_id().as_str(),
                record.msg_id(),
            );
            self.touch_mailbox(&key.0, &key.1, &key.2);
            let record = self.mailbox.remove(&previous).unwrap();
            self.mailbox_index.insert(key, next);
            moved.push((next, record));
        }
        self.mailbox.extend(moved);
    }
    pub(crate) fn retain_without_run(&mut self, run: &GraphRunId) {
        let tasks: Vec<_> = self
            .tasks()
            .filter(|r| r.run_id() == run)
            .map(|r| identity(r.team_id().as_str(), run.as_str(), r.task_id().as_str()))
            .collect();
        let runners: Vec<_> = self
            .runners()
            .filter(|r| r.run_id() == run)
            .map(|r| identity(r.team_id().as_str(), run.as_str(), r.runner_id()))
            .collect();
        let mailbox: Vec<_> = self
            .mailbox()
            .filter(|r| r.run_id() == run)
            .map(|r| identity(r.team_id().as_str(), run.as_str(), r.msg_id()))
            .collect();
        for (team, run, id) in tasks {
            self.remove_task(&team, &run, &id);
        }
        for (team, run, id) in runners {
            self.remove_runner(&team, &run, &id);
        }
        for (team, run, id) in mailbox {
            self.remove_mailbox(&team, &run, &id);
        }
    }
    pub(crate) fn restore(
        tasks: Vec<TaskRecord>,
        runners: Vec<AutoRunnerFacts>,
        mailbox: Vec<MailboxMessage>,
    ) -> Result<Self, TaskBoardError> {
        Self::restore_ordered(
            tasks
                .into_iter()
                .enumerate()
                .map(|(i, r)| (i as u64, r))
                .collect(),
            runners
                .into_iter()
                .enumerate()
                .map(|(i, r)| (i as u64, r))
                .collect(),
            mailbox
                .into_iter()
                .enumerate()
                .map(|(i, r)| (i as u64, r))
                .collect(),
        )
    }
    pub(crate) fn restore_ordered(
        tasks: Vec<(u64, TaskRecord)>,
        runners: Vec<(u64, AutoRunnerFacts)>,
        mailbox: Vec<(u64, MailboxMessage)>,
    ) -> Result<Self, TaskBoardError> {
        let mut board = Self::default();
        for (ordinal, record) in tasks {
            if board
                .task_record(
                    record.team_id().as_str(),
                    record.run_id().as_str(),
                    record.task_id().as_str(),
                )
                .is_some()
            {
                return Err(TaskBoardError::DuplicateTask);
            }
            board.restore_task(ordinal, record)?;
        }
        for (ordinal, record) in runners {
            if board
                .runner_record(
                    record.team_id().as_str(),
                    record.run_id().as_str(),
                    record.runner_id(),
                )
                .is_some()
            {
                return Err(TaskBoardError::DuplicateRunner);
            }
            board.restore_runner(ordinal, record)?;
        }
        for (ordinal, record) in mailbox {
            if board
                .mailbox_record(
                    record.team_id().as_str(),
                    record.run_id().as_str(),
                    record.msg_id(),
                )
                .is_some()
            {
                return Err(TaskBoardError::DuplicateMessage);
            }
            board.restore_mailbox(ordinal, record)?;
        }
        board.validate()?;
        Ok(board)
    }
    pub fn validate(&self) -> Result<(), TaskBoardError> {
        for task in self.tasks() {
            if task.depends_on().iter().any(|d| d == task.task_id()) {
                return Err(TaskBoardError::DependencyCycle);
            }
            if task.depends_on().iter().any(|dependency| {
                self.task(task.team_id(), task.run_id(), dependency)
                    .is_none()
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
