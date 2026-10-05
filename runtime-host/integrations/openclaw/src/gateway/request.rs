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
    pub operation_id: String,
    pub session_key: String,
    pub view_id: String,
    pub standalone: Option<bool>,
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
    if !object.keys().all(|key| {
        matches!(
            key.as_str(),
            "operationId" | "sessionKey" | "viewId" | "standalone"
        )
    }) || !object.contains_key("operationId")
        || !object.contains_key("sessionKey")
        || !object.contains_key("viewId")
    {
        return Err(InvalidGatewayRequest);
    }
    let operation_id = bounded_gateway_text(object.get("operationId"))?;
    if !operation_id.starts_with("mcp.app.") {
        return Err(InvalidGatewayRequest);
    }
    Ok(OpenClawMcpAppGatewayRequest {
        operation_id,
        session_key: bounded_gateway_text(object.get("sessionKey"))?,
        view_id: bounded_gateway_text(object.get("viewId"))?,
        standalone: match object.get("standalone") {
            Some(value) => Some(value.as_bool().ok_or(InvalidGatewayRequest)?),
            None => None,
        },
    })
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
