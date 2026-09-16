use serde::Deserialize;
use serde_json::Value;

use crate::{
    tasks::manager::{Command, MutationOutcome, Outcome, ReadOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

pub(crate) const LIST_PATH: &str = "/api/tasks/list";
pub(crate) const GET_PATH: &str = "/api/tasks/get";
pub(crate) const CREATE_PATH: &str = "/api/tasks/create";
pub(crate) const UPDATE_PATH: &str = "/api/tasks/update";
pub(crate) const TODOS_GET_PATH: &str = "/api/tasks/todos/get";
pub(crate) const TODOS_WRITE_PATH: &str = "/api/tasks/todos/write";

const MANAGEMENT_CAPABILITY: &str = "task.management";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request<T> {
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
    metadata: Option<openclaw::task_manager::TaskMetadata>,
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
    metadata: Option<openclaw::task_manager::TaskMetadata>,
}

fn deserialize_task_metadata<'de, D>(
    deserializer: D,
) -> Result<Option<openclaw::task_manager::TaskMetadata>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(openclaw::task_manager::TaskMetadata::new(
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

pub(crate) struct TaskRequest(Command);

impl TaskRequest {
    pub(crate) fn decode(
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

    pub(crate) fn into_command(self) -> Command {
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

fn decode_command(path: &str, value: Value, operation: &str) -> Result<Command, ()> {
    match path {
        LIST_PATH => {
            let request: Request<ListInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            Command::list(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
            )
            .map_err(|_| ())
        }
        GET_PATH => {
            let request: Request<GetInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            Command::get(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                request.input.task_id,
            )
            .map_err(|_| ())
        }
        CREATE_PATH => {
            let request: Request<CreateInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let input = openclaw::task_manager::TaskCreate::try_new(
                request.input.subject,
                request.input.description,
                request.input.active_form,
                request.input.owner,
                request.input.metadata,
            )
            .map_err(|_| ())?;
            Command::create(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                input,
            )
            .map_err(|_| ())
        }
        UPDATE_PATH => {
            let request: Request<UpdateInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let input = openclaw::task_manager::TaskUpdate::try_new(
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
            Command::update(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
                request.input.team_key,
                input,
            )
            .map_err(|_| ())
        }
        TODOS_GET_PATH => {
            let request: Request<TodosGetInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            Command::todo_get(
                request.input.session_identity.agent_id,
                request.input.session_identity.session_key,
            )
            .map_err(|_| ())
        }
        TODOS_WRITE_PATH => {
            let request: Request<TodosWriteInput> = decode_request(
                value,
                MANAGEMENT_CAPABILITY,
                operation,
                "session",
                "task-manager",
            )?;
            validate_identity(&request, &request.input.session_identity)?;
            let old_todos = todos(request.input.old_todos)?;
            let new_todos = todos(request.input.new_todos)?;
            Command::todo_write(
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
) -> Result<Request<T>, ()> {
    let request = serde_json::from_value::<Request<T>>(value).map_err(|_| ())?;
    (request.id == id
        && request.operation_id == operation
        && request.scope.kind == scope_kind
        && request.target.kind == target_kind
        && request.scope.identity == request.target.identity
        && request.scope.identity.endpoint.is_openclaw_local())
    .then_some(request)
    .ok_or(())
}

fn validate_identity<T>(request: &Request<T>, input_identity: &SessionIdentity) -> Result<(), ()> {
    (request.scope.identity == *input_identity)
        .then_some(())
        .ok_or(())
}

fn todos(values: Vec<TodoInput>) -> Result<Vec<openclaw::task_manager::Todo>, ()> {
    values
        .into_iter()
        .map(|todo| {
            openclaw::task_manager::Todo::try_new(
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

fn task_status(value: String) -> Result<openclaw::task_manager::TaskStatus, ()> {
    match value.as_str() {
        "pending" => Ok(openclaw::task_manager::TaskStatus::Pending),
        "in_progress" => Ok(openclaw::task_manager::TaskStatus::InProgress),
        "completed" => Ok(openclaw::task_manager::TaskStatus::Completed),
        "deleted" => Ok(openclaw::task_manager::TaskStatus::Deleted),
        _ => Err(()),
    }
}

fn todo_status(value: String) -> Result<openclaw::task_manager::TodoStatus, ()> {
    match value.as_str() {
        "pending" => Ok(openclaw::task_manager::TodoStatus::Pending),
        "in_progress" => Ok(openclaw::task_manager::TodoStatus::InProgress),
        "completed" => Ok(openclaw::task_manager::TodoStatus::Completed),
        _ => Err(()),
    }
}

fn format_task_status(status: openclaw::task_manager::TaskStatus) -> &'static str {
    match status {
        openclaw::task_manager::TaskStatus::Pending => "pending",
        openclaw::task_manager::TaskStatus::InProgress => "in_progress",
        openclaw::task_manager::TaskStatus::Completed => "completed",
        openclaw::task_manager::TaskStatus::Deleted => "deleted",
    }
}

fn format_todo_status(status: openclaw::task_manager::TodoStatus) -> &'static str {
    match status {
        openclaw::task_manager::TodoStatus::Pending => "pending",
        openclaw::task_manager::TodoStatus::InProgress => "in_progress",
        openclaw::task_manager::TodoStatus::Completed => "completed",
    }
}

pub(crate) struct Delivery {
    status: u16,
    body: Value,
}

impl Delivery {
    pub(crate) fn unavailable() -> Self {
        Self::fixed(503, "Task manager is unavailable")
    }

    pub(crate) fn from_outcome(outcome: Outcome) -> Self {
        match outcome {
            Outcome::List(outcome) => read_snapshot(outcome),
            Outcome::Get(outcome) => read_task(outcome),
            Outcome::Create(outcome) => create(outcome),
            Outcome::Update(outcome) => mutation_snapshot(outcome),
            Outcome::TodoGet(outcome) => read_todos(outcome),
            Outcome::TodoWrite(outcome) => mutation_todos(outcome),
        }
    }

    pub(crate) fn status(&self) -> u16 {
        self.status
    }
    pub(crate) fn body(&self) -> &Value {
        &self.body
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

fn unavailable<T>(outcome: ReadOutcome<T>) -> Delivery {
    match outcome {
        ReadOutcome::Unavailable => Delivery::unavailable(),
        ReadOutcome::NotFound | ReadOutcome::Rejected | ReadOutcome::Protocol => {
            Delivery::fixed(409, "Task manager request was rejected")
        }
        ReadOutcome::Found(_) => unreachable!(),
    }
}

fn read_snapshot(outcome: ReadOutcome<openclaw::task_manager::TaskSnapshot>) -> Delivery {
    match outcome {
        ReadOutcome::Found(snapshot) => Delivery {
            status: 200,
            body: snapshot_body(&snapshot),
        },
        outcome => unavailable(outcome),
    }
}

fn read_task(outcome: ReadOutcome<openclaw::task_manager::Task>) -> Delivery {
    match outcome {
        ReadOutcome::Found(task) => Delivery {
            status: 200,
            body: serde_json::json!({ "task": task_body(&task) }),
        },
        ReadOutcome::NotFound => Delivery {
            status: 200,
            body: serde_json::json!({ "task": null }),
        },
        outcome => unavailable(outcome),
    }
}

fn create(outcome: MutationOutcome<openclaw::task_manager::TaskCreateReceipt>) -> Delivery {
    match outcome {
        MutationOutcome::Applied(receipt) => Delivery {
            status: 200,
            body: serde_json::json!({
                "outcome": "applied",
                "task": task_body(receipt.task()),
                "snapshot": snapshot_body(receipt.snapshot()),
            }),
        },
        MutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        MutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn mutation_snapshot(outcome: MutationOutcome<openclaw::task_manager::TaskSnapshot>) -> Delivery {
    match outcome {
        MutationOutcome::Applied(snapshot) => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "applied", "snapshot": snapshot_body(&snapshot) }),
        },
        MutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        MutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn read_todos(outcome: ReadOutcome<openclaw::task_manager::TodoSnapshot>) -> Delivery {
    match outcome {
        ReadOutcome::Found(snapshot) => Delivery {
            status: 200,
            body: todos_body(&snapshot),
        },
        outcome => unavailable(outcome),
    }
}

fn mutation_todos(outcome: MutationOutcome<openclaw::task_manager::TodoSnapshot>) -> Delivery {
    match outcome {
        MutationOutcome::Applied(snapshot) => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "applied", "snapshot": todos_body(&snapshot) }),
        },
        MutationOutcome::Rejected => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "rejected" }),
        },
        MutationOutcome::OutcomeUnknown => Delivery {
            status: 200,
            body: serde_json::json!({ "outcome": "unknown" }),
        },
    }
}

fn snapshot_body(snapshot: &openclaw::task_manager::TaskSnapshot) -> Value {
    serde_json::json!({ "tasks": snapshot.tasks().iter().map(task_body).collect::<Vec<_>>(), "todos": snapshot.todos().iter().map(todo_body).collect::<Vec<_>>() })
}

fn todos_body(snapshot: &openclaw::task_manager::TodoSnapshot) -> Value {
    serde_json::json!({ "todos": snapshot.todos().iter().map(todo_body).collect::<Vec<_>>(), "updatedAt": snapshot.updated_at() })
}

fn task_body(task: &openclaw::task_manager::Task) -> Value {
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
    status: openclaw::task_manager::TaskStatus,
    blocked_by: &[String],
    blocks: &[String],
    active_form: Option<&str>,
    owner: Option<&str>,
    metadata: Option<&openclaw::task_manager::TaskMetadata>,
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

fn todo_body(todo: &openclaw::task_manager::Todo) -> Value {
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
    fn accepts_object_metadata_on_management_inputs() {
        let create = decode_command(
            CREATE_PATH,
            request(
                "tasks.create",
                json!({
                    "sessionIdentity": identity(),
                    "subject": "subject",
                    "description": "description",
                    "metadata": { "priority": "high", "nested": { "attempt": 2 } },
                }),
            ),
            "tasks.create",
        )
        .expect("create metadata is accepted");
        let Command::Create { input, .. } = create else {
            panic!("expected create command");
        };
        assert_eq!(
            serde_json::to_value(input).expect("serialize create input"),
            json!({
                "subject": "subject",
                "description": "description",
                "metadata": { "priority": "high", "nested": { "attempt": 2 } },
            })
        );

        let update = decode_command(
            UPDATE_PATH,
            request(
                "tasks.update",
                json!({
                    "sessionIdentity": identity(),
                    "taskId": "task-1",
                    "metadata": { "remove": null, "next": [1, 2] },
                }),
            ),
            "tasks.update",
        )
        .expect("metadata-only update is accepted");
        let Command::Update { input, .. } = update else {
            panic!("expected update command");
        };
        assert_eq!(
            serde_json::to_value(input).expect("serialize update input"),
            json!({
                "taskId": "task-1",
                "metadata": { "remove": null, "next": [1, 2] },
            })
        );
    }

    #[test]
    fn rejects_non_object_metadata_and_unknown_management_fields() {
        let mut unknown = request("tasks.list", json!({ "sessionIdentity": identity() }));
        unknown["input"]["workspaceDir"] = json!("C:/private");
        assert!(decode_command(LIST_PATH, unknown, "tasks.list").is_err());

        for (path, operation, input) in [
            (
                CREATE_PATH,
                "tasks.create",
                json!({
                    "sessionIdentity": identity(),
                    "subject": "subject",
                    "description": "description",
                    "metadata": [],
                }),
            ),
            (
                UPDATE_PATH,
                "tasks.update",
                json!({ "sessionIdentity": identity(), "taskId": "task-1", "metadata": null }),
            ),
            (
                UPDATE_PATH,
                "tasks.update",
                json!({ "sessionIdentity": identity(), "taskId": "task-1", "metadata": true }),
            ),
            (
                UPDATE_PATH,
                "tasks.update",
                json!({
                    "sessionIdentity": identity(),
                    "taskId": "task-1",
                    "metadata": {},
                    "workspaceDir": "C:/private",
                }),
            ),
        ] {
            assert!(decode_command(path, request(operation, input), operation).is_err());
        }
    }

    #[test]
    fn todo_requests_are_state_only_and_mutation_outcomes_remain_closed() {
        for (path, operation, input) in [
            (
                TODOS_GET_PATH,
                "todos.get",
                json!({ "sessionIdentity": identity(), "teamKey": "forbidden" }),
            ),
            (
                TODOS_WRITE_PATH,
                "todos.write",
                json!({
                    "sessionIdentity": identity(),
                    "oldTodos": [],
                    "newTodos": [],
                    "workspaceDir": "C:/private",
                }),
            ),
        ] {
            assert!(decode_command(path, request(operation, input), operation).is_err());
        }

        let rejected = Delivery::from_outcome(Outcome::TodoWrite(MutationOutcome::Rejected));
        assert_eq!(rejected.status(), 200);
        assert_eq!(rejected.body(), &json!({ "outcome": "rejected" }));
        let unknown = Delivery::from_outcome(Outcome::TodoWrite(MutationOutcome::OutcomeUnknown));
        assert_eq!(unknown.status(), 200);
        assert_eq!(unknown.body(), &json!({ "outcome": "unknown" }));
    }

    #[test]
    fn public_task_projection_preserves_metadata() {
        let metadata = openclaw::task_manager::TaskMetadata::new(serde_json::Map::from_iter([
            ("priority".into(), json!("high")),
            ("nested".into(), json!({ "attempt": 2 })),
        ]));
        let body = task_body_from_fields(
            "task-1",
            "subject",
            "description",
            openclaw::task_manager::TaskStatus::Pending,
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

        let without_metadata = task_body_from_fields(
            "task-1",
            "subject",
            "description",
            openclaw::task_manager::TaskStatus::Pending,
            &[],
            &[],
            None,
            None,
            None,
            1,
            2,
        );
        assert!(without_metadata.get("metadata").is_none());
    }

    #[test]
    fn task_get_not_found_projects_null_task_without_conflict() {
        let not_found = Delivery::from_outcome(Outcome::Get(ReadOutcome::NotFound));
        assert_eq!(not_found.status(), 200);
        assert_eq!(not_found.body(), &json!({ "task": null }));
    }

    #[test]
    fn task_get_rejection_still_projects_conflict() {
        let rejected = Delivery::from_outcome(Outcome::Get(
            ReadOutcome::<openclaw::task_manager::Task>::Rejected,
        ));
        assert_eq!(rejected.status(), 409);
        assert_eq!(
            rejected.body(),
            &json!({ "success": false, "error": "Task manager request was rejected" })
        );
    }

    #[test]
    fn maps_owner_unavailability() {
        let unavailable = Delivery::from_outcome(Outcome::List(ReadOutcome::Unavailable));
        assert_eq!(unavailable.status(), 503);
        assert_eq!(
            unavailable.body(),
            &json!({ "success": false, "error": "Task manager is unavailable" })
        );
    }
}
