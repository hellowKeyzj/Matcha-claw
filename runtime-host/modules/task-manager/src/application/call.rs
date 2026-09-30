use platform::call::{CallContext, CallDetail, CallLogError, CallStatus};
use serde::Serialize;

use crate::domain::model::{
    TaskCommand, TaskMutationOutcome, TaskOutcome, TaskReadOutcome, TaskSnapshot, TaskStatus,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskCallDetail {
    agent_ref: Option<String>,
    session_ref: Option<String>,
    team_ref: Option<String>,
    task_ref: Option<String>,
    requested_status: Option<TaskStatus>,
    task_status: Option<TaskStatus>,
    task_count: Option<usize>,
    todo_count: Option<usize>,
    mutation: Option<MutationStatus>,
    read: Option<ReadStatus>,
    pub(crate) failure: Option<CallFailure>,
}

impl CallDetail for TaskCallDetail {
    const MODULE: &'static str = "task-manager";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum MutationStatus {
    Applied,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReadStatus {
    Found,
    NotFound,
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallFailure {
    AdmissionClosed,
    Unsupported,
    Unavailable,
    OwnerUnavailable,
}

impl TaskCallDetail {
    pub(crate) fn from_command(command: &TaskCommand) -> Self {
        let (session, team_key, task_id, requested_status) = match command {
            TaskCommand::List { target } | TaskCommand::Create { target, .. } => {
                (target.session(), target.team_key(), None, None)
            }
            TaskCommand::Get { target, task_id } => (
                target.session(),
                target.team_key(),
                Some(task_id.as_str()),
                None,
            ),
            TaskCommand::Update { target, input } => (
                target.session(),
                target.team_key(),
                Some(input.task_id()),
                input.status(),
            ),
            TaskCommand::TodoGet { target } | TaskCommand::TodoWrite { target, .. } => {
                (target, None, None, None)
            }
        };
        Self {
            agent_ref: safe_reference(session.agent_id()),
            session_ref: safe_reference(session.session_key()),
            team_ref: team_key.and_then(safe_reference),
            task_ref: task_id.and_then(safe_reference),
            requested_status,
            task_status: None,
            task_count: None,
            todo_count: None,
            mutation: None,
            read: None,
            failure: None,
        }
    }

    pub(crate) fn finish(&mut self, outcome: &TaskOutcome) -> CallStatus {
        match outcome {
            TaskOutcome::List(outcome) => {
                if let TaskReadOutcome::Found(snapshot) = outcome {
                    self.snapshot(snapshot);
                }
                self.read(outcome)
            }
            TaskOutcome::Get(outcome) => {
                if let TaskReadOutcome::Found(task) = outcome {
                    self.task_ref = safe_reference(task.id());
                    self.task_status = Some(task.status());
                    self.task_count = Some(1);
                } else if matches!(outcome, TaskReadOutcome::NotFound) {
                    self.task_count = Some(0);
                }
                self.read(outcome)
            }
            TaskOutcome::Create(outcome) => {
                if let TaskMutationOutcome::Applied(receipt) = outcome {
                    self.task_ref = safe_reference(receipt.task().id());
                    self.task_status = Some(receipt.task().status());
                    self.snapshot(receipt.snapshot());
                }
                self.mutation(outcome)
            }
            TaskOutcome::Update(outcome) => {
                if let TaskMutationOutcome::Applied(snapshot) = outcome {
                    self.task_status = snapshot
                        .tasks()
                        .iter()
                        .find(|task| Some(task.id()) == self.task_ref.as_deref())
                        .map(|task| task.status());
                    self.snapshot(snapshot);
                }
                self.mutation(outcome)
            }
            TaskOutcome::TodoGet(outcome) => {
                if let TaskReadOutcome::Found(snapshot) = outcome {
                    self.todo_count = Some(snapshot.todos().len());
                }
                self.read(outcome)
            }
            TaskOutcome::TodoWrite(outcome) => {
                if let TaskMutationOutcome::Applied(snapshot) = outcome {
                    self.todo_count = Some(snapshot.todos().len());
                }
                self.mutation(outcome)
            }
        }
    }

    fn snapshot(&mut self, snapshot: &TaskSnapshot) {
        self.task_count = Some(snapshot.tasks().len());
        self.todo_count = Some(snapshot.todos().len());
    }

    fn read<T>(&mut self, outcome: &TaskReadOutcome<T>) -> CallStatus {
        let (read, status) = match outcome {
            TaskReadOutcome::Found(_) => (ReadStatus::Found, CallStatus::Succeeded),
            TaskReadOutcome::NotFound => (ReadStatus::NotFound, CallStatus::Succeeded),
            TaskReadOutcome::Unavailable => (ReadStatus::Unavailable, CallStatus::Failed),
            TaskReadOutcome::Rejected => (ReadStatus::Rejected, CallStatus::Rejected),
            TaskReadOutcome::Protocol => (ReadStatus::Protocol, CallStatus::Failed),
        };
        self.read = Some(read);
        status
    }

    fn mutation<T>(&mut self, outcome: &TaskMutationOutcome<T>) -> CallStatus {
        // Applied confirms this store mutation, not task execution or completion.
        let (mutation, status) = match outcome {
            TaskMutationOutcome::Applied(_) => (MutationStatus::Applied, CallStatus::Succeeded),
            TaskMutationOutcome::Rejected => (MutationStatus::Rejected, CallStatus::Rejected),
            TaskMutationOutcome::OutcomeUnknown => (MutationStatus::Unknown, CallStatus::Unknown),
        };
        self.mutation = Some(mutation);
        status
    }
}

pub(crate) struct TaskCall {
    pub(crate) context: CallContext<TaskCallDetail>,
    pub(crate) detail: TaskCallDetail,
}

fn safe_reference(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')))
    .then(|| value.to_owned())
}

pub(crate) fn command_name(command: &TaskCommand) -> &'static str {
    match command {
        TaskCommand::List { .. } => "tasks.list",
        TaskCommand::Get { .. } => "tasks.get",
        TaskCommand::Create { .. } => "tasks.create",
        TaskCommand::Update { .. } => "tasks.update",
        TaskCommand::TodoGet { .. } => "todos.get",
        TaskCommand::TodoWrite { .. } => "todos.write",
    }
}

pub(crate) fn record_error(result: Result<(), CallLogError>) {
    if let Err(error) = result {
        eprintln!("[task-manager.call_log] outcome=failed code={error:?}");
    }
}
