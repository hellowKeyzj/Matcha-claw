use serde_json::{Map, Value};

use crate::session::protocol::{ChatHistoryResult, HistoryRole};

use super::model::{
    Direction, Message, MessageContent, MessageRole, OmittedContentKind, PageRequest,
    SessionWindow, window_range,
};

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_METADATA_BYTES: usize = 8 * 1024;
const MAX_MEDIA_REF_BYTES: usize = 512;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryError {
    Malformed,
}

pub fn decode_window(payload: Value, request: PageRequest) -> Result<SessionWindow, HistoryError> {
    let messages = match decode_native_window(payload.clone()) {
        Ok(messages) => messages,
        Err(_) if is_text_history(&payload) => decode_text_history(payload)?,
        Err(error) => return Err(error),
    };
    let total_item_count = messages.len();
    let range = window_range(total_item_count, request);
    Ok(SessionWindow::new(
        messages[range.start()..range.end()].to_vec(),
        range,
        total_item_count,
    ))
}

fn decode_native_window(payload: Value) -> Result<Vec<Message>, HistoryError> {
    let envelope = object(payload)?;
    validate_envelope(&envelope)?;
    array(required(&envelope, "messages")?)?
        .iter()
        .map(decode_message)
        .collect()
}

fn is_text_history(payload: &Value) -> bool {
    payload
        .as_object()
        .and_then(|envelope| envelope.get("messages"))
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().all(|message| {
                message.as_object().is_some_and(|message| {
                    message.contains_key("text")
                        && message
                            .keys()
                            .all(|key| matches!(key.as_str(), "role" | "text"))
                })
            })
        })
}

fn decode_text_history(payload: Value) -> Result<Vec<Message>, HistoryError> {
    let history: ChatHistoryResult =
        serde_json::from_value(payload).map_err(|_| HistoryError::Malformed)?;
    Ok(history
        .messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| {
            let role = match message.role {
                HistoryRole::User => MessageRole::User,
                HistoryRole::Assistant => MessageRole::Assistant,
            };
            Message::new(
                role,
                message.text.clone(),
                vec![MessageContent::Text { text: message.text }],
                Some(format!("history:{index}")),
                None,
                None,
                None,
                None,
                Some(index as u64),
                None,
                None,
            )
        })
        .collect())
}

fn validate_envelope(envelope: &Map<String, Value>) -> Result<(), HistoryError> {
    optional_string(envelope, "sessionKey")?;
    optional_string(envelope, "sessionId")?;
    optional_string(envelope, "thinkingLevel")?;
    optional_bool(envelope, "fastMode")?;
    optional_string(envelope, "verboseLevel")?;
    Ok(())
}

fn decode_message(value: &Value) -> Result<Message, HistoryError> {
    let message = value.as_object().ok_or(HistoryError::Malformed)?;
    let role = decode_role(string(required(message, "role")?)?)?;
    let (text, content) = decode_content(required(message, "content")?, role)?;
    let message_id = optional_alias_string(message, "messageId", "id")?;
    let parent_id = optional_alias_string(message, "parentId", "parentMessageId")?;
    let origin = bounded_optional_string(message, "origin", MAX_METADATA_BYTES)?;
    let tool_call_id = bounded_optional_string(message, "toolCallId", MAX_METADATA_BYTES)?;
    let run_id = bounded_optional_string(message, "runId", MAX_METADATA_BYTES)?;
    let sequence = optional_alias_u64_pair(message, "seq", "sequence")?;
    if sequence.is_some_and(|value| value > MAX_SAFE_SEQUENCE) {
        return Err(HistoryError::Malformed);
    }
    let created_at = optional_created_at(message)?;
    let updated_at = optional_u64(message, "updatedAt")?;
    Ok(Message::new(
        role,
        text,
        content,
        message_id,
        parent_id,
        origin,
        tool_call_id,
        run_id,
        sequence,
        created_at,
        updated_at,
    ))
}

fn decode_role(role: &str) -> Result<MessageRole, HistoryError> {
    match role {
        "user" => Ok(MessageRole::User),
        "assistant" => Ok(MessageRole::Assistant),
        "system" => Ok(MessageRole::System),
        "toolResult" | "toolresult" | "tool_result" => Ok(MessageRole::ToolResult),
        _ => Err(HistoryError::Malformed),
    }
}

fn decode_content(
    value: &Value,
    role: MessageRole,
) -> Result<(String, Vec<MessageContent>), HistoryError> {
    let blocks = match value {
        Value::String(text) => {
            let text = bounded_text(text)?;
            return Ok((text.clone(), vec![MessageContent::Text { text }]));
        }
        Value::Array(blocks) => blocks,
        _ => return Err(HistoryError::Malformed),
    };
    let mut text_parts = Vec::new();
    let mut content = Vec::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            return Err(HistoryError::Malformed);
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = bounded_text(string(required(block, "text")?)?)?;
                text_parts.push(text.clone());
                content.push(MessageContent::Text { text });
            }
            Some("thinking") | Some("redacted_thinking") => {
                content.push(MessageContent::Omitted {
                    kind: OmittedContentKind::Thinking,
                });
            }
            Some("toolCall") | Some("tool_use") => {
                let name = bounded_string(
                    block.get("name").or_else(|| block.get("toolName")),
                    MAX_TOOL_NAME_BYTES,
                )?;
                let tool_call_id = bounded_optional_value_string(
                    block.get("id").or_else(|| block.get("toolCallId")),
                    MAX_METADATA_BYTES,
                )?;
                content.push(MessageContent::ToolUse { name, tool_call_id });
            }
            Some("toolResult") | Some("tool_result") => {
                let summary = block
                    .get("content")
                    .or_else(|| block.get("result"))
                    .and_then(safe_summary)
                    .transpose()?;
                let tool_name =
                    bounded_optional_value_string(block.get("toolName"), MAX_TOOL_NAME_BYTES)?;
                let tool_call_id =
                    bounded_optional_value_string(block.get("toolCallId"), MAX_METADATA_BYTES)?;
                let is_error = optional_value_bool(block, "isError")?;
                content.push(MessageContent::ToolResult {
                    tool_name,
                    tool_call_id,
                    summary,
                    is_error,
                });
            }
            Some("image") | Some("media") => {
                let media_type = bounded_optional_value_string(
                    block.get("mimeType").or_else(|| block.get("mediaType")),
                    MAX_METADATA_BYTES,
                )?;
                let reference = bounded_optional_value_string(
                    block
                        .get("ref")
                        .or_else(|| block.get("reference"))
                        .or_else(|| block.get("viewId")),
                    MAX_MEDIA_REF_BYTES,
                )?;
                let bytes = block.get("data").and_then(Value::as_str).map(str::len);
                let unsafe_media = bytes.is_some() || reference.is_none();
                content.push(MessageContent::Media {
                    media_type,
                    reference,
                    bytes,
                });
                if unsafe_media {
                    content.push(MessageContent::Omitted {
                        kind: OmittedContentKind::UnsafeMedia,
                    });
                }
            }
            Some(_) | None => content.push(MessageContent::Omitted {
                kind: OmittedContentKind::Unknown,
            }),
        }
    }
    if content.is_empty() && role != MessageRole::ToolResult {
        return Err(HistoryError::Malformed);
    }
    let text = bounded_text(&text_parts.join("\n"))?;
    Ok((text, content))
}

fn safe_summary(value: &Value) -> Option<Result<String, HistoryError>> {
    match value {
        Value::String(text) => Some(bounded_text(text)),
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\\n");
            Some(bounded_text(&text))
        }
        Value::Object(object)
            if object
                .keys()
                .all(|key| matches!(key.as_str(), "text" | "type")) =>
        {
            object.get("text").and_then(Value::as_str).map(bounded_text)
        }
        _ => None,
    }
}

fn bounded_text(text: &str) -> Result<String, HistoryError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(HistoryError::Malformed);
    }
    Ok(text.to_owned())
}

fn bounded_string(value: Option<&Value>, limit: usize) -> Result<String, HistoryError> {
    let value = value.ok_or(HistoryError::Malformed)?;
    let text = string(value)?;
    if text.is_empty() || text.len() > limit {
        return Err(HistoryError::Malformed);
    }
    Ok(text.to_owned())
}

fn bounded_optional_string(
    object: &Map<String, Value>,
    field: &str,
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    object
        .get(field)
        .map(|value| bounded_string(Some(value), limit))
        .transpose()
}

fn bounded_optional_value_string(
    value: Option<&Value>,
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    value
        .map(|value| bounded_string(Some(value), limit))
        .transpose()
}

fn optional_value_bool(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, HistoryError> {
    object
        .get(field)
        .map(|value| value.as_bool().ok_or(HistoryError::Malformed))
        .transpose()
}

fn optional_alias_u64_pair(
    object: &Map<String, Value>,
    first: &str,
    second: &str,
) -> Result<Option<u64>, HistoryError> {
    let first = optional_u64(object, first)?;
    let second = optional_u64(object, second)?;
    match (first, second) {
        (Some(_), Some(_)) => Err(HistoryError::Malformed),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn object(value: Value) -> Result<Map<String, Value>, HistoryError> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(HistoryError::Malformed),
    }
}

fn array(value: &Value) -> Result<&Vec<Value>, HistoryError> {
    match value {
        Value::Array(values) => Ok(values),
        _ => Err(HistoryError::Malformed),
    }
}

fn required<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a Value, HistoryError> {
    object.get(field).ok_or(HistoryError::Malformed)
}

fn string(value: &Value) -> Result<&str, HistoryError> {
    value.as_str().ok_or(HistoryError::Malformed)
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, HistoryError> {
    object
        .get(field)
        .map(|value| string(value).map(str::to_owned))
        .transpose()
}

fn optional_bool(object: &Map<String, Value>, field: &str) -> Result<Option<bool>, HistoryError> {
    object
        .get(field)
        .map(|value| value.as_bool().ok_or(HistoryError::Malformed))
        .transpose()
}

fn optional_alias_string(
    object: &Map<String, Value>,
    first: &str,
    second: &str,
) -> Result<Option<String>, HistoryError> {
    let first = optional_string(object, first)?;
    let second = optional_string(object, second)?;
    match (first, second) {
        (Some(_), Some(_)) => Err(HistoryError::Malformed),
        (Some(first), None) => Ok(Some(first)),
        (None, second) => Ok(second),
    }
}

fn optional_created_at(object: &Map<String, Value>) -> Result<Option<u64>, HistoryError> {
    optional_alias_u64(object, "createdAt", "timestamp", "ts")
}

fn optional_u64(object: &Map<String, Value>, field: &str) -> Result<Option<u64>, HistoryError> {
    object
        .get(field)
        .map(|value| value.as_u64().ok_or(HistoryError::Malformed))
        .transpose()
}

fn optional_alias_u64(
    object: &Map<String, Value>,
    first: &str,
    second: &str,
    third: &str,
) -> Result<Option<u64>, HistoryError> {
    let values = [
        optional_u64(object, first)?,
        optional_u64(object, second)?,
        optional_u64(object, third)?,
    ];
    if values.into_iter().flatten().count() > 1 {
        return Err(HistoryError::Malformed);
    }
    Ok(values.into_iter().flatten().next())
}

pub fn direction(value: &str) -> Option<Direction> {
    match value {
        "latest" => Some(Direction::Latest),
        "older" => Some(Direction::Older),
        "newer" => Some(Direction::Newer),
        _ => None,
    }
}
