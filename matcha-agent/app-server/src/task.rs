use crate::{
    config::{ConfigStore, validate_id},
    diagnostics::Diagnostics,
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};

mod context;
mod files;
mod lock;
mod todos;

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum ListParams {
    #[serde(rename = "runtime", rename_all = "camelCase")]
    Runtime {
        agent_id: String,
        session_id: String,
    },
    #[serde(rename = "taskList", rename_all = "camelCase")]
    TaskList {
        agent_id: String,
        session_id: String,
        instance_id: Option<String>,
        list_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum GetParams {
    #[serde(rename = "runtime", rename_all = "camelCase")]
    Runtime {
        agent_id: String,
        session_id: String,
        id: String,
    },
    #[serde(rename = "taskList", rename_all = "camelCase")]
    TaskList {
        agent_id: String,
        session_id: String,
        instance_id: Option<String>,
        list_id: Option<String>,
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopParams {
    agent_id: String,
    session_id: String,
    instance_id: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    session_id: String,
    agent_id: String,
    instance_id: Option<String>,
    initialize: Option<Value>,
    tasks: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationParams {
    agent_id: String,
    session_id: String,
    instance_id: Option<String>,
    list_id: Option<String>,
    input: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TodoGetParams {
    agent_id: String,
    session_id: String,
    instance_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TodoWriteParams {
    agent_id: String,
    session_id: String,
    instance_id: Option<String>,
    old_todos: Vec<Value>,
    new_todos: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn capabilities() -> Value {
    json!({
        "methods": ["tasks.list", "tasks.get", "tasks.create", "tasks.update", "tasks.stop", "todos.get", "todos.write", "tasks.capabilities"],
        "kinds": {
            "runtime": {"source": "session.native_snapshot.tasks", "coverage": "observedNativeEvents"},
            "taskList": {"source": "persisted native files", "read": ["tasks.list", "tasks.get"], "controls": ["task_create", "task_update"], "delete": "tasks.update input.status=deleted"},
            "todo": {"source": "persisted native files", "read": ["todos.get"], "controls": ["write_todos"], "writeReceipt": ["stateApplied", "transcriptPersisted", "transcriptMessageId"]}
        },
        "stop": {"nativeRequest": "stop_task", "requires": ["sessionId", "instanceId", "observed task id"], "ackIsTerminal": false},
        "limitations": [
            "TaskList事项不是运行task或subagent；事项不支持stop。",
            "运行任务仅反映当前CLI实例实际观察到的原生消息，不是完整内部任务枚举；重启清空观察。",
            "task_started/task_progress不是当前活性证明；终态只来自task_notification.status。",
            "initialize.agents是可调用Agent定义，不是已启动subagent。",
            "事项读取始终直读CLI原生文件并参与既有proper-lockfile列表锁；事项写入只由CLI执行。",
            "Todo读取按主会话原生transcript恢复；写入拒绝运行中会话，并以native transcript读取确认持久化，不以control ACK确认。",
            "事项和Todo读取不启动CLI，不需要模型凭据，instanceId返回null；仅写入省略instanceId可启动当前CLI，可能触发原生hooks/cron/channel。",
            "没有运行task create/start/内部subagent CRUD入口，不通过prompt伪造。"
        ]
    })
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
    diagnostics: &Diagnostics,
) -> rpc::Result<Value> {
    match method {
        "tasks.capabilities" => {
            let _: Empty = rpc::params(params)?;
            Ok(capabilities())
        }
        "tasks.list" => match rpc::params::<ListParams>(params)? {
            ListParams::Runtime {
                agent_id,
                session_id,
            } => {
                let snapshot = observe(config, sessions, &agent_id, &session_id).await?;
                runtime_view(snapshot, None)
            }
            ListParams::TaskList {
                agent_id,
                session_id,
                instance_id,
                list_id,
            } => {
                persisted_read(
                    config,
                    sessions,
                    diagnostics,
                    &agent_id,
                    &session_id,
                    instance_id.as_deref(),
                    PersistedRead::TaskList {
                        list_id: list_id.as_deref(),
                        id: None,
                    },
                )
                .await
            }
        },
        "tasks.get" => match rpc::params::<GetParams>(params)? {
            GetParams::Runtime {
                agent_id,
                session_id,
                id,
            } => {
                validate_id(&id)?;
                let snapshot = observe(config, sessions, &agent_id, &session_id).await?;
                runtime_view(snapshot, Some(&id))
            }
            GetParams::TaskList {
                agent_id,
                session_id,
                instance_id,
                list_id,
                id,
            } => {
                validate_id(&id)?;
                persisted_read(
                    config,
                    sessions,
                    diagnostics,
                    &agent_id,
                    &session_id,
                    instance_id.as_deref(),
                    PersistedRead::TaskList {
                        list_id: list_id.as_deref(),
                        id: Some(&id),
                    },
                )
                .await
            }
        },
        "tasks.create" | "tasks.update" => {
            let input: MutationParams = rpc::params(params)?;
            validate_task_input(&input.input, method == "tasks.update")?;
            native_control(config, sessions, diagnostics, &input.agent_id, &input.session_id, input.instance_id.as_deref(),
                json!({"subtype": if method == "tasks.create" { "task_create" } else { "task_update" }, "list_id": input.list_id, "input": input.input})).await
        }
        "todos.get" => {
            let input: TodoGetParams = rpc::params(params)?;
            persisted_read(
                config,
                sessions,
                diagnostics,
                &input.agent_id,
                &input.session_id,
                input.instance_id.as_deref(),
                PersistedRead::Todos,
            )
            .await
        }
        "todos.write" => {
            let input: TodoWriteParams = rpc::params(params)?;
            validate_todos(&input.old_todos)?;
            validate_todos(&input.new_todos)?;
            native_control(config, sessions, diagnostics, &input.agent_id, &input.session_id, input.instance_id.as_deref(),
                json!({"subtype": "write_todos", "old_todos": input.old_todos, "new_todos": input.new_todos})).await
        }
        "tasks.stop" => {
            let params: StopParams = rpc::params(params)?;
            validate_id(&params.id)?;
            if params.instance_id.is_empty() {
                return Err(rpc::Error::invalid("instanceId must not be empty"));
            }
            let snapshot = observe(config, sessions, &params.agent_id, &params.session_id).await?;
            if snapshot.instance_id.as_deref() != Some(params.instance_id.as_str()) {
                return Err(rpc::Error::conflict(
                    "task_instance_changed",
                    "The observed CLI instance is no longer current",
                ));
            }
            let task = snapshot
                .tasks
                .iter()
                .find(|task| task["task_id"].as_str() == Some(params.id.as_str()))
                .ok_or_else(|| rpc::Error::not_found("Observed runtime task"))?;
            validate_observation(task)?;
            if task["subtype"] == "task_notification" {
                return Err(rpc::Error::conflict(
                    "task_terminal_observed",
                    "A native terminal notification has already been observed",
                ));
            }
            if let Some(kind) = task["task_type"].as_str()
                && !matches!(
                    kind,
                    "local_bash"
                        | "local_agent"
                        | "remote_agent"
                        | "local_workflow"
                        | "monitor_mcp"
                        | "dream"
                )
            {
                return Err(rpc::Error::unavailable(
                    "task_stop_type",
                    "The native stop_task dispatcher does not support this observed task type",
                ));
            }
            sessions
                .control_instance(
                    &params.session_id,
                    &params.instance_id,
                    json!({"subtype": "stop_task", "task_id": params.id}),
                )
                .await?;
            Ok(json!({
                "agentId": params.agent_id, "sessionId": params.session_id,
                "instanceId": params.instance_id, "id": params.id,
                "acknowledged": true, "terminalConfirmed": false
            }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}

async fn observe(
    config: &ConfigStore,
    sessions: &Sessions,
    agent_id: &str,
    session_id: &str,
) -> rpc::Result<Snapshot> {
    ensure_agent(config, agent_id).await?;
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| rpc::Error::invalid("sessionId must be a UUID"))?;
    let snapshot: Snapshot = serde_json::from_value(sessions.native_snapshot(session_id).await?)
        .map_err(|_| native_invalid())?;
    if snapshot.agent_id != agent_id || snapshot.session_id != session_id {
        return Err(rpc::Error::not_found("Agent session"));
    }
    Ok(snapshot)
}

fn validate_observation(task: &Value) -> rpc::Result<()> {
    let id = task["task_id"].as_str().ok_or_else(native_invalid)?;
    if validate_id(id).is_err() || task["type"] != "system" {
        return Err(native_invalid());
    }
    match task["subtype"].as_str() {
        Some("task_started" | "task_progress") => Ok(()),
        Some("task_notification")
            if matches!(
                task["status"].as_str(),
                Some("completed" | "failed" | "stopped")
            ) =>
        {
            Ok(())
        }
        _ => Err(native_invalid()),
    }
}

fn runtime_view(snapshot: Snapshot, id: Option<&str>) -> rpc::Result<Value> {
    for task in &snapshot.tasks {
        validate_observation(task)?;
    }
    let task = if let Some(id) = id {
        Some(
            snapshot
                .tasks
                .iter()
                .find(|task| task["task_id"].as_str() == Some(id))
                .ok_or_else(|| rpc::Error::not_found("Observed runtime task"))?
                .clone(),
        )
    } else {
        None
    };
    let definitions = snapshot
        .initialize
        .as_ref()
        .and_then(|value| value.get("agents"))
        .cloned();
    let mut result = json!({
        "kind": "runtime", "agentId": snapshot.agent_id, "sessionId": snapshot.session_id,
        "instanceId": snapshot.instance_id, "coverage": "observedNativeEvents",
        "agentDefinitions": definitions, "initializeObserved": snapshot.initialize.is_some()
    });
    if let Some(task) = task {
        result["task"] = json!({"id": task["task_id"], "native": task});
    } else {
        result["tasks"] = Value::Array(
            snapshot
                .tasks
                .into_iter()
                .map(|task| json!({"id": task["task_id"], "native": task}))
                .collect(),
        );
    }
    Ok(result)
}

async fn ensure_agent(config: &ConfigStore, agent_id: &str) -> rpc::Result<()> {
    validate_id(agent_id)?;
    if !config.snapshot().await.agents.contains_key(agent_id) {
        return Err(rpc::Error::not_found("Agent"));
    }
    Ok(())
}

enum PersistedRead<'a> {
    TaskList {
        list_id: Option<&'a str>,
        id: Option<&'a str>,
    },
    Todos,
}

async fn persisted_read(
    config: &ConfigStore,
    sessions: &Sessions,
    diagnostics: &Diagnostics,
    agent_id: &str,
    session_id: &str,
    instance_id: Option<&str>,
    read: PersistedRead<'_>,
) -> rpc::Result<Value> {
    let (todo, list_id, id) = match read {
        PersistedRead::TaskList { list_id, id } => (false, list_id, id),
        PersistedRead::Todos => (true, None, None),
    };
    let mut stage = "observe";
    let result = async {
        validate_id(agent_id)?;
        if instance_id.is_some_and(str::is_empty) {
            return Err(rpc::Error::invalid("instanceId must not be empty"));
        }
        if let Some(list_id) = list_id {
            validate_list_id(list_id)?;
        }
        let _guard = sessions.agent_guard(agent_id).await;
        let native = sessions.native_files(session_id).await?;
        if native.agent_id != agent_id || native.session_id != session_id {
            return Err(rpc::Error::not_found("Agent session"));
        }
        stage = "native_read";
        let (native, context) = file_io(move || {
            let context = files::context(&native)?;
            Ok((native, context))
        })
        .await?;
        let context = match context {
            Some(context) => context,
            None => context::initial(&config.snapshot().await, session_id)?,
        };
        if todo && context.todo_v2 {
            return Err(rpc::Error::unavailable(
                "todo_owner_inactive",
                "TodoWrite is not active in this native session",
            ));
        }
        let mut receipt = if context.todo_v2 {
            json!({"todos": []})
        } else {
            let _permit = read_permit().await?;
            todos::restore(&sessions.persisted_history(session_id).await?)?
        };
        if !todo {
            let list_id = list_id.map(sanitize).unwrap_or(context.list_id);
            let id = id.map(str::to_owned);
            let list = list_id.clone();
            let value = file_io(move || files::tasks(&native, &list, id.as_deref())).await?;
            receipt
                .as_object_mut()
                .expect("native receipt")
                .extend(value.as_object().expect("native task view").clone());
            receipt["listId"] = json!(list_id);
        }
        receipt["source"] = json!("persisted native files");
        Ok(json!({
            "kind": if todo { "todo" } else { "taskList" },
            "agentId": agent_id, "sessionId": session_id, "instanceId": null,
            "receipt": receipt,
        }))
    }
    .await;
    if let Err(error) = &result {
        let cause_kind = error
            .data
            .as_ref()
            .and_then(|data| data["kind"].as_str())
            .filter(|kind| {
                matches!(
                    *kind,
                    "invalid_params"
                        | "not_found"
                        | "task_native_schema"
                        | "task_io"
                        | "task_lock_conflict"
                        | "todo_owner_inactive"
                )
            })
            .unwrap_or("remote_error");
        let _ = diagnostics
            .record(
                "task",
                "persisted_read",
                "failed",
                json!({
                    "agentId": agent_id,
                    "sessionId": uuid::Uuid::parse_str(session_id).ok().map(|_| session_id),
                    "instanceId": null, "stage": stage, "causeKind": cause_kind,
                    "rpcCode": error.code, "delivery": "notSent",
                }),
            )
            .await;
    }
    result.map_err(|error| error.with_data(json!({"stage": stage})))
}

async fn read_permit() -> rpc::Result<tokio::sync::OwnedSemaphorePermit> {
    static READS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(8)));
    READS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| rpc::Error::internal("task_read_admission"))
}

async fn file_io<T: Send + 'static>(
    operation: impl FnOnce() -> rpc::Result<T> + Send + 'static,
) -> rpc::Result<T> {
    let permit = read_permit().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| rpc::Error::internal("task_read_join").with_source(error))?
}

pub(crate) fn sanitize(value: &str) -> String {
    value
        .encode_utf16()
        .map(|character| {
            let character = char::from_u32(u32::from(character)).unwrap_or('-');
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn validate_list_id(list_id: &str) -> rpc::Result<()> {
    if list_id.is_empty() || list_id.encode_utf16().count() > 256 || list_id.contains('\0') {
        return Err(rpc::Error::invalid(
            "listId must be a non-empty native task list identity",
        ));
    }
    Ok(())
}

async fn native_control(
    config: &ConfigStore,
    sessions: &Sessions,
    diagnostics: &Diagnostics,
    agent_id: &str,
    session_id: &str,
    instance_id: Option<&str>,
    mut request: Value,
) -> rpc::Result<Value> {
    let mut stage = "observe";
    let mut observed_instance = None;
    let result = async {
        if instance_id.is_some_and(str::is_empty) {
            return Err(rpc::Error::invalid("instanceId must not be empty"));
        }
        let snapshot = observe(config, sessions, agent_id, session_id)
            .await
            .map_err(control_not_sent)?;
        observed_instance = snapshot.instance_id.clone();
        if let Some(list_id) = request.get("list_id") {
            if list_id.is_null() {
                request
                    .as_object_mut()
                    .expect("native request object")
                    .remove("list_id");
            } else {
                validate_list_id(
                    list_id
                        .as_str()
                        .ok_or_else(|| rpc::Error::invalid("listId must be a string"))?,
                )?;
            }
        }
        let snapshot = if let Some(expected) = instance_id {
            if snapshot.instance_id.as_deref() != Some(expected) {
                return Err(rpc::Error::conflict(
                    "native_instance_changed",
                    "The requested CLI instance is no longer current",
                )
                .with_data(json!({"delivery": "notSent", "outcome": "rejected"})));
            }
            snapshot
        } else {
            stage = "ensure_native";
            let started: Snapshot = serde_json::from_value(
                sessions
                    .ensure_native(session_id)
                    .await
                    .map_err(control_not_sent)?,
            )
            .map_err(|_| control_not_sent(native_invalid()))?;
            if started.agent_id != agent_id || started.session_id != session_id {
                return Err(control_not_sent(native_invalid()));
            }
            started
        };
        observed_instance = snapshot.instance_id.clone();
        let instance_id = snapshot.instance_id.ok_or_else(|| {
            rpc::Error::unavailable(
                "native_instance_absent",
                "This session has no live CLI instance",
            )
            .with_data(json!({"delivery": "notSent", "outcome": "rejected"}))
        })?;
        let todo = request["subtype"]
            .as_str()
            .is_some_and(|kind| kind.ends_with("todos"));
        stage = "control";
        let response = sessions
            .control_instance(session_id, &instance_id, request)
            .await?;
        stage = "receipt";
        if let Some(error) = response.get("error") {
            let kind = error["kind"].as_str().ok_or_else(native_invalid)?;
            let outcome = error["outcome"].as_str().ok_or_else(native_invalid)?;
            let code = match kind {
                "invalid_params" => -32602,
                "not_found" => -32001,
                "task_lock_conflict"
                | "todo_conflict"
                | "todo_session_busy"
                | "task_dependency_missing" => -32002,
                "task_io" | "todo_io" => -32005,
                _ => -32003,
            };
            return Err(rpc::Error::new(
                code,
                kind,
                "The native task owner could not complete this request",
            )
            .with_data(json!({"delivery": "responseReceived", "outcome": outcome})));
        }
        if !response.is_object()
            || if todo {
                response["stateApplied"] != true
                    || response["transcriptPersisted"] != true
                    || !response["transcriptMessageId"].is_string()
            } else {
                response["persisted"] != true || response["outcome"] != "applied"
            }
        {
            return Err(rpc::Error::new(
                -32006,
                "task_receipt_unknown",
                "The native task mutation receipt could not be verified",
            )
            .with_data(json!({"delivery": "responseReceived", "outcome": "unknown"})));
        }
        Ok(json!({
            "kind": if todo { "todo" } else { "taskList" },
            "agentId": agent_id, "sessionId": session_id, "instanceId": instance_id,
            "receipt": response,
        }))
    }
    .await;
    if let Err(error) = &result {
        let data = error.data.as_ref();
        let cause_kind = data
            .and_then(|data| data["kind"].as_str())
            .filter(|kind| {
                matches!(
                    *kind,
                    "invalid_params"
                        | "not_found"
                        | "server_shutdown"
                        | "session_closed"
                        | "native_cleanup_unconfirmed"
                        | "native_start_unknown"
                        | "native_instance_changed"
                        | "native_instance_handoff"
                        | "native_instance_sealed"
                        | "native_instance_absent"
                        | "native_instance_closed"
                        | "native_response_lost"
                        | "native_control_error"
                        | "native_input_encode"
                        | "native_initialization_observer_closed"
                        | "native_settings_encode"
                        | "native_settings_writer"
                        | "native_settings_directory_create"
                        | "native_environment_encoding"
                        | "native_env_source_empty"
                        | "native_env_source_missing"
                        | "native_env_source_encoding"
                        | "native_path_encoding"
                        | "native_runtime_create"
                        | "native_workspace_create"
                        | "process_spawn_failed"
                        | "process_executable_not_found"
                        | "process_resume_failed"
                        | "process_launch_join"
                        | "stdin_closed"
                        | "stdin_write_cancelled"
                        | "stdin_broken_pipe"
                        | "stdin_write_failed"
                        | "task_lock_conflict"
                        | "todo_conflict"
                        | "todo_session_busy"
                        | "todo_owner_inactive"
                        | "todo_persistence_disabled"
                        | "task_dependency_missing"
                        | "task_io"
                        | "todo_io"
                        | "task_native_schema"
                        | "task_receipt_unknown"
                )
            })
            .unwrap_or("remote_error");
        let delivery = match data.and_then(|data| data["delivery"].as_str()) {
            Some(delivery @ ("notSent" | "sent" | "responseReceived" | "unknown")) => delivery,
            _ => match stage {
                "observe" | "ensure_native" => "notSent",
                "receipt" => "responseReceived",
                _ => "unknown",
            },
        };
        // Native error kinds are untrusted; never persist the original error or response.
        let _ = diagnostics
            .record(
                "task",
                "native_control",
                "failed",
                json!({
                    "agentId": agent_id,
                    "sessionId": uuid::Uuid::parse_str(session_id).ok().map(|_| session_id),
                    "instanceId": observed_instance,
                    "stage": stage, "causeKind": cause_kind, "rpcCode": error.code,
                    "delivery": delivery,
                }),
            )
            .await;
    }
    result.map_err(|error| error.with_data(json!({ "stage": stage })))
}

fn control_not_sent(error: rpc::Error) -> rpc::Error {
    error.with_data(json!({"delivery": "notSent", "outcome": "rejected"}))
}

fn validate_task_input(input: &Value, update: bool) -> rpc::Result<()> {
    let input = input
        .as_object()
        .ok_or_else(|| rpc::Error::invalid("input must be an object"))?;
    for (key, value) in input {
        match key.as_str() {
            "subject" | "description" | "activeForm" | "owner"
                if value.as_str().is_some_and(|v| !v.is_empty()) => {}
            "metadata" if value.is_object() => {}
            "taskId" if update && value.as_str().is_some_and(|id| validate_id(id).is_ok()) => {}
            "status"
                if update
                    && matches!(
                        value.as_str(),
                        Some("pending" | "in_progress" | "completed" | "deleted")
                    ) => {}
            "addBlocks" | "addBlockedBy"
                if update
                    && value.as_array().is_some_and(|ids| {
                        ids.iter()
                            .all(|id| id.as_str().is_some_and(|id| validate_id(id).is_ok()))
                    }) => {}
            _ => return Err(rpc::Error::invalid("Task input contains an invalid field")),
        }
    }
    if update {
        if !input.contains_key("taskId") || input.len() < 2 {
            return Err(rpc::Error::invalid(
                "Task update requires taskId and a change",
            ));
        }
    } else if !input.contains_key("subject") || !input.contains_key("description") {
        return Err(rpc::Error::invalid(
            "Task create requires subject and description",
        ));
    }
    Ok(())
}

fn validate_todos(todos: &[Value]) -> rpc::Result<()> {
    for todo in todos {
        let item = todo
            .as_object()
            .ok_or_else(|| rpc::Error::invalid("Todo must be an object"))?;
        if item.len() != 3
            || !item
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
            || !item
                .get("activeForm")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
            || !matches!(
                item.get("status").and_then(Value::as_str),
                Some("pending" | "in_progress" | "completed")
            )
        {
            return Err(rpc::Error::invalid(
                "Todo must match the native content/status/activeForm schema",
            ));
        }
    }
    Ok(())
}

fn native_invalid() -> rpc::Error {
    rpc::Error::unavailable(
        "task_native_schema",
        "The native task data does not match its resource identity or supported schema",
    )
}
