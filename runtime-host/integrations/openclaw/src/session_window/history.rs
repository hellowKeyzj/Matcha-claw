use serde_json::{Map, Value};

use crate::session::protocol::{ChatHistoryResult, HistoryRole};

use super::model::{
    Direction, Message, MessageContent, MessageRole, MessageToolDeliveryMedia, OmittedContentKind,
    PageRequest, SessionWindow, window_range,
};

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_TOOL_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_METADATA_BYTES: usize = 8 * 1024;
const MAX_MEDIA_REF_BYTES: usize = 512;
const MAX_DELIVERY_MEDIA_REF_BYTES: usize = 256;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const MESSAGE_TOOL_NAME: &str = "message";
const OUTGOING_MEDIA_PREFIX: &str = "/api/chat/media/outgoing/";
const OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH: &str = "api/chat/media/outgoing/";
const TOOL_CALL_BLOCK_TYPES: &[&str] = &[
    "toolCall",
    "toolUse",
    "functionCall",
    "tool_call",
    "tool_use",
    "function_call",
];
const TOOL_RESULT_BLOCK_TYPES: &[&str] = &["toolResult", "tool_result"];
const TOOL_NAME_FIELDS: &[&str] = &["name", "toolName"];
const ROLE_TOOL_NAME_FIELDS: &[&str] = &["toolName", "name"];
const TOOL_CALL_ID_FIELDS: &[&str] = &[
    "id",
    "call_id",
    "toolCallId",
    "toolUseId",
    "tool_call_id",
    "tool_use_id",
];
const ROLE_TOOL_CALL_ID_FIELDS: &[&str] = &[
    "toolCallId",
    "toolUseId",
    "tool_call_id",
    "tool_use_id",
    "call_id",
];
const TOOL_INPUT_FIELDS: &[&str] = &["args", "arguments", "input", "toolInput", "tool_input"];
const TOOL_RESULT_OUTPUT_FIELDS: &[&str] = &[
    "result",
    "output",
    "partialResult",
    "partial_result",
    "content",
];
const TOOL_RESULT_SUMMARY_FIELDS: &[&str] = &["summary", "content", "text"];
const TOOL_ERROR_FIELDS: &[&str] = &["isError", "is_error"];
const TOOL_NAME_FIELD: &str = "name|toolName";
const TOOL_CALL_ID_FIELD: &str = "id|call_id|toolCallId|toolUseId|tool_call_id|tool_use_id";
const ROLE_TOOL_CALL_ID_FIELD: &str = "toolCallId|toolUseId|tool_call_id|tool_use_id|call_id";
const TOOL_ERROR_FIELD: &str = "isError|is_error";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryDiagnostic {
    message_index: Option<usize>,
    block_index: Option<usize>,
    field: &'static str,
    reason: &'static str,
    actual: &'static str,
}

impl HistoryDiagnostic {
    const fn new(
        message_index: Option<usize>,
        block_index: Option<usize>,
        field: &'static str,
        reason: &'static str,
        actual: &'static str,
    ) -> Self {
        Self {
            message_index,
            block_index,
            field,
            reason,
            actual,
        }
    }

    pub const fn message_index(self) -> Option<usize> {
        self.message_index
    }

    pub const fn block_index(self) -> Option<usize> {
        self.block_index
    }

    pub const fn field(self) -> &'static str {
        self.field
    }

    pub const fn reason(self) -> &'static str {
        self.reason
    }

    pub const fn actual(self) -> &'static str {
        self.actual
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryError {
    diagnostic: HistoryDiagnostic,
}

impl HistoryError {
    pub const fn malformed() -> Self {
        Self {
            diagnostic: HistoryDiagnostic::new(None, None, "payload", "malformed", "unknown"),
        }
    }

    const fn new(diagnostic: HistoryDiagnostic) -> Self {
        Self { diagnostic }
    }

    pub const fn diagnostic(self) -> HistoryDiagnostic {
        self.diagnostic
    }
}

fn payload_error(field: &'static str, reason: &'static str, actual: &'static str) -> HistoryError {
    HistoryError::new(HistoryDiagnostic::new(None, None, field, reason, actual))
}

fn message_error(
    message_index: usize,
    field: &'static str,
    reason: &'static str,
    actual: &'static str,
) -> HistoryError {
    HistoryError::new(HistoryDiagnostic::new(
        Some(message_index),
        None,
        field,
        reason,
        actual,
    ))
}

fn block_error(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    reason: &'static str,
    actual: &'static str,
) -> HistoryError {
    HistoryError::new(HistoryDiagnostic::new(
        Some(message_index),
        Some(block_index),
        field,
        reason,
        actual,
    ))
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub fn decode_window(payload: Value, request: PageRequest) -> Result<SessionWindow, HistoryError> {
    let envelope = payload.as_object().cloned();
    let session_key = envelope
        .as_ref()
        .map(|envelope| optional_string(envelope, "sessionKey"))
        .transpose()?
        .flatten()
        .filter(|value| !value.is_empty());
    let native_session_id = envelope
        .as_ref()
        .map(|envelope| optional_string(envelope, "sessionId"))
        .transpose()?
        .flatten()
        .filter(|value| !value.is_empty());
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
        session_key,
        native_session_id,
    ))
}

fn decode_native_window(payload: Value) -> Result<Vec<Message>, HistoryError> {
    let envelope = match payload {
        Value::Object(envelope) => envelope,
        value => {
            return Err(payload_error(
                "payload",
                "expected_object",
                value_kind(&value),
            ));
        }
    };
    validate_envelope(&envelope)?;
    let Some(messages) = envelope.get("messages") else {
        return Err(payload_error("messages", "missing", "missing"));
    };
    let messages = match messages {
        Value::Array(messages) => messages,
        value => {
            return Err(payload_error(
                "messages",
                "expected_array",
                value_kind(value),
            ));
        }
    };
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| decode_message(index, message))
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
        serde_json::from_value(payload).map_err(|_| HistoryError::malformed())?;
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
    for field in ["sessionKey", "sessionId", "thinkingLevel", "verboseLevel"] {
        if let Some(value) = envelope.get(field) {
            if !value.is_string() {
                return Err(payload_error(field, "expected_string", value_kind(value)));
            }
        }
    }
    if let Some(value) = envelope.get("fastMode") {
        if !value.is_boolean() {
            return Err(payload_error(
                "fastMode",
                "expected_boolean",
                value_kind(value),
            ));
        }
    }
    Ok(())
}

fn decode_message(index: usize, value: &Value) -> Result<Message, HistoryError> {
    let message = value
        .as_object()
        .ok_or_else(|| message_error(index, "message", "expected_object", value_kind(value)))?;
    let role_value = required_message(message, index, "role")?;
    let role = decode_role(index, string_message(role_value, index, "role")?)?;
    let (text, mut content) = decode_content(index, required_message(message, index, "content")?)?;
    let message_id = optional_alias_string_message(message, index, "messageId", "id")?;
    let parent_id = optional_alias_string_message(message, index, "parentId", "parentMessageId")?;
    let origin = bounded_optional_string_message(message, index, "origin", MAX_METADATA_BYTES)?;
    let tool_call_id = bounded_optional_alias_string_message(
        message,
        index,
        ROLE_TOOL_CALL_ID_FIELD,
        ROLE_TOOL_CALL_ID_FIELDS,
        MAX_METADATA_BYTES,
    )?;
    if role == MessageRole::ToolResult && !has_tool_result_content(&content) {
        append_role_tool_result_content(
            message,
            index,
            &text,
            tool_call_id.as_deref(),
            &mut content,
        )?;
    }
    if role == MessageRole::ToolResult {
        if let Some(delivery) = decode_message_tool_delivery(message, &text, &content) {
            content.push(delivery);
        }
    }
    let run_id = bounded_optional_string_message(message, index, "runId", MAX_METADATA_BYTES)?;
    let sequence = optional_alias_u64_pair_message(message, index, "seq", "sequence")?;
    if sequence.is_some_and(|value| value > MAX_SAFE_SEQUENCE) {
        return Err(message_error(
            index,
            "seq",
            "exceeds_safe_integer",
            "number",
        ));
    }
    let created_at = optional_created_at_message(message, index)?;
    let updated_at = optional_u64_message(message, index, "updatedAt")?;
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

fn decode_role(index: usize, role: &str) -> Result<MessageRole, HistoryError> {
    match role {
        "user" => Ok(MessageRole::User),
        "assistant" => Ok(MessageRole::Assistant),
        "system" => Ok(MessageRole::System),
        "toolResult" | "toolresult" | "tool_result" => Ok(MessageRole::ToolResult),
        _ => Err(message_error(index, "role", "unsupported_role", "string")),
    }
}

fn decode_content(
    message_index: usize,
    value: &Value,
) -> Result<(String, Vec<MessageContent>), HistoryError> {
    let blocks = match value {
        Value::String(text) => {
            let text = bounded_message_text(message_index, "content", text)?;
            return Ok((text.clone(), vec![MessageContent::Text { text }]));
        }
        Value::Array(blocks) => blocks,
        value => {
            return Err(message_error(
                message_index,
                "content",
                "expected_string_or_array",
                value_kind(value),
            ));
        }
    };
    let mut text_parts = Vec::new();
    let mut content = Vec::new();
    for (block_index, block) in blocks.iter().enumerate() {
        let Some(block) = block.as_object() else {
            return Err(block_error(
                message_index,
                block_index,
                "content[]",
                "expected_object",
                value_kind(block),
            ));
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text_value = required_block(block, message_index, block_index, "text")?;
                let text = bounded_block_text(
                    message_index,
                    block_index,
                    "text",
                    string_block(text_value, message_index, block_index, "text")?,
                )?;
                text_parts.push(text.clone());
                content.push(MessageContent::Text { text });
            }
            Some("thinking") | Some("redacted_thinking") => {
                content.push(MessageContent::Omitted {
                    kind: OmittedContentKind::Thinking,
                });
            }
            Some(block_type) if TOOL_CALL_BLOCK_TYPES.contains(&block_type) => {
                let name = bounded_required_block_alias_string(
                    message_index,
                    block_index,
                    TOOL_NAME_FIELD,
                    block,
                    TOOL_NAME_FIELDS,
                    MAX_TOOL_NAME_BYTES,
                )?;
                let tool_call_id = bounded_optional_block_alias_string(
                    message_index,
                    block_index,
                    TOOL_CALL_ID_FIELD,
                    block,
                    TOOL_CALL_ID_FIELDS,
                    MAX_METADATA_BYTES,
                )?;
                let input = tool_payload(block, TOOL_INPUT_FIELDS);
                let input_text = tool_input_text(block, input.as_ref());
                content.push(MessageContent::ToolUse {
                    name,
                    tool_call_id,
                    input,
                    input_text,
                });
            }
            Some(block_type) if TOOL_RESULT_BLOCK_TYPES.contains(&block_type) => {
                let output_value = first_alias_value(block, TOOL_RESULT_OUTPUT_FIELDS);
                let summary = first_alias_value(block, TOOL_RESULT_SUMMARY_FIELDS)
                    .or(output_value)
                    .and_then(safe_summary)
                    .transpose()?;
                let output = output_value.and_then(project_tool_payload);
                let tool_name = bounded_optional_block_alias_string(
                    message_index,
                    block_index,
                    TOOL_NAME_FIELD,
                    block,
                    ROLE_TOOL_NAME_FIELDS,
                    MAX_TOOL_NAME_BYTES,
                )?;
                let tool_call_id = bounded_optional_block_alias_string(
                    message_index,
                    block_index,
                    TOOL_CALL_ID_FIELD,
                    block,
                    TOOL_CALL_ID_FIELDS,
                    MAX_METADATA_BYTES,
                )?;
                let is_error = optional_block_alias_bool(
                    message_index,
                    block_index,
                    block,
                    TOOL_ERROR_FIELD,
                    TOOL_ERROR_FIELDS,
                )?;
                content.push(MessageContent::ToolResult {
                    tool_name,
                    tool_call_id,
                    summary,
                    output,
                    is_error,
                });
            }
            Some("image") | Some("media") => {
                let media_type = bounded_optional_block_string(
                    message_index,
                    block_index,
                    "mimeType|mediaType",
                    block.get("mimeType").or_else(|| block.get("mediaType")),
                    MAX_METADATA_BYTES,
                )?;
                let reference = bounded_optional_block_string(
                    message_index,
                    block_index,
                    "ref|reference|viewId",
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
    let text = bounded_message_text(message_index, "content", &text_parts.join("\n"))?;
    Ok((text, content))
}

fn has_tool_result_content(content: &[MessageContent]) -> bool {
    content
        .iter()
        .any(|content| matches!(content, MessageContent::ToolResult { .. }))
}

fn append_role_tool_result_content(
    message: &Map<String, Value>,
    message_index: usize,
    text: &str,
    tool_call_id: Option<&str>,
    content: &mut Vec<MessageContent>,
) -> Result<(), HistoryError> {
    let tool_name = bounded_optional_alias_string_message(
        message,
        message_index,
        TOOL_NAME_FIELD,
        ROLE_TOOL_NAME_FIELDS,
        MAX_TOOL_NAME_BYTES,
    )?;
    let is_error =
        optional_alias_bool_message(message, message_index, TOOL_ERROR_FIELD, TOOL_ERROR_FIELDS)?;
    let output_value = first_alias_value(message, &["result", "output", "content"]);
    let output = output_value.and_then(project_tool_payload);
    content.push(MessageContent::ToolResult {
        tool_name,
        tool_call_id: tool_call_id.map(str::to_owned),
        summary: non_empty_summary(text),
        output,
        is_error,
    });
    Ok(())
}

fn decode_message_tool_delivery(
    message: &Map<String, Value>,
    text: &str,
    content: &[MessageContent],
) -> Option<MessageContent> {
    if message_tool_result_is_error(message)
        || content.iter().any(|content| {
            matches!(
                content,
                MessageContent::ToolResult {
                    is_error: Some(true),
                    ..
                }
            )
        })
        || !is_message_tool_result(message, content)
    {
        return None;
    }
    if let Some(delivery) = message
        .get("details")
        .and_then(Value::as_object)
        .and_then(extract_message_tool_delivery)
    {
        return Some(delivery);
    }
    if let Some(delivery) = message_content_delivery(message) {
        return Some(delivery);
    }
    for block in content {
        let MessageContent::ToolResult {
            output: Some(output),
            ..
        } = block
        else {
            continue;
        };
        if let Some(delivery) =
            tool_result_output_details(output).and_then(extract_message_tool_delivery)
        {
            return Some(delivery);
        }
    }
    let parsed = parse_message_tool_delivery_text(text)?;
    match parsed {
        Value::Object(object) => {
            tool_result_output_details_object(&object).and_then(extract_message_tool_delivery)
        }
        _ => None,
    }
}

fn is_message_tool_result(message: &Map<String, Value>, content: &[MessageContent]) -> bool {
    first_alias_value(message, ROLE_TOOL_NAME_FIELDS)
        .and_then(Value::as_str)
        .is_some_and(is_message_tool_name)
        || content.iter().any(|content| {
            matches!(content, MessageContent::ToolResult { tool_name: Some(tool_name), .. } if is_message_tool_name(tool_name))
        })
}

fn message_content_delivery(message: &Map<String, Value>) -> Option<MessageContent> {
    let content = message.get("content")?.as_array()?;
    for block in content.iter().filter_map(Value::as_object) {
        if !block
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|block_type| TOOL_RESULT_BLOCK_TYPES.contains(&block_type))
        {
            continue;
        }
        if let Some(delivery) = block
            .get("details")
            .and_then(Value::as_object)
            .and_then(extract_message_tool_delivery)
        {
            return Some(delivery);
        }
        if let Some(delivery) = first_alias_value(block, TOOL_RESULT_OUTPUT_FIELDS)
            .and_then(tool_result_output_details)
            .and_then(extract_message_tool_delivery)
        {
            return Some(delivery);
        }
    }
    None
}

fn is_message_tool_name(value: &str) -> bool {
    value.eq_ignore_ascii_case(MESSAGE_TOOL_NAME)
}

fn message_tool_result_is_error(message: &Map<String, Value>) -> bool {
    TOOL_ERROR_FIELDS
        .iter()
        .find_map(|field| message.get(*field))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn tool_result_output_details(value: &Value) -> Option<&Map<String, Value>> {
    let object = value.as_object()?;
    tool_result_output_details_object(object)
}

fn tool_result_output_details_object(object: &Map<String, Value>) -> Option<&Map<String, Value>> {
    object
        .get("details")
        .and_then(Value::as_object)
        .or(Some(object))
}

fn parse_message_tool_delivery_text(text: &str) -> Option<Value> {
    let text = text.trim();
    if text.len() > MAX_TOOL_PAYLOAD_BYTES || text.contains('\0') || !text.starts_with('{') {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn extract_message_tool_delivery(details: &Map<String, Value>) -> Option<MessageContent> {
    if details_status_is_error(details) || !is_internal_source_reply(details) {
        return None;
    }
    let source_reply = details.get("sourceReply").and_then(Value::as_object);
    let text = source_reply
        .and_then(delivery_text)
        .or_else(|| delivery_text(details));
    let mut media = Vec::new();
    if let Some(source_reply) = source_reply {
        collect_delivery_media(source_reply, &mut media);
    }
    collect_delivery_media(details, &mut media);
    details
        .get("media")
        .and_then(Value::as_object)
        .map(|media_details| collect_delivery_media(media_details, &mut media));
    if text.is_none() && media.is_empty() {
        return None;
    }
    Some(MessageContent::MessageToolDelivery { text, media })
}

fn details_status_is_error(details: &Map<String, Value>) -> bool {
    details
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status.eq_ignore_ascii_case("error"))
        || details
            .get("isError")
            .or_else(|| details.get("is_error"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn is_internal_source_reply(details: &Map<String, Value>) -> bool {
    details
        .get("sourceReplySink")
        .and_then(Value::as_str)
        .is_some_and(|sink| sink == "internal-ui")
        || details
            .get("sourceReplyDeliveryMode")
            .and_then(Value::as_str)
            .is_some_and(|mode| mode == "message_tool_only")
}

fn delivery_text(object: &Map<String, Value>) -> Option<String> {
    ["text", "message"].into_iter().find_map(|field| {
        let text = object.get(field)?.as_str()?.trim();
        (!text.is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0'))
            .then(|| text.to_owned())
    })
}

fn collect_delivery_media(object: &Map<String, Value>, media: &mut Vec<MessageToolDeliveryMedia>) {
    for field in ["media", "mediaUrl", "url", "fileUrl", "filePath", "path"] {
        if let Some(reference) = object.get(field).and_then(Value::as_str) {
            push_delivery_media(media, object, reference);
        }
    }
    if let Some(values) = object.get("mediaUrls").and_then(Value::as_array) {
        for value in values {
            if let Some(reference) = value.as_str() {
                push_delivery_media(media, object, reference);
            }
        }
    }
    if let Some(attachments) = object.get("attachments").and_then(Value::as_array) {
        for attachment in attachments.iter().filter_map(Value::as_object) {
            collect_delivery_media(attachment, media);
        }
    }
}

fn push_delivery_media(
    media: &mut Vec<MessageToolDeliveryMedia>,
    object: &Map<String, Value>,
    reference: &str,
) {
    let Some(reference) = safe_delivery_media_reference(reference) else {
        return;
    };
    if media.iter().any(|media| media.reference() == reference) {
        return;
    }
    let media_type = explicit_media_type(object).or_else(|| infer_media_type(&reference));
    media.push(MessageToolDeliveryMedia::new(media_type, reference));
}

fn safe_delivery_media_reference(reference: &str) -> Option<String> {
    let value = reference.trim();
    if value.is_empty()
        || value.len() > MAX_DELIVERY_MEDIA_REF_BYTES
        || value.chars().any(char::is_control)
    {
        return None;
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX) {
        return Some(value.to_owned());
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH) {
        return Some(format!("/{value}"));
    }
    (value.starts_with("https://") || value.starts_with("http://")).then(|| value.to_owned())
}

fn explicit_media_type(object: &Map<String, Value>) -> Option<String> {
    ["mimeType", "mediaType"]
        .into_iter()
        .find_map(|field| object.get(field).and_then(Value::as_str))
        .and_then(|value| {
            let value = value.trim();
            (!value.is_empty()
                && value.len() <= MAX_TOOL_NAME_BYTES
                && !value.chars().any(char::is_control))
            .then(|| value.to_owned())
        })
}

fn infer_media_type(reference: &str) -> Option<String> {
    let path = reference.split(['?', '#']).next().unwrap_or(reference);
    let lower = path.to_ascii_lowercase();
    let media_type = if lower.ends_with(".svg") || lower.ends_with(".svgz") {
        "image/svg+xml"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else if is_outgoing_media_reference(reference) {
        "image/png"
    } else {
        return None;
    };
    Some(media_type.to_owned())
}

fn is_outgoing_media_reference(reference: &str) -> bool {
    reference.starts_with(OUTGOING_MEDIA_PREFIX) || reference.contains(OUTGOING_MEDIA_PREFIX)
}

fn non_empty_summary(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| text.to_owned())
}

fn first_alias_value<'a>(
    object: &'a Map<String, Value>,
    fields: &[&'static str],
) -> Option<&'a Value> {
    fields.iter().find_map(|field| object.get(*field))
}

fn bounded_optional_alias_string_message(
    object: &Map<String, Value>,
    message_index: usize,
    field: &'static str,
    fields: &[&'static str],
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    first_alias_value(object, fields)
        .map(|value| bounded_string_message(value, message_index, field, limit))
        .transpose()
}

fn bounded_required_block_alias_string(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    object: &Map<String, Value>,
    fields: &[&'static str],
    limit: usize,
) -> Result<String, HistoryError> {
    let value = first_alias_value(object, fields);
    bounded_block_string(message_index, block_index, field, value, limit)
}

fn bounded_optional_block_alias_string(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    object: &Map<String, Value>,
    fields: &[&'static str],
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    first_alias_value(object, fields)
        .map(|value| bounded_block_string(message_index, block_index, field, Some(value), limit))
        .transpose()
}

fn optional_alias_bool_message(
    object: &Map<String, Value>,
    message_index: usize,
    field: &'static str,
    fields: &[&'static str],
) -> Result<Option<bool>, HistoryError> {
    first_alias_value(object, fields)
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                message_error(message_index, field, "expected_boolean", value_kind(value))
            })
        })
        .transpose()
}

fn optional_block_alias_bool(
    message_index: usize,
    block_index: usize,
    object: &Map<String, Value>,
    field: &'static str,
    fields: &[&'static str],
) -> Result<Option<bool>, HistoryError> {
    first_alias_value(object, fields)
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                block_error(
                    message_index,
                    block_index,
                    field,
                    "expected_boolean",
                    value_kind(value),
                )
            })
        })
        .transpose()
}

fn required_message<'a>(
    object: &'a Map<String, Value>,
    message_index: usize,
    field: &'static str,
) -> Result<&'a Value, HistoryError> {
    object
        .get(field)
        .ok_or_else(|| message_error(message_index, field, "missing", "missing"))
}

fn string_message<'a>(
    value: &'a Value,
    message_index: usize,
    field: &'static str,
) -> Result<&'a str, HistoryError> {
    value
        .as_str()
        .ok_or_else(|| message_error(message_index, field, "expected_string", value_kind(value)))
}

fn bounded_message_text(
    message_index: usize,
    field: &'static str,
    text: &str,
) -> Result<String, HistoryError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(message_error(
            message_index,
            field,
            "text_too_large",
            "string",
        ));
    }
    Ok(text.to_owned())
}

fn bounded_optional_string_message(
    object: &Map<String, Value>,
    message_index: usize,
    field: &'static str,
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    object
        .get(field)
        .map(|value| bounded_string_message(value, message_index, field, limit))
        .transpose()
}

fn bounded_string_message(
    value: &Value,
    message_index: usize,
    field: &'static str,
    limit: usize,
) -> Result<String, HistoryError> {
    let text = string_message(value, message_index, field)?;
    if text.is_empty() {
        return Err(message_error(
            message_index,
            field,
            "empty_string",
            "string",
        ));
    }
    if text.len() > limit {
        return Err(message_error(
            message_index,
            field,
            "string_too_large",
            "string",
        ));
    }
    Ok(text.to_owned())
}

fn optional_alias_string_message(
    object: &Map<String, Value>,
    message_index: usize,
    first: &'static str,
    second: &'static str,
) -> Result<Option<String>, HistoryError> {
    let first_value = object
        .get(first)
        .map(|value| string_message(value, message_index, first).map(str::to_owned))
        .transpose()?;
    let second_value = object
        .get(second)
        .map(|value| string_message(value, message_index, second).map(str::to_owned))
        .transpose()?;
    match (first_value, second_value) {
        (Some(_), Some(_)) => Err(message_error(
            message_index,
            first,
            "alias_conflict",
            "string",
        )),
        (Some(first_value), None) => Ok(Some(first_value)),
        (None, second_value) => Ok(second_value),
    }
}

fn optional_u64_message(
    object: &Map<String, Value>,
    message_index: usize,
    field: &'static str,
) -> Result<Option<u64>, HistoryError> {
    object
        .get(field)
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                message_error(message_index, field, "expected_u64", value_kind(value))
            })
        })
        .transpose()
}

fn optional_alias_u64_pair_message(
    object: &Map<String, Value>,
    message_index: usize,
    first: &'static str,
    second: &'static str,
) -> Result<Option<u64>, HistoryError> {
    let first_value = optional_u64_message(object, message_index, first)?;
    let second_value = optional_u64_message(object, message_index, second)?;
    match (first_value, second_value) {
        (Some(_), Some(_)) => Err(message_error(
            message_index,
            first,
            "alias_conflict",
            "number",
        )),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn optional_created_at_message(
    object: &Map<String, Value>,
    message_index: usize,
) -> Result<Option<u64>, HistoryError> {
    let values = [
        optional_u64_message(object, message_index, "createdAt")?,
        optional_u64_message(object, message_index, "timestamp")?,
        optional_u64_message(object, message_index, "ts")?,
    ];
    if values.into_iter().flatten().count() > 1 {
        return Err(message_error(
            message_index,
            "createdAt|timestamp|ts",
            "alias_conflict",
            "number",
        ));
    }
    Ok(values.into_iter().flatten().next())
}

fn required_block<'a>(
    object: &'a Map<String, Value>,
    message_index: usize,
    block_index: usize,
    field: &'static str,
) -> Result<&'a Value, HistoryError> {
    object
        .get(field)
        .ok_or_else(|| block_error(message_index, block_index, field, "missing", "missing"))
}

fn string_block<'a>(
    value: &'a Value,
    message_index: usize,
    block_index: usize,
    field: &'static str,
) -> Result<&'a str, HistoryError> {
    value.as_str().ok_or_else(|| {
        block_error(
            message_index,
            block_index,
            field,
            "expected_string",
            value_kind(value),
        )
    })
}

fn bounded_block_text(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    text: &str,
) -> Result<String, HistoryError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(block_error(
            message_index,
            block_index,
            field,
            "text_too_large",
            "string",
        ));
    }
    Ok(text.to_owned())
}

fn bounded_block_string(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    value: Option<&Value>,
    limit: usize,
) -> Result<String, HistoryError> {
    let value = value
        .ok_or_else(|| block_error(message_index, block_index, field, "missing", "missing"))?;
    let text = string_block(value, message_index, block_index, field)?;
    if text.is_empty() {
        return Err(block_error(
            message_index,
            block_index,
            field,
            "empty_string",
            "string",
        ));
    }
    if text.len() > limit {
        return Err(block_error(
            message_index,
            block_index,
            field,
            "string_too_large",
            "string",
        ));
    }
    Ok(text.to_owned())
}

fn bounded_optional_block_string(
    message_index: usize,
    block_index: usize,
    field: &'static str,
    value: Option<&Value>,
    limit: usize,
) -> Result<Option<String>, HistoryError> {
    value
        .map(|value| bounded_block_string(message_index, block_index, field, Some(value), limit))
        .transpose()
}

fn tool_payload(object: &Map<String, Value>, fields: &[&'static str]) -> Option<Value> {
    first_alias_value(object, fields).and_then(project_tool_payload)
}

fn project_tool_payload(value: &Value) -> Option<Value> {
    if !is_allowed_tool_payload(value) || tool_payload_contains_nul(value) {
        return None;
    }
    let text = serde_json::to_string(value).ok()?;
    (text.len() <= MAX_TOOL_PAYLOAD_BYTES).then(|| value.clone())
}

fn is_allowed_tool_payload(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
        Value::Array(values) => values.iter().all(is_allowed_tool_payload),
        Value::Object(object) => object.values().all(is_allowed_tool_payload),
    }
}

fn tool_payload_contains_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(values) => values.iter().any(tool_payload_contains_nul),
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| key.contains('\0') || tool_payload_contains_nul(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn tool_input_text(object: &Map<String, Value>, input: Option<&Value>) -> Option<String> {
    if let Some(text) = first_alias_value(
        object,
        &[
            "input_text",
            "inputText",
            "partialText",
            "partial_text",
            "partial_json",
            "partialJson",
        ],
    )
    .and_then(Value::as_str)
    .filter(|text| !text.is_empty())
    {
        return bounded_tool_payload_text(text);
    }
    match input? {
        Value::String(text) if !text.is_empty() => bounded_tool_payload_text(text),
        value => {
            let text = serde_json::to_string_pretty(value).ok()?;
            (!text.is_empty())
                .then(|| bounded_tool_payload_text(&text))
                .flatten()
        }
    }
}

fn bounded_tool_payload_text(text: &str) -> Option<String> {
    (text.len() <= MAX_TOOL_PAYLOAD_BYTES && !text.contains('\0')).then(|| text.to_owned())
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
            (!text.is_empty()).then(|| bounded_text(&text))
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
        return Err(HistoryError::malformed());
    }
    Ok(text.to_owned())
}

fn string(value: &Value) -> Result<&str, HistoryError> {
    value.as_str().ok_or(HistoryError::malformed())
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

pub fn direction(value: &str) -> Option<Direction> {
    match value {
        "latest" => Some(Direction::Latest),
        "older" => Some(Direction::Older),
        "newer" => Some(Direction::Newer),
        _ => None,
    }
}
