use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidGatewayRequest;

#[derive(Clone, Debug, PartialEq)]
pub struct OpenClawBrowserGatewayRequest {
    pub method: String,
    pub path: String,
    pub query: Option<Value>,
    pub body: Option<Value>,
    pub timeout_ms: Option<u64>,
    pub target: Option<String>,
    pub node: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawMcpAppGatewayRequest {
    pub session_identity: sessions_module::state::SessionIdentity,
    pub view_id: String,
    pub operation: OpenClawMcpAppOperation,
}

impl OpenClawMcpAppGatewayRequest {
    pub fn operation_id(&self) -> &'static str {
        self.operation.operation_id()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenClawMcpAppOperation {
    View,
    CallTool { tool_name: String, arguments: Option<Value> },
    ListTools { cursor: Option<String> },
    ListResources { cursor: Option<String> },
    ListResourceTemplates { cursor: Option<String> },
    ReadResource { uri: String },
    UpdateModelContext { content: Option<Vec<Value>> },
}

impl OpenClawMcpAppOperation {
    pub fn operation_id(&self) -> &'static str {
        match self {
            Self::View => "mcp.app.view",
            Self::CallTool { .. } => "mcp.app.callTool",
            Self::ListTools { .. } => "mcp.app.listTools",
            Self::ListResources { .. } => "mcp.app.listResources",
            Self::ListResourceTemplates { .. } => "mcp.app.listResourceTemplates",
            Self::ReadResource { .. } => "mcp.app.readResource",
            Self::UpdateModelContext { .. } => "mcp.app.updateModelContext",
        }
    }

    pub fn has_side_effects(&self) -> bool {
        matches!(self, Self::CallTool { .. } | Self::UpdateModelContext { .. })
    }
}

pub fn is_mcp_app_operation_id(value: &str) -> bool {
    matches!(value, "mcp.app.view" | "mcp.app.callTool" | "mcp.app.listTools"
        | "mcp.app.listResources" | "mcp.app.listResourceTemplates"
        | "mcp.app.readResource" | "mcp.app.updateModelContext")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawCanvasGatewayRequest {
    pub session_identity: sessions_module::state::SessionIdentity,
    pub doc_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawProgressCardGatewayRequest {
    pub session_identity: sessions_module::state::SessionIdentity,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenClawQuestionListGatewayRequest {
    pub session_identity: sessions_module::state::SessionIdentity,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenClawQuestionResolveGatewayRequest {
    pub session_identity: sessions_module::state::SessionIdentity,
    pub id: String,
    pub answers: Value,
    pub resolved_by: Option<String>,
    pub resolution_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OpenClawGatewayControlOutcome {
    Succeeded(Value),
    Unknown(Value),
    Rejected,
    Unavailable,
    CapacityExhausted,
    SurfaceRejected(Value),
}

pub fn project_gateway_request_outcome(
    outcome: crate::port::OpenClawGatewayRequestOutcome,
) -> OpenClawGatewayControlOutcome {
    match outcome {
        crate::port::OpenClawGatewayRequestOutcome::Succeeded(payload) => {
            OpenClawGatewayControlOutcome::Succeeded(payload)
        }
        crate::port::OpenClawGatewayRequestOutcome::Rejected => {
            OpenClawGatewayControlOutcome::Rejected
        }
        crate::port::OpenClawGatewayRequestOutcome::Unavailable => {
            OpenClawGatewayControlOutcome::Unavailable
        }
        crate::port::OpenClawGatewayRequestOutcome::CapacityExhausted => {
            OpenClawGatewayControlOutcome::CapacityExhausted
        }
        crate::port::OpenClawGatewayRequestOutcome::OutcomeUnknown => {
            OpenClawGatewayControlOutcome::Unknown(json!({ "outcome": "unknown" }))
        }
        crate::port::OpenClawGatewayRequestOutcome::SurfaceRejected(failure) => {
            OpenClawGatewayControlOutcome::SurfaceRejected(failure.public_error())
        }
    }
}

pub fn decode_browser_request(
    input: Value,
) -> Result<OpenClawBrowserGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    if !object.keys().all(|key| {
        matches!(
            key.as_str(),
            "method" | "path" | "query" | "body" | "timeoutMs" | "target" | "node"
        )
    }) || !object.contains_key("method")
        || !object.contains_key("path")
    {
        return Err(InvalidGatewayRequest);
    }
    let query = object.get("query").cloned();
    if query.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(InvalidGatewayRequest);
    }
    let timeout_ms = match object.get("timeoutMs") {
        Some(value) => {
            let timeout_ms = value.as_u64().ok_or(InvalidGatewayRequest)?;
            if timeout_ms == 0 {
                return Err(InvalidGatewayRequest);
            }
            Some(timeout_ms)
        }
        None => None,
    };
    let target = match object.get("target") {
        Some(value) => {
            let target = bounded_gateway_text(Some(value))?;
            if target != "host" && target != "node" {
                return Err(InvalidGatewayRequest);
            }
            Some(target)
        }
        None => None,
    };
    let node = match object.get("node") {
        Some(value) if target.as_deref() == Some("node") => {
            Some(bounded_gateway_text(Some(value))?)
        }
        Some(_) => return Err(InvalidGatewayRequest),
        None => None,
    };
    Ok(OpenClawBrowserGatewayRequest {
        method: bounded_gateway_text(object.get("method"))?,
        path: bounded_gateway_text(object.get("path"))?,
        query,
        body: object.get("body").cloned(),
        timeout_ms,
        target,
        node,
    })
}

pub fn decode_mcp_app_request(
    input: Value,
) -> Result<OpenClawMcpAppGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    let operation_id = object.get("operationId").and_then(Value::as_str).ok_or(InvalidGatewayRequest)?;
    let extra: &[&str] = match operation_id {
        "mcp.app.view" => &[],
        "mcp.app.callTool" => &["toolName", "arguments"],
        "mcp.app.listTools" | "mcp.app.listResources" | "mcp.app.listResourceTemplates" => &["cursor"],
        "mcp.app.readResource" => &["uri"],
        "mcp.app.updateModelContext" => &["content"],
        _ => return Err(InvalidGatewayRequest),
    };
    if !object.keys().all(|key| matches!(key.as_str(), "operationId" | "sessionIdentity" | "viewId") || extra.contains(&key.as_str())) {
        return Err(InvalidGatewayRequest);
    }
    let view_id = bounded_surface_text(object.get("viewId"))?;
    if view_id.len() > 128 { return Err(InvalidGatewayRequest); }
    let cursor = || object.get("cursor").map(|value| bounded_surface_text(Some(value))).transpose();
    let operation = match operation_id {
        "mcp.app.view" => OpenClawMcpAppOperation::View,
        "mcp.app.callTool" => {
            let arguments = object.get("arguments").cloned();
            if arguments.as_ref().is_some_and(|arguments| !arguments.is_object()) { return Err(InvalidGatewayRequest); }
            OpenClawMcpAppOperation::CallTool { tool_name: bounded_surface_text(object.get("toolName"))?, arguments }
        }
        "mcp.app.listTools" => OpenClawMcpAppOperation::ListTools { cursor: cursor()? },
        "mcp.app.listResources" => OpenClawMcpAppOperation::ListResources { cursor: cursor()? },
        "mcp.app.listResourceTemplates" => OpenClawMcpAppOperation::ListResourceTemplates { cursor: cursor()? },
        "mcp.app.readResource" => OpenClawMcpAppOperation::ReadResource { uri: bounded_surface_text(object.get("uri"))? },
        "mcp.app.updateModelContext" => {
            let content = object.get("content").map(|value| value.as_array().cloned().ok_or(InvalidGatewayRequest)).transpose()?;
            if let Some(content) = &content {
                if content.len() > 1 || content.first().is_some_and(|block| !is_model_context_text(block)) {
                    return Err(InvalidGatewayRequest);
                }
            }
            OpenClawMcpAppOperation::UpdateModelContext { content }
        }
        _ => return Err(InvalidGatewayRequest),
    };
    Ok(OpenClawMcpAppGatewayRequest {
        session_identity: decode_question_session_identity(object.get("sessionIdentity"))?,
        view_id,
        operation,
    })
}

fn bounded_surface_text(value: Option<&Value>) -> Result<String, InvalidGatewayRequest> {
    let value = bounded_gateway_text(value)?;
    if value.trim() != value { return Err(InvalidGatewayRequest); }
    Ok(value)
}

fn is_model_context_text(value: &Value) -> bool {
    value.as_object().is_some_and(|block| block.len() == 2 && block.get("type").and_then(Value::as_str) == Some("text")
        && block.get("text").and_then(Value::as_str).is_some_and(|text| text.len() <= 16 * 1024))
}

pub fn decode_canvas_request(input: Value) -> Result<OpenClawCanvasGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    if object.len() != 3 || object.get("operationId").and_then(Value::as_str) != Some("canvas.document.view") {
        return Err(InvalidGatewayRequest);
    }
    let doc_id = bounded_gateway_text(object.get("docId"))?;
    if !is_canvas_document_id(&doc_id) { return Err(InvalidGatewayRequest); }
    Ok(OpenClawCanvasGatewayRequest {
        session_identity: decode_question_session_identity(object.get("sessionIdentity"))?,
        doc_id,
    })
}

pub(crate) fn is_canvas_document_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value != "." && value != ".."
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn decode_progress_card_request(input: Value) -> Result<OpenClawProgressCardGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    if object.len() != 2 || object.get("operationId").and_then(Value::as_str) != Some("progressCard.get") {
        return Err(InvalidGatewayRequest);
    }
    let session_identity = serde_json::from_value(object.get("sessionIdentity").cloned().ok_or(InvalidGatewayRequest)?)
        .map_err(|_| InvalidGatewayRequest)?;
    validate_progress_card_identity(&session_identity)?;
    Ok(OpenClawProgressCardGatewayRequest { session_identity })
}

pub(crate) fn validate_progress_card_identity(identity: &sessions_module::state::SessionIdentity) -> Result<(), InvalidGatewayRequest> {
    if matches!(identity.session_key.as_str(), "global" | "unknown") {
        identity.validate().map_err(|_| InvalidGatewayRequest)?;
        if identity.endpoint != sessions_module::state::SessionEndpoint::local(sessions_module::state::SessionProvider::OpenClaw) {
            return Err(InvalidGatewayRequest);
        }
        crate::session::protocol::AgentId::try_new(&identity.agent_id).map_err(|_| InvalidGatewayRequest)?;
        Ok(())
    } else {
        crate::port::validate_observation_identity(identity).map_err(|_| InvalidGatewayRequest)
    }
}

pub fn decode_question_list_request(
    input: Value,
) -> Result<OpenClawQuestionListGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    if object.len() != 1 {
        return Err(InvalidGatewayRequest);
    }
    Ok(OpenClawQuestionListGatewayRequest {
        session_identity: decode_question_session_identity(object.get("sessionIdentity"))?,
    })
}

fn decode_question_session_identity(
    value: Option<&Value>,
) -> Result<sessions_module::state::SessionIdentity, InvalidGatewayRequest> {
    let identity = serde_json::from_value(value.cloned().ok_or(InvalidGatewayRequest)?)
        .map_err(|_| InvalidGatewayRequest)?;
    crate::port::validate_observation_identity(&identity).map_err(|_| InvalidGatewayRequest)?;
    Ok(identity)
}

pub fn decode_question_resolve_request(
    input: Value,
) -> Result<OpenClawQuestionResolveGatewayRequest, InvalidGatewayRequest> {
    let object = input.as_object().ok_or(InvalidGatewayRequest)?;
    if !object.keys().all(|key| {
        matches!(key.as_str(), "sessionIdentity" | "id" | "answers" | "resolvedBy" | "resolutionId")
    }) || !object.contains_key("sessionIdentity")
        || !object.contains_key("id")
        || !object.contains_key("answers")
    {
        return Err(InvalidGatewayRequest);
    }
    let id = bounded_gateway_text(object.get("id"))?;
    let answers = object.get("answers").cloned().ok_or(InvalidGatewayRequest)?;
    if !is_question_answers(&answers) {
        return Err(InvalidGatewayRequest);
    }
    if object.get("resolutionId").and_then(Value::as_str).is_some_and(|value| value.chars().count() > 128) {
        return Err(InvalidGatewayRequest);
    }
    Ok(OpenClawQuestionResolveGatewayRequest {
        session_identity: decode_question_session_identity(object.get("sessionIdentity"))?,
        id,
        answers,
        resolved_by: optional_bounded_gateway_text(object.get("resolvedBy"))?,
        resolution_id: optional_bounded_gateway_text(object.get("resolutionId"))?,
    })
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingQuestionRecord {
    id: String,
    questions: Vec<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    created_at_ms: u64,
    expires_at_ms: u64,
    status: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Question {
    question_id: String,
    header: String,
    question: String,
    options: Vec<QuestionOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    multi_select: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_other: Option<bool>,
    #[serde(default, skip_serializing)]
    is_secret: bool,
    #[serde(skip_serializing)]
    secret_store: Option<Value>,
    #[serde(skip_serializing)]
    secret_store_existing: Option<Value>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct QuestionOption {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

pub(crate) fn project_pending_question(
    value: Value,
    identity: &sessions_module::state::SessionIdentity,
) -> Result<Option<Value>, InvalidGatewayRequest> {
    let record = serde_json::from_value::<PendingQuestionRecord>(value)
        .map_err(|_| InvalidGatewayRequest)?;
    // Unscoped and secret-store prompts are not part of the ordinary ask_user surface.
    if record.status != "pending"
        || record.agent_id.as_deref() != Some(identity.agent_id.as_str())
        || record.session_key.as_deref() != Some(identity.session_key.as_str())
        || record.questions.iter().any(|question| question.is_secret
            || question.secret_store.is_some() || question.secret_store_existing.is_some())
    {
        return Ok(None);
    }
    if bounded_gateway_text(Some(&Value::String(record.id.clone()))).is_err()
        || record.created_at_ms > 9_007_199_254_740_991
        || record.expires_at_ms > 9_007_199_254_740_991
        || record.questions.is_empty() || record.questions.len() > 3
        || record.run_id.as_ref().is_some_and(|id| bounded_gateway_text(Some(&Value::String(id.clone()))).is_err())
        || record.questions.iter().any(|question| !is_question_id(&question.question_id)
            || question.question.is_empty() || question.options.len() > 4 || question.options.len() == 1
            || question.options.iter().any(|option| option.label.is_empty()))
        || record.questions.iter().map(|question| &question.question_id).collect::<std::collections::HashSet<_>>().len() != record.questions.len()
    {
        return Err(InvalidGatewayRequest);
    }
    serde_json::to_value(record).map(Some).map_err(|_| InvalidGatewayRequest)
}

pub(crate) fn project_question_resolve_result(value: Value) -> Result<Value, InvalidGatewayRequest> {
    if value.get("status").and_then(Value::as_str) != Some("answered") {
        return Err(InvalidGatewayRequest);
    }
    let answers = value.get("answers").ok_or(InvalidGatewayRequest)?;
    if !is_question_answers(answers) {
        return Err(InvalidGatewayRequest);
    }
    Ok(json!({ "status": "answered", "answers": answers }))
}

fn bounded_gateway_text(value: Option<&Value>) -> Result<String, InvalidGatewayRequest> {
    let value = value.and_then(Value::as_str).ok_or(InvalidGatewayRequest)?;
    if value.trim().is_empty() || value.len() > 4_096 || value.chars().any(char::is_control) {
        return Err(InvalidGatewayRequest);
    }
    Ok(value.to_owned())
}

fn optional_bounded_gateway_text(value: Option<&Value>) -> Result<Option<String>, InvalidGatewayRequest> {
    value.map(|value| bounded_gateway_text(Some(value))).transpose()
}

fn is_question_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn is_question_answers(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(answers) = object.get("answers").and_then(Value::as_object) else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    answers.iter().all(|(key, value)| {
        is_question_id(key)
            && value.as_array().is_some_and(|answers| answers.iter().all(is_question_answer_text))
    })
}

fn is_question_answer_text(value: &Value) -> bool {
    value.is_string()
}
