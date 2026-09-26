use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskMetadata(serde_json::Map<String, serde_json::Value>);

impl TaskMetadata {
    pub fn new(object: serde_json::Map<String, serde_json::Value>) -> Self {
        Self(object)
    }

    pub fn as_object(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.0
    }
}

impl fmt::Debug for TaskMetadata {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TaskMetadata([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreate {
    subject: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<TaskMetadata>,
}

impl TaskCreate {
    pub fn try_new(
        subject: String,
        description: String,
        active_form: Option<String>,
        owner: Option<String>,
        metadata: Option<TaskMetadata>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self {
            subject: non_empty(subject)?,
            description: non_empty(description)?,
            active_form: active_form.map(non_empty).transpose()?,
            owner: owner.map(non_empty).transpose()?,
            metadata,
        })
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn active_form(&self) -> Option<&str> {
        self.active_form.as_deref()
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    pub fn metadata(&self) -> Option<&TaskMetadata> {
        self.metadata.as_ref()
    }
}

impl fmt::Debug for TaskCreate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TaskCreate").finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<TaskStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    add_blocked_by: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    add_blocks: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<TaskMetadata>,
}

impl TaskUpdate {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        task_id: String,
        status: Option<TaskStatus>,
        subject: Option<String>,
        description: Option<String>,
        active_form: Option<String>,
        owner: Option<String>,
        add_blocked_by: Option<Vec<String>>,
        add_blocks: Option<Vec<String>>,
        metadata: Option<TaskMetadata>,
    ) -> Result<Self, TaskInputError> {
        let result = Self {
            task_id: non_empty(task_id)?,
            status,
            subject: subject.map(non_empty).transpose()?,
            description: description.map(non_empty).transpose()?,
            active_form: active_form.map(non_empty).transpose()?,
            owner: owner.map(non_empty).transpose()?,
            add_blocked_by: add_blocked_by.map(non_empty_list).transpose()?,
            add_blocks: add_blocks.map(non_empty_list).transpose()?,
            metadata,
        };
        if result.status.is_none()
            && result.subject.is_none()
            && result.description.is_none()
            && result.active_form.is_none()
            && result.owner.is_none()
            && result.add_blocked_by.is_none()
            && result.add_blocks.is_none()
            && result.metadata.is_none()
        {
            return Err(TaskInputError);
        }
        Ok(result)
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn status(&self) -> Option<TaskStatus> {
        self.status
    }

    pub fn subject(&self) -> Option<&str> {
        self.subject.as_deref()
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn active_form(&self) -> Option<&str> {
        self.active_form.as_deref()
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    pub fn add_blocked_by(&self) -> Option<&[String]> {
        self.add_blocked_by.as_deref()
    }

    pub fn add_blocks(&self) -> Option<&[String]> {
        self.add_blocks.as_deref()
    }

    pub fn metadata(&self) -> Option<&TaskMetadata> {
        self.metadata.as_ref()
    }
}

impl fmt::Debug for TaskUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TaskUpdate").finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_form: Option<String>,
    status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
}

impl Todo {
    pub fn try_new(
        id: Option<String>,
        content: String,
        active_form: Option<String>,
        status: TodoStatus,
        owner: Option<String>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self {
            id: id.map(non_empty).transpose()?,
            content: non_empty(content)?,
            active_form: active_form.map(non_empty).transpose()?,
            status,
            owner: owner.map(non_empty).transpose()?,
        })
    }

    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn active_form(&self) -> Option<&str> {
        self.active_form.as_deref()
    }

    pub fn status(&self) -> TodoStatus {
        self.status
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }
}

impl fmt::Debug for Todo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Todo").finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct Task {
    id: String,
    subject: String,
    description: String,
    active_form: Option<String>,
    status: TaskStatus,
    owner: Option<String>,
    blocked_by: Vec<String>,
    blocks: Vec<String>,
    metadata: Option<TaskMetadata>,
    created_at: u64,
    updated_at: u64,
}

impl Task {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        subject: String,
        description: String,
        active_form: Option<String>,
        status: TaskStatus,
        owner: Option<String>,
        blocked_by: Vec<String>,
        blocks: Vec<String>,
        metadata: Option<TaskMetadata>,
        created_at: u64,
        updated_at: u64,
    ) -> Self {
        Self {
            id,
            subject,
            description,
            active_form,
            status,
            owner,
            blocked_by,
            blocks,
            metadata,
            created_at,
            updated_at,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn active_form(&self) -> Option<&str> {
        self.active_form.as_deref()
    }

    pub fn status(&self) -> TaskStatus {
        self.status
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    pub fn blocked_by(&self) -> &[String] {
        &self.blocked_by
    }

    pub fn blocks(&self) -> &[String] {
        &self.blocks
    }

    pub fn metadata(&self) -> Option<&TaskMetadata> {
        self.metadata.as_ref()
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

impl fmt::Debug for Task {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Task")
            .field("id", &self.id)
            .field("subject", &self.subject)
            .field("description", &self.description)
            .field("active_form", &self.active_form)
            .field("status", &self.status)
            .field("owner", &self.owner)
            .field("blocked_by", &self.blocked_by)
            .field("blocks", &self.blocks)
            .field("metadata", &self.metadata.as_ref().map(|_| "[REDACTED]"))
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskSnapshot {
    tasks: Vec<Task>,
    todos: Vec<Todo>,
}

impl TaskSnapshot {
    pub fn new(tasks: Vec<Task>, todos: Vec<Todo>) -> Self {
        Self { tasks, todos }
    }

    pub fn tasks(&self) -> &[Task] {
        &self.tasks
    }

    pub fn todos(&self) -> &[Todo] {
        &self.todos
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskCreateReceipt {
    task: Task,
    snapshot: TaskSnapshot,
}

impl TaskCreateReceipt {
    pub fn new(task: Task, snapshot: TaskSnapshot) -> Self {
        Self { task, snapshot }
    }

    pub fn task(&self) -> &Task {
        &self.task
    }

    pub fn snapshot(&self) -> &TaskSnapshot {
        &self.snapshot
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TodoSnapshot {
    todos: Vec<Todo>,
    updated_at: Option<u64>,
}

impl TodoSnapshot {
    pub fn new(todos: Vec<Todo>, updated_at: Option<u64>) -> Self {
        Self { todos, updated_at }
    }

    pub fn todos(&self) -> &[Todo] {
        &self.todos
    }

    pub fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskReadFailure {
    NotFound,
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Debug, Eq, PartialEq)]
pub enum TaskMutationOutcome<T> {
    Applied(T),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskInputError;

impl fmt::Display for TaskInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("task-manager input is invalid")
    }
}

impl std::error::Error for TaskInputError {}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionTarget {
    agent_id: String,
    session_key: String,
}

impl SessionTarget {
    pub fn try_new(agent_id: String, session_key: String) -> Result<Self, TaskInputError> {
        let agent_id = validate_agent_id(agent_id)?;
        if session_key.trim() != session_key || session_key.as_bytes().contains(&0) {
            return Err(TaskInputError);
        }
        let endpoint_session_id = match session_key.strip_prefix("agent:") {
            Some(canonical_key) => {
                let (canonical_agent_id, endpoint_session_id) =
                    canonical_key.split_once(':').ok_or(TaskInputError)?;
                if canonical_agent_id != agent_id {
                    return Err(TaskInputError);
                }
                required(endpoint_session_id.to_owned())?
            }
            None => required(session_key)?,
        };
        if endpoint_session_id
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("agent:"))
            || endpoint_session_id.split(':').any(str::is_empty)
        {
            return Err(TaskInputError);
        }
        let session_key = format!("agent:{agent_id}:{endpoint_session_id}");
        Ok(Self {
            agent_id,
            session_key,
        })
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }
}

impl fmt::Debug for SessionTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionTarget([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TaskTarget {
    session: SessionTarget,
    team_key: Option<String>,
}

impl TaskTarget {
    pub fn try_new(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self {
            session: SessionTarget::try_new(agent_id, session_key)?,
            team_key: team_key.map(required).transpose()?,
        })
    }

    pub fn session(&self) -> &SessionTarget {
        &self.session
    }

    pub fn session_key(&self) -> &str {
        self.session.session_key()
    }

    pub fn team_key(&self) -> Option<&str> {
        self.team_key.as_deref()
    }
}

impl fmt::Debug for TaskTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TaskTarget([REDACTED])")
    }
}

pub type ListOutcome = TaskReadOutcome<TaskSnapshot>;
pub type GetOutcome = TaskReadOutcome<Task>;
pub type CreateOutcome = TaskMutationOutcome<TaskCreateReceipt>;
pub type UpdateOutcome = TaskMutationOutcome<TaskSnapshot>;
pub type TodoWriteOutcome = TaskMutationOutcome<TodoSnapshot>;
pub type TodoGetOutcome = TaskReadOutcome<TodoSnapshot>;

#[derive(Debug, Eq, PartialEq)]
pub enum TaskReadOutcome<T> {
    Found(T),
    NotFound,
    Unavailable,
    Rejected,
    Protocol,
}

impl<T> From<TaskReadFailure> for TaskReadOutcome<T> {
    fn from(value: TaskReadFailure) -> Self {
        match value {
            TaskReadFailure::NotFound => Self::NotFound,
            TaskReadFailure::Unavailable => Self::Unavailable,
            TaskReadFailure::Rejected => Self::Rejected,
            TaskReadFailure::Protocol => Self::Protocol,
        }
    }
}

pub enum TaskOutcome {
    List(ListOutcome),
    Get(GetOutcome),
    Create(CreateOutcome),
    Update(UpdateOutcome),
    TodoWrite(TodoWriteOutcome),
    TodoGet(TodoGetOutcome),
}

impl fmt::Debug for TaskOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::List(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::List")
                .field(outcome)
                .finish(),
            Self::Get(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::Get")
                .field(outcome)
                .finish(),
            Self::Create(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::Create")
                .field(outcome)
                .finish(),
            Self::Update(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::Update")
                .field(outcome)
                .finish(),
            Self::TodoWrite(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::TodoWrite")
                .field(outcome)
                .finish(),
            Self::TodoGet(outcome) => formatter
                .debug_tuple("TaskManagerOutcome::TodoGet")
                .field(outcome)
                .finish(),
        }
    }
}

impl TaskOutcome {
    pub fn unavailable(command: TaskCommand) -> Self {
        match command {
            TaskCommand::List { .. } => Self::List(TaskReadOutcome::Unavailable),
            TaskCommand::Get { .. } => Self::Get(TaskReadOutcome::Unavailable),
            TaskCommand::Create { .. } => Self::Create(TaskMutationOutcome::OutcomeUnknown),
            TaskCommand::Update { .. } => Self::Update(TaskMutationOutcome::OutcomeUnknown),
            TaskCommand::TodoWrite { .. } => Self::TodoWrite(TaskMutationOutcome::OutcomeUnknown),
            TaskCommand::TodoGet { .. } => Self::TodoGet(TaskReadOutcome::Unavailable),
        }
    }

    pub fn from_failure(command: TaskCommand, failure: TaskRuntimeFailure) -> Self {
        match failure {
            TaskRuntimeFailure::TargetRejected => match command {
                TaskCommand::List { .. } => Self::List(TaskReadOutcome::Rejected),
                TaskCommand::Get { .. } => Self::Get(TaskReadOutcome::Rejected),
                TaskCommand::Create { .. } => Self::Create(TaskMutationOutcome::Rejected),
                TaskCommand::Update { .. } => Self::Update(TaskMutationOutcome::Rejected),
                TaskCommand::TodoWrite { .. } => Self::TodoWrite(TaskMutationOutcome::Rejected),
                TaskCommand::TodoGet { .. } => Self::TodoGet(TaskReadOutcome::Rejected),
            },
            TaskRuntimeFailure::Unsupported
            | TaskRuntimeFailure::Unavailable
            | TaskRuntimeFailure::Unknown => Self::unavailable(command),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskRuntimeFailure {
    Unsupported,
    Unavailable,
    TargetRejected,
    Unknown,
}

pub enum TaskCommand {
    List {
        target: TaskTarget,
    },
    Get {
        target: TaskTarget,
        task_id: String,
    },
    Create {
        target: TaskTarget,
        input: TaskCreate,
    },
    Update {
        target: TaskTarget,
        input: TaskUpdate,
    },
    TodoWrite {
        target: SessionTarget,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    },
    TodoGet {
        target: SessionTarget,
    },
}

impl TaskCommand {
    pub fn list(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self::List {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
        })
    }

    pub fn get(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        task_id: String,
    ) -> Result<Self, TaskInputError> {
        Ok(Self::Get {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            task_id: required(task_id)?,
        })
    }

    pub fn create(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        input: TaskCreate,
    ) -> Result<Self, TaskInputError> {
        Ok(Self::Create {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            input,
        })
    }

    pub fn update(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        input: TaskUpdate,
    ) -> Result<Self, TaskInputError> {
        Ok(Self::Update {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            input,
        })
    }

    pub fn todo_write(
        agent_id: String,
        session_key: String,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self::TodoWrite {
            target: SessionTarget::try_new(agent_id, session_key)?,
            old_todos,
            new_todos,
        })
    }

    pub fn todo_get(agent_id: String, session_key: String) -> Result<Self, TaskInputError> {
        Ok(Self::TodoGet {
            target: SessionTarget::try_new(agent_id, session_key)?,
        })
    }
}

impl fmt::Debug for TaskCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::List { .. } => formatter.write_str("TaskManagerCommand::List"),
            Self::Get { .. } => formatter.write_str("TaskManagerCommand::Get"),
            Self::Create { .. } => formatter.write_str("TaskManagerCommand::Create"),
            Self::Update { .. } => formatter.write_str("TaskManagerCommand::Update"),
            Self::TodoWrite { .. } => formatter.write_str("TaskManagerCommand::TodoWrite"),
            Self::TodoGet { .. } => formatter.write_str("TaskManagerCommand::TodoGet"),
        }
    }
}

fn required(value: String) -> Result<String, TaskInputError> {
    if value.is_empty() || value.trim() != value || value.as_bytes().contains(&0) {
        return Err(TaskInputError);
    }
    Ok(value)
}

fn validate_agent_id(value: String) -> Result<String, TaskInputError> {
    let value = required(value)?;
    let bytes = value.as_bytes();
    ((1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && bytes.iter().all(|byte| !byte.is_ascii_uppercase()))
    .then_some(value)
    .ok_or(TaskInputError)
}

fn non_empty(value: String) -> Result<String, TaskInputError> {
    required(value)
}

fn non_empty_list(values: Vec<String>) -> Result<Vec<String>, TaskInputError> {
    if values.is_empty() {
        return Err(TaskInputError);
    }
    values.into_iter().map(non_empty).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_crud_builds_a_canonical_agent_scoped_session_key() {
        let command =
            TaskCommand::list("main".into(), "session-1".into(), Some("team-1".into())).unwrap();
        let TaskCommand::List { target } = command else {
            panic!("list constructor must create the list command");
        };

        assert_eq!(target.session_key(), "agent:main:session-1");
        assert!(format!("{target:?}").contains("REDACTED"));
    }

    #[test]
    fn session_target_accepts_bare_and_matching_canonical_session_keys() {
        for session_key in ["session-1", "agent:main:session-1"] {
            let command = TaskCommand::todo_get("main".into(), session_key.into()).unwrap();
            let TaskCommand::TodoGet { target } = command else {
                panic!("todo get constructor must create the todo get command");
            };

            assert_eq!(target.session_key(), "agent:main:session-1");
            assert_eq!(format!("{target:?}"), "SessionTarget([REDACTED])");
        }
    }

    #[test]
    fn invalid_or_ambiguous_identity_is_rejected() {
        for (agent, session) in [
            ("".into(), "session-1".into()),
            ("main".into(), " agent:main:session-1".into()),
            ("main".into(), "agent:other:session-1".into()),
            ("main".into(), "agent:main".into()),
            ("main".into(), "agent:main:agent:session-1".into()),
            ("main".into(), "agent:main:session::one".into()),
            ("main".into(), "agent:main:session-1 ".into()),
            ("main".into(), "agent:main:session\0one".into()),
            ("main".into(), "session::one".into()),
            ("main".into(), "session\0one".into()),
        ] {
            assert!(TaskCommand::todo_get(agent, session).is_err());
        }
        assert!(
            TaskCommand::list("main".into(), "session-1".into(), Some(" team".into())).is_err()
        );
    }

    #[test]
    fn read_and_mutation_outcomes_preserve_their_semantics() {
        let not_found: TaskReadOutcome<()> = TaskReadFailure::NotFound.into();
        let unavailable: TaskReadOutcome<()> = TaskReadFailure::Unavailable.into();
        let rejected: TaskMutationOutcome<()> = TaskMutationOutcome::Rejected;
        let unknown: TaskMutationOutcome<()> = TaskMutationOutcome::OutcomeUnknown;

        assert!(matches!(not_found, TaskReadOutcome::NotFound));
        assert!(matches!(unavailable, TaskReadOutcome::Unavailable));
        assert!(matches!(rejected, TaskMutationOutcome::Rejected));
        assert!(matches!(unknown, TaskMutationOutcome::OutcomeUnknown));
    }
}
