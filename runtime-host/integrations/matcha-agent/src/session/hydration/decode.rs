use serde_json::{Map, Value};

use super::model::{
    DecodeFailure, HydratedContentBlock, HydratedImage, HydratedLargeText, HydratedMessage,
    HydratedMessageRole, HydratedToolMetadata, HydratedToolResult, HydratedToolUse, bounded_body,
    bounded_identifier, bounded_media_reference, bounded_text, bounded_timestamp,
    bounded_tool_input, bounded_tool_input_text, bounded_tool_name, max_metadata_keys,
};

const ALLOWED_IMAGE_MEDIA_TYPES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DecodeLineFailure {
    reason: DecodeFailure,
    field: &'static str,
    block_index: Option<usize>,
    block_type: Option<&'static str>,
    actual: &'static str,
}

impl DecodeLineFailure {
    const fn new(
        reason: DecodeFailure,
        field: &'static str,
        block_index: Option<usize>,
        block_type: Option<&'static str>,
        actual: &'static str,
    ) -> Self {
        Self {
            reason,
            field,
            block_index,
            block_type,
            actual,
        }
    }

    pub(crate) const fn reason(self) -> DecodeFailure {
        self.reason
    }

    pub(crate) const fn field(self) -> &'static str {
        self.field
    }

    pub(crate) const fn block_index(self) -> Option<usize> {
        self.block_index
    }

    pub(crate) const fn block_type(self) -> Option<&'static str> {
        self.block_type
    }

    pub(crate) const fn actual(self) -> &'static str {
        self.actual
    }
}

pub(crate) fn decode_transcript_line(
    line: &str,
) -> Result<Option<HydratedMessage>, DecodeLineFailure> {
    let line: Value = serde_json::from_str(line).map_err(|_| {
        DecodeLineFailure::new(
            DecodeFailure::InvalidJson,
            "line",
            None,
            None,
            "invalid_json",
        )
    })?;
    let line = line.as_object().ok_or_else(|| {
        DecodeLineFailure::new(
            DecodeFailure::InvalidShape,
            "line",
            None,
            None,
            "non_object",
        )
    })?;
    if !only_keys(line, &["id", "parentId", "timestamp", "message"]) {
        return Err(DecodeLineFailure::new(
            DecodeFailure::InvalidShape,
            "line.keys",
            None,
            None,
            "unknown_key",
        ));
    }

    let message = line
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DecodeLineFailure::new(
                DecodeFailure::InvalidShape,
                "message",
                None,
                None,
                "missing_or_non_object",
            )
        })?;
    if !only_keys(
        message,
        &[
            "role",
            "content",
            "id",
            "originMessageId",
            "metadata",
            "toolCallId",
        ],
    ) || !valid_metadata(message.get("metadata"))
    {
        return Err(DecodeLineFailure::new(
            DecodeFailure::InvalidShape,
            "message.keys",
            None,
            None,
            "unknown_key_or_invalid_metadata",
        ));
    }

    let raw_role = message.get("role").and_then(Value::as_str).ok_or_else(|| {
        DecodeLineFailure::new(
            DecodeFailure::InvalidShape,
            "message.role",
            None,
            None,
            "missing_or_non_string",
        )
    })?;
    let role = match raw_role {
        "user" => HydratedMessageRole::User,
        "assistant" => HydratedMessageRole::Assistant,
        "system" => HydratedMessageRole::System,
        // The legacy source labels a Claude user tool_result as toolresult. Keep
        // the source's three-role model while retaining the typed result block.
        "toolresult" | "tool_result" => HydratedMessageRole::User,
        _ => {
            return Err(DecodeLineFailure::new(
                DecodeFailure::UnsupportedRole,
                "message.role",
                None,
                None,
                "unsupported_value",
            ));
        }
    };

    let content = message.get("content").ok_or_else(|| {
        DecodeLineFailure::new(
            DecodeFailure::InvalidShape,
            "message.content",
            None,
            None,
            "missing",
        )
    })?;
    let content = decode_content(content)?;
    if content.is_empty() {
        return Ok(None);
    }

    let id = optional_identifier(line.get("id"))
        .map_err(|reason| DecodeLineFailure::new(reason, "id", None, None, "invalid_identifier"))?;
    let message_id = optional_identifier(message.get("id")).map_err(|reason| {
        DecodeLineFailure::new(reason, "message.id", None, None, "invalid_identifier")
    })?;
    let id = id.or(message_id);
    let parent_id = optional_identifier(line.get("parentId")).map_err(|reason| {
        DecodeLineFailure::new(reason, "parentId", None, None, "invalid_identifier")
    })?;
    let origin_message_id = optional_identifier(message.get("originMessageId"))
        .map_err(|reason| {
            DecodeLineFailure::new(
                reason,
                "message.originMessageId",
                None,
                None,
                "invalid_identifier",
            )
        })?
        .or(parent_id.clone());
    let timestamp = optional_timestamp(line.get("timestamp")).map_err(|reason| {
        DecodeLineFailure::new(reason, "timestamp", None, None, "invalid_timestamp")
    })?;
    let explicit_tool_call_id =
        optional_identifier(message.get("toolCallId")).map_err(|reason| {
            DecodeLineFailure::new(
                reason,
                "message.toolCallId",
                None,
                None,
                "invalid_identifier",
            )
        })?;
    let tool_call_id = explicit_tool_call_id.or_else(|| {
        content
            .iter()
            .find_map(content_tool_call_id)
            .map(str::to_owned)
    });

    HydratedMessage::try_from_parts(
        id,
        parent_id,
        timestamp,
        origin_message_id,
        role,
        content,
        tool_call_id,
    )
    .map(Some)
    .map_err(|reason| {
        DecodeLineFailure::new(reason, "message.content", None, None, "empty_content")
    })
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn valid_metadata(metadata: Option<&Value>) -> bool {
    metadata.is_none_or(|metadata| {
        let Some(metadata) = metadata.as_object() else {
            return false;
        };
        metadata.len() <= max_metadata_keys()
            && only_keys(metadata, &["sessionId"])
            && metadata.get("sessionId").is_none_or(Value::is_string)
    })
}

fn decode_content(content: &Value) -> Result<Vec<HydratedContentBlock>, DecodeLineFailure> {
    match content {
        Value::String(text) => bounded_text(text.clone())
            .map(|text| vec![HydratedContentBlock::Text { text }])
            .ok_or_else(|| {
                DecodeLineFailure::new(
                    DecodeFailure::TextTooLarge,
                    "message.content",
                    None,
                    None,
                    "text_too_large",
                )
            }),
        Value::Array(blocks) => blocks
            .iter()
            .enumerate()
            .map(|(index, block)| {
                decode_block(block).map_err(|reason| {
                    DecodeLineFailure::new(
                        reason,
                        "message.content.block",
                        Some(index),
                        block_type_name(block),
                        decode_failure_actual(reason),
                    )
                })
            })
            .collect(),
        _ => Err(DecodeLineFailure::new(
            DecodeFailure::UnsafeContent,
            "message.content",
            None,
            None,
            value_kind(content),
        )),
    }
}

fn block_type_name(block: &Value) -> Option<&'static str> {
    match block
        .as_object()
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str)
    {
        Some("text") => Some("text"),
        Some("large_text") => Some("large_text"),
        Some("thinking") => Some("thinking"),
        Some("tool_use") => Some("tool_use"),
        Some("tool_result") => Some("tool_result"),
        Some("tool_use_result") => Some("tool_use_result"),
        Some("image") => Some("image"),
        Some(_) => Some("unknown"),
        None => None,
    }
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

fn decode_failure_actual(reason: DecodeFailure) -> &'static str {
    match reason {
        DecodeFailure::InvalidJson => "invalid_json",
        DecodeFailure::InvalidShape => "invalid_shape",
        DecodeFailure::UnsupportedRole => "unsupported_role",
        DecodeFailure::UnsafeContent => "unsafe_content",
        DecodeFailure::TextTooLarge => "text_too_large",
        DecodeFailure::EmptyContent => "empty_content",
        DecodeFailure::TranscriptTooLarge => "transcript_too_large",
    }
}

fn decode_block(block: &Value) -> Result<HydratedContentBlock, DecodeFailure> {
    let block = block.as_object().ok_or(DecodeFailure::UnsafeContent)?;
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;

    match block_type {
        "text" => {
            if !only_keys(block, &["type", "text"]) {
                return Err(DecodeFailure::UnsafeContent);
            }
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or(DecodeFailure::UnsafeContent)?;
            bounded_text(text.to_owned())
                .map(|text| HydratedContentBlock::Text { text })
                .ok_or(DecodeFailure::TextTooLarge)
        }
        "large_text" => decode_large_text(block),
        "thinking" => decode_thinking(block),
        "tool_use" => decode_tool_use(block),
        "tool_result" | "tool_use_result" => decode_tool_result(block),
        "image" => decode_image(block),
        _ => Err(DecodeFailure::UnsafeContent),
    }
}

fn decode_large_text(block: &Map<String, Value>) -> Result<HydratedContentBlock, DecodeFailure> {
    if !only_keys(block, &["type", "text", "content_ref", "total_bytes"]) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let text = block
        .get("text")
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;
    let content_ref = block
        .get("content_ref")
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;
    let total_bytes = block
        .get("total_bytes")
        .and_then(Value::as_u64)
        .ok_or(DecodeFailure::UnsafeContent)?;
    HydratedLargeText::try_new(text.to_owned(), content_ref.to_owned(), total_bytes)
        .map(HydratedContentBlock::LargeText)
}

fn decode_thinking(block: &Map<String, Value>) -> Result<HydratedContentBlock, DecodeFailure> {
    // Signature and all unknown/private fields are rejected. The renderer-safe
    // text is the only retained part of a thinking block.
    if !only_keys(block, &["type", "thinking", "text", "signature"]) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let visible = block
        .get("text")
        .or_else(|| block.get("thinking"))
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;
    bounded_text(visible.to_owned())
        .map(|text| HydratedContentBlock::Thinking { text })
        .ok_or(DecodeFailure::TextTooLarge)
}

fn decode_tool_use(block: &Map<String, Value>) -> Result<HydratedContentBlock, DecodeFailure> {
    if !only_keys(block, &["type", "id", "name", "input"]) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let tool_call_id = bounded_identifier(
        block
            .get("id")
            .and_then(Value::as_str)
            .ok_or(DecodeFailure::UnsafeContent)?,
    )
    .ok_or(DecodeFailure::UnsafeContent)?;
    let name = bounded_tool_name(
        block
            .get("name")
            .and_then(Value::as_str)
            .ok_or(DecodeFailure::UnsafeContent)?,
    )
    .ok_or(DecodeFailure::UnsafeContent)?;
    let input = block.get("input");
    let metadata = decode_tool_metadata(input)?;
    let input = input.and_then(bounded_tool_input);
    let input_text = input.as_ref().map(tool_input_text).transpose()?;
    Ok(HydratedContentBlock::ToolUse(HydratedToolUse::new(
        tool_call_id,
        name,
        input,
        input_text,
        metadata,
    )))
}

fn tool_input_text(input: &Value) -> Result<String, DecodeFailure> {
    let text = match input {
        Value::String(text) => text.clone(),
        value => serde_json::to_string_pretty(value).map_err(|_| DecodeFailure::UnsafeContent)?,
    };
    bounded_tool_input_text(text).ok_or(DecodeFailure::UnsafeContent)
}

fn decode_tool_metadata(input: Option<&Value>) -> Result<HydratedToolMetadata, DecodeFailure> {
    let Some(input) = input else {
        return Ok(HydratedToolMetadata::new(Vec::new()));
    };
    let object = input.as_object().ok_or(DecodeFailure::UnsafeContent)?;
    if object.len() > max_metadata_keys() {
        return Err(DecodeFailure::UnsafeContent);
    }
    let mut keys = Vec::with_capacity(object.len());
    for key in object.keys() {
        bounded_identifier(key).ok_or(DecodeFailure::UnsafeContent)?;
        keys.push(key.clone());
    }
    Ok(HydratedToolMetadata::new(keys))
}

fn decode_tool_result(block: &Map<String, Value>) -> Result<HydratedContentBlock, DecodeFailure> {
    if !only_keys(
        block,
        &[
            "type",
            "tool_use_id",
            "toolUseId",
            "id",
            "content",
            "is_error",
            "isError",
        ],
    ) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let tool_call_id = match ["tool_use_id", "toolUseId", "id"]
        .iter()
        .find_map(|key| block.get(*key).and_then(Value::as_str))
    {
        Some(value) => Some(bounded_identifier(value).ok_or(DecodeFailure::UnsafeContent)?),
        None => None,
    };
    let body = block
        .get("content")
        .map(decode_bounded_body)
        .transpose()?
        .flatten();
    let is_error = block
        .get("is_error")
        .or_else(|| block.get("isError"))
        .map(|value| value.as_bool().ok_or(DecodeFailure::UnsafeContent))
        .transpose()?;
    Ok(HydratedContentBlock::ToolResult(HydratedToolResult::new(
        tool_call_id,
        body,
        is_error,
    )))
}

fn decode_bounded_body(value: &Value) -> Result<Option<String>, DecodeFailure> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.as_object())
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return Ok(None),
    };
    let safe = redact_unsafe_body(&text);
    Ok(bounded_body(safe))
}

fn redact_unsafe_body(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            if looks_like_path(token) || looks_like_base64(token) {
                "[redacted]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with('\\')
        || value
            .get(1..3)
            .is_some_and(|prefix| prefix.ends_with(":\\"))
        || value.contains(".matcha-agent-app-server")
}

fn looks_like_base64(value: &str) -> bool {
    value.len() >= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'_'))
}

fn optional_identifier(value: Option<&Value>) -> Result<Option<String>, DecodeFailure> {
    value.map_or(Ok(None), |value| {
        value
            .as_str()
            .map(bounded_identifier)
            .ok_or(DecodeFailure::InvalidShape)?
            .ok_or(DecodeFailure::InvalidShape)
            .map(Some)
    })
}

fn optional_timestamp(value: Option<&Value>) -> Result<Option<String>, DecodeFailure> {
    value.map_or(Ok(None), |value| {
        value
            .as_str()
            .map(bounded_timestamp)
            .ok_or(DecodeFailure::InvalidShape)?
            .ok_or(DecodeFailure::InvalidShape)
            .map(Some)
    })
}

fn content_tool_call_id(block: &HydratedContentBlock) -> Option<&str> {
    match block {
        HydratedContentBlock::ToolUse(tool) => Some(tool.tool_call_id()),
        HydratedContentBlock::ToolResult(result) => result.tool_call_id(),
        _ => None,
    }
}

fn decode_image(block: &Map<String, Value>) -> Result<HydratedContentBlock, DecodeFailure> {
    if !only_keys(block, &["type", "source"]) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let source = block
        .get("source")
        .and_then(Value::as_object)
        .ok_or(DecodeFailure::UnsafeContent)?;
    if !only_keys(source, &["type", "media_type", "mediaType", "url", "data"]) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let media_type = source
        .get("media_type")
        .or_else(|| source.get("mediaType"))
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;
    if !ALLOWED_IMAGE_MEDIA_TYPES.contains(&media_type) {
        return Err(DecodeFailure::UnsafeContent);
    }
    let source_type = source
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::UnsafeContent)?;
    let reference = match source_type {
        "url" => source
            .get("url")
            .and_then(Value::as_str)
            .and_then(bounded_media_reference),
        // Never expose inline bytes. The caller may safely omit this block.
        "base64" => return Err(DecodeFailure::UnsafeContent),
        _ => None,
    }
    .ok_or(DecodeFailure::UnsafeContent)?;
    if !(reference.starts_with("https://") || reference.starts_with("http://")) {
        return Err(DecodeFailure::UnsafeContent);
    }
    Ok(HydratedContentBlock::Image(HydratedImage::new(
        media_type.to_owned(),
        reference,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_rich_ordered_content_and_identity_fields() {
        let message = decode_transcript_line(
            r#"{"id":"m1","parentId":"p1","timestamp":"2026-07-11T12:00:00.000Z","message":{"role":"assistant","id":"m1","originMessageId":"p1","content":[{"type":"thinking","thinking":"visible thought","signature":"private"},{"type":"text","text":"visible"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"path":"/private/file","limit":10}},{"type":"image","source":{"type":"url","media_type":"image/png","url":"https://cdn.example/image.png"}}]}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(message.id(), Some("m1"));
        assert_eq!(message.parent_id(), Some("p1"));
        assert_eq!(message.origin_message_id(), Some("p1"));
        assert_eq!(message.timestamp(), Some("2026-07-11T12:00:00.000Z"));
        assert_eq!(message.content().len(), 4);
        assert_eq!(message.tool_call_id(), Some("tool-1"));
        assert!(matches!(
            message.content()[0],
            HydratedContentBlock::Thinking { .. }
        ));
        assert!(matches!(
            message.content()[2],
            HydratedContentBlock::ToolUse(_)
        ));
    }

    #[test]
    fn retains_bounded_tool_result_body_without_paths_or_base64() {
        let message = decode_transcript_line(
            r#"{"message":{"role":"toolresult","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok /private/file aGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9hGVsbG9="}]}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(message.role(), HydratedMessageRole::User);
        match &message.content()[0] {
            HydratedContentBlock::ToolResult(result) => {
                assert_eq!(result.tool_call_id(), Some("tool-1"));
                assert!(!result.body().unwrap().contains("/private/file"));
                assert!(!result.body().unwrap().contains("aGVsbG9"));
            }
            _ => panic!("expected tool result"),
        }
    }

    #[test]
    fn retains_bounded_tool_use_input_and_visible_text() {
        let message = decode_transcript_line(
            r#"{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"cargo test","description":"Run tests"}}]}}"#,
        )
        .unwrap()
        .unwrap();

        match &message.content()[0] {
            HydratedContentBlock::ToolUse(tool) => {
                assert_eq!(
                    tool.input(),
                    Some(&serde_json::json!({"command":"cargo test","description":"Run tests"}))
                );
                assert_eq!(
                    tool.input_text(),
                    Some("{\n  \"command\": \"cargo test\",\n  \"description\": \"Run tests\"\n}")
                );
                assert_eq!(tool.metadata().input_keys(), &["command", "description"]);
            }
            _ => panic!("expected tool use"),
        }
    }

    #[test]
    fn rejects_unknown_and_private_media_shapes() {
        for line in [
            r#"{"message":{"role":"assistant","content":[{"type":"text","text":"visible","path":"path-canary"}]}}"#,
            r#"{"message":{"role":"assistant","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"raw-base64"}}]}}"#,
            r#"{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tool","name":"Read","input":{"secret":"value"},"future":true}]}}"#,
        ] {
            assert!(decode_transcript_line(line).is_err(), "{line}");
        }
    }
}
