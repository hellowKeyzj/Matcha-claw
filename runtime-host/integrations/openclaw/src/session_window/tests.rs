use serde_json::json;

use super::{
    Direction, HistoryError, MessageContent, MessageRole, OmittedContentKind, PageRequest,
    decode_window, direction, window_range,
};

fn request(direction: Direction, limit: usize, offset: Option<usize>) -> PageRequest {
    PageRequest::new(direction, limit, offset).expect("valid page request")
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
    assert_eq!(
        decode_window(tool_block, request(Direction::Latest, 2, None)),
        Err(HistoryError::Malformed)
    );
}

#[test]
fn rejects_malformed_payloads_and_ambiguous_timestamps() {
    assert_eq!(
        decode_window(
            json!({ "messages": {} }),
            request(Direction::Latest, 2, None)
        ),
        Err(HistoryError::Malformed)
    );

    let mut malformed_envelope = payload();
    malformed_envelope["fastMode"] = json!("false");
    assert_eq!(
        decode_window(malformed_envelope, request(Direction::Latest, 2, None)),
        Err(HistoryError::Malformed)
    );

    let mut malformed_content = payload();
    malformed_content["messages"][0]["content"] = json!({ "text": "not a text payload" });
    assert_eq!(
        decode_window(malformed_content, request(Direction::Latest, 2, None)),
        Err(HistoryError::Malformed)
    );

    let mut malformed = payload();
    malformed["messages"][0]["role"] = json!("tool");
    assert_eq!(
        decode_window(malformed, request(Direction::Latest, 2, None)),
        Err(HistoryError::Malformed)
    );

    let mut ambiguous = payload();
    ambiguous["messages"][0]["ts"] = json!(10);
    assert_eq!(
        decode_window(ambiguous, request(Direction::Latest, 2, None)),
        Err(HistoryError::Malformed)
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
    assert!(window.messages()[1].content().iter().any(|content| matches!(content, MessageContent::ToolUse { name, tool_call_id: Some(id) } if name == "read" && id == "call-1")));
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
