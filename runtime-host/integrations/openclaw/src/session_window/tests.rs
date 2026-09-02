use serde_json::json;

use super::{
    Direction, HistoryError, MessageContent, MessageRole, OmittedContentKind, PageRequest,
    decode_window, direction, window_range,
};

fn request(direction: Direction, limit: usize, offset: Option<usize>) -> PageRequest {
    PageRequest::new(direction, limit, offset).expect("valid page request")
}

fn assert_diagnostic(
    result: Result<super::SessionWindow, HistoryError>,
    message_index: Option<usize>,
    block_index: Option<usize>,
    field: &str,
    reason: &str,
    actual: &str,
) {
    let diagnostic = result.unwrap_err().diagnostic();
    assert_eq!(diagnostic.message_index(), message_index);
    assert_eq!(diagnostic.block_index(), block_index);
    assert_eq!(diagnostic.field(), field);
    assert_eq!(diagnostic.reason(), reason);
    assert_eq!(diagnostic.actual(), actual);
}

fn payload() -> serde_json::Value {
    json!({
        "messages": [
            { "role": "user", "messageId": "one", "content": "first request", "timestamp": 10 },
            { "role": "assistant", "id": "two", "content": [{ "type": "text", "text": "first reply" }], "ts": 20 },
            { "role": "user", "messageId": "three", "content": "second request", "createdAt": 30 },
            { "role": "assistant", "id": "four", "content": [{ "type": "text", "text": "second" }, { "type": "text", "text": "reply" }], "ts": 40, "updatedAt": 45 },
            { "role": "user", "messageId": "five", "content": "third request", "timestamp": 50 }
        ],
        "sessionKey": "agent:main:main",
        "sessionId": "session-id",
        "thinkingLevel": "medium",
        "fastMode": false,
        "verboseLevel": "off"
    })
}

#[test]
fn defaults_to_an_eighty_message_latest_request() {
    let request = PageRequest::latest();

    assert_eq!(request.direction(), Direction::Latest);
    assert_eq!(request.limit(), 80);
    assert_eq!(request.offset(), None);
}

#[test]
fn rejects_limits_above_the_bounded_window_and_latest_offsets() {
    assert_eq!(PageRequest::new(Direction::Latest, 201, None), None);
    assert_eq!(PageRequest::new(Direction::Latest, 80, Some(0)), None);
}

#[test]
fn preserves_legacy_latest_older_and_newer_ranges() {
    let latest = window_range(10, request(Direction::Latest, 3, None));
    assert_eq!((latest.start(), latest.end()), (7, 10));

    let older = window_range(10, request(Direction::Older, 3, Some(6)));
    assert_eq!((older.start(), older.end()), (3, 9));

    let newer = window_range(10, request(Direction::Newer, 3, Some(6)));
    assert_eq!((newer.start(), newer.end()), (6, 9));
}

#[test]
fn zero_limit_is_always_an_empty_window() {
    let latest = window_range(10, request(Direction::Latest, 0, None));
    assert_eq!((latest.start(), latest.end()), (10, 10));

    let older = window_range(10, request(Direction::Older, 0, Some(4)));
    assert_eq!((older.start(), older.end()), (4, 4));

    let newer = window_range(10, request(Direction::Newer, 0, Some(4)));
    assert_eq!((newer.start(), newer.end()), (4, 4));
}

#[test]
fn projects_renderer_text_and_safe_message_metadata() {
    let window = decode_window(payload(), request(Direction::Latest, 2, None)).unwrap();

    assert_eq!(window.range().start(), 3);
    assert_eq!(window.range().end(), 5);
    assert_eq!(window.messages().len(), 2);
    assert_eq!(window.total_item_count(), 5);
    assert_eq!(window.session_key(), Some("agent:main:main"));
    assert_eq!(window.native_session_id(), Some("session-id"));
    assert_eq!(window.messages()[0].role(), MessageRole::Assistant);
    assert_eq!(window.messages()[0].text(), "second\nreply");
    assert_eq!(window.messages()[0].message_id(), Some("four"));
    assert_eq!(window.messages()[0].created_at(), Some(40));
    assert_eq!(window.messages()[0].updated_at(), Some(45));
    assert_eq!(window.messages()[1].role(), MessageRole::User);
    assert_eq!(window.messages()[1].text(), "third request");
    assert_eq!(window.messages()[1].message_id(), Some("five"));
    assert_eq!(window.messages()[1].created_at(), Some(50));
    assert_eq!(window.messages()[1].updated_at(), None);
}

#[test]
fn accepts_empty_legacy_message_content() {
    let window = decode_window(
        json!({
            "messages": [
                { "role": "user", "messageId": "empty-user", "content": [], "timestamp": 10 },
                { "role": "assistant", "id": "reply", "content": [{ "type": "text", "text": "visible" }], "ts": 20 }
            ]
        }),
        request(Direction::Latest, 2, None),
    )
    .unwrap();

    assert_eq!(window.messages().len(), 2);
    assert_eq!(window.total_item_count(), 2);
    assert_eq!(window.messages()[0].role(), MessageRole::User);
    assert_eq!(window.messages()[0].text(), "");
    assert!(window.messages()[0].content().is_empty());
    assert_eq!(window.messages()[0].message_id(), Some("empty-user"));
}

#[test]
fn accepts_openclaw_tool_call_aliases() {
    let window = decode_window(
        json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "toolCall", "name": "tool-a", "id": "call-a" },
                    { "type": "toolUse", "name": "tool-b", "call_id": "call-b" },
                    { "type": "functionCall", "toolName": "tool-c", "toolCallId": "call-c" },
                    { "type": "tool_call", "name": "tool-d", "toolUseId": "call-d" },
                    { "type": "tool_use", "name": "tool-e", "tool_call_id": "call-e" },
                    { "type": "function_call", "name": "tool-f", "tool_use_id": "call-f" },
                    { "type": "tool_result", "toolName": "tool-g", "tool_use_id": "call-g", "content": "result", "is_error": true }
                ]
            }]
        }),
        request(Direction::Latest, 1, None),
    )
    .unwrap();

    let content = window.messages()[0].content();
    assert!(
        matches!(&content[0], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-a" && id == "call-a")
    );
    assert!(
        matches!(&content[1], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-b" && id == "call-b")
    );
    assert!(
        matches!(&content[2], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-c" && id == "call-c")
    );
    assert!(
        matches!(&content[3], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-d" && id == "call-d")
    );
    assert!(
        matches!(&content[4], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-e" && id == "call-e")
    );
    assert!(
        matches!(&content[5], MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "tool-f" && id == "call-f")
    );
    assert!(
        matches!(&content[6], MessageContent::ToolResult { tool_name: Some(name), tool_call_id: Some(id), summary: Some(summary), output: Some(output), is_error: Some(true) } if name == "tool-g" && id == "call-g" && summary == "result" && output == "result")
    );
}

#[test]
fn decodes_role_level_tool_result_as_tool_content() {
    let window = decode_window(
        json!({
            "messages": [{
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "read",
                "content": [{ "type": "text", "text": "file list" }],
                "isError": false
            }]
        }),
        request(Direction::Latest, 1, None),
    )
    .unwrap();

    let message = &window.messages()[0];
    assert_eq!(message.role(), MessageRole::ToolResult);
    assert!(message.content().iter().any(|content| matches!(
        content,
        MessageContent::ToolResult {
            tool_name: Some(name),
            tool_call_id: Some(id),
            summary: Some(summary),
            output: Some(output),
            is_error: Some(false),
        } if name == "read" && id == "call-1" && summary == "file list" && output == &json!([{ "type": "text", "text": "file list" }])
    )));
}

#[test]
fn projects_tool_payload_aliases_without_private_envelopes() {
    let window = decode_window(
        json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "toolCall", "name": "args-tool", "id": "call-args", "args": { "path": "Cargo.toml" } },
                    { "type": "toolCall", "name": "arguments-tool", "id": "call-arguments", "arguments": ["--help"] },
                    { "type": "toolCall", "name": "input-tool", "id": "call-input", "input": "literal input" },
                    { "type": "toolCall", "name": "tool-input-tool", "id": "call-tool-input", "toolInput": { "cmd": "cargo test" } },
                    { "type": "toolCall", "name": "tool-input-snake-tool", "id": "call-tool-input-snake", "tool_input": { "cwd": "repo" } },
                    { "type": "tool_result", "toolName": "result-tool", "tool_use_id": "call-result", "result": { "ok": true } },
                    { "type": "tool_result", "toolName": "output-tool", "tool_use_id": "call-output", "output": ["line"] },
                    { "type": "tool_result", "toolName": "partial-camel-tool", "tool_use_id": "call-partial-camel", "partialResult": { "chunk": 1 } },
                    { "type": "tool_result", "toolName": "partial-tool", "tool_use_id": "call-partial", "partial_result": "partial" },
                    { "type": "tool_result", "toolName": "unsafe-tool", "tool_use_id": "call-unsafe", "output": "bad\u{0}payload" }
                ]
            }]
        }),
        request(Direction::Latest, 1, None),
    )
    .unwrap();

    let content = window.messages()[0].content();
    assert!(
        matches!(&content[0], MessageContent::ToolUse { input: Some(input), input_text: Some(input_text), .. } if input == &json!({ "path": "Cargo.toml" }) && input_text == "{\n  \"path\": \"Cargo.toml\"\n}")
    );
    assert!(
        matches!(&content[1], MessageContent::ToolUse { input: Some(input), input_text: Some(input_text), .. } if input == &json!(["--help"]) && input_text == "[\n  \"--help\"\n]")
    );
    assert!(
        matches!(&content[2], MessageContent::ToolUse { input: Some(input), input_text: Some(input_text), .. } if input == "literal input" && input_text == "literal input")
    );
    assert!(
        matches!(&content[3], MessageContent::ToolUse { input: Some(input), input_text: Some(input_text), .. } if input == &json!({ "cmd": "cargo test" }) && input_text == "{\n  \"cmd\": \"cargo test\"\n}")
    );
    assert!(
        matches!(&content[4], MessageContent::ToolUse { input: Some(input), input_text: Some(input_text), .. } if input == &json!({ "cwd": "repo" }) && input_text == "{\n  \"cwd\": \"repo\"\n}")
    );
    assert!(
        matches!(&content[5], MessageContent::ToolResult { output: Some(output), summary: None, .. } if output == &json!({ "ok": true }))
    );
    assert!(
        matches!(&content[6], MessageContent::ToolResult { output: Some(output), summary: None, .. } if output == &json!(["line"]))
    );
    assert!(
        matches!(&content[7], MessageContent::ToolResult { output: Some(output), summary: None, .. } if output == &json!({ "chunk": 1 }))
    );
    assert!(
        matches!(&content[8], MessageContent::ToolResult { output: Some(output), summary: Some(summary), .. } if output == "partial" && summary == "partial")
    );
    assert!(
        matches!(&content[9], MessageContent::ToolResult { output: None, summary: Some(summary), .. } if summary == "bad\0payload")
    );
}

#[test]
fn decodes_internal_message_tool_delivery_media() {
    let window = decode_window(
        json!({
            "messages": [{
                "role": "toolResult",
                "toolCallId": "call-message",
                "toolName": "message",
                "content": "sent",
                "isError": false,
                "details": {
                    "status": "ok",
                    "sourceReplySink": "internal-ui",
                    "sourceReply": {
                        "text": "Here is the image",
                        "mediaUrl": "api/chat/media/outgoing/session-1/second.svg",
                        "mediaUrls": [
                            "/api/chat/media/outgoing/session-1/image.png",
                            "C:/private/image.png"
                        ]
                    },
                    "media": {
                        "mediaUrls": ["https://cdn.example.test/image.webp"]
                    }
                }
            }]
        }),
        request(Direction::Latest, 1, None),
    )
    .unwrap();

    let delivery = window.messages()[0]
        .content()
        .iter()
        .find_map(|content| match content {
            MessageContent::MessageToolDelivery { text, media } => Some((text, media)),
            _ => None,
        })
        .unwrap();

    assert_eq!(delivery.0.as_deref(), Some("Here is the image"));
    assert_eq!(delivery.1.len(), 3);
    assert!(delivery.1.iter().any(|media| media.reference()
        == "/api/chat/media/outgoing/session-1/second.svg"
        && media.media_type() == Some("image/svg+xml")));
    assert!(delivery.1.iter().any(|media| media.reference()
        == "/api/chat/media/outgoing/session-1/image.png"
        && media.media_type() == Some("image/png")));
    assert!(delivery.1.iter().any(|media| media.reference()
        == "https://cdn.example.test/image.webp"
        && media.media_type() == Some("image/webp")));
}

#[test]
fn falls_back_to_bounded_text_history_projection() {
    let window = decode_window(
        json!({
            "messages": [
                { "role": "user", "text": "request" },
                { "role": "assistant", "text": "reply" }
            ]
        }),
        request(Direction::Latest, 2, None),
    )
    .unwrap();

    assert_eq!(window.messages().len(), 2);
    assert_eq!(window.messages()[0].role(), MessageRole::User);
    assert_eq!(window.session_key(), None);
    assert_eq!(window.native_session_id(), None);
    assert_eq!(window.messages()[0].text(), "request");
    assert_eq!(window.messages()[1].role(), MessageRole::Assistant);
    assert_eq!(window.messages()[1].text(), "reply");
}

#[test]
fn ignores_unknown_envelope_and_message_fields() {
    let mut envelope = payload();
    envelope["cwd"] = json!("C:/private");
    assert!(decode_window(envelope, request(Direction::Latest, 2, None)).is_ok());

    let mut tool = payload();
    tool["messages"][1]["toolInput"] = json!({ "path": "C:/secret" });
    assert!(decode_window(tool, request(Direction::Latest, 2, None)).is_ok());

    let window = decode_window(
        json!({
            "messages": [{
                "role": "assistant",
                "content": [{ "type": "toolCall", "name": "read", "id": "call-1", "toolInput": { "path": "C:/secret" } }]
            }]
        }),
        request(Direction::Latest, 1, None),
    )
    .unwrap();
    assert!(matches!(
        &window.messages()[0].content()[0],
        MessageContent::ToolUse { input: Some(input), .. } if input == &json!({ "path": "C:/secret" })
    ));

    let mut approval = payload();
    approval["messages"][1]["approval"] = json!({ "decision": "allow" });
    assert!(decode_window(approval, request(Direction::Latest, 2, None)).is_ok());

    let mut attachment = payload();
    attachment["messages"][0]["attachments"] = json!([{ "path": "C:/private" }]);
    assert!(decode_window(attachment, request(Direction::Latest, 2, None)).is_ok());

    let mut raw_event = payload();
    raw_event["messages"][1]["rawEvent"] = json!({ "secretRef": "provider-key" });
    assert!(decode_window(raw_event, request(Direction::Latest, 2, None)).is_ok());
}

#[test]
fn rejects_malformed_tool_blocks_without_required_names() {
    let mut tool_block = payload();
    tool_block["messages"][1]["content"] =
        json!([{ "type": "toolCall", "input": { "cwd": "C:/private" } }]);
    assert_diagnostic(
        decode_window(tool_block, request(Direction::Latest, 2, None)),
        Some(1),
        Some(0),
        "name|toolName",
        "missing",
        "missing",
    );
}

#[test]
fn rejects_malformed_payloads_and_ambiguous_timestamps() {
    assert_diagnostic(
        decode_window(
            json!({ "messages": {} }),
            request(Direction::Latest, 2, None),
        ),
        None,
        None,
        "messages",
        "expected_array",
        "object",
    );

    let mut malformed_envelope = payload();
    malformed_envelope["fastMode"] = json!("false");
    assert_diagnostic(
        decode_window(malformed_envelope, request(Direction::Latest, 2, None)),
        None,
        None,
        "fastMode",
        "expected_boolean",
        "string",
    );

    let mut malformed_content = payload();
    malformed_content["messages"][0]["content"] = json!({ "text": "not a text payload" });
    assert_diagnostic(
        decode_window(malformed_content, request(Direction::Latest, 2, None)),
        Some(0),
        None,
        "content",
        "expected_string_or_array",
        "object",
    );

    let mut malformed = payload();
    malformed["messages"][0]["role"] = json!("tool");
    assert_diagnostic(
        decode_window(malformed, request(Direction::Latest, 2, None)),
        Some(0),
        None,
        "role",
        "unsupported_role",
        "string",
    );

    let mut ambiguous = payload();
    ambiguous["messages"][0]["ts"] = json!(10);
    assert_diagnostic(
        decode_window(ambiguous, request(Direction::Latest, 2, None)),
        Some(0),
        None,
        "createdAt|timestamp|ts",
        "alias_conflict",
        "number",
    );
}

#[test]
fn projects_source_backed_rich_content_without_private_payloads() {
    let window = decode_window(
        json!({
            "messages": [
                {"role":"system","messageId":"sys-1","content":"policy"},
                {"role":"assistant","content":[
                    {"type":"thinking","thinking":"private reasoning","signature":"sig"},
                    {"type":"text","text":"visible"},
                    {"type":"toolCall","name":"read","id":"call-1"},
                    {"type":"image","mimeType":"image/png","data":"raw-base64","viewId":"canvas-1"}
                ],"runId":"run-1","seq":7},
                {"role":"toolResult","toolCallId":"call-1","toolName":"read","content":"result text","isError":false}
            ]
        }),
        request(Direction::Latest, 3, None),
    ).unwrap();
    assert_eq!(window.messages()[0].role(), MessageRole::System);
    assert_eq!(window.messages()[1].role(), MessageRole::Assistant);
    assert_eq!(window.messages()[1].text(), "visible");
    assert_eq!(window.messages()[1].sequence(), Some(7));
    assert!(window.messages()[1].content().iter().any(|content| matches!(content, MessageContent::ToolUse { name, tool_call_id: Some(id), .. } if name == "read" && id == "call-1")));
    assert!(
        window.messages()[1]
            .content()
            .iter()
            .any(|content| matches!(
                content,
                MessageContent::Omitted {
                    kind: OmittedContentKind::Thinking
                }
            ))
    );
    assert_eq!(window.messages()[2].role(), MessageRole::ToolResult);
}

#[test]
fn parses_only_known_paging_directions() {
    assert_eq!(direction("latest"), Some(Direction::Latest));
    assert_eq!(direction("older"), Some(Direction::Older));
    assert_eq!(direction("newer"), Some(Direction::Newer));
    assert_eq!(direction("LATEST"), None);
    assert_eq!(direction("future"), None);
}
