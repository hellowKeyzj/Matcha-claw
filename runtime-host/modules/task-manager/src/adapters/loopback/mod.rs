use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    api::TaskHandle,
    domain::model::{
        Task, TaskCommand, TaskCreate, TaskCreateReceipt, TaskMetadata, TaskMutationOutcome,
        TaskOutcome, TaskReadOutcome, TaskSnapshot, TaskStatus, TaskUpdate, Todo, TodoSnapshot,
        TodoStatus,
    },
};

pub const LIST_PATH: &str = "/api/tasks/list";
pub const GET_PATH: &str = "/api/tasks/get";
pub const CREATE_PATH: &str = "/api/tasks/create";
pub const UPDATE_PATH: &str = "/api/tasks/update";
pub const TODOS_GET_PATH: &str = "/api/tasks/todos/get";
pub const TODOS_WRITE_PATH: &str = "/api/tasks/todos/write";

const MANAGEMENT_CAPABILITY: &str = "task.management";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const TASK_MANAGER_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    task_manager: TaskHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, task_manager: TaskHandle) -> Self {
        Self {
            verifier,
            task_manager,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("task-manager"),
        vec![RouteDescriptor::bound(
            "task-manager.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_task_manager_route(path).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), TASK_MANAGER_REQUEST_BYTES),
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(request, dependencies).await.into() })
}

async fn handle(request: Request, dependencies: Dependencies) -> Response {
    let path = pathname(request.path());
    if request.method() != "POST" || !is_task_manager_route(path) {
        return ResponseBody::not_found().into_response();
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return ResponseBody::unauthorized().into_response();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return ResponseBody::bad_request().into_response(),
    };
    let mut verifier = dependencies.verifier.lock().await;
    let request = match TaskRequest::decode(path, value, authorization, &mut verifier, now_millis())
    {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return ResponseBody::unauthorized().into_response(),
        Err(DecodeError::Invalid) => return ResponseBody::bad_request().into_response(),
    };
    drop(verifier);
    match dependencies
        .task_manager
        .task_manager(request.into_command())
        .await
    {
        Ok(outcome) => Delivery::from_outcome(outcome).into_response(),
        Err(_) => Delivery::unavailable().into_response(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestEnvelope<T> {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIdentity {
    endpoint: Endpoint,
    agent_id: String,
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn is_openclaw_local(&self) -> bool {
        self.kind == RUNTIME_KIND
            && self.runtime_adapter_id == RUNTIME_ADAPTER_ID
            && self.runtime_instance_id == RUNTIME_INSTANCE_ID
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    session_identity: SessionIdentity,
    #[serde(default)]
    team_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    session_identity: SessionIdentity,
    #[serde(default)]
    team_key: Option<String>,
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    session_identity: SessionIdentity,
    #[serde(default)]
    team_key: Option<String>,
    subject: String,
    description: String,
    #[serde(default)]
    active_form: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default, deserialize_with = "deserialize_task_metadata")]
    metadata: Option<TaskMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    session_identity: SessionIdentity,
    #[serde(default)]
    team_key: Option<String>,
    task_id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    active_form: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    add_blocked_by: Option<Vec<String>>,
    #[serde(default)]
    add_blocks: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_task_metadata")]
    metadata: Option<TaskMetadata>,
}

fn deserialize_task_metadata<'de, D>(deserializer: D) -> Result<Option<TaskMetadata>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(TaskMetadata::new(
        serde_json::Map::<String, Value>::deserialize(deserializer)?,
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TodosGetInput {
    session_identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TodosWriteInput {
    session_identity: SessionIdentity,
    old_todos: Vec<TodoInput>,
    new_todos: Vec<TodoInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TodoInput {
    #[serde(default)]
    id: Option<String>,
    content: String,
    #[serde(default)]
    active_form: Option<String>,
    status: String,
    #[serde(default)]
    owner: Option<String>,
}

struct TaskRequest(TaskCommand);

impl TaskRequest {
    fn decode(
        path: &str,
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        let (scope, capability, subject, operation) =
            authorization_for(path).ok_or(DecodeError::Invalid)?;
        verifier
            .verify(authorization, now, path, scope, capability, subject)
            .map_err(|_| DecodeError::Unauthorized)?;
        decode_command(path, value, operation)
            .map(Self)
            .map_err(|_| DecodeError::Invalid)
    }

    fn into_command(self) -> TaskCommand {
        self.0
    }
}

fn authorization_for(
    path: &str,
) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match path {
        LIST_PATH => Some((
            "tasks:read",
            MANAGEMENT_CAPABILITY,
            "tasks-list",
            "tasks.list",
        )),
        GET_PATH => Some((
            "tasks:read",
            MANAGEMENT_CAPABILITY,
            "tasks-get",
            "tasks.get",
        )),
        CREATE_PATH => Some((
            "tasks:write",
            MANAGEMENT_CAPABILITY,
            "tasks-create",
            "tasks.create",
        )),
        UPDATE_PATH => Some((
            "tasks:write",
            MANAGEMENT_CAPABILITY,
            "tasks-update",
            "tasks.update",
        )),
        TODOS_GET_PATH => Some((
            "tasks:read",
            MANAGEMENT_CAPABILITY,
            "todos-get",
            "todos.get",
        )),
        TODOS_WRITE_PATH => Some((
            "tasks:write",
            MANAGEMENT_CAPABILITY,
            "todos-write",
            "todos.write",
        )),
        _ => None,
    }
}

fn decode_command(path: &str, value: Value, operation: &str) -> Result<TaskCommand, ()> {
    match path {
        LIST_PATH => {
            let request: RequestEnvelope<ListInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            TaskCommand::list(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
            )
            .map_err(|_| ())
        }
        GET_PATH => {
            let request: RequestEnvelope<GetInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            TaskCommand::get(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                request.input.task_id,
            )
            .map_err(|_| ())
        }
        CREATE_PATH => {
            let request: RequestEnvelope<CreateInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let input = TaskCreate::try_new(
                request.input.subject,
                request.input.description,
                request.input.active_form,
                request.input.owner,
                request.input.metadata,
            )
            .map_err(|_| ())?;
            TaskCommand::create(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                input,
            )
            .map_err(|_| ())
        }
        UPDATE_PATH => {
            let request: RequestEnvelope<UpdateInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let input = TaskUpdate::try_new(
                request.input.task_id,
                request
                    .input
                    .status
                    .map(task_status)
                    .transpose()
                    .map_err(|_| ())?,
                request.input.subject,
                request.input.description,
                request.input.active_form,
                request.input.owner,
                request.input.add_blocked_by,
                request.input.add_blocks,
                request.input.metadata,
            )
            .map_err(|_| ())?;
            TaskCommand::update(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                input,
            )
            .map_err(|_| ())
        }
        TODOS_GET_PATH => {
            let request: RequestEnvelope<TodosGetInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            TaskCommand::todo_get(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
            )
            .map_err(|_| ())
        }
        TODOS_WRITE_PATH => {
            let request: RequestEnvelope<TodosWriteInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let old_todos = todos(request.input.old_todos)?;
            let new_todos = todos(request.input.new_todos)?;
            TaskCommand::todo_write(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                old_todos,
                new_todos,
            )
            .map_err(|_| ())
        }
        _ => Err(()),
    }
}

fn decode_request<T: for<'de> Deserialize<'de>>(
    value: Value,
    id: &str,
    operation: &str,
    scope_kind: &str,
    target_kind: &str,
) -> Result<RequestEnvelope<T>, ()> {
    let request = serde_json::from_value::<RequestEnvelope<T>>(value).map_err(|_| ())?;
    (request.id == id
        && request.operation_id == operation
        && request.scope.kind == scope_kind
        && request.target.kind == target_kind
        && request.scope.identity == request.target.identity
        && request.scope.identity.endpoint.is_openclaw_local())
    .then_some(request)
    .ok_or(())
}

fn validate_identity<T>(
    request: &RequestEnvelope<T>,
    input_identity: &SessionIdentity,
) -> Result<(), ()> {
    (request.scope.identity == *input_identity)
        .then_some(())
        .ok_or(())
}

fn todos(values: Vec<TodoInput>) -> Result<Vec<Todo>, ()> {
    values
        .into_iter()
        .map(|todo| {
            Todo::try_new(
                todo.id,
                todo.content,
                todo.active_form,
                todo_status(todo.status)?,
                todo.owner,
            )
            .map_err(|_| ())
        })
        .collect()
}

fn task_status(value: String) -> Result<TaskStatus, ()> {
    match value.as_str() {
        "pending" => Ok(TaskStatus::Pending),
        "in_progress" => Ok(TaskStatus::InProgress),
        "completed" => Ok(TaskStatus::Completed),
        "deleted" => Ok(TaskStatus::Deleted),
        _ => Err(()),
    }
}

fn todo_status(value: String) -> Result<TodoStatus, ()> {
    match value.as_str() {
        "pending" => Ok(TodoStatus::Pending),
        "in_progress" => Ok(TodoStatus::InProgress),
        "completed" => Ok(TodoStatus::Completed),
        _ => Err(()),
    }
}

fn format_task_status(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::InProgress => "in_progress",
        TaskStatus::Completed => "completed",
        TaskStatus::Deleted => "deleted",
    }
}

fn format_todo_status(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Completed => "completed",
    }
}

struct Delivery {
    status: u16,
    body: Value,
}

impl Delivery {
    fn unavailable() -> Self {
        Self::fixed(503, "Task manager is unavailable")
    }

    fn from_outcome(outcome: TaskOutcome) -> Self {
        match outcome {
            TaskOutcome::List(outcome) => read_snapshot(outcome),
            TaskOutcome::Get(outcome) => read_task(outcome),
            TaskOutcome::Create(outcome) => create(outcome),
            TaskOutcome::Update(outcome) => mutation_snapshot(outcome),
            TaskOutcome::TodoGet(outcome) => read_todos(outcome),
            TaskOutcome::TodoWrite(outcome) => mutation_todos(outcome),
        }
    }

    fn into_response(self) -> Response {
        Response::json(self.status, self.body)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

fn unavailable<T>(outcome: TaskReadOutcome<T>) -> Delivery {
    match outcome {
        TaskReadOutcome::Unavailable => Delivery::unavailable(),
        TaskReadOutcome::NotFound | TaskReadOutcome::Rejected | TaskReadOutcome::Protocol => {
            Delivery::fixed(409, "Task manager request was rejected")
        }
        TaskReadOutcome::Found(_) => unreachable!(),
    }
}

fn read_snapshot(outcome: TaskReadOutcome<TaskSnapshot>) -> Delivery {
    match outcome {
        TaskReadOutcome::Found(snapshot) => Delivery {
            status: 200,
            body: snapshot_body(&snapshot),
        },
        outcome => unavailable(outcome),
    }
}

fn read_task(outcome: TaskReadOutcome<Task>) -> Delivery {
    match outcome {
        TaskReadOutcome::Found(task) => Delivery {
            status: 200,
            body: serde_json::json!({ "task": task_body(&task) }),
        },
        TaskReadOutcome::NotFound => Delivery {
            status: 200,
            body: serde_json::json!({ "task": null }),
        },
        outcome => unavailable(outcome),
    }
}

fn create(outcome: TaskMutationOutcome<TaskCreateReceipt>) -> Delivery {
    match outcome {
        TaskMutationOutcome::Applied(receipt) => Delivery {
            status: 200,
            body: serde_json::json!({
                "outcome": "applied",
                "task": task_body(receipt.task()),
                "snapshot": snapshot_body(receipt.snapshot()),
            }),
        },
        TaskMutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        TaskMutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn mutation_snapshot(outcome: TaskMutationOutcome<TaskSnapshot>) -> Delivery {
    match outcome {
        TaskMutationOutcome::Applied(snapshot) => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "applied", "snapshot": snapshot_body(&snapshot) }),
        },
        TaskMutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        TaskMutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn read_todos(outcome: TaskReadOutcome<TodoSnapshot>) -> Delivery {
    match outcome {
        TaskReadOutcome::Found(snapshot) => Delivery {
            status: 200,
            body: todos_body(&snapshot),
        },
        outcome => unavailable(outcome),
    }
}

fn mutation_todos(outcome: TaskMutationOutcome<TodoSnapshot>) -> Delivery {
    match outcome {
        TaskMutationOutcome::Applied(snapshot) => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "applied", "snapshot": todos_body(&snapshot) }),
        },
        TaskMutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        TaskMutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn snapshot_body(snapshot: &TaskSnapshot) -> Value {
    serde_json::json!({
        "tasks": snapshot.tasks().iter().map(task_body).collect::<Vec<_>>(),
        "todos": snapshot.todos().iter().map(todo_body).collect::<Vec<_>>(),
    })
}

fn todos_body(snapshot: &TodoSnapshot) -> Value {
    let mut body = serde_json::json!({
        "todos": snapshot.todos().iter().map(todo_body).collect::<Vec<_>>(),
    });
    if let Some(updated_at) = snapshot.updated_at() {
        body["updatedAt"] = updated_at.into();
    }
    body
}

fn task_body(task: &Task) -> Value {
    task_body_from_fields(
        task.id(),
        task.subject(),
        task.description(),
        task.status(),
        task.blocked_by(),
        task.blocks(),
        task.active_form(),
        task.owner(),
        task.metadata(),
        task.created_at(),
        task.updated_at(),
    )
}

#[allow(clippy::too_many_arguments)]
fn task_body_from_fields(
    id: &str,
    subject: &str,
    description: &str,
    status: TaskStatus,
    blocked_by: &[String],
    blocks: &[String],
    active_form: Option<&str>,
    owner: Option<&str>,
    metadata: Option<&TaskMetadata>,
    created_at: u64,
    updated_at: u64,
) -> Value {
    let mut body = serde_json::json!({
        "id": id, "subject": subject, "description": description,
        "status": format_task_status(status), "blockedBy": blocked_by, "blocks": blocks,
        "createdAt": created_at, "updatedAt": updated_at,
    });
    let object = body.as_object_mut().expect("task projection is an object");
    if let Some(active_form) = active_form {
        object.insert("activeForm".into(), Value::String(active_form.into()));
    }
    if let Some(owner) = owner {
        object.insert("owner".into(), Value::String(owner.into()));
    }
    if let Some(metadata) = metadata {
        object.insert(
            "metadata".into(),
            Value::Object(metadata.as_object().clone()),
        );
    }
    body
}

fn todo_body(todo: &Todo) -> Value {
    let mut body = serde_json::json!({ "content": todo.content(), "status": format_todo_status(todo.status()) });
    let object = body.as_object_mut().expect("todo projection is an object");
    if let Some(id) = todo.id() {
        object.insert("id".into(), Value::String(id.into()));
    }
    if let Some(active_form) = todo.active_form() {
        object.insert("activeForm".into(), Value::String(active_form.into()));
    }
    if let Some(owner) = todo.owner() {
        object.insert("owner".into(), Value::String(owner.into()));
    }
    body
}

struct ResponseBody {
    status: u16,
    body: Value,
}

impl ResponseBody {
    fn bad_request() -> Self {
        Self::fixed(400, "Task manager request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Task manager authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Task manager route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn into_response(self) -> Response {
        Response::json(self.status, self.body)
    }
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: 64 * 1024,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn is_task_manager_route(path: &str) -> bool {
    matches!(
        path,
        LIST_PATH | GET_PATH | CREATE_PATH | UPDATE_PATH | TODOS_GET_PATH | TODOS_WRITE_PATH
    )
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    fn identity() -> Value {
        json!({ "endpoint": { "kind": "native-runtime", "runtimeAdapterId": "openclaw", "runtimeInstanceId": "local" }, "agentId": "main", "sessionKey": "session-1" })
    }

    fn request(operation: &str, input: Value) -> Value {
        json!({ "id": MANAGEMENT_CAPABILITY, "operationId": operation, "scope": { "kind": "session", "identity": identity() }, "target": { "kind": "task-manager", "identity": identity() }, "input": input })
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[41; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(path: &str, scope: &str, capability: &str, subject: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "task-transport-test",
            "endpoint": path,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": now_millis() + 60_000,
            "correlation": format!("task-test:{path}:{subject}"),
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    #[test]
    fn accepts_only_fixed_post_routes() {
        for path in [
            LIST_PATH,
            GET_PATH,
            CREATE_PATH,
            UPDATE_PATH,
            TODOS_GET_PATH,
            TODOS_WRITE_PATH,
        ] {
            assert!(is_task_manager_route(path));
        }
        assert!(!is_task_manager_route("/api/tasks/unknown"));
    }

    #[test]
    fn enforces_canonical_identity_and_team_boundaries() {
        let list = request(
            "tasks.list",
            json!({ "sessionIdentity": identity(), "teamKey": "team-1" }),
        );
        assert!(decode_command(LIST_PATH, list, "tasks.list").is_ok());
        let todos = request(
            "todos.get",
            json!({ "sessionIdentity": identity(), "teamKey": "team-1" }),
        );
        assert!(decode_command(TODOS_GET_PATH, todos, "todos.get").is_err());
        let mut mismatch = request(
            "tasks.get",
            json!({ "sessionIdentity": identity(), "taskId": "task-1" }),
        );
        mismatch["input"]["sessionIdentity"]["agentId"] = json!("other");
        assert!(decode_command(GET_PATH, mismatch, "tasks.get").is_err());
    }

    #[test]
    fn authorizes_each_fixed_endpoint_scope_operation_and_subject() {
        let authorization = decision(LIST_PATH, "tasks:read", MANAGEMENT_CAPABILITY, "tasks-list");
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(
            TaskRequest::decode(
                LIST_PATH,
                request("tasks.list", json!({ "sessionIdentity": identity() })),
                &authorization,
                &mut verifier,
                now_millis(),
            )
            .is_ok()
        );

        let authorization = decision(LIST_PATH, "tasks:read", MANAGEMENT_CAPABILITY, "tasks-list");
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(matches!(
            TaskRequest::decode(
                GET_PATH,
                request(
                    "tasks.get",
                    json!({ "sessionIdentity": identity(), "taskId": "task-1" })
                ),
                &authorization,
                &mut verifier,
                now_millis(),
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn public_task_projection_preserves_metadata() {
        let metadata = TaskMetadata::new(serde_json::Map::from_iter([
            ("priority".into(), json!("high")),
            ("nested".into(), json!({ "attempt": 2 })),
        ]));
        let body = task_body_from_fields(
            "task-1",
            "subject",
            "description",
            TaskStatus::Pending,
            &[],
            &[],
            None,
            None,
            Some(&metadata),
            1,
            2,
        );
        assert_eq!(
            body,
            json!({
                "id": "task-1", "subject": "subject", "description": "description",
                "status": "pending", "blockedBy": [], "blocks": [],
                "metadata": { "priority": "high", "nested": { "attempt": 2 } },
                "createdAt": 1, "updatedAt": 2,
            })
        );
    }
}
