use super::{
    model::{valid_agent_id, valid_uuid},
    rpc::Failure,
};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::{Value, json};
use sessions_module::state::{
    ItemStatus, MAX_ID_BYTES, MAX_SEGMENTS, MAX_TEXT_BYTES, MAX_TOOLS, OmissionReason,
    SessionContent, SessionItem, ToolPhase, ToolView,
};
mod stream;
pub(crate) use stream::Streaming;

/// The address identifies a candidate; callers must verify Server agent ownership.
pub fn parse_session_key(key: &str) -> Option<(&str, &str)> {
    let (agent, id) = key.strip_prefix("matcha-agent:")?.split_once(':')?;
    (valid_agent_id(agent) && valid_uuid(id)).then_some((agent, id))
}
pub fn session_ownership_key(
    endpoint: RuntimeEndpoint,
    _agent_id: &str,
    _session_key: &str,
    endpoint_session_id: &str,
) -> (RuntimeEndpoint, Option<String>, String) {
    (endpoint, None, endpoint_session_id.to_owned())
}

#[derive(Clone)]
pub(crate) struct Message {
    pub item: SessionItem,
    pub tools: Vec<ToolView>,
}
fn id(value: &str) -> Result<&str, Failure> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        Err(Failure::InvalidReadback)
    } else {
        Ok(value)
    }
}
pub(crate) fn prefix(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
pub(crate) fn block_text(block: &Value) -> String {
    if let Some(text) = block.as_str() {
        return text.to_owned();
    }
    if let Some(blocks) = block.as_array() {
        return blocks.iter().map(block_text).collect::<Vec<_>>().join("\n");
    }
    block
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn text_content(text: &str, uuid: &str, index: usize, thinking: bool) -> SessionContent {
    if text.len() > MAX_TEXT_BYTES {
        SessionContent::LargeText {
            text: prefix(text, MAX_TEXT_BYTES).to_owned(),
            content_ref: format!("native:{uuid}:{index}"),
            total_bytes: text.len() as u64,
            loaded_bytes: prefix(text, MAX_TEXT_BYTES).len() as u64,
        }
    } else if thinking {
        SessionContent::Thinking {
            text: text.to_owned(),
        }
    } else {
        SessionContent::Text {
            text: text.to_owned(),
        }
    }
}
fn payload(value: &Value) -> Option<Value> {
    serde_json::to_vec(value)
        .ok()
        .filter(|bytes| bytes.len() <= MAX_TEXT_BYTES && !bytes.contains(&0))
        .map(|_| value.clone())
}

pub(crate) fn trace_shape(row: &Value) -> Value {
    fn label(value: Option<&Value>, allowed: &[&'static str]) -> &'static str {
        match value.and_then(Value::as_str) {
            Some(value) => allowed
                .iter()
                .copied()
                .find(|label| *label == value)
                .unwrap_or("other"),
            None => "absent_or_invalid",
        }
    }
    fn hash(value: Option<&Value>) -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(platform::trace::identifier_hash)
    }
    let event = row.get("event");
    let content = row
        .pointer("/message/content")
        .or_else(|| row.get("content"));
    json!({
        "rowType": label(row.get("type"), &["stream_event", "assistant", "user", "system", "attachment"]),
        "eventType": label(event.and_then(|event| event.get("type")), &["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping", "error"]),
        "blockType": label(event.and_then(|event| event.pointer("/content_block/type")), &["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use", "tool_result", "image", "document"]),
        "deltaType": label(event.and_then(|event| event.pointer("/delta/type")), &["text_delta", "thinking_delta", "signature_delta", "input_json_delta"]),
        "index": event.and_then(|event| event.get("index")).and_then(Value::as_u64),
        "rowHash": hash(row.get("uuid")),
        "parentHash": hash(row.get("parent_tool_use_id")),
        "providerMessageHash": hash(row.pointer("/message/id").or_else(|| row.pointer("/event/message/id"))),
        "contentBlockCount": content.and_then(Value::as_array).map(Vec::len),
    })
}
fn rejected(row: &Value, reason: &'static str, event: Option<&crate::client::Event>) -> Failure {
    platform::trace::runtime_trace("matcha.session.projection.rejected", || {
        json!({
            "reason": reason,
            "row": trace_shape(row),
            "sessionHash": event.map(|event| platform::trace::identifier_hash(&event.session_id)),
            "nativeSeq": event.map(|event| event.seq),
        })
    });
    Failure::InvalidReadback
}

pub(crate) fn message(row: &Value, status: ItemStatus) -> Result<Option<Message>, Failure> {
    message_with_event(row, status, None)
}
fn message_with_event(
    row: &Value,
    status: ItemStatus,
    event: Option<&crate::client::Event>,
) -> Result<Option<Message>, Failure> {
    let rejected = |row: &Value, reason| rejected(row, reason, event);
    let kind = row
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| rejected(row, "message.type_invalid"))?;
    if !matches!(kind, "user" | "assistant" | "system" | "attachment") {
        return Ok(None);
    }
    // System status/init/state events have no transcript body and are not chat messages.
    if kind == "system" && row.get("message").is_none() && row.get("content").is_none() {
        return Ok(None);
    }
    let uuid = id(row
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or_else(|| rejected(row, "message.uuid_missing"))?)
    .map_err(|_| rejected(row, "message.uuid_invalid"))?;
    let body = row
        .pointer("/message/content")
        .or_else(|| row.get("content"))
        .unwrap_or(&Value::Null);
    let blocks = match body {
        Value::Array(blocks) => blocks.clone(),
        Value::String(text) => vec![json!({"type":"text","text":text})],
        Value::Null => Vec::new(),
        _ => return Err(rejected(row, "message.content_invalid")),
    };
    if blocks.len() > MAX_SEGMENTS {
        return Err(rejected(row, "message.segment_limit"));
    }
    let mut content = Vec::new();
    let mut tools = Vec::new();
    let mut text = String::new();
    for (index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let value = block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| rejected(row, "message.text_invalid"))?;
                text.push_str(prefix(value, MAX_TEXT_BYTES.saturating_sub(text.len())));
                content.push(text_content(value, uuid, index, false));
            }
            Some("thinking") => {
                let value = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .ok_or_else(|| rejected(row, "message.thinking_invalid"))?;
                content.push(text_content(value, uuid, index, true));
            }
            Some("redacted_thinking") => content.push(SessionContent::Omitted {
                reason: OmissionReason::Thinking,
            }),
            Some("tool_use" | "server_tool_use") => {
                let tool = id(block
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| rejected(row, "message.tool_id_missing"))?)
                .map_err(|_| rejected(row, "message.tool_id_invalid"))?
                .to_owned();
                let name = id(block
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| rejected(row, "message.tool_name_missing"))?)
                .map_err(|_| rejected(row, "message.tool_name_invalid"))?
                .to_owned();
                let input = block.get("input").and_then(payload);
                content.push(SessionContent::ToolUse {
                    name: name.clone(),
                    tool_call_id: tool.clone(),
                });
                tools.push(ToolView {
                    tool_call_id: tool,
                    run_id: None,
                    name: Some(name),
                    phase: ToolPhase::Started,
                    input,
                    input_text: None,
                    summary: None,
                    output: None,
                    details: None,
                    is_error: None,
                });
            }
            Some("tool_result") => {
                let tool = id(block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| rejected(row, "message.tool_result_id_missing"))?)
                .map_err(|_| rejected(row, "message.tool_result_id_invalid"))?
                .to_owned();
                let output = block.get("content").unwrap_or(&Value::Null);
                let summary = block_text(output);
                let error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                content.push(SessionContent::ToolResult {
                    tool_call_id: tool.clone(),
                    summary: Some(prefix(&summary, MAX_TEXT_BYTES).to_owned()),
                    is_error: error,
                });
                tools.push(ToolView {
                    tool_call_id: tool,
                    run_id: None,
                    name: None,
                    phase: if error {
                        ToolPhase::Failed
                    } else {
                        ToolPhase::Completed
                    },
                    input: None,
                    input_text: None,
                    summary: Some(prefix(&summary, MAX_TEXT_BYTES).to_owned()),
                    output: payload(output),
                    details: None,
                    is_error: Some(error),
                });
            }
            Some("image" | "document") => content.push(SessionContent::Omitted {
                reason: OmissionReason::UnsafeMedia,
            }),
            _ => content.push(SessionContent::Omitted {
                reason: OmissionReason::Unknown,
            }),
        }
    }
    let item = match kind {
        "assistant" => SessionItem::AssistantTurn {
            item_id: uuid.to_owned(),
            run_id: None,
            message_id: Some(uuid.to_owned()),
            status,
            segments: content,
            text,
        },
        "user" => SessionItem::UserMessage {
            item_id: uuid.to_owned(),
            message_id: Some(uuid.to_owned()),
            status,
            content,
            text,
        },
        _ => SessionItem::System {
            item_id: uuid.to_owned(),
            status,
            text,
        },
    };
    Ok(Some(Message { item, tools }))
}

pub(crate) fn merge_tool(tools: &mut Vec<ToolView>, incoming: ToolView) -> Result<(), Failure> {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.tool_call_id == incoming.tool_call_id)
    {
        if incoming.name.is_some() {
            tool.name = incoming.name;
        }
        if incoming.input.is_some() {
            tool.input = incoming.input;
        }
        if incoming.input_text.is_some() {
            tool.input_text = incoming.input_text;
        }
        if incoming.summary.is_some() {
            tool.summary = incoming.summary;
        }
        if incoming.output.is_some() {
            tool.output = incoming.output;
        }
        if incoming.is_error.is_some() {
            tool.is_error = incoming.is_error;
        }
        if matches!(incoming.phase, ToolPhase::Completed | ToolPhase::Failed)
            || !matches!(tool.phase, ToolPhase::Completed | ToolPhase::Failed)
        {
            tool.phase = incoming.phase;
        }
    } else {
        if tools.len() >= MAX_TOOLS {
            return Err(Failure::InvalidReadback);
        }
        tools.push(incoming);
    }
    Ok(())
}
