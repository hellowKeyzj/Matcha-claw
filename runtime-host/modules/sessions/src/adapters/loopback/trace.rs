use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::state::{ItemAnchor, SessionChange, SessionContent, SessionFact, SessionIdentity, SessionItem, SessionView};

tokio::task_local! {
    static CONTEXT: Value;
}

pub fn with_context<T>(context: Value, action: impl FnOnce() -> T) -> T {
    CONTEXT.sync_scope(context, action)
}

pub fn log_unscoped(stage: &str, payload: Value) {
    if enabled() { emit(stage, None, payload); }
}

/// Same FNV-1a over UTF-16 code units as Renderer summarizeIdentifier; diagnostic only.
pub fn fingerprint(value: &str) -> String {
    let hash = value.encode_utf16().fold(2_166_136_261u32, |hash, unit| (hash ^ u32::from(unit)).wrapping_mul(16_777_619));
    format!("{hash:08x}")
}

pub fn text_shape(value: &str) -> Value {
    let (hash, length) = value.encode_utf16().fold((2_166_136_261u32, 0usize), |(hash, length), unit|
        ((hash ^ u32::from(unit)).wrapping_mul(16_777_619), length + 1));
    serde_json::json!({ "hash": format!("{hash:08x}"), "utf8Bytes": value.len(), "utf16Length": length })
}

pub fn identity_shape(identity: &SessionIdentity) -> Value {
    serde_json::json!({
        "provider": identity.provider(), "sessionHash": fingerprint(&identity.session_key),
        "agentHash": fingerprint(&identity.agent_id), "instanceHash": fingerprint(&identity.endpoint.runtime_instance_id),
    })
}

pub fn item_shape(item: &SessionItem) -> Value {
    let (kind, text, status, run, message, segments) = match item {
        SessionItem::AssistantTurn { text, status, run_id, message_id, segments, .. } =>
            ("assistantTurn", text, status, run_id.as_deref(), message_id.as_deref(), segments.as_slice()),
        SessionItem::UserMessage { text, status, message_id, content, .. } =>
            ("userMessage", text, status, None, message_id.as_deref(), content.as_slice()),
        SessionItem::System { text, status, .. } => ("system", text, status, None, None, &[][..]),
    };
    serde_json::json!({ "kind": kind, "itemHash": fingerprint(item.item_id()), "runHash": run.map(fingerprint),
        "messageHash": message.map(fingerprint), "status": status, "text": text_shape(text),
        "segmentCount": segments.len(), "segmentsTruncated": segments.len() > crate::state::MAX_SEGMENTS,
        "segments": segments.iter().take(crate::state::MAX_SEGMENTS).map(|segment| match segment {
            SessionContent::Text { text } => serde_json::json!({ "kind": "text", "text": text_shape(text) }),
            SessionContent::Thinking { text } => serde_json::json!({ "kind": "thinking", "text": text_shape(text) }),
            SessionContent::LargeText { text, loaded_bytes, total_bytes, .. } => serde_json::json!({ "kind": "largeText", "text": text_shape(text), "loadedBytes": loaded_bytes, "totalBytes": total_bytes }),
            SessionContent::ToolUse { tool_call_id, .. } => serde_json::json!({ "kind": "toolUse", "toolHash": fingerprint(tool_call_id) }),
            SessionContent::ToolResult { tool_call_id, is_error, .. } => serde_json::json!({ "kind": "toolResult", "toolHash": fingerprint(tool_call_id), "isError": is_error }),
            SessionContent::Media { .. } => serde_json::json!({ "kind": "media" }),
            SessionContent::Omitted { reason } => serde_json::json!({ "kind": "omitted", "reason": reason }),
        }).collect::<Vec<_>>() })
}

pub fn items_shape(items: &[SessionItem]) -> Value {
    serde_json::json!({ "count": items.len(), "truncated": items.len() > crate::state::MAX_ITEMS,
        "values": items.iter().take(crate::state::MAX_ITEMS).map(item_shape).collect::<Vec<_>>() })
}

pub fn view_shape(view: &SessionView) -> Value {
    let items = match &view.items { SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => items.as_slice(), _ => &[] };
    serde_json::json!({ "identity": identity_shape(&view.identity), "epoch": view.epoch, "seq": view.seq,
        "cursor": view.cursor, "items": items_shape(items) })
}

pub fn changes_shape(changes: &[SessionChange]) -> Value {
    serde_json::json!({ "count": changes.len(), "truncated": changes.len() > crate::state::MAX_CHANGE_COUNT,
        "values": changes.iter().take(crate::state::MAX_CHANGE_COUNT).map(|change| match change {
        SessionChange::ItemsReplaced { old_item_ids, anchor, items } => serde_json::json!({ "kind": "itemsReplaced",
            "oldItemCount": old_item_ids.len(), "oldItemsTruncated": old_item_ids.len() > crate::state::MAX_ITEMS,
            "oldItemHashes": old_item_ids.iter().take(crate::state::MAX_ITEMS).map(|id| fingerprint(id)).collect::<Vec<_>>(),
            "anchorHash": match anchor { ItemAnchor::Start => None, ItemAnchor::After { item_id } => Some(fingerprint(item_id)) }, "items": items_shape(items) }),
        SessionChange::MessageUpdated { item } => serde_json::json!({ "kind": "messageUpdated", "item": item_shape(item) }),
        SessionChange::MessageReplaced { item } => serde_json::json!({ "kind": "messageReplaced", "item": item_shape(item) }),
        SessionChange::MessageDelta { item_id, run_id, message_id, text, replace, status } => serde_json::json!({ "kind": "messageDelta",
            "itemHash": fingerprint(item_id), "runHash": run_id.as_deref().map(fingerprint), "messageHash": message_id.as_deref().map(fingerprint),
            "text": text_shape(text), "replace": replace, "status": status }),
        SessionChange::ToolUpdated { tool } => serde_json::json!({ "kind": "toolUpdated", "toolHash": fingerprint(&tool.tool_call_id), "runHash": tool.run_id.as_deref().map(fingerprint), "phase": tool.phase }),
        SessionChange::RunPhaseChanged { run_id, phase } => serde_json::json!({ "kind": "runPhaseChanged", "runHash": fingerprint(run_id), "phase": phase }),
        SessionChange::RecoveryRequired { reason } => serde_json::json!({ "kind": "recoveryRequired", "reason": reason }),
        SessionChange::RuntimeChanged { runtime } => serde_json::json!({ "kind": "runtimeChanged", "phase": runtime.phase, "runHash": runtime.active_run_id.as_deref().map(fingerprint) }),
        SessionChange::ApprovalUpdated { approval } => serde_json::json!({ "kind": "approvalUpdated", "approvalHash": fingerprint(&approval.approval_id), "phase": approval.phase }),
        SessionChange::RuntimeNoticeUpdated { notice } => serde_json::json!({ "kind": "runtimeNoticeUpdated", "runHash": fingerprint(&notice.run_id), "noticeKind": notice.kind }),
        SessionChange::GoalChanged { goal } => serde_json::json!({ "kind": "goalChanged", "known": matches!(goal, crate::goal::SessionGoalView::Known { .. }) }),
        SessionChange::WindowChanged { window } => serde_json::json!({ "kind": "windowChanged", "window": window }),
    }).collect::<Vec<_>>() })
}

pub const HEADER: &str = "x-matchaclaw-session-trace";

pub fn trace_id<'a>(headers: &'a [(String, String)]) -> Option<&'a str> {
    headers
        .iter()
        .find(|(name, _)| name == HEADER)
        .map(|(_, value)| value.as_str())
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
}

pub fn log(stage: &str, trace_id: Option<&str>, payload: Value) {
    if trace_id.is_none() || !enabled() {
        return;
    }
    emit(stage, trace_id, payload);
}

pub fn enabled() -> bool {
    std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() == Ok("1")
}

fn emit(stage: &str, trace_id: Option<&str>, payload: Value) {
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    if let Some(trace_id) = trace_id {
        event.insert("traceId".into(), Value::String(trace_id.into()));
    }
    event.insert("stage".into(), Value::String(stage.into()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Ok(Value::Object(fields)) = CONTEXT.try_with(Clone::clone) {
        event.extend(fields);
    }
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

pub fn id_shape(value: Option<&str>) -> Value {
    match value {
        Some(value) => serde_json::json!({ "present": true, "length": value.len(), "hash": fingerprint(value) }),
        None => serde_json::json!({ "present": false, "length": 0, "hash": null }),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
