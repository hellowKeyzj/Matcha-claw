use foundation::process::supervision::SupervisorPhase;
use serde::Deserialize;
use serde_json::{Value, json};
use task_manager::{
    SessionTarget, Task, TaskCommand, TaskCreateReceipt, TaskDelivery, TaskExecution,
    TaskFailure, TaskFailureCode, TaskFailureStage, TaskFuture, TaskMetadata,
    TaskMutationOutcome, TaskOps, TaskOutcome, TaskReadOutcome, TaskSnapshot,
    TaskStatus, Todo, TodoSnapshot, TodoStatus,
};

use crate::{client::{Client, Delivery, Error}, driver::MatchaRuntimeDriver};

impl TaskOps for MatchaRuntimeDriver {
    fn task_manager<'a>(&'a self, command: TaskCommand) -> TaskFuture<'a, TaskExecution> {
        Box::pin(async move {
            let client = self.native_client();
            let target = match &command {
                TaskCommand::List { target } | TaskCommand::Get { target, .. }
                | TaskCommand::Create { target, .. } | TaskCommand::Update { target, .. } => target.session(),
                TaskCommand::TodoGet { target } | TaskCommand::TodoWrite { target, .. } => target,
            };
            let (agent_id, session_id) = match address(&client, target).await {
                Ok(address) => address,
                Err((failure, diagnostic)) => return failed_before_write(command, failure, diagnostic),
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
                    params["input"] = match serde_json::to_value(input) { Ok(input) => input, Err(_) => return failed(command, Failure::Rejected, TaskFailure::new(TaskFailureStage::TaskRequest, TaskFailureCode::InvalidParams)) };
                    "tasks.create"
                }
                TaskCommand::Update { target, input } => {
                    list_id(&mut params, target.team_key());
                    params["input"] = match serde_json::to_value(input) { Ok(input) => input, Err(_) => return failed(command, Failure::Rejected, TaskFailure::new(TaskFailureStage::TaskRequest, TaskFailureCode::InvalidParams)) };
                    "tasks.update"
                }
                TaskCommand::TodoGet { .. } => "todos.get",
                TaskCommand::TodoWrite { old_todos, new_todos, .. } => {
                    let (Some(old), Some(new)) = (native_todos(old_todos), native_todos(new_todos)) else {
                        return failed(command, Failure::Rejected, TaskFailure::new(TaskFailureStage::TaskRequest, TaskFailureCode::InvalidParams));
                    };
                    params["oldTodos"] = Value::Array(old);
                    params["newTodos"] = Value::Array(new);
                    "todos.write"
                }
            };
            let receipt = match client.call(method, params).await {
                Ok(value) if value["agentId"] != agent_id || value["sessionId"] != session_id => {
                    return failed(command, Failure::Protocol, response_failure(TaskFailureCode::OwnershipMismatch));
                }
                Ok(value) if match &command {
                    TaskCommand::List { .. } | TaskCommand::Get { .. } | TaskCommand::TodoGet { .. } => {
                        value.get("instanceId") == Some(&Value::Null)
                    }
                    TaskCommand::Create { .. } | TaskCommand::Update { .. } | TaskCommand::TodoWrite { .. } => {
                        value["instanceId"].as_str().is_some_and(|id| !id.is_empty())
                    }
                } => value["receipt"].clone(),
                Ok(_) => return failed(command, Failure::Protocol, response_failure(TaskFailureCode::ReceiptInvalid)),
                Err(error) => return failed(command, failure(&error), diagnostic(&error, TaskFailureStage::TaskRequest)),
            };
            let outcome = match command {
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
            };
            if matches!(&outcome,
                TaskOutcome::List(TaskReadOutcome::Protocol) | TaskOutcome::Get(TaskReadOutcome::Protocol)
                | TaskOutcome::TodoGet(TaskReadOutcome::Protocol) | TaskOutcome::Create(TaskMutationOutcome::OutcomeUnknown)
                | TaskOutcome::Update(TaskMutationOutcome::OutcomeUnknown) | TaskOutcome::TodoWrite(TaskMutationOutcome::OutcomeUnknown)
            ) {
                TaskExecution::failed(outcome, response_failure(TaskFailureCode::ReceiptInvalid))
            } else {
                TaskExecution::new(outcome)
            }
        })
    }

    fn task_runtime_ready(&self) -> bool {
        self.lifecycle_handle().snapshot().phase() == SupervisorPhase::Running
    }
}

async fn address(client: &Client, target: &SessionTarget) -> Result<(String, String), (Failure, TaskFailure)> {
    let rejected = |code| (Failure::Rejected, TaskFailure::new(TaskFailureStage::SessionLookup, code));
    let platform::endpoint::runtime_address::RuntimeScope::Session(identity) = target.scope() else { return Err(rejected(TaskFailureCode::InvalidIdentity)); };
    if identity.endpoint() != &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() { return Err(rejected(TaskFailureCode::InvalidIdentity)); }
    let (agent_id, session_id) = crate::session::projection::parse_session_key(target.session_key()).ok_or_else(|| rejected(TaskFailureCode::InvalidIdentity))?;
    if agent_id != target.agent_id() { return Err(rejected(TaskFailureCode::OwnershipMismatch)); }
    let session = client.call("sessions.get", json!({"sessionId": session_id})).await
        .map_err(|error| (failure(&error), diagnostic(&error, TaskFailureStage::SessionLookup)))?;
    if session["sessionId"] != session_id || session["agentId"] != agent_id {
        return Err((Failure::Rejected, response_failure(TaskFailureCode::OwnershipMismatch)));
    }
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

fn failed_before_write(command: TaskCommand, failure: Failure, diagnostic: TaskFailure) -> TaskExecution {
    if matches!(command, TaskCommand::Create { .. } | TaskCommand::Update { .. } | TaskCommand::TodoWrite { .. }) {
        failed(command, Failure::Rejected, diagnostic)
    } else {
        failed(command, failure, diagnostic)
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
fn response_failure(code: TaskFailureCode) -> TaskFailure {
    TaskFailure { delivery: Some(TaskDelivery::ResponseReceived), ..TaskFailure::new(TaskFailureStage::Response, code) }
}

fn diagnostic(error: &Error, request_stage: TaskFailureStage) -> TaskFailure {
    let data = error.data();
    let native_stage = data.and_then(|data| data["stage"].as_str());
    let code = match error.kind() {
        "not_found" => TaskFailureCode::NotFound,
        "invalid_params" => TaskFailureCode::InvalidParams,
        "invalid_endpoint" => TaskFailureCode::InvalidIdentity,
        "connect_failed" => TaskFailureCode::ConnectFailed,
        "connection_closed" | "client_shutdown" | "native_instance_closed" => TaskFailureCode::ConnectionClosed,
        "upgrade_failed" => TaskFailureCode::UpgradeFailed,
        "deadline" => TaskFailureCode::Deadline,
        "cancelled" => TaskFailureCode::Cancelled,
        "unauthorized" | "not_initialized" | "invalid_token" => TaskFailureCode::AuthenticationFailed,
        "unsupported_protocol" => TaskFailureCode::UnsupportedProtocol,
        "method_not_found" => TaskFailureCode::MethodNotFound,
        "native_start_failed" | "native_start_unknown" => TaskFailureCode::NativeStartFailed,
        "native_instance_absent" => TaskFailureCode::NativeInstanceAbsent,
        "native_instance_changed" => TaskFailureCode::NativeInstanceChanged,
        "native_cleanup_unconfirmed" => TaskFailureCode::NativeCleanupUnconfirmed,
        "session_closed" => TaskFailureCode::SessionClosed,
        "native_control_error" | "native_instance_handoff" | "native_instance_sealed" => TaskFailureCode::NativeControlError,
        "native_response_lost" => TaskFailureCode::NativeResponseLost,
        "task_io" => TaskFailureCode::TaskIo,
        "todo_io" => TaskFailureCode::TodoIo,
        "task_native_schema" => TaskFailureCode::TaskNativeSchema,
        "task_lock_conflict" => TaskFailureCode::TaskLockConflict,
        "todo_conflict" => TaskFailureCode::TodoConflict,
        "todo_session_busy" => TaskFailureCode::TodoSessionBusy,
        "task_dependency_missing" => TaskFailureCode::TaskDependencyMissing,
        "todo_owner_inactive" => TaskFailureCode::TodoOwnerInactive,
        "todo_persistence_disabled" => TaskFailureCode::TodoPersistenceDisabled,
        "task_receipt_unknown" => TaskFailureCode::ReceiptInvalid,
        "protocol" => TaskFailureCode::Protocol,
        "transport" | "close_failed" | "connection_task_failed" | "request_id_exhausted" => TaskFailureCode::Transport,
        _ => match error.code() {
            Some(-32001) => TaskFailureCode::NotFound,
            Some(-32601) => TaskFailureCode::MethodNotFound,
            Some(-32602) => TaskFailureCode::InvalidParams,
            Some(-32007) => TaskFailureCode::AuthenticationFailed,
            _ if native_stage == Some("ensure_native") => TaskFailureCode::NativeStartFailed,
            _ if data.and_then(|data| data["outcome"].as_str()) == Some("rejected") => TaskFailureCode::RequestRejected,
            Some(_) => TaskFailureCode::RemoteError,
            None => TaskFailureCode::Transport,
        },
    };
    let stage = match native_stage {
        Some("observe") => TaskFailureStage::SessionLookup,
        Some("ensure_native") => TaskFailureStage::NativeStart,
        Some("control") => TaskFailureStage::NativeControl,
        Some("native_read") => TaskFailureStage::NativeRead,
        Some("receipt") | None if matches!(code,
            TaskFailureCode::TaskIo | TaskFailureCode::TodoIo | TaskFailureCode::TaskNativeSchema
            | TaskFailureCode::TaskLockConflict | TaskFailureCode::TodoConflict | TaskFailureCode::TodoSessionBusy
            | TaskFailureCode::TaskDependencyMissing | TaskFailureCode::TodoOwnerInactive | TaskFailureCode::TodoPersistenceDisabled
        ) => TaskFailureStage::NativeRead,
        Some("receipt") => TaskFailureStage::Response,
        _ => match code {
            TaskFailureCode::NativeStartFailed => TaskFailureStage::NativeStart,
            TaskFailureCode::NativeControlError | TaskFailureCode::NativeResponseLost => TaskFailureStage::NativeControl,
            TaskFailureCode::ReceiptInvalid => TaskFailureStage::Response,
            _ if error.kind() == "native_instance_closed" => TaskFailureStage::NativeControl,
            _ => request_stage,
        },
    };
    let delivery = match error.delivery() {
        Delivery::NotSent => TaskDelivery::NotSent,
        Delivery::Unknown => TaskDelivery::Unknown,
        Delivery::ResponseReceived => match data.and_then(|data| data["delivery"].as_str()) {
            Some("notSent") => TaskDelivery::NotSent,
            Some("sent") => TaskDelivery::Sent,
            Some("unknown") => TaskDelivery::Unknown,
            _ => TaskDelivery::ResponseReceived,
        },
    };
    TaskFailure {
        stage, code,
        rpc_code: error.code().filter(|code| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(code)),
        delivery: Some(delivery),
    }
}

fn failed(command: TaskCommand, failure: Failure, diagnostic: TaskFailure) -> TaskExecution {
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
    let outcome = match command {
        TaskCommand::List { .. } => TaskOutcome::List(read_failure(failure)),
        TaskCommand::Get { .. } => TaskOutcome::Get(read_failure(failure)),
        TaskCommand::Create { .. } => TaskOutcome::Create(mutation_failure(failure)),
        TaskCommand::Update { .. } => TaskOutcome::Update(mutation_failure(failure)),
        TaskCommand::TodoGet { .. } => TaskOutcome::TodoGet(read_failure(failure)),
        TaskCommand::TodoWrite { .. } => TaskOutcome::TodoWrite(mutation_failure(failure)),
    };
    TaskExecution::failed(outcome, diagnostic)
}
