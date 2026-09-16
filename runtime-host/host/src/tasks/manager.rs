use std::fmt;

use openclaw::{
    session::protocol::{AgentId, AgentScopedSessionKey, EndpointSessionId},
    task_manager::{
        Task, TaskCreate, TaskMutationOutcome, TaskReadFailure, TaskScope, TaskSnapshot,
        TaskUpdate, Todo, TodoSnapshot,
    },
};

/// Host-owned task-manager admission command. OpenClaw owns the plugin state
/// machine; this command only carries a validated native task target.
pub(crate) enum Command {
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

impl Command {
    pub(crate) fn list(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self::List {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
        })
    }

    pub(crate) fn get(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        task_id: String,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self::Get {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            task_id: required(task_id)?,
        })
    }

    pub(crate) fn create(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        input: TaskCreate,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self::Create {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            input,
        })
    }

    pub(crate) fn update(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
        input: TaskUpdate,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self::Update {
            target: TaskTarget::try_new(agent_id, session_key, team_key)?,
            input,
        })
    }

    pub(crate) fn todo_write(
        agent_id: String,
        session_key: String,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self::TodoWrite {
            target: SessionTarget::try_new(agent_id, session_key)?,
            old_todos,
            new_todos,
        })
    }

    pub(crate) fn todo_get(agent_id: String, session_key: String) -> Result<Self, InvalidIdentity> {
        Ok(Self::TodoGet {
            target: SessionTarget::try_new(agent_id, session_key)?,
        })
    }
}

impl fmt::Debug for Command {
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

/// A canonical agent-scoped OpenClaw session target for todos.
/// It is deliberately not a public DTO: session identity is never projected.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SessionTarget {
    session_key: String,
}

impl SessionTarget {
    fn try_new(agent_id: String, session_key: String) -> Result<Self, InvalidIdentity> {
        let agent_id = AgentId::try_new(agent_id).map_err(|_| InvalidIdentity)?;
        if session_key.trim() != session_key || session_key.as_bytes().contains(&0) {
            return Err(InvalidIdentity);
        }

        let endpoint_session_id = match session_key.strip_prefix("agent:") {
            Some(canonical_key) => {
                let (canonical_agent_id, endpoint_session_id) =
                    canonical_key.split_once(':').ok_or(InvalidIdentity)?;
                if canonical_agent_id != agent_id.as_str() {
                    return Err(InvalidIdentity);
                }
                EndpointSessionId::try_new(endpoint_session_id).map_err(|_| InvalidIdentity)?
            }
            None => EndpointSessionId::try_new(session_key).map_err(|_| InvalidIdentity)?,
        };
        let session_key = AgentScopedSessionKey::try_new(agent_id, endpoint_session_id)
            .map_err(|_| InvalidIdentity)?;
        Ok(Self {
            session_key: session_key.as_str().to_owned(),
        })
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.session_key
    }

    pub(crate) fn scope(&self, workspace_dir: String) -> Result<TaskScope, InvalidIdentity> {
        TaskScope::try_new(self.session_key.clone(), None, workspace_dir)
            .map_err(|_| InvalidIdentity)
    }
}

impl fmt::Debug for SessionTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionTarget([REDACTED])")
    }
}

/// A task CRUD target may carry a team key. Todos intentionally use
/// `SessionTarget`, so a team key cannot enter those calls.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct TaskTarget {
    session: SessionTarget,
    team_key: Option<String>,
}

impl TaskTarget {
    fn try_new(
        agent_id: String,
        session_key: String,
        team_key: Option<String>,
    ) -> Result<Self, InvalidIdentity> {
        Ok(Self {
            session: SessionTarget::try_new(agent_id, session_key)?,
            team_key: team_key.map(required).transpose()?,
        })
    }

    pub(crate) fn session_key(&self) -> &str {
        self.session.session_key()
    }

    pub(crate) fn scope(&self, workspace_dir: String) -> Result<TaskScope, InvalidIdentity> {
        TaskScope::try_new(
            self.session.session_key.clone(),
            self.team_key.clone(),
            workspace_dir,
        )
        .map_err(|_| InvalidIdentity)
    }
}

impl fmt::Debug for TaskTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TaskTarget([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidIdentity;

impl fmt::Display for InvalidIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("task target is invalid")
    }
}

impl std::error::Error for InvalidIdentity {}

/// Read projections preserve the native task/todo view but never expose a
/// session, team, workspace, or raw gateway payload. Metadata remains opaque
/// inside the OpenClaw integration type.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ReadOutcome<T> {
    Found(T),
    NotFound,
    Unavailable,
    Rejected,
    Protocol,
}

impl<T> From<Result<T, TaskReadFailure>> for ReadOutcome<T> {
    fn from(value: Result<T, TaskReadFailure>) -> Self {
        match value {
            Ok(value) => Self::Found(value),
            Err(TaskReadFailure::NotFound) => Self::NotFound,
            Err(TaskReadFailure::Unavailable) => Self::Unavailable,
            Err(TaskReadFailure::Rejected) => Self::Rejected,
            Err(TaskReadFailure::Protocol) => Self::Protocol,
        }
    }
}

/// A mutation acknowledgement is not retried. `Applied` carries the native
/// authoritative readback for create/update, or the native receipt otherwise.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum MutationOutcome<T> {
    Applied(T),
    Rejected,
    OutcomeUnknown,
}

impl<T> From<TaskMutationOutcome<T>> for MutationOutcome<T> {
    fn from(value: TaskMutationOutcome<T>) -> Self {
        match value {
            TaskMutationOutcome::Applied(value) => Self::Applied(value),
            TaskMutationOutcome::Rejected => Self::Rejected,
            TaskMutationOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

pub(crate) type ListOutcome = ReadOutcome<TaskSnapshot>;
pub(crate) type GetOutcome = ReadOutcome<Task>;
pub(crate) type CreateOutcome = MutationOutcome<openclaw::task_manager::TaskCreateReceipt>;
pub(crate) type UpdateOutcome = MutationOutcome<TaskSnapshot>;
pub(crate) type TodoWriteOutcome = MutationOutcome<TodoSnapshot>;
pub(crate) type TodoGetOutcome = ReadOutcome<TodoSnapshot>;

pub(crate) enum Outcome {
    List(ListOutcome),
    Get(GetOutcome),
    Create(CreateOutcome),
    Update(UpdateOutcome),
    TodoWrite(TodoWriteOutcome),
    TodoGet(TodoGetOutcome),
}

impl fmt::Debug for Outcome {
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

impl Outcome {
    pub(crate) fn unavailable(command: Command) -> Self {
        match command {
            Command::List { .. } => Self::List(ReadOutcome::Unavailable),
            Command::Get { .. } => Self::Get(ReadOutcome::Unavailable),
            Command::Create { .. } => Self::Create(MutationOutcome::OutcomeUnknown),
            Command::Update { .. } => Self::Update(MutationOutcome::OutcomeUnknown),
            Command::TodoWrite { .. } => Self::TodoWrite(MutationOutcome::OutcomeUnknown),
            Command::TodoGet { .. } => Self::TodoGet(ReadOutcome::Unavailable),
        }
    }

    pub(crate) fn from_failure(
        command: Command,
        failure: crate::runtime::driver::RuntimeOperationFailure,
    ) -> Self {
        match failure {
            crate::runtime::driver::RuntimeOperationFailure::TargetRejected => match command {
                Command::List { .. } => Self::List(ReadOutcome::Rejected),
                Command::Get { .. } => Self::Get(ReadOutcome::Rejected),
                Command::Create { .. } => Self::Create(MutationOutcome::Rejected),
                Command::Update { .. } => Self::Update(MutationOutcome::Rejected),
                Command::TodoWrite { .. } => Self::TodoWrite(MutationOutcome::Rejected),
                Command::TodoGet { .. } => Self::TodoGet(ReadOutcome::Rejected),
            },
            crate::runtime::driver::RuntimeOperationFailure::Unsupported
            | crate::runtime::driver::RuntimeOperationFailure::Unavailable
            | crate::runtime::driver::RuntimeOperationFailure::Unknown => {
                Self::unavailable(command)
            }
        }
    }
}

fn required(value: String) -> Result<String, InvalidIdentity> {
    if value.is_empty() || value.trim() != value || value.as_bytes().contains(&0) {
        return Err(InvalidIdentity);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_crud_builds_a_canonical_agent_scoped_session_key() {
        let command =
            Command::list("main".into(), "session-1".into(), Some("team-1".into())).unwrap();
        let Command::List { target } = command else {
            panic!("list constructor must create the list command");
        };

        assert_eq!(target.session_key(), "agent:main:session-1");
        assert!(format!("{target:?}").contains("REDACTED"));
    }

    #[test]
    fn session_target_accepts_bare_and_matching_canonical_session_keys() {
        for session_key in ["session-1", "agent:main:session-1"] {
            let command = Command::todo_get("main".into(), session_key.into()).unwrap();
            let Command::TodoGet { target } = command else {
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
            assert!(Command::todo_get(agent, session).is_err());
        }
        assert!(Command::list("main".into(), "session-1".into(), Some(" team".into())).is_err());
    }

    #[test]
    fn read_and_mutation_outcomes_preserve_their_semantics() {
        let not_found: ReadOutcome<()> = Err(TaskReadFailure::NotFound).into();
        let unavailable: ReadOutcome<()> = Err(TaskReadFailure::Unavailable).into();
        let rejected: MutationOutcome<()> = TaskMutationOutcome::Rejected.into();
        let unknown: MutationOutcome<()> = TaskMutationOutcome::OutcomeUnknown.into();

        assert!(matches!(not_found, ReadOutcome::NotFound));
        assert!(matches!(unavailable, ReadOutcome::Unavailable));
        assert!(matches!(rejected, MutationOutcome::Rejected));
        assert!(matches!(unknown, MutationOutcome::OutcomeUnknown));
    }
}
