use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::state::ToolView;

pub(crate) struct ImageTaskCancellation {
    pub(crate) cancelled: bool,
    pub(crate) standalone: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageTask {
    pub(crate) task_id: String,
    pub(crate) session_key: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) status: String,
    pub(crate) updated_at: u64,
    pub(crate) terminal_outcome: Option<String>,
    pub(crate) delivery_status: Option<String>,
    kind: String,
}

impl ImageTask {
    pub(crate) fn decode(value: &Value) -> Option<Self> {
        let task: Self = serde_json::from_value(value.clone()).ok()?;
        (task.kind == "image_generation" && !task.task_id.is_empty()
            && matches!(task.status.as_str(), "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled"))
            .then_some(task)
    }

    pub(crate) fn deleted(task_id: &str, identity: &sessions_module::state::SessionIdentity) -> Self {
        Self { task_id: task_id.to_owned(), session_key: identity.session_key.clone(), agent_id: Some(identity.agent_id.clone()),
            run_id: None, status: "deleted".into(), updated_at: 0, terminal_outcome: None, delivery_status: None, kind: "image_generation".into() }
    }

    pub(crate) fn matches(&self, identity: &sessions_module::state::SessionIdentity) -> bool {
        self.session_key == identity.session_key && self.agent_id.as_deref().is_none_or(|agent| agent == identity.agent_id)
            && crate::port::validate_observation_identity(identity).is_ok()
    }
}

pub(crate) fn task_id(tool: &ToolView) -> Option<&str> {
    if tool.name.as_deref() != Some("image_generate") { return None; }
    tool.details.as_ref()?.get("taskId")?.as_str().filter(|id| !id.is_empty())
}

pub(crate) fn needs_read(tool: &ToolView) -> bool {
    task_id(tool).is_some() && tool.details.as_ref().and_then(|details| details.pointer("/task/status"))
        .and_then(Value::as_str).is_none_or(|status| matches!(status, "queued" | "running"))
}

pub(crate) fn update_tool(tool: &mut ToolView, task: &ImageTask) -> bool {
    if task_id(tool) != Some(task.task_id.as_str()) { return false; }
    if task.status == "deleted" { return delete_tool(tool, &task.task_id); }
    let Some(details) = tool.details.as_mut().and_then(Value::as_object_mut) else { return false; };
    let current = details.get("task");
    if current.and_then(|task| task.get("updatedAt")).and_then(Value::as_u64).is_some_and(|updated| updated > task.updated_at)
        || (current.and_then(|task| task.get("status")).and_then(Value::as_str)
            .is_some_and(|status| !matches!(status, "queued" | "running")) && matches!(task.status.as_str(), "queued" | "running"))
    { return false; }
    let mut next = json!({ "taskId": task.task_id, "runId": task.run_id, "status": task.status, "updatedAt": task.updated_at });
    if let Some(outcome) = &task.terminal_outcome { next["terminalOutcome"] = json!(outcome); }
    if let Some(status) = &task.delivery_status { next["deliveryStatus"] = json!(status); }
    if current == Some(&next) { return false; }
    details.insert("task".into(), next);
    true
}

pub(crate) fn delete_tool(tool: &mut ToolView, deleted_id: &str) -> bool {
    if task_id(tool) != Some(deleted_id) { return false; }
    let Some(task) = tool.details.as_mut().and_then(|details| details.get_mut("task")).and_then(Value::as_object_mut) else { return false; };
    if task.get("status").and_then(Value::as_str) == Some("deleted") { return false; }
    task.insert("status".into(), json!("deleted"));
    true
}

pub(crate) fn preserve_task_details(current: &Option<Value>, incoming: &mut Option<Value>) {
    let Some(current) = current.as_ref() else { return; };
    let Some(incoming) = incoming.as_mut().and_then(Value::as_object_mut) else { return; };
    if current.get("taskId") == incoming.get("taskId") && current.pointer("/task/status").is_some()
        && incoming.get("task").and_then(|task| task.get("status")).is_none()
        && let Some(task) = current.get("task")
    { incoming.insert("task".into(), task.clone()); }
}
