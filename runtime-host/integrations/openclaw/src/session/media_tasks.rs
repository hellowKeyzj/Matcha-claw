use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::state::ToolView;

pub(crate) struct ImageTaskCancellation {
    pub(crate) cancelled: bool,
    pub(crate) standalone: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum GenerationKind {
    ImageGeneration,
    VideoGeneration,
}

impl GenerationKind {
    fn tool_name(&self) -> &'static str {
        match self {
            Self::ImageGeneration => "image_generate",
            Self::VideoGeneration => "video_generate",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaGenerationTask {
    pub(crate) task_id: String,
    pub(crate) session_key: String,
    agent_id: Option<String>,
    run_id: Option<String>,
    status: String,
    updated_at: u64,
    created_at: u64,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    progress_summary: Option<String>,
    error: Option<String>,
    terminal_outcome: Option<String>,
    delivery_status: Option<String>,
    kind: GenerationKind,
}

impl MediaGenerationTask {
    pub(crate) fn decode(value: &Value) -> Option<Self> {
        let task: Self = serde_json::from_value(value.clone()).ok()?;
        (!task.task_id.is_empty()
            && matches!(task.status.as_str(), "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled"))
            .then_some(task)
    }

    pub(crate) fn matches(&self, identity: &sessions_module::state::SessionIdentity) -> bool {
        self.session_key == identity.session_key && self.agent_id.as_deref().is_none_or(|agent| agent == identity.agent_id)
            && crate::port::validate_observation_identity(identity).is_ok()
    }
}

fn reference(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty() && text.len() <= 4_096
        && text.trim() == *text && !text.chars().any(char::is_control))
}

fn details_task_id(details: &Value) -> Option<&str> {
    let nested = details.pointer("/task/taskId");
    let id = reference(details.get("taskId").or(nested)?)?;
    nested.is_none_or(|nested| nested.as_str() == Some(id)).then_some(id)
}

pub(crate) fn project_task_reference(tool_name: Option<&str>, value: &Value) -> Option<serde_json::Map<String, Value>> {
    if !matches!(tool_name, Some("image_generate" | "video_generate")) { return None; }
    let task_id = details_task_id(value)?;
    let mut projected = serde_json::Map::new();
    projected.insert("taskId".into(), json!(task_id));
    if let Some(run_id) = value.get("runId").or_else(|| value.pointer("/task/runId")).and_then(reference) {
        if value.pointer("/task/runId").is_some_and(|nested| nested.as_str() != Some(run_id)) { return None; }
        projected.insert("runId".into(), json!(run_id));
    }
    if value.get("async").and_then(Value::as_bool) == Some(true)
        && value.get("status").and_then(Value::as_str) == Some("started") {
        projected.insert("async".into(), json!(true));
        projected.insert("status".into(), json!("started"));
    }
    Some(projected)
}

pub(crate) fn task_id(tool: &ToolView) -> Option<&str> {
    if !matches!(tool.name.as_deref(), Some("image_generate" | "video_generate")) { return None; }
    details_task_id(tool.details.as_ref()?)
}

pub(crate) fn needs_read(tool: &ToolView) -> bool {
    task_id(tool).is_some() && tool.details.as_ref().and_then(|details| details.pointer("/task/status"))
        .and_then(Value::as_str) != Some("deleted")
}

pub(crate) fn is_active(tool: &ToolView) -> bool {
    task_id(tool).is_some() && tool.details.as_ref().and_then(|details| details.pointer("/task/status"))
        .and_then(Value::as_str).is_none_or(|status| matches!(status, "queued" | "running"))
}

pub(crate) fn update_tool(tool: &mut ToolView, task: &MediaGenerationTask) -> bool {
    if task_id(tool) != Some(task.task_id.as_str()) || tool.name.as_deref() != Some(task.kind.tool_name()) { return false; }
    let Some(details) = tool.details.as_mut().and_then(Value::as_object_mut) else { return false; };
    let current = details.get("task");
    if current.and_then(|task| task.get("status")).and_then(Value::as_str) == Some("deleted")
        || current.and_then(|task| task.get("updatedAt")).and_then(Value::as_u64).is_some_and(|updated| updated > task.updated_at)
        || (current.and_then(|task| task.get("status")).and_then(Value::as_str)
            .is_some_and(|status| !matches!(status, "queued" | "running")) && matches!(task.status.as_str(), "queued" | "running"))
    { return false; }
    let mut next = json!({ "taskId": task.task_id, "runId": task.run_id, "status": task.status, "updatedAt": task.updated_at, "createdAt": task.created_at });
    if let Some(started_at) = task.started_at { next["startedAt"] = json!(started_at); }
    if let Some(ended_at) = task.ended_at { next["endedAt"] = json!(ended_at); }
    if let Some(summary) = &task.progress_summary { next["progressSummary"] = json!(summary); }
    if let Some(error) = &task.error { next["error"] = json!(error); }
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
    let Some(task_id) = details_task_id(current) else { return; };
    if incoming.as_ref().and_then(details_task_id) != Some(task_id) { return; }
    let Some(incoming) = incoming.as_mut().and_then(Value::as_object_mut) else { return; };
    if current.pointer("/task/status").is_some()
        && incoming.get("task").and_then(|task| task.get("status")).is_none()
        && let Some(task) = current.get("task")
    { incoming.insert("task".into(), task.clone()); }
}
