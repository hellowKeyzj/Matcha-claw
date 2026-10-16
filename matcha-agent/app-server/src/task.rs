use crate::{
    config::{ConfigStore, validate_id},
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};

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
            "taskList": {"source": "CLI native TaskList owner", "controls": ["task_list", "task_get", "task_create", "task_update"], "delete": "tasks.update input.status=deleted"},
            "todo": {"source": "CLI AppState.todos and native transcript", "controls": ["get_todos", "write_todos"], "writeReceipt": ["stateApplied", "transcriptPersisted", "transcriptMessageId"]}
        },
        "stop": {"nativeRequest": "stop_task", "requires": ["sessionId", "instanceId", "observed task id"], "ackIsTerminal": false},
        "limitations": [
            "TaskList事项不是运行task或subagent；事项不支持stop。",
            "运行任务仅反映当前CLI实例实际观察到的原生消息，不是完整内部任务枚举；重启清空观察。",
            "task_started/task_progress不是当前活性证明；终态只来自task_notification.status。",
            "initialize.agents是可调用Agent定义，不是已启动subagent。",
            "事项CRUD由CLI真实owner执行并参与既有文件锁；Host和Server不直接写native事项文件。",
            "Todo仅主会话AppState.todos；写入拒绝运行中会话，并以native transcript读取确认持久化，不以control ACK确认。",
            "省略instanceId可启动当前CLI，启动可能触发原生hooks/cron/channel；不合成Run或prompt。",
            "没有运行task create/start/内部subagent CRUD入口，不通过prompt伪造。"
        ]
    })
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
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
                native_control(
                    config,
                    sessions,
                    &agent_id,
                    &session_id,
                    instance_id.as_deref(),
                    json!({"subtype": "task_list", "list_id": list_id}),
                    false,
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
                native_control(
                    config,
                    sessions,
                    &agent_id,
                    &session_id,
                    instance_id.as_deref(),
                    json!({"subtype": "task_get", "list_id": list_id, "task_id": id}),
                    false,
                )
                .await
            }
        },
        "tasks.create" | "tasks.update" => {
            let input: MutationParams = rpc::params(params)?;
            validate_task_input(&input.input, method == "tasks.update")?;
            native_control(config, sessions, &input.agent_id, &input.session_id, input.instance_id.as_deref(),
                json!({"subtype": if method == "tasks.create" { "task_create" } else { "task_update" }, "list_id": input.list_id, "input": input.input}), true).await
        }
        "todos.get" => {
            let input: TodoGetParams = rpc::params(params)?;
            native_control(
                config,
                sessions,
                &input.agent_id,
                &input.session_id,
                input.instance_id.as_deref(),
                json!({"subtype": "get_todos"}),
                false,
            )
            .await
        }
        "todos.write" => {
            let input: TodoWriteParams = rpc::params(params)?;
            validate_todos(&input.old_todos)?;
            validate_todos(&input.new_todos)?;
            native_control(config, sessions, &input.agent_id, &input.session_id, input.instance_id.as_deref(),
                json!({"subtype": "write_todos", "old_todos": input.old_todos, "new_todos": input.new_todos}), true).await
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

async fn native_control(
    config: &ConfigStore,
    sessions: &Sessions,
    agent_id: &str,
    session_id: &str,
    instance_id: Option<&str>,
    mut request: Value,
    mutation: bool,
) -> rpc::Result<Value> {
    if instance_id.is_some_and(str::is_empty) {
        return Err(rpc::Error::invalid("instanceId must not be empty"));
    }
    let snapshot = observe(config, sessions, agent_id, session_id)
        .await
        .map_err(control_not_sent)?;
    if let Some(list_id) = request.get("list_id") {
        if list_id.is_null() {
            request
                .as_object_mut()
                .expect("native request object")
                .remove("list_id");
        } else if !list_id
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 256 && !id.contains('\0'))
        {
            return Err(rpc::Error::invalid(
                "listId must be a non-empty native task list identity",
            ));
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
    let response = sessions
        .control_instance(session_id, &instance_id, request)
        .await?;
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
        || (mutation
            && if todo {
                response["stateApplied"] != true
                    || response["transcriptPersisted"] != true
                    || !response["transcriptMessageId"].is_string()
            } else {
                response["persisted"] != true || response["outcome"] != "applied"
            })
    {
        return Err(if mutation {
            rpc::Error::new(
                -32006,
                "task_receipt_unknown",
                "The native task mutation receipt could not be verified",
            )
            .with_data(json!({"delivery": "responseReceived", "outcome": "unknown"}))
        } else {
            native_invalid()
        });
    }
    Ok(json!({
        "kind": if todo { "todo" } else { "taskList" },
        "agentId": agent_id, "sessionId": session_id, "instanceId": instance_id,
        "receipt": response,
    }))
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
