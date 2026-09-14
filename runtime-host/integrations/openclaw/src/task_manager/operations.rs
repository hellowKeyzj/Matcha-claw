use std::{fmt, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    delivery::{DispatcherError, MutationDelivery},
    wire::{self, GatewayResponse},
};

static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

const TASK_CREATE_METHOD: &str = "TaskCreate";
const TASK_UPDATE_METHOD: &str = "TaskUpdate";
const TASK_LIST_METHOD: &str = "TaskList";
const TASK_GET_METHOD: &str = "TaskGet";
const TODO_WRITE_METHOD: &str = "TodoWrite";
const TODO_GET_METHOD: &str = "TodoGet";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Fixed typed adapter for the task-manager plugin methods over the shared
/// GatewayClient control exchange. It neither creates connections nor owns task
/// or todo state.
pub struct TaskManagerOperation {
    gateway: Arc<GatewayClient>,
    scope: TaskScope,
}

impl TaskManagerOperation {
    pub(crate) fn new(gateway: Arc<GatewayClient>, scope: TaskScope) -> Self {
        Self { gateway, scope }
    }

    pub async fn list(&self) -> Result<TaskSnapshot, TaskReadFailure> {
        self.read(
            TASK_LIST_METHOD,
            TaskListRequest::new(&self.scope),
            |response| decode_task_snapshot(&self.scope, response),
        )
        .await
    }

    pub async fn get(&self, task_id: String) -> Result<Task, TaskReadFailure> {
        let request =
            TaskGetRequest::new(&self.scope, task_id).map_err(|_| TaskReadFailure::Rejected)?;
        self.read(TASK_GET_METHOD, request, |response| {
            decode_task_get(&self.scope, response)
        })
        .await
    }

    pub async fn create(&self, input: TaskCreate) -> TaskMutationOutcome<TaskCreateReceipt> {
        let expected = input.clone();
        let request = match TaskCreateRequest::new(&self.scope, input) {
            Ok(request) => request,
            Err(_) => return TaskMutationOutcome::Rejected,
        };
        match self.mutate(TASK_CREATE_METHOD, request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                TaskMutationOutcome::Rejected
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                TaskMutationOutcome::OutcomeUnknown
            }
            MutationDelivery::Response(response) => {
                let task = match decode_task_create(&self.scope, response) {
                    Ok(task) => task,
                    Err(_) => return TaskMutationOutcome::OutcomeUnknown,
                };
                if validate_create_receipt(&task, &expected).is_err() {
                    return TaskMutationOutcome::OutcomeUnknown;
                }
                match self.list().await {
                    Ok(snapshot)
                        if validate_create_readback(&task, &snapshot, &expected).is_ok() =>
                    {
                        TaskMutationOutcome::Applied(TaskCreateReceipt { task, snapshot })
                    }
                    Ok(_) | Err(_) => TaskMutationOutcome::OutcomeUnknown,
                }
            }
        }
    }

    pub async fn update(&self, input: TaskUpdate) -> TaskMutationOutcome<TaskSnapshot> {
        let expected_task_id = input.task_id.clone();
        let expected = input.clone();
        let request = match TaskUpdateRequest::new(&self.scope, input) {
            Ok(request) => request,
            Err(_) => return TaskMutationOutcome::Rejected,
        };
        match self.mutate(TASK_UPDATE_METHOD, request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                TaskMutationOutcome::Rejected
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                TaskMutationOutcome::OutcomeUnknown
            }
            MutationDelivery::Response(response) => {
                let receipt = match decode_task_update(&self.scope, &expected_task_id, response) {
                    Ok(receipt) => receipt,
                    Err(_) => return TaskMutationOutcome::OutcomeUnknown,
                };
                if validate_update_receipt(&receipt, &expected).is_err() {
                    return TaskMutationOutcome::OutcomeUnknown;
                }
                match self.list().await {
                    Ok(snapshot)
                        if validate_update_readback(&receipt, &snapshot, &expected).is_ok() =>
                    {
                        TaskMutationOutcome::Applied(snapshot)
                    }
                    Ok(_) | Err(_) => TaskMutationOutcome::OutcomeUnknown,
                }
            }
        }
    }

    pub async fn todo_write(
        &self,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> TaskMutationOutcome<TodoSnapshot> {
        let request = match TodoWriteRequest::new(&self.scope, old_todos, new_todos) {
            Ok(request) => request,
            Err(_) => return TaskMutationOutcome::Rejected,
        };
        match self.mutate(TODO_WRITE_METHOD, request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                TaskMutationOutcome::Rejected
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                TaskMutationOutcome::OutcomeUnknown
            }
            MutationDelivery::Response(response) => decode_todo_snapshot(response)
                .map(TaskMutationOutcome::Applied)
                .unwrap_or(TaskMutationOutcome::OutcomeUnknown),
        }
    }

    pub async fn todo_get(&self) -> Result<TodoSnapshot, TaskReadFailure> {
        self.read(
            TODO_GET_METHOD,
            TodoGetRequest::new(&self.scope),
            decode_todo_snapshot,
        )
        .await
    }

    async fn read<P: Serialize, T>(
        &self,
        method: &'static str,
        params: P,
        decode: impl FnOnce(GatewayResponse) -> Result<T, ProtocolError>,
    ) -> Result<T, TaskReadFailure> {
        let request = plugin_request(method, params).map_err(|_| TaskReadFailure::Protocol)?;
        self.gateway
            .rpc_query(request)
            .await
            .map_err(TaskReadFailure::from_gateway)
            .and_then(|response| decode(response).map_err(Into::into))
    }

    async fn mutate<P: Serialize>(&self, method: &'static str, params: P) -> MutationDelivery {
        let request = match plugin_request(method, params) {
            Ok(request) => request,
            Err(_) => return MutationDelivery::NotWritten(DispatcherError::Protocol),
        };
        self.gateway.rpc_mutation(request).await
    }
}

impl fmt::Debug for TaskManagerOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskManagerOperation")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TaskScope {
    session_key: String,
    team_key: Option<String>,
    workspace_dir: String,
}

impl TaskScope {
    pub fn try_new(
        session_key: String,
        team_key: Option<String>,
        workspace_dir: String,
    ) -> Result<Self, TaskInputError> {
        Ok(Self {
            session_key: non_empty(session_key)?,
            team_key: team_key.map(non_empty).transpose()?,
            workspace_dir: non_empty(workspace_dir)?,
        })
    }
}

impl fmt::Debug for TaskScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskScope")
            .field("session_key", &"[REDACTED]")
            .field("team_key", &self.team_key.as_ref().map(|_| "[REDACTED]"))
            .field("workspace_dir", &"[REDACTED]")
            .finish()
    }
}

/// Opaque native task metadata. The task-manager plugin owns its schema and
/// patch semantics; this adapter only carries a JSON object without rendering it.
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
}

impl fmt::Debug for TaskUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TaskUpdate").finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
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

#[derive(Clone, Debug, Eq, PartialEq)]
enum TaskUpdateReceipt {
    Task(Task),
    Deleted { task_id: String },
}

impl TaskCreateReceipt {
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
    updated_at: u64,
}

impl TodoSnapshot {
    pub fn todos(&self) -> &[Todo] {
        &self.todos
    }

    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

impl TaskReadFailure {
    fn from_gateway(error: GatewayClientError) -> Self {
        match error {
            GatewayClientError::Protocol | GatewayClientError::RpcFailed => Self::Protocol,
            _ => Self::Unavailable,
        }
    }
}

impl From<ProtocolError> for TaskReadFailure {
    fn from(value: ProtocolError) -> Self {
        match value {
            ProtocolError::Rejected => Self::Rejected,
            ProtocolError::Invalid => Self::Protocol,
        }
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskScopeRequest<'a> {
    session_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_key: Option<&'a str>,
    workspace_dir: &'a str,
}

impl<'a> From<&'a TaskScope> for TaskScopeRequest<'a> {
    fn from(scope: &'a TaskScope) -> Self {
        Self {
            session_key: &scope.session_key,
            team_key: scope.team_key.as_deref(),
            workspace_dir: &scope.workspace_dir,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListRequest<'a> {
    #[serde(flatten)]
    scope: TaskScopeRequest<'a>,
}

impl<'a> TaskListRequest<'a> {
    fn new(scope: &'a TaskScope) -> Self {
        Self {
            scope: scope.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskGetRequest<'a> {
    #[serde(flatten)]
    scope: TaskScopeRequest<'a>,
    task_id: String,
}

impl<'a> TaskGetRequest<'a> {
    fn new(scope: &'a TaskScope, task_id: String) -> Result<Self, TaskInputError> {
        Ok(Self {
            scope: scope.into(),
            task_id: non_empty(task_id)?,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskCreateRequest<'a> {
    #[serde(flatten)]
    scope: TaskScopeRequest<'a>,
    #[serde(flatten)]
    input: TaskCreate,
}

impl<'a> TaskCreateRequest<'a> {
    fn new(scope: &'a TaskScope, input: TaskCreate) -> Result<Self, TaskInputError> {
        Ok(Self {
            scope: scope.into(),
            input,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskUpdateRequest<'a> {
    #[serde(flatten)]
    scope: TaskScopeRequest<'a>,
    #[serde(flatten)]
    input: TaskUpdate,
}

impl<'a> TaskUpdateRequest<'a> {
    fn new(scope: &'a TaskScope, input: TaskUpdate) -> Result<Self, TaskInputError> {
        Ok(Self {
            scope: scope.into(),
            input,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodoWriteRequest<'a> {
    session_key: &'a str,
    workspace_dir: &'a str,
    old_todos: Vec<Todo>,
    new_todos: Vec<Todo>,
}

impl<'a> TodoWriteRequest<'a> {
    fn new(
        scope: &'a TaskScope,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> Result<Self, TaskInputError> {
        Ok(Self {
            session_key: &scope.session_key,
            workspace_dir: &scope.workspace_dir,
            old_todos,
            new_todos,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodoGetRequest<'a> {
    session_key: &'a str,
    workspace_dir: &'a str,
}

impl<'a> TodoGetRequest<'a> {
    fn new(scope: &'a TaskScope) -> Self {
        Self {
            session_key: &scope.session_key,
            workspace_dir: &scope.workspace_dir,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProtocolError {
    Rejected,
    Invalid,
}

fn plugin_request<P: Serialize>(
    method: &'static str,
    params: P,
) -> Result<wire::RpcRequest, wire::WireError> {
    let params = serde_json::to_value(params).map_err(|_| wire::WireError::EncodeRequest)?;
    wire::operations_request(next_request_id(method), method, params)
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("matcha-task-{operation}-{sequence}")
}

fn validate_create_receipt(task: &Task, expected: &TaskCreate) -> Result<(), ProtocolError> {
    if task.subject() != expected.subject
        || task.description() != expected.description
        || task.status() != TaskStatus::Pending
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(active_form) = expected.active_form.as_deref()
        && task.active_form() != Some(active_form)
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(owner) = expected.owner.as_deref()
        && task.owner() != Some(owner)
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(metadata) = expected.metadata.as_ref()
        && task.metadata().map(TaskMetadata::as_object) != Some(metadata.as_object())
    {
        return Err(ProtocolError::Invalid);
    }
    Ok(())
}

fn validate_create_readback(
    task: &Task,
    snapshot: &TaskSnapshot,
    expected: &TaskCreate,
) -> Result<(), ProtocolError> {
    let readback = snapshot
        .tasks()
        .iter()
        .find(|candidate| candidate.id() == task.id())
        .ok_or(ProtocolError::Invalid)?;
    (readback == task && validate_create_receipt(readback, expected).is_ok())
        .then_some(())
        .ok_or(ProtocolError::Invalid)
}

fn validate_update_receipt(
    receipt: &TaskUpdateReceipt,
    expected: &TaskUpdate,
) -> Result<(), ProtocolError> {
    match receipt {
        TaskUpdateReceipt::Task(task) => validate_update_task(task, expected),
        TaskUpdateReceipt::Deleted { .. } => (expected.status == Some(TaskStatus::Deleted))
            .then_some(())
            .ok_or(ProtocolError::Invalid),
    }
}

fn validate_update_task(task: &Task, expected: &TaskUpdate) -> Result<(), ProtocolError> {
    if task.id() != expected.task_id {
        return Err(ProtocolError::Invalid);
    }
    if expected.status == Some(TaskStatus::Deleted) {
        return Err(ProtocolError::Invalid);
    }
    if let Some(status) = expected.status
        && task.status() != status
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(subject) = expected.subject.as_deref()
        && task.subject() != subject
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(description) = expected.description.as_deref()
        && task.description() != description
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(active_form) = expected.active_form.as_deref()
        && task.active_form() != Some(active_form)
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(owner) = expected.owner.as_deref()
        && task.owner() != Some(owner)
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(blocked_by) = expected.add_blocked_by.as_ref()
        && blocked_by
            .iter()
            .any(|task_id| !task.blocked_by().contains(task_id))
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(blocks) = expected.add_blocks.as_ref()
        && blocks
            .iter()
            .any(|task_id| !task.blocks().contains(task_id))
    {
        return Err(ProtocolError::Invalid);
    }
    if let Some(metadata) = expected.metadata.as_ref() {
        let actual = task.metadata().map(TaskMetadata::as_object);
        for (key, value) in metadata.as_object() {
            if value.is_null() {
                if actual.is_some_and(|object| object.contains_key(key)) {
                    return Err(ProtocolError::Invalid);
                }
            } else if actual.is_none_or(|object| object.get(key) != Some(value)) {
                return Err(ProtocolError::Invalid);
            }
        }
    }
    Ok(())
}

fn validate_update_readback(
    receipt: &TaskUpdateReceipt,
    snapshot: &TaskSnapshot,
    expected: &TaskUpdate,
) -> Result<(), ProtocolError> {
    match receipt {
        TaskUpdateReceipt::Task(task) => {
            let readback = snapshot
                .tasks()
                .iter()
                .find(|candidate| candidate.id() == expected.task_id)
                .ok_or(ProtocolError::Invalid)?;
            (readback == task)
                .then_some(())
                .ok_or(ProtocolError::Invalid)?;
            validate_update_task(readback, expected)
        }
        TaskUpdateReceipt::Deleted { task_id } => {
            if task_id != &expected.task_id || expected.status != Some(TaskStatus::Deleted) {
                return Err(ProtocolError::Invalid);
            }
            (!snapshot
                .tasks()
                .iter()
                .any(|candidate| candidate.id() == expected.task_id))
            .then_some(())
            .ok_or(ProtocolError::Invalid)
        }
    }
}

fn decode_task_snapshot(
    requested_scope: &TaskScope,
    response: GatewayResponse,
) -> Result<TaskSnapshot, ProtocolError> {
    let payload = payload(response)?;
    let wire: TaskListResponse =
        serde_json::from_value(payload).map_err(|_| ProtocolError::Invalid)?;
    validate_task_scope(requested_scope, wire.scope)?;
    let tasks = wire
        .tasks
        .into_iter()
        .map(Task::try_from)
        .collect::<Result<_, _>>()?;
    let todos = wire
        .todos
        .into_iter()
        .map(Todo::try_from)
        .collect::<Result<_, _>>()?;
    Ok(TaskSnapshot { tasks, todos })
}

fn decode_task_get(
    requested_scope: &TaskScope,
    response: GatewayResponse,
) -> Result<Task, ProtocolError> {
    let payload = payload(response)?;
    let wire: TaskGetResponse =
        serde_json::from_value(payload).map_err(|_| ProtocolError::Invalid)?;
    validate_task_scope(requested_scope, wire.scope)?;
    Task::try_from(wire.task)
}

fn decode_task_create(
    requested_scope: &TaskScope,
    response: GatewayResponse,
) -> Result<Task, ProtocolError> {
    let payload = payload(response)?;
    let wire: TaskCreateResponse =
        serde_json::from_value(payload).map_err(|_| ProtocolError::Invalid)?;
    validate_task_scope(requested_scope, wire.scope)?;
    Task::try_from(wire.task)
}

fn decode_task_update(
    requested_scope: &TaskScope,
    expected_task_id: &str,
    response: GatewayResponse,
) -> Result<TaskUpdateReceipt, ProtocolError> {
    let payload = payload(response)?;
    let wire: TaskUpdateResponse =
        serde_json::from_value(payload).map_err(|_| ProtocolError::Invalid)?;
    match wire {
        TaskUpdateResponse::Task(TaskUpdateTaskResponse { scope, task }) => {
            validate_task_scope(requested_scope, scope)?;
            let task = Task::try_from(task)?;
            (task.id() == expected_task_id)
                .then_some(TaskUpdateReceipt::Task(task))
                .ok_or(ProtocolError::Invalid)
        }
        TaskUpdateResponse::Deleted(TaskUpdateDeletedResponse {
            scope,
            task_id,
            deleted,
            todos,
        }) => {
            validate_task_scope(requested_scope, scope)?;
            if !deleted || task_id != expected_task_id {
                return Err(ProtocolError::Invalid);
            }
            todos
                .into_iter()
                .map(Todo::try_from)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(TaskUpdateReceipt::Deleted { task_id })
        }
    }
}

fn decode_todo_snapshot(response: GatewayResponse) -> Result<TodoSnapshot, ProtocolError> {
    let payload = payload(response)?;
    let wire: TodoResponse = serde_json::from_value(payload).map_err(|_| ProtocolError::Invalid)?;
    let todos = wire
        .todos
        .into_iter()
        .map(Todo::try_from)
        .collect::<Result<_, _>>()?;
    safe_integer(wire.updated_at)?;
    Ok(TodoSnapshot {
        todos,
        updated_at: wire.updated_at,
    })
}

fn payload(response: GatewayResponse) -> Result<serde_json::Value, ProtocolError> {
    match response {
        GatewayResponse::Success {
            payload: Some(payload),
            ..
        } => Ok(payload),
        GatewayResponse::Failure { .. } => Err(ProtocolError::Rejected),
        GatewayResponse::Success { .. } => Err(ProtocolError::Invalid),
    }
}

fn validate_task_scope(
    requested_scope: &TaskScope,
    returned_scope: ScopeWire,
) -> Result<(), ProtocolError> {
    if !valid_string(&returned_scope.label) || !optional_string(&returned_scope.agent_id) {
        return Err(ProtocolError::Invalid);
    }

    match (requested_scope.team_key.as_deref(), returned_scope) {
        (
            Some(team_key),
            ScopeWire {
                kind,
                key,
                session_key: None,
                team_key: Some(returned_team_key),
                ..
            },
        ) if kind == "team"
            && key == format!("team:{team_key}")
            && returned_team_key == team_key =>
        {
            Ok(())
        }
        (
            None,
            ScopeWire {
                kind,
                key,
                session_key: Some(returned_session_key),
                team_key: None,
                ..
            },
        ) if kind == "session"
            && key == requested_scope.session_key
            && returned_session_key == requested_scope.session_key =>
        {
            Ok(())
        }
        _ => Err(ProtocolError::Invalid),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskListResponse {
    scope: ScopeWire,
    tasks: Vec<TaskWire>,
    todos: Vec<TodoWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskGetResponse {
    scope: ScopeWire,
    task: TaskWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskCreateResponse {
    scope: ScopeWire,
    task: TaskWire,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TaskUpdateResponse {
    Task(TaskUpdateTaskResponse),
    Deleted(TaskUpdateDeletedResponse),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskUpdateTaskResponse {
    scope: ScopeWire,
    task: TaskWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskUpdateDeletedResponse {
    scope: ScopeWire,
    task_id: String,
    deleted: bool,
    todos: Vec<TodoWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TodoResponse {
    todos: Vec<TodoWire>,
    updated_at: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScopeWire {
    #[serde(rename = "type")]
    kind: String,
    key: String,
    label: String,
    session_key: Option<String>,
    team_key: Option<String>,
    agent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskWire {
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

impl TryFrom<TaskWire> for Task {
    type Error = ProtocolError;

    fn try_from(value: TaskWire) -> Result<Self, Self::Error> {
        if !valid_string(&value.id)
            || !valid_string(&value.subject)
            || !valid_string(&value.description)
            || !optional_string(&value.active_form)
            || !optional_string(&value.owner)
            || !valid_strings(&value.blocked_by)
            || !valid_strings(&value.blocks)
        {
            return Err(ProtocolError::Invalid);
        }
        safe_integer(value.created_at)?;
        safe_integer(value.updated_at)?;
        Ok(Self {
            id: value.id,
            subject: value.subject,
            description: value.description,
            active_form: value.active_form,
            status: value.status,
            owner: value.owner,
            blocked_by: value.blocked_by,
            blocks: value.blocks,
            metadata: value.metadata,
            created_at: value.created_at,
            updated_at: value.updated_at,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TodoWire {
    id: Option<String>,
    content: String,
    active_form: Option<String>,
    status: TodoStatus,
    owner: Option<String>,
}

impl TryFrom<TodoWire> for Todo {
    type Error = ProtocolError;

    fn try_from(value: TodoWire) -> Result<Self, Self::Error> {
        Todo::try_new(
            value.id,
            value.content,
            value.active_form,
            value.status,
            value.owner,
        )
        .map_err(|_| ProtocolError::Invalid)
    }
}

fn non_empty(value: String) -> Result<String, TaskInputError> {
    let value = value.trim();
    (!value.is_empty())
        .then(|| value.to_owned())
        .ok_or(TaskInputError)
}

fn non_empty_list(values: Vec<String>) -> Result<Vec<String>, TaskInputError> {
    if values.is_empty() {
        return Ok(values);
    }
    values.into_iter().map(non_empty).collect()
}

fn valid_string(value: &str) -> bool {
    !value.trim().is_empty()
}

fn optional_string(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(valid_string)
}

fn valid_strings(values: &[String]) -> bool {
    values.iter().all(|value| valid_string(value))
}

fn safe_integer(value: u64) -> Result<(), ProtocolError> {
    (value <= MAX_SAFE_INTEGER)
        .then_some(())
        .ok_or(ProtocolError::Invalid)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, sync::oneshot, time::timeout};
    use tokio_tungstenite::tungstenite::Message;

    use crate::gateway::{
        auth::GatewaySecret,
        client::{
            GatewayClient, GatewayClientMetadata, GatewayControlReadiness, GatewayEndpoint,
            test_support::{TestSocket, TestTlsIdentity, accept_websocket},
        },
        wire,
    };

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    fn success(payload: serde_json::Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "task-test".into(),
            payload: Some(payload),
        }
    }

    fn scope() -> TaskScope {
        TaskScope::try_new(
            "session-canary".into(),
            Some("team-canary".into()),
            "workspace-canary".into(),
        )
        .unwrap()
    }

    fn task() -> serde_json::Value {
        json!({
            "id": "task-1", "subject": "subject", "description": "description",
            "activeForm": "working", "status": "pending", "owner": "owner",
            "blockedBy": [], "blocks": [], "createdAt": 1, "updatedAt": 2
        })
    }

    fn todo() -> serde_json::Value {
        json!({"id": "todo-1", "content": "content", "activeForm": "working", "status": "pending", "owner": "owner"})
    }

    #[tokio::test(flavor = "current_thread")]
    async fn create_uses_gateway_control_then_reads_back_the_authoritative_snapshot() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());
            let create = operation.create(
                TaskCreate::try_new("subject".into(), "description".into(), None, None, None)
                    .unwrap(),
            );
            tokio::pin!(create);

            let _ = futures_util::poll!(&mut create);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_CREATE_METHOD);
            assert_eq!(request["params"]["teamKey"], "team-canary");
            send_json(
                &mut peer.socket,
                plugin_response(
                    &request,
                    json!({
                        "scope": team_scope(),
                        "task": task()
                    }),
                ),
            )
            .await;

            let request = tokio::select! {
                request = read_json(&mut peer.socket) => request,
                outcome = &mut create => panic!("create completed before TaskList: {outcome:?}"),
            };
            assert_plugin_request(&request, TASK_LIST_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(
                    &request,
                    json!({
                        "scope": team_scope(),
                        "tasks": [
                            {"id":"task-older","subject":"subject","description":"description","status":"pending","blockedBy":[],"blocks":[],"createdAt":1,"updatedAt":1},
                            task()
                        ],
                        "todos": [todo()]
                    }),
                ),
            )
            .await;

            let TaskMutationOutcome::Applied(receipt) =
                timeout(TEST_TIMEOUT, &mut create).await.unwrap()
            else {
                panic!("create must return an applied receipt");
            };
            assert_eq!(receipt.task().id(), "task-1");
            assert_eq!(receipt.snapshot().tasks().len(), 2);
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn update_uses_gateway_control_then_reads_back_the_authoritative_snapshot() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());
            let update = operation.update(
                TaskUpdate::try_new(
                    "task-1".into(),
                    Some(TaskStatus::Completed),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            tokio::pin!(update);

            let _ = futures_util::poll!(&mut update);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_UPDATE_METHOD);
            let mut updated_task = task();
            updated_task["status"] = json!("completed");
            send_json(
                &mut peer.socket,
                plugin_response(
                    &request,
                    json!({
                        "scope": team_scope(),
                        "task": updated_task
                    }),
                ),
            )
            .await;

            let request = tokio::select! {
                request = read_json(&mut peer.socket) => request,
                outcome = &mut update => panic!("update completed before TaskList: {outcome:?}"),
            };
            assert_plugin_request(&request, TASK_LIST_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(
                    &request,
                    json!({
                        "scope": team_scope(),
                        "tasks": [{
                            "id":"task-1", "subject":"subject", "description":"description",
                            "activeForm":"working", "status":"completed", "owner":"owner",
                            "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":2
                        }],
                        "todos": [todo()]
                    }),
                ),
            )
            .await;

            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut update).await.unwrap(),
                TaskMutationOutcome::Applied(_)
            ));
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn native_rejection_is_rejected_without_a_readback() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());
            let create = operation.create(
                TaskCreate::try_new("subject".into(), "description".into(), None, None, None)
                    .unwrap(),
            );
            tokio::pin!(create);

            let _ = futures_util::poll!(&mut create);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_CREATE_METHOD);
            send_json(
                &mut peer.socket,
                json!({
                    "type":"res",
                    "id":request["id"],
                    "ok":false,
                    "error":{"code":"FORBIDDEN","message":"native-rejection-canary"}
                }),
            )
            .await;

            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut create).await.unwrap(),
                TaskMutationOutcome::Rejected
            ));
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acknowledged_create_becomes_unknown_when_its_required_readback_is_rejected() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());
            let create = operation.create(
                TaskCreate::try_new("subject".into(), "description".into(), None, None, None)
                    .unwrap(),
            );
            tokio::pin!(create);

            let _ = futures_util::poll!(&mut create);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_CREATE_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(&request, json!({"scope":team_scope(),"task":task()})),
            )
            .await;

            let request = tokio::select! {
                request = read_json(&mut peer.socket) => request,
                outcome = &mut create => panic!("create completed before its required TaskList readback: {outcome:?}"),
            };
            assert_plugin_request(&request, TASK_LIST_METHOD);
            send_json(
                &mut peer.socket,
                json!({
                    "type":"res",
                    "id":request["id"],
                    "ok":false,
                    "error":{"code":"FORBIDDEN","message":"readback-rejection-canary"}
                }),
            )
            .await;

            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut create).await.unwrap(),
                TaskMutationOutcome::OutcomeUnknown
            ));
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn todo_write_and_get_preserve_their_distinct_rejection_semantics() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());
            let todo_write = operation.todo_write(vec![], vec![]);
            tokio::pin!(todo_write);

            let _ = futures_util::poll!(&mut todo_write);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TODO_WRITE_METHOD);
            assert!(request["params"].get("teamKey").is_none());
            send_json(
                &mut peer.socket,
                json!({
                    "type":"res",
                    "id":request["id"],
                    "ok":false,
                    "error":{"code":"FORBIDDEN","message":"todo-write-rejection-canary"}
                }),
            )
            .await;
            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut todo_write).await.unwrap(),
                TaskMutationOutcome::Rejected
            ));

            let todo_get = operation.todo_get();
            tokio::pin!(todo_get);
            let _ = futures_util::poll!(&mut todo_get);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TODO_GET_METHOD);
            send_json(
                &mut peer.socket,
                json!({
                    "type":"res",
                    "id":request["id"],
                    "ok":false,
                    "error":{"code":"FORBIDDEN","message":"todo-get-rejection-canary"}
                }),
            )
            .await;
            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut todo_get).await.unwrap(),
                Err(TaskReadFailure::Rejected)
            ));
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn planning_operations_use_gateway_control_exchange() {
        let (client, mut peer) = connected_gateway().await;
        {
            let operation = TaskManagerOperation::new(Arc::clone(&client), scope());

            let list = operation.list();
            tokio::pin!(list);
            let _ = futures_util::poll!(&mut list);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_LIST_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(
                    &request,
                    json!({"scope":team_scope(),"tasks":[task()],"todos":[todo()]}),
                ),
            )
            .await;
            assert!(timeout(TEST_TIMEOUT, &mut list).await.unwrap().is_ok());

            let get = operation.get("task-1".into());
            tokio::pin!(get);
            let _ = futures_util::poll!(&mut get);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TASK_GET_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(&request, json!({"scope":team_scope(),"task":task()})),
            )
            .await;
            assert!(timeout(TEST_TIMEOUT, &mut get).await.unwrap().is_ok());

            let todo_write = operation.todo_write(vec![], vec![]);
            tokio::pin!(todo_write);
            let _ = futures_util::poll!(&mut todo_write);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TODO_WRITE_METHOD);
            assert!(request["params"].get("teamKey").is_none());
            send_json(
                &mut peer.socket,
                plugin_response(&request, json!({"todos":[todo()],"updatedAt":2})),
            )
            .await;
            assert!(matches!(
                timeout(TEST_TIMEOUT, &mut todo_write).await.unwrap(),
                TaskMutationOutcome::Applied(_)
            ));

            let todo_get = operation.todo_get();
            tokio::pin!(todo_get);
            let _ = futures_util::poll!(&mut todo_get);
            let request = read_json(&mut peer.socket).await;
            assert_plugin_request(&request, TODO_GET_METHOD);
            send_json(
                &mut peer.socket,
                plugin_response(&request, json!({"todos":[todo()],"updatedAt":2})),
            )
            .await;
            assert!(timeout(TEST_TIMEOUT, &mut todo_get).await.unwrap().is_ok());
        }
        client.close_control_connection().await;
        peer.server.await.unwrap();
    }

    async fn connected_gateway() -> (Arc<GatewayClient>, FakePeer) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let gateway = Arc::new(GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("local-test-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "test".into()).unwrap(),
        ));
        let acceptor = identity.acceptor();
        let (peer_sender, peer_receiver) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {"nonce": "local-test-nonce", "ts": 42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;
            peer_sender.send(socket).unwrap();
        });
        assert_eq!(
            gateway.observe_control().await,
            GatewayControlReadiness::Ready
        );
        let socket = peer_receiver.await.unwrap();
        (gateway, FakePeer { socket, server })
    }

    struct FakePeer {
        socket: TestSocket,
        server: tokio::task::JoinHandle<()>,
    }

    fn team_scope() -> Value {
        json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"})
    }

    fn assert_plugin_request(request: &Value, method: &str) {
        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], method);
        assert_eq!(request["params"]["sessionKey"], "session-canary");
        assert_eq!(request["params"]["workspaceDir"], "workspace-canary");
    }

    fn plugin_response(request: &Value, payload: Value) -> Value {
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload})
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn hello(id: &str) -> Value {
        json!({
            "type": "res",
            "id": id,
            "ok": true,
            "payload": {
                "type": "hello-ok",
                "protocol": 4,
                "server": {"version": "2026.5.20", "connId": "local-test-connection"},
                "features": {"methods": [
                    "status",
                    "config.get",
                    "config.patch",
                    "config.apply",
                    "plugins.refresh",
                    "agents.list",
                    "skills.status",
                    wire::SYSTEM_PRESENCE_METHOD,
                    "chat.send",
                    "chat.abort",
                    "chat.history",
                    "sessions.list",
                    "sessions.patch",
                    "sessions.create",
                    "sessions.delete",
                    "TaskCreate",
                    "TaskUpdate",
                    "TaskList",
                    "TaskGet",
                    "TodoWrite",
                    "TodoGet"
                ], "events": ["tick", "chat", "session.message", "session.operation", "session.tool", "sessions.changed"]},
                "snapshot": {
                    "presence": [],
                    "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1},
                    "uptimeMs": 100
                },
                "auth": {"role": "operator", "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]},
                "policy": {
                    "maxPayload": 26214400,
                    "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        })
    }

    #[test]
    fn trusted_scope_is_the_only_source_of_scope_and_workspace_wire_values() {
        let scope = scope();
        let request = TaskCreateRequest::new(
            &scope,
            TaskCreate::try_new("subject".into(), "description".into(), None, None, None).unwrap(),
        )
        .unwrap();
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["sessionKey"], "session-canary");
        assert_eq!(value["teamKey"], "team-canary");
        assert_eq!(value["workspaceDir"], "workspace-canary");
        assert!(!format!("{scope:?}").contains("workspace-canary"));
    }

    #[test]
    fn request_dtos_cover_the_six_planning_plugin_methods() {
        let scope = scope();
        let cases = [
            (
                TASK_CREATE_METHOD,
                serde_json::to_value(
                    TaskCreateRequest::new(
                        &scope,
                        TaskCreate::try_new(
                            "subject".into(),
                            "description".into(),
                            None,
                            None,
                            None,
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
            ),
            (
                TASK_UPDATE_METHOD,
                serde_json::to_value(
                    TaskUpdateRequest::new(
                        &scope,
                        TaskUpdate::try_new(
                            "task-1".into(),
                            Some(TaskStatus::Completed),
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
            ),
            (
                TASK_LIST_METHOD,
                serde_json::to_value(TaskListRequest::new(&scope)).unwrap(),
            ),
            (
                TASK_GET_METHOD,
                serde_json::to_value(TaskGetRequest::new(&scope, "task-1".into()).unwrap())
                    .unwrap(),
            ),
            (
                TODO_WRITE_METHOD,
                serde_json::to_value(TodoWriteRequest::new(&scope, vec![], vec![]).unwrap())
                    .unwrap(),
            ),
            (
                TODO_GET_METHOD,
                serde_json::to_value(TodoGetRequest::new(&scope)).unwrap(),
            ),
        ];
        for (method, params) in cases {
            assert!(params.is_object(), "{method}");
            assert_eq!(params["sessionKey"], "session-canary", "{method}");
            assert_eq!(params["workspaceDir"], "workspace-canary", "{method}");
        }
    }

    #[test]
    fn decoders_accept_all_fixed_plugin_response_shapes() {
        let requested_scope = scope();
        let response_scope = json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"});
        assert!(
            decode_task_snapshot(
                &requested_scope,
                success(json!({"scope": response_scope, "tasks":[task()], "todos":[todo()]}))
            )
            .is_ok()
        );
        let response_scope = json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"});
        assert!(
            decode_task_get(
                &requested_scope,
                success(json!({"scope": response_scope, "task":task()}))
            )
            .is_ok()
        );
        let response_scope = json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"});
        assert!(
            decode_task_create(
                &requested_scope,
                success(json!({"scope": response_scope, "task":task()}))
            )
            .is_ok()
        );
        let response_scope = json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"});
        assert!(
            decode_task_update(
                &requested_scope,
                "task-1",
                success(json!({"scope": response_scope, "task":task()}))
            )
            .is_ok()
        );
        let response_scope = json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"});
        assert!(decode_task_update(&requested_scope, "task-1", success(json!({"scope": response_scope, "taskId":"task-1", "deleted":true, "todos":[todo()]}))).is_ok());
        assert!(decode_todo_snapshot(success(json!({"todos":[todo()], "updatedAt":2}))).is_ok());
    }

    #[test]
    fn task_update_receipt_rejects_a_valid_but_wrong_task_id() {
        let requested_scope = scope();
        let error = decode_task_update(
            &requested_scope,
            "task-1",
            success(json!({"scope":team_scope(),"task":{
                "id":"task-2", "subject":"subject", "description":"description",
                "status":"pending", "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":2
            }})),
        )
        .unwrap_err();
        assert_eq!(error, ProtocolError::Invalid);

        let error = decode_task_update(
            &requested_scope,
            "task-1",
            success(json!({"scope":team_scope(),"taskId":"task-2","deleted":true,"todos":[]})),
        )
        .unwrap_err();
        assert_eq!(error, ProtocolError::Invalid);
    }

    #[test]
    fn metadata_is_an_opaque_object_on_create_update_and_read_responses() {
        let metadata = TaskMetadata::new(serde_json::Map::from_iter([
            (
                "private".to_owned(),
                json!({"nested":[true, null, "canary"]}),
            ),
            ("remove".to_owned(), serde_json::Value::Null),
        ]));
        let request_scope = scope();
        let create = TaskCreateRequest::new(
            &request_scope,
            TaskCreate::try_new(
                "subject".into(),
                "description".into(),
                None,
                None,
                Some(metadata.clone()),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(create).unwrap()["metadata"],
            json!({"private":{"nested":[true, null, "canary"]},"remove":null})
        );

        let update = TaskUpdateRequest::new(
            &request_scope,
            TaskUpdate::try_new(
                "task-1".into(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(metadata),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(update).unwrap()["metadata"],
            json!({"private":{"nested":[true, null, "canary"]},"remove":null})
        );

        let mut with_metadata = task();
        with_metadata["metadata"] =
            json!({"private":{"nested":[true, null, "canary"]},"remove":null});
        let requested_scope = scope();
        let task = decode_task_get(
            &requested_scope,
            success(json!({"scope":team_scope(),"task":with_metadata})),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(task.metadata().unwrap()).unwrap(),
            json!({"private":{"nested":[true, null, "canary"]},"remove":null})
        );
        assert!(!format!("{task:?}").contains("canary"));
        assert!(!format!("{:?}", task.metadata().unwrap()).contains("canary"));
    }

    #[test]
    fn delivery_views_expose_only_the_projectable_task_manager_fields() {
        let mut task_with_metadata = task();
        task_with_metadata["metadata"] = json!({"private":"metadata-canary"});
        let snapshot = decode_task_snapshot(
            &scope(),
            success(json!({
                "scope": team_scope(),
                "tasks": [task_with_metadata],
                "todos": [todo()]
            })),
        )
        .unwrap();
        let task = &snapshot.tasks()[0];
        assert_eq!(task.id(), "task-1");
        assert_eq!(task.subject(), "subject");
        assert_eq!(task.description(), "description");
        assert_eq!(task.active_form(), Some("working"));
        assert_eq!(task.status(), TaskStatus::Pending);
        assert_eq!(task.owner(), Some("owner"));
        assert_eq!(task.blocked_by(), &[] as &[String]);
        assert_eq!(task.blocks(), &[] as &[String]);
        assert_eq!(
            task.metadata().unwrap().as_object(),
            &serde_json::Map::from_iter([("private".to_owned(), json!("metadata-canary"))])
        );
        assert_eq!(task.created_at(), 1);
        assert_eq!(task.updated_at(), 2);
        assert_eq!(snapshot.todos().len(), 1);

        let delivery_todo = &snapshot.todos()[0];
        assert_eq!(delivery_todo.id(), Some("todo-1"));
        assert_eq!(delivery_todo.content(), "content");
        assert_eq!(delivery_todo.active_form(), Some("working"));
        assert_eq!(delivery_todo.status(), TodoStatus::Pending);
        assert_eq!(delivery_todo.owner(), Some("owner"));

        let todo_snapshot = decode_todo_snapshot(success(json!({
            "todos": [todo()],
            "updatedAt": 2
        })))
        .unwrap();
        assert_eq!(todo_snapshot.todos().len(), 1);
        assert_eq!(todo_snapshot.updated_at(), 2);

        assert!(!format!("{snapshot:?}").contains("metadata-canary"));
    }

    #[test]
    fn task_decoders_accept_metadata_without_relaxing_unknown_field_rejection() {
        let mut with_metadata = task();
        with_metadata["metadata"] = json!({"private":"canary"});
        let requested_scope = scope();
        assert!(
            decode_task_snapshot(
                &requested_scope,
                success(
                    json!({"scope":team_scope(),"tasks":[with_metadata.clone()],"todos":[todo()]})
                ),
            )
            .is_ok()
        );
        assert!(
            decode_task_get(
                &requested_scope,
                success(json!({"scope":team_scope(),"task":with_metadata.clone()})),
            )
            .is_ok()
        );
        assert!(
            decode_task_create(
                &requested_scope,
                success(json!({"scope":team_scope(),"task":with_metadata.clone()})),
            )
            .is_ok()
        );
        assert!(
            decode_task_update(
                &requested_scope,
                "task-1",
                success(json!({"scope":team_scope(),"task":with_metadata})),
            )
            .is_ok()
        );

        let mut unknown = task();
        unknown["metadata"] = json!({"private":"canary"});
        unknown["unexpected"] = json!(true);
        let error = decode_task_get(
            &requested_scope,
            success(json!({"scope":team_scope(),"task":unknown})),
        )
        .unwrap_err();
        assert_eq!(error, ProtocolError::Invalid);
        assert!(!format!("{error:?}").contains("canary"));
    }

    #[test]
    fn task_scope_mismatch_fails_closed_without_echoing_native_scope() {
        let error = decode_task_snapshot(
            &scope(),
            success(json!({
                "scope":{"type":"team","key":"team:other-canary","label":"Team · other-canary","teamKey":"other-canary"},
                "tasks":[],
                "todos":[]
            })),
        )
        .unwrap_err();
        assert_eq!(error, ProtocolError::Invalid);
        assert!(!format!("{error:?}").contains("other-canary"));
    }

    #[test]
    fn malformed_and_unknown_payloads_fail_closed_without_echoing_them() {
        let error = decode_todo_snapshot(success(
            json!({"todos":[],"updatedAt":2,"private":"canary"}),
        ))
        .unwrap_err();
        assert_eq!(error, ProtocolError::Invalid);
        assert!(!format!("{:?}", error).contains("canary"));
        assert!(TaskScope::try_new(" ".into(), None, "workspace".into()).is_err());
        assert!(
            TaskUpdate::try_new(
                "task".into(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None
            )
            .is_err()
        );
    }
}
