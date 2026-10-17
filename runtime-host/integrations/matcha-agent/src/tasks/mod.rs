use foundation::process::supervision::SupervisorPhase;
use serde::Deserialize;
use serde_json::{Value, json};
use task_manager::{
    SessionTarget, Task, TaskCommand, TaskCreateReceipt, TaskFuture, TaskMetadata,
    TaskMutationOutcome, TaskOps, TaskOutcome, TaskReadOutcome, TaskSnapshot,
    TaskStatus, Todo, TodoSnapshot, TodoStatus,
};

use crate::{client::{Client, Delivery, Error}, driver::MatchaRuntimeDriver};

impl TaskOps for MatchaRuntimeDriver {
    fn task_manager<'a>(&'a self, command: TaskCommand) -> TaskFuture<'a, TaskOutcome> {
        Box::pin(async move {
            let client = self.native_client();
            let target = match &command {
                TaskCommand::List { target } | TaskCommand::Get { target, .. }
                | TaskCommand::Create { target, .. } | TaskCommand::Update { target, .. } => target.session(),
                TaskCommand::TodoGet { target } | TaskCommand::TodoWrite { target, .. } => target,
            };
            let (agent_id, session_id) = match address(&client, target).await {
                Ok(address) => address,
                Err(failure) => return failed_before_write(command, failure),
            };
            let mut params = json!({"agentId": agent_id, "sessionId": session_id});
            let method = match &command {
                TaskCommand::List { target } => {
                    params["kind"] = json!("taskList");
                    list_id(&mut params, target.team_key());
                    "tasks.list"
                }
                TaskCommand::Get { target, task_id } => {
                    params["kind"] = json!("taskList");
                    params["id"] = json!(task_id);
                    list_id(&mut params, target.team_key());
                    "tasks.get"
                }
                TaskCommand::Create { target, input } => {
                    list_id(&mut params, target.team_key());
                    params["input"] = match serde_json::to_value(input) { Ok(input) => input, Err(_) => return failed(command, Failure::Rejected) };
                    "tasks.create"
                }
                TaskCommand::Update { target, input } => {
                    list_id(&mut params, target.team_key());
                    params["input"] = match serde_json::to_value(input) { Ok(input) => input, Err(_) => return failed(command, Failure::Rejected) };
                    "tasks.update"
                }
                TaskCommand::TodoGet { .. } => "todos.get",
                TaskCommand::TodoWrite { old_todos, new_todos, .. } => {
                    let (Some(old), Some(new)) = (native_todos(old_todos), native_todos(new_todos)) else {
                        return failed(command, Failure::Rejected);
                    };
                    params["oldTodos"] = Value::Array(old);
                    params["newTodos"] = Value::Array(new);
                    "todos.write"
                }
            };
            let receipt = match client.call(method, params).await {
                Ok(value) if value["agentId"] == agent_id && value["sessionId"] == session_id && value["instanceId"].is_string() => value["receipt"].clone(),
                Ok(_) => return failed(command, Failure::Protocol),
                Err(error) => return failed(command, failure(&error)),
            };
            match command {
                TaskCommand::List { .. } => TaskOutcome::List(read(snapshot(&receipt))),
                TaskCommand::Get { task_id, .. } => TaskOutcome::Get(read(task(&receipt["task"]).filter(|task| task.id() == task_id))),
                TaskCommand::Create { .. } => {
                    let value = if receipt["persisted"] == true && receipt["outcome"] == "applied" {
                        task(&receipt["task"]).zip(snapshot(&receipt)).map(|(task, snapshot)| TaskCreateReceipt::new(task, snapshot))
                    } else { None };
                    TaskOutcome::Create(mutation(value))
                }
                TaskCommand::Update { input, .. } => {
                    let applied = receipt["persisted"] == true && receipt["outcome"] == "applied";
                    let value = snapshot(&receipt).filter(|snapshot| {
                        if input.status() == Some(TaskStatus::Deleted) {
                            receipt["deletedId"] == input.task_id() && snapshot.tasks().iter().all(|task| task.id() != input.task_id() && !task.blocks().iter().chain(task.blocked_by()).any(|id| id == input.task_id()))
                        } else { snapshot.tasks().iter().any(|task| task.id() == input.task_id()) }
                    });
                    TaskOutcome::Update(mutation(value.filter(|_| applied)))
                }
                TaskCommand::TodoGet { .. } => TaskOutcome::TodoGet(read(todo_snapshot(&receipt))),
                TaskCommand::TodoWrite { .. } => {
                    let applied = receipt["stateApplied"] == true && receipt["transcriptPersisted"] == true
                        && receipt["transcriptMessageId"].as_str().is_some_and(|id| !id.is_empty());
                    TaskOutcome::TodoWrite(mutation(todo_snapshot(&receipt).filter(|snapshot| applied && snapshot.updated_at().is_some())))
                }
            }
        })
    }

    fn task_runtime_ready(&self) -> bool {
        self.lifecycle_handle().snapshot().phase() == SupervisorPhase::Running
    }
}

async fn address(client: &Client, target: &SessionTarget) -> Result<(String, String), Failure> {
    let platform::endpoint::runtime_address::RuntimeScope::Session(identity) = target.scope() else { return Err(Failure::Rejected); };
    if identity.endpoint() != &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() { return Err(Failure::Rejected); }
    let (agent_id, session_id) = crate::session::projection::parse_session_key(target.session_key()).ok_or(Failure::Rejected)?;
    if agent_id != target.agent_id() { return Err(Failure::Rejected); }
    let session = client.call("sessions.get", json!({"sessionId": session_id})).await.map_err(|error| failure(&error))?;
    if session["sessionId"] != session_id || session["agentId"] != agent_id { return Err(Failure::Rejected); }
    Ok((agent_id.to_owned(), session_id.to_owned()))
}

fn list_id(params: &mut Value, team_key: Option<&str>) {
    if let Some(key) = team_key { params["listId"] = json!(key); }
}

fn native_todos(todos: &[Todo]) -> Option<Vec<Value>> {
    todos.iter().map(|todo| {
        // Native Todo has no id/owner fields. Never silently discard product data.
        if todo.id().is_some() || todo.owner().is_some() { return None; }
        Some(json!({"content": todo.content(), "activeForm": todo.active_form()?, "status": todo.status()}))
    }).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTask {
    id: String, subject: String, description: String, status: TaskStatus,
    active_form: Option<String>, owner: Option<String>, blocks: Vec<String>, blocked_by: Vec<String>,
    metadata: Option<TaskMetadata>, created_at: u64, updated_at: u64,
}
fn task(value: &Value) -> Option<Task> {
    let t: NativeTask = serde_json::from_value(value.clone()).ok()?;
    if t.id.is_empty() || t.status == TaskStatus::Deleted { return None; }
    Some(Task::new(t.id, t.subject, t.description, t.active_form, t.status, t.owner,
        t.blocked_by, t.blocks, t.metadata, t.created_at, t.updated_at))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeTodo { content: String, active_form: String, status: TodoStatus }
fn todos(value: &Value) -> Option<Vec<Todo>> {
    serde_json::from_value::<Vec<NativeTodo>>(value.clone()).ok()?.into_iter().map(|todo| {
        Todo::try_new(None, todo.content, Some(todo.active_form), todo.status, None).ok()
    }).collect()
}
fn snapshot(value: &Value) -> Option<TaskSnapshot> {
    Some(TaskSnapshot::new(value["tasks"].as_array()?.iter().map(task).collect::<Option<Vec<_>>>()?, todos(&value["todos"])?))
}
fn todo_snapshot(value: &Value) -> Option<TodoSnapshot> {
    let updated_at = match value.get("updatedAt") {
        Some(value) => Some(value.as_u64().filter(|timestamp| *timestamp <= 9_007_199_254_740_991)?),
        None => None,
    };
    Some(TodoSnapshot::new(todos(&value["todos"])?, updated_at))
}
fn read<T>(value: Option<T>) -> TaskReadOutcome<T> {
    value.map(TaskReadOutcome::Found).unwrap_or(TaskReadOutcome::Protocol)
}
fn mutation<T>(value: Option<T>) -> TaskMutationOutcome<T> {
    value.map(TaskMutationOutcome::Applied).unwrap_or(TaskMutationOutcome::OutcomeUnknown)
}

#[derive(Clone, Copy)]
enum Failure { NotFound, Rejected, NotSent, Unavailable, Protocol, Unknown }

fn failed_before_write(command: TaskCommand, failure: Failure) -> TaskOutcome {
    if matches!(command, TaskCommand::Create { .. } | TaskCommand::Update { .. } | TaskCommand::TodoWrite { .. }) {
        failed(command, Failure::Rejected)
    } else {
        failed(command, failure)
    }
}
fn failure(error: &Error) -> Failure {
    if error.data().and_then(|value| value["outcome"].as_str()) == Some("unknown") { return Failure::Unknown; }
    match error.code() {
        Some(-32001) => return Failure::NotFound,
        Some(-32602 | -32002) => return Failure::Rejected,
        _ => {},
    }
    if error.data().and_then(|value| value["outcome"].as_str()) == Some("rejected")
        || error.data().and_then(|value| value["delivery"].as_str()) == Some("notSent") { return Failure::NotSent; }
    if error.delivery() == Delivery::Unknown || error.code() == Some(-32006) { return Failure::Unknown; }
    if error.delivery() == Delivery::NotSent { return Failure::NotSent; }
    Failure::Unavailable
}
fn failed(command: TaskCommand, failure: Failure) -> TaskOutcome {
    fn read_failure<T>(failure: Failure) -> TaskReadOutcome<T> {
        match failure {
            Failure::NotFound => TaskReadOutcome::NotFound,
            Failure::Rejected => TaskReadOutcome::Rejected,
            Failure::Protocol => TaskReadOutcome::Protocol,
            Failure::NotSent | Failure::Unavailable | Failure::Unknown => TaskReadOutcome::Unavailable,
        }
    }
    fn mutation_failure<T>(failure: Failure) -> TaskMutationOutcome<T> {
        match failure { Failure::NotFound | Failure::Rejected | Failure::NotSent => TaskMutationOutcome::Rejected, Failure::Unavailable | Failure::Protocol | Failure::Unknown => TaskMutationOutcome::OutcomeUnknown }
    }
    match command {
        TaskCommand::List { .. } => TaskOutcome::List(read_failure(failure)),
        TaskCommand::Get { .. } => TaskOutcome::Get(read_failure(failure)),
        TaskCommand::Create { .. } => TaskOutcome::Create(mutation_failure(failure)),
        TaskCommand::Update { .. } => TaskOutcome::Update(mutation_failure(failure)),
        TaskCommand::TodoGet { .. } => TaskOutcome::TodoGet(read_failure(failure)),
        TaskCommand::TodoWrite { .. } => TaskOutcome::TodoWrite(mutation_failure(failure)),
    }
}
