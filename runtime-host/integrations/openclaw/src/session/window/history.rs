use serde_json::{Map, Value};

use crate::session::protocol::{ChatHistoryResult, HistoryRole};

use super::model::{
    ActivityPosition, DisplayPosition, StreamFallback, StreamFallbackSource,
    Direction, HistoryKind, InFlightRun, InputReceipt, Message, MessageContent, MessageRole,
    MessageToolDeliveryMedia, OmittedContentKind, PageMetadata, PageRequest, PendingInput,
    PendingInputState, RunState, SessionState, SessionWindow, WindowRange, window_range,
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
const TEXT_BLOCK_TYPES: &[&str] = &["text", "input_text", "output_text"];
const TOOL_CALL_BLOCK_TYPES: &[&str] = &[
    "toolCall",
    "toolUse",
    "functionCall",
    "toolcall",
    "tooluse",
    "tool_call",
    "tool_use",
    "function_call",
];
const TOOL_RESULT_BLOCK_TYPES: &[&str] =
    &["toolResult", "toolresult", "tool_result", "tool_use_result"];
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
        .map(decode_native_session_id)
        .transpose()?
        .flatten()
        .filter(|value| !value.is_empty());
    let kind = match envelope.as_ref().and_then(|value| value.get("kind")).and_then(Value::as_str) {
        None => HistoryKind::Full,
        Some("delta") => HistoryKind::Delta,
        Some("reset") => HistoryKind::Reset,
        Some(_) => return Err(payload_error("kind", "unsupported", "string")),
    };
    let messages = if kind == HistoryKind::Reset {
        Vec::new()
    } else if kind == HistoryKind::Delta {
        envelope.as_ref().and_then(|value| value.get("messages")).and_then(Value::as_array)
            .ok_or_else(|| payload_error("messages", "expected_array", "missing"))?
            .iter().map(decode_session_message).collect::<Result<Vec<_>, _>>()?
    } else {
        match decode_native_window(payload.clone()) {
            Ok(messages) => messages,
            Err(_) if is_text_history(&payload) => decode_text_history(payload)?,
            Err(error) => return Err(error),
        }
    };
    let pagination = envelope
        .as_ref()
        .map(decode_pagination)
        .transpose()?
        .flatten();
    let total_item_count = pagination
        .map(|pagination| pagination.total_messages())
        .unwrap_or(messages.len());
    let range = pagination
        .map(|pagination| page_range(pagination, &messages))
        .transpose()?
        .unwrap_or_else(|| window_range(total_item_count, request));
    let (messages, range) = if kind == HistoryKind::Full {
        bound_source_window(messages, range, total_item_count, request, pagination)?
    } else {
        (messages, range)
    };
    let state = envelope
        .as_ref()
        .map(decode_session_state)
        .transpose()?
        .unwrap_or_else(empty_session_state)
        .with_history(kind, envelope.as_ref().and_then(|value| value.get("sessionInfo"))
            .and_then(Value::as_object).filter(|info| info.contains_key("activeLeafEntryId"))
            .map(|info| match info.get("activeLeafEntryId") {
                Some(Value::Null) => Ok(None),
                _ => optional_string(info, "activeLeafEntryId").map(|leaf| leaf
                    .map(|leaf| leaf.trim().to_owned()).filter(|leaf| !leaf.is_empty())),
            }).transpose()?);
    Ok(SessionWindow::new(
        messages,
        range,
        total_item_count,
        pagination,
        session_key,
        native_session_id,
        state,
    ))
}

fn decode_native_session_id(envelope: &Map<String, Value>) -> Result<Option<String>, HistoryError> {
    if let Some(session_id) = optional_string(envelope, "sessionId")? {
        return Ok(Some(session_id));
    }
    let Some(value) = envelope.get("sessionInfo") else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| payload_error("sessionInfo", "expected_object", value_kind(value)))?;
    optional_bounded_id(object, "sessionId")
}

pub(crate) fn decode_total_messages(payload: &Value) -> Result<usize, HistoryError> {
    let envelope = payload.as_object().ok_or_else(HistoryError::malformed)?;
    optional_usize(envelope, "totalMessages")?
        .filter(|total| *total as u64 <= MAX_SAFE_SEQUENCE)
        .ok_or_else(|| payload_error("totalMessages", "missing_or_invalid", "number"))
}

fn decode_pagination(
    envelope: &Map<String, Value>,
) -> Result<Option<PageMetadata>, HistoryError> {
    let Some(total_messages) = optional_usize(envelope, "totalMessages")? else {
        return Ok(None);
    };
    let offset = optional_usize(envelope, "offset")?.unwrap_or(0).min(total_messages);
    let next_offset = optional_usize(envelope, "nextOffset")?;
    let has_more = optional_bool(envelope, "hasMore")?;
    if next_offset.is_some_and(|next_offset| next_offset > total_messages) {
        return Err(payload_error(
            "nextOffset",
            "exceeds_total_messages",
            "number",
        ));
    }
    if next_offset.is_some_and(|next_offset| next_offset < offset) {
        return Err(payload_error("nextOffset", "before_offset", "number"));
    }
    Ok(Some(PageMetadata::new(
        offset,
        total_messages,
        next_offset,
        has_more,
    )))
}

fn page_range(pagination: PageMetadata, messages: &[Message]) -> Result<WindowRange, HistoryError> {
    let total = pagination.total_messages();
    let end = total.saturating_sub(pagination.offset());
    let start = if let Some(next_offset) = pagination.next_offset() {
        total.saturating_sub(next_offset)
    } else if pagination.has_more() == Some(false) {
        0
    } else if let Some(seq) = messages.iter().filter_map(Message::identity_sequence).min() {
        usize::try_from(seq).ok().filter(|seq| *seq > 0 && *seq <= end)
            .ok_or_else(|| payload_error("seq", "outside_source_range", "number"))? - 1
    } else {
        return Err(payload_error("pagination", "source_range_required", "missing"));
    };
    if start == end && !messages.is_empty() {
        return Err(payload_error("pagination", "source_group_cannot_advance", "number"));
    }
    Ok(WindowRange::new(start, end))
}

fn bound_source_window(
    mut messages: Vec<Message>,
    range: WindowRange,
    total: usize,
    request: PageRequest,
    pagination: Option<PageMetadata>,
) -> Result<(Vec<Message>, WindowRange), HistoryError> {
    let requested = window_range(total, request);
    let mut end = range.end().min(requested.end());
    let mut start = range.start().max(match request.direction() {
        Direction::Latest => end.saturating_sub(PageRequest::MAX_LIMIT),
        Direction::Older | Direction::Newer => requested.start(),
    }).min(end);
    if request.limit() == 0 {
        return Ok((Vec::new(), requested));
    }
    // A replay cursor excludes this partially returned source from the consumed cut.
    let mut partial_start = pagination.is_some_and(|page| page.next_offset().is_some() && page.has_more() != Some(false))
        && start == range.start()
        && (matches!(request.direction(), Direction::Latest) || start > requested.start());
    let needs_source = start != range.start() || end != range.end()
        || messages.len() > request.limit()
        || messages.iter().any(|message| message.identity_sequence().is_some_and(|seq| seq <= start as u64 || seq > end as u64));
    if !needs_source {
        return Ok((messages, WindowRange::new(start, end)));
    }
    let mut groups = std::collections::BTreeMap::<usize, usize>::new();
    let mut source = None;
    for message in &messages {
        let seq = message.identity_sequence().filter(|seq| *seq > 0 && *seq <= total as u64)
            .ok_or_else(|| payload_error("seq", "source_position_required", "missing_or_invalid"))? as usize;
        if let Some(position) = message.display_position() {
            if source.is_some_and(|source| source != position.source.as_str()) {
                return Err(payload_error("transcriptPosition", "mixed_source_range", "object"));
            }
            source = Some(position.source.as_str());
        }
        if (seq > start || partial_start && seq == start) && seq <= end {
            *groups.entry(seq).or_default() += 1;
        }
    }
    let mut count = 0;
    let mut take_group = |size: usize| -> Result<bool, HistoryError> {
        if size > PageRequest::MAX_LIMIT {
            return Err(payload_error("messages", "source_siblings_exceed_budget", "array"));
        }
        if count > 0 && count + size > request.limit() || count + size > PageRequest::MAX_LIMIT {
            return Ok(false);
        }
        count += size;
        Ok(true)
    };
    match request.direction() {
        Direction::Latest | Direction::Older => {
            for (&seq, &size) in groups.iter().rev() {
                if !take_group(size)? { start = seq; partial_start = false; break; }
            }
        }
        Direction::Newer => {
            for (&seq, &size) in &groups {
                if !take_group(size)? { end = seq - 1; break; }
            }
        }
    }
    messages.retain(|message| message.identity_sequence().is_some_and(|seq|
        (seq > start as u64 || partial_start && seq == start as u64) && seq <= end as u64));
    Ok((messages, WindowRange::new(start, end)))
}

fn empty_session_state() -> SessionState {
    SessionState::new(Vec::new(), Vec::new(), None, None, None)
}

fn decode_session_state(envelope: &Map<String, Value>) -> Result<SessionState, HistoryError> {
    let state = SessionState::new(
        decode_pending_inputs(envelope)?,
        decode_input_receipts(envelope)?,
        decode_in_flight_run(envelope)?,
        decode_delta_cursor(envelope)?,
        optional_bool(envelope, "completeSnapshot")?,
    );
    let Some(info) = envelope.get("sessionInfo") else { return Ok(state); };
    let info = info.as_object().ok_or_else(|| payload_error("sessionInfo", "expected_object", value_kind(info)))?;
    Ok(state.with_activity(
        optional_string(info, "status")?,
        match info.get("hasActiveRun") {
            None | Some(Value::Null) => None,
            _ => optional_bool(info, "hasActiveRun")?,
        },
        info.get("activeRunIds").map(|value| {
            value.as_array().ok_or_else(|| payload_error("activeRunIds", "expected_array", value_kind(value)))?
                .iter().map(|value| bounded_id(value, "activeRunIds[]")).collect::<Result<Vec<_>, _>>()
        }).transpose()?,
    ))
}

fn decode_pending_inputs(envelope: &Map<String, Value>) -> Result<Vec<PendingInput>, HistoryError> {
    let Some(value) = envelope.get("pendingInputs") else {
        return Ok(Vec::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| payload_error("pendingInputs", "expected_object", value_kind(value)))?;
    let items = object
        .get("items")
        .ok_or_else(|| payload_error("pendingInputs.items", "missing", "missing"))?;
    let values = items
        .as_array()
        .ok_or_else(|| payload_error("pendingInputs.items", "expected_array", value_kind(items)))?;
    values
        .iter()
        .map(|value| {
            let object = value.as_object().ok_or_else(|| {
                payload_error(
                    "pendingInputs.items[]",
                    "expected_object",
                    value_kind(value),
                )
            })?;
            Ok(PendingInput::new(
                Some(required_bounded_id(object, "id")?),
                optional_bounded_id(object, "runId")?,
                decode_pending_input_state(object.get("state").ok_or_else(|| {
                    payload_error("pendingInputs.items[].state", "missing", "missing")
                })?)?,
            ))
        })
        .collect()
}

fn decode_pending_input_state(value: &Value) -> Result<PendingInputState, HistoryError> {
    match value.as_str() {
        Some("queued") => Ok(PendingInputState::Queued),
        Some("cancelled" | "canceled") => Ok(PendingInputState::Cancelled),
        Some("interrupted") => Ok(PendingInputState::Interrupted),
        Some(_) => Err(payload_error(
            "pendingInputs.items[].state",
            "unsupported_state",
            "string",
        )),
        None => Err(payload_error(
            "pendingInputs.items[].state",
            "expected_string",
            value_kind(value),
        )),
    }
}

fn decode_input_receipts(envelope: &Map<String, Value>) -> Result<Vec<InputReceipt>, HistoryError> {
    let mut receipts = Vec::new();
    append_input_receipts(envelope, "inputReceipts", false, &mut receipts)?;
    append_input_receipts(envelope, "inputConsumptions", true, &mut receipts)?;
    Ok(receipts)
}

fn append_input_receipts(
    envelope: &Map<String, Value>,
    field: &'static str,
    consumed: bool,
    receipts: &mut Vec<InputReceipt>,
) -> Result<(), HistoryError> {
    let Some(value) = envelope.get(field) else {
        return Ok(());
    };
    let values = value
        .as_array()
        .ok_or_else(|| payload_error(field, "expected_array", value_kind(value)))?;
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| payload_error(field, "expected_object", value_kind(value)))?;
        receipts.push(InputReceipt::new(
            optional_bounded_id(object, "inputId")?,
            optional_bounded_id(object, "runId")?,
            consumed,
        ));
    }
    Ok(())
}

fn decode_in_flight_run(
    envelope: &Map<String, Value>,
) -> Result<Option<InFlightRun>, HistoryError> {
    let Some(value) = envelope.get("inFlightRun") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| payload_error("inFlightRun", "expected_object", value_kind(value)))?;
    let run_id = required_bounded_id(object, "runId")?;
    let state = object
        .get("state")
        .or_else(|| object.get("status"))
        .or_else(|| object.get("phase"))
        .map(decode_run_state)
        .transpose()?
        .unwrap_or(RunState::Started);
    let text = optional_string(object, "text")?.unwrap_or_default();
    let text = bounded_message_text(0, "inFlightRun.text", &text)?;
    Ok(Some(InFlightRun::new(run_id, state).with_text(text)))
}

fn decode_run_state(value: &Value) -> Result<RunState, HistoryError> {
    match value.as_str() {
        Some("queued" | "pending") => Ok(RunState::Queued),
        Some("started" | "running" | "inFlight" | "in_flight" | "streaming") => {
            Ok(RunState::Started)
        }
        Some("waitingForApproval" | "waiting_for_approval" | "waitingApproval") => {
            Ok(RunState::WaitingForApproval)
        }
        Some("cancellationRequested" | "cancellation_requested" | "stopping") => {
            Ok(RunState::CancellationRequested)
        }
        Some("cancelled" | "canceled") => Ok(RunState::Cancelled),
        Some("completed" | "complete" | "done" | "ok") => Ok(RunState::Completed),
        Some("failed" | "error") => Ok(RunState::Failed),
        Some("interrupted") => Ok(RunState::Interrupted),
        Some(_) => Err(payload_error(
            "inFlightRun.state",
            "unsupported_state",
            "string",
        )),
        None => Err(payload_error(
            "inFlightRun.state",
            "expected_string",
            value_kind(value),
        )),
    }
}

fn decode_delta_cursor(envelope: &Map<String, Value>) -> Result<Option<String>, HistoryError> {
    let Some(value) = envelope.get("deltaCursor") else {
        return Ok(None);
    };
    let cursor = value
        .as_str()
        .ok_or_else(|| payload_error("deltaCursor", "expected_string", value_kind(value)))?;
    if cursor.is_empty() || cursor.len() > MAX_METADATA_BYTES {
        return Err(payload_error("deltaCursor", "invalid", "string"));
    }
    Ok(Some(cursor.to_owned()))
}

fn required_bounded_id(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<String, HistoryError> {
    let value = object
        .get(field)
        .ok_or_else(|| payload_error(field, "missing", "missing"))?;
    bounded_id(value, field)
}

fn optional_bounded_id(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<String>, HistoryError> {
    object
        .get(field)
        .map(|value| bounded_id(value, field))
        .transpose()
}

fn bounded_id(value: &Value, field: &'static str) -> Result<String, HistoryError> {
    let text = value
        .as_str()
        .ok_or_else(|| payload_error(field, "expected_string", value_kind(value)))?;
    if text.is_empty() || text.len() > MAX_METADATA_BYTES {
        return Err(payload_error(field, "invalid", "string"));
    }
    Ok(text.to_owned())
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
        .map(|(index, message)| decode_message(index, message, None))
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

pub(crate) fn decode_session_message(value: &Value) -> Result<Message, HistoryError> {
    let envelope = value.as_object().ok_or_else(HistoryError::malformed)?;
    let mut message = envelope.get("message").and_then(Value::as_object)
        .cloned().ok_or_else(HistoryError::malformed)?;
    insert_missing_string_alias(&mut message, "messageId", "id", envelope.get("messageId"))?;
    if !message.contains_key("seq") && !message.contains_key("sequence") {
        if let Some(sequence) = envelope.get("messageSeq") { message.insert("seq".to_owned(), sequence.clone()); }
    }
    let message = decode_message(0, &Value::Object(message), Some(envelope))?;
    let mirror_origin = message.mirror_origin().map(str::to_owned);
    let run_terminal = message.run_terminal();
    let has_active_run = match envelope.get("hasActiveRun") {
        None | Some(Value::Null) => None,
        _ => optional_bool(envelope, "hasActiveRun")?,
    };
    Ok(message.with_projection_state(has_active_run, mirror_origin, run_terminal))
}

pub(crate) fn decode_transcript_event_message(
    source_sequence: u64,
    object: &Map<String, Value>,
) -> Result<Message, HistoryError> {
    decode_event_message(Some(source_sequence), object)
}

pub(crate) fn decode_event_message(
    source_sequence: Option<u64>,
    object: &Map<String, Value>,
) -> Result<Message, HistoryError> {
    if source_sequence.is_some_and(|sequence| sequence > MAX_SAFE_SEQUENCE) {
        return Err(payload_error("seq", "exceeds_safe_integer", "number"));
    }
    let value = object
        .get("message")
        .ok_or_else(|| payload_error("message", "missing", "missing"))?;
    let mut message = value
        .as_object()
        .cloned()
        .ok_or_else(|| payload_error("message", "expected_object", value_kind(value)))?;
    insert_missing_string_alias(&mut message, "messageId", "id", object.get("id"))?;
    insert_missing_string_alias(
        &mut message,
        "parentId",
        "parentMessageId",
        object.get("parentId"),
    )?;
    if !message.contains_key("seq") && !message.contains_key("sequence") {
        if let Some(sequence) = source_sequence { message.insert("seq".to_owned(), Value::from(sequence)); }
    }
    decode_message(0, &Value::Object(message), Some(object))
}

fn insert_missing_string_alias(
    message: &mut Map<String, Value>,
    first: &'static str,
    second: &str,
    value: Option<&Value>,
) -> Result<(), HistoryError> {
    if message.contains_key(first) || message.contains_key(second) {
        return Ok(());
    }
    match value {
        Some(Value::String(text)) if !text.is_empty() => {
            message.insert(first.to_owned(), Value::String(text.to_owned()));
            Ok(())
        }
        Some(Value::String(_)) | Some(Value::Null) | None => Ok(()),
        Some(value) => Err(payload_error(
            first,
            "expected_string_or_null",
            value_kind(value),
        )),
    }
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

fn decode_message(index: usize, value: &Value, envelope: Option<&Map<String, Value>>) -> Result<Message, HistoryError> {
    let message = value
        .as_object()
        .ok_or_else(|| message_error(index, "message", "expected_object", value_kind(value)))?;
    let role_value = required_message(message, index, "role")?;
    let role = decode_role(index, string_message(role_value, index, "role")?)?;
    let (text, mut content) = decode_content(index, required_message(message, index, "content")?)?;
    let native = message.get("__openclaw").filter(|value| !value.is_null())
        .map(|value| value.as_object().ok_or_else(|| message_error(index, "__openclaw", "expected_object", value_kind(value))))
        .transpose()?;
    let truncated = native.map(|meta| optional_alias_bool_message(meta, index, "truncated", &["truncated"]))
        .transpose()?.flatten().unwrap_or(false);
    let hidden_control_reply = role == MessageRole::Assistant && hidden_control_reply(message, &text);
    if let Some(media) = native.and_then(|meta| meta.get("media")).and_then(Value::as_array) {
        for fact in media.iter().filter_map(Value::as_object) {
            if fact.get("hydrationSuppressed").and_then(Value::as_bool) == Some(true) { continue; }
            let Some(reference) = fact.get("url").and_then(Value::as_str).and_then(safe_native_media_reference) else { continue; };
            let media_type = explicit_media_type(fact).or_else(|| fact.get("contentType").and_then(Value::as_str)
                .filter(|value| valid_media_reference_shape(value, MAX_TOOL_NAME_BYTES)).map(str::to_owned))
                .or_else(|| infer_media_type(&reference));
            if !content.iter().any(|block| matches!(block, MessageContent::Media { reference: Some(old), .. } if old == &reference)) {
                content.push(MessageContent::Media { media_type, reference: Some(reference), bytes: None });
            }
        }
    }
    let mirror_origin = native.map(|meta| projection_string(meta, index, "mirrorOrigin"))
        .transpose()?.flatten();
    let run_terminal = native.map(|meta| optional_alias_bool_message(meta, index, "runTerminal", &["runTerminal"]))
        .transpose()?.flatten().unwrap_or(false);
    let identity_message_id = native.map(|meta| projection_string(meta, index, "id")).transpose()?.flatten()
        .or(envelope.map(|envelope| projection_string(envelope, index, "messageId")).transpose()?.flatten());
    let message_id = identity_message_id.clone().or(optional_alias_string_message(message, index, "messageId", "id")?);
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
    let fallback = message.get("openclawStreamFallback").filter(|value| !value.is_null())
        .map(|value| value.as_object().ok_or_else(|| message_error(index, "openclawStreamFallback", "expected_object", value_kind(value))))
        .transpose()?;
    let stream_fallback = fallback.map(|fallback| decode_stream_fallback(index, fallback)).transpose()?;
    let display_position = native.and_then(|meta| meta.get("transcriptPosition")).and_then(decode_display_position);
    let is_imported = native.map(|meta| ["importedFrom", "cliSessionId", "externalId"].into_iter()
        .try_fold(false, |imported, field| projection_string(meta, index, field).map(|value| imported || value.is_some())))
        .transpose()?.unwrap_or(false);
    let steer_target_run_id = native.map(|meta| projection_string(meta, index, "steerTargetRunId")).transpose()?.flatten();
    let metadata_run = native.map(|meta| projection_string(meta, index, "runId")).transpose()?.flatten().and_then(normalize_run);
    let envelope_run = envelope.map(|envelope| projection_string(envelope, index, "runId")).transpose()?.flatten().and_then(normalize_run);
    let persisted_run = native.map(|meta| projection_string(meta, index, "idempotencyKey")).transpose()?.flatten()
        .or(projection_string(message, index, "idempotencyKey")?)
        .or(envelope.map(|envelope| projection_string(envelope, index, "idempotencyKey")).transpose()?.flatten())
        .or(envelope.map(|envelope| projection_string(envelope, index, "clientRunId")).transpose()?.flatten())
        .and_then(normalize_run);
    let has_send_identity = persisted_run.is_some();
    let cli_assistant = role == MessageRole::Assistant && projection_string(message, index, "api")?
        .is_some_and(|api| api.eq_ignore_ascii_case("cli"));
    let persisted_run = persisted_run.and_then(|run| {
        if cli_assistant && let Some(run) = run.strip_prefix("cli-assistant:") {
            (!run.trim().is_empty()).then(|| run.trim().to_owned())
        } else { Some(run) }
    });
    let optimistic = native.is_some_and(|meta| meta.keys().all(|field| field == "idempotencyKey"));
    let identity_run_id = if role == MessageRole::Assistant {
        metadata_run.or(envelope_run).or_else(|| (cli_assistant || mirror_origin.is_none() || optimistic).then_some(persisted_run).flatten())
    } else { metadata_run.or(persisted_run).or(envelope_run) };
    let run_id = identity_run_id.clone().or(projection_string(message, index, "runId")?.and_then(normalize_run))
        .or_else(|| (role == MessageRole::Assistant).then(|| stream_fallback.as_ref().and_then(|fallback| fallback.run_id.clone())).flatten());
    let identity_sequence = native.map(|meta| optional_u64_message(meta, index, "seq")).transpose()?.flatten().filter(|seq| *seq > 0)
        .or(envelope.map(|envelope| optional_u64_message(envelope, index, "messageSeq")).transpose()?.flatten().filter(|seq| *seq > 0));
    let sequence = identity_sequence.or(optional_alias_u64_pair_message(message, index, "seq", "sequence")?);
    let after_sequence = match envelope.and_then(|envelope| envelope.get("afterSequence")) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => Some(Some(value.as_u64().ok_or_else(|| message_error(index, "afterSequence", "expected_u64", value_kind(value)))?)),
    };
    if after_sequence.flatten().is_some_and(|seq| seq > MAX_SAFE_SEQUENCE) {
        return Err(message_error(index, "afterSequence", "exceeds_safe_integer", "number"));
    }
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
    ).with_display(display_position, stream_fallback).with_imported(is_imported)
        .with_identity(identity_message_id, identity_run_id, identity_sequence, after_sequence)
        .with_steer_target_run_id(steer_target_run_id)
        .with_projection_state(None, mirror_origin, run_terminal)
        .with_event_facts(
            envelope.map(|envelope| projection_string(envelope, index, "runId")).transpose()?.flatten(),
            envelope.map(|envelope| projection_string(envelope, index, "clientRunId")).transpose()?.flatten(),
            has_send_identity,
            native.is_some_and(|meta| meta.get("seq").and_then(Value::as_u64).is_some_and(|seq| seq > 0)
                || ["importedFrom", "cliSessionId", "externalId"].into_iter().all(|field| meta.get(field).and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty()))),
            terminal_reply_signature(message, run_terminal, hidden_control_reply),
        )
        .with_hidden_control_reply(hidden_control_reply).with_truncated(truncated))
}

fn terminal_reply_signature(message: &Map<String, Value>, run_terminal: bool, hidden: bool) -> Option<String> {
    if hidden { return None; }
    let direct = message.get("phase").and_then(Value::as_str).filter(|phase| matches!(*phase, "commentary" | "final_answer"));
    let mut phase = None;
    let mut mixed = false;
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks.iter().filter(|block| block.get("type").and_then(Value::as_str).is_some_and(|kind| TEXT_BLOCK_TYPES.contains(&kind))) {
            let signature = block.get("textSignature").and_then(Value::as_str).and_then(|value| serde_json::from_str::<Value>(value).ok());
            let Some(signature) = signature.filter(|value| value.get("v").and_then(Value::as_u64) == Some(1)) else { continue; };
            if let Some(next) = signature.get("phase").and_then(Value::as_str).filter(|phase| matches!(*phase, "commentary" | "final_answer")) {
                mixed |= phase.is_some_and(|phase| phase != next);
                phase = Some(if next == "commentary" { "commentary" } else { "final_answer" });
            }
        }
    }
    let phase = direct.or_else(|| (!mixed).then_some(phase).flatten());
    let stop = message.get("stopReason").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
    if phase == Some("commentary") || ((stop.is_empty() || stop == "tooluse") && !run_terminal) { return None; }
    let content = match message.get("content")? {
        Value::String(text) if !text.trim().is_empty() => vec![serde_json::json!({ "type": "text", "text": text })],
        Value::Array(blocks) => blocks.iter().filter(|block| {
            let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "text" { block.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty()) }
            else { !TOOL_CALL_BLOCK_TYPES.contains(&kind) && !TOOL_RESULT_BLOCK_TYPES.contains(&kind) }
        }).cloned().collect(),
        _ => Vec::new(),
    };
    (!content.is_empty()).then(|| serde_json::to_string(&content).ok()).flatten()
}

fn projection_string(object: &Map<String, Value>, index: usize, field: &'static str) -> Result<Option<String>, HistoryError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let text = string_message(value, index, field)?.trim();
            if text.len() > MAX_METADATA_BYTES { return Err(message_error(index, field, "string_too_large", "string")); }
            Ok((!text.is_empty()).then(|| text.to_owned()))
        }
    }
}

fn normalize_run(run: String) -> Option<String> {
    let run = run.strip_suffix(":user").unwrap_or(&run);
    (!run.is_empty()).then(|| run.to_owned())
}

fn decode_display_position(value: &Value) -> Option<DisplayPosition> {
    let object = value.as_object()?;
    let source = object.get("source")?.as_str()?;
    if source.is_empty() || source.encode_utf16().count() > 128 { return None; }
    let raw_seq = object.get("rawSeq")?.as_u64()?;
    let activity = match object.get("activity") {
        None => None,
        Some(value) => {
            let activity = value.as_object()?;
            let after_raw_seq = match activity.get("afterRawSeq")? {
                Value::Null => None,
                value => Some(value.as_u64()?),
            };
            if after_raw_seq.is_some_and(|after| after >= raw_seq) { return None; }
            let scope_id = activity.get("scopeId")?.as_str()?;
            if scope_id.is_empty() || scope_id.encode_utf16().count() > 1024 { return None; }
            Some(ActivityPosition { after_raw_seq, scope_id: scope_id.to_owned(), start_order: activity.get("startOrder")?.as_u64()? })
        }
    };
    Some(DisplayPosition { source: source.to_owned(), raw_seq, activity })
}

fn decode_stream_fallback(index: usize, object: &Map<String, Value>) -> Result<StreamFallback, HistoryError> {
    let source = match object.get("source").and_then(Value::as_str) {
        Some("segment") => StreamFallbackSource::Segment,
        Some("current") => StreamFallbackSource::Current,
        _ => return Err(message_error(index, "openclawStreamFallback.source", "unsupported_source", "missing_or_invalid")),
    };
    let replacement_text = bounded_message_text(index, "replacementText", string_message(required_message(object, index, "replacementText")?, index, "replacementText")?)?;
    Ok(StreamFallback {
        source,
        replacement_text,
        item_id: projection_string(object, index, "itemId")?,
        run_id: projection_string(object, index, "runId")?,
        after_boundary_run_id: projection_string(object, index, "afterBoundaryRunId")?,
    })
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
            Some(block_type) if TEXT_BLOCK_TYPES.contains(&block_type) => {
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
            Some("thinking") => {
                let text_value = required_block(block, message_index, block_index, "thinking")?;
                let text = bounded_block_text(
                    message_index,
                    block_index,
                    "thinking",
                    string_block(text_value, message_index, block_index, "thinking")?,
                )?;
                content.push(MessageContent::Thinking { text });
            }
            Some("redacted_thinking") => {
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
                let output_value = tool_result_output(block);
                let summary = first_alias_value(block, TOOL_RESULT_SUMMARY_FIELDS)
                    .or(output_value)
                    .and_then(safe_summary)
                    .transpose()?;
                let output = output_value.and_then(project_tool_payload);
                let details = tool_details(block, output_value);
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
                    details,
                    is_error,
                });
            }
            Some("image" | "audio" | "video" | "media" | "attachment") => {
                let media = block.get("attachment").and_then(Value::as_object).unwrap_or(block);
                let source = media.get("source").and_then(Value::as_object);
                let media_type = bounded_optional_block_string(
                    message_index,
                    block_index,
                    "mimeType|mediaType|media_type",
                    media.get("mimeType").or_else(|| media.get("mediaType"))
                        .or_else(|| source.and_then(|source| source.get("mimeType").or_else(|| source.get("mediaType")).or_else(|| source.get("media_type")))),
                    MAX_METADATA_BYTES,
                )?;
                let reference = bounded_optional_block_string(
                    message_index,
                    block_index,
                    "ref|reference|viewId",
                    media.get("ref").or_else(|| media.get("reference")).or_else(|| media.get("viewId")),
                    MAX_MEDIA_REF_BYTES,
                )?.or_else(|| native_media_reference(media));
                let media_type = media_type.or_else(|| reference.as_deref().and_then(infer_media_type));
                let bytes = [Some(media), source].into_iter().flatten()
                    .find_map(|media| media.get("data").or_else(|| media.get("blob")).and_then(Value::as_str).map(str::len));
                content.push(MessageContent::Media { media_type, reference, bytes });
            }
            Some(_) | None => content.push(MessageContent::Omitted {
                kind: OmittedContentKind::Unknown,
            }),
        }
    }
    let text = join_display_text(message_index, text_parts.iter().map(String::as_str), MAX_TEXT_BYTES)?;
    Ok((text, content))
}

fn native_media_reference(media: &Map<String, Value>) -> Option<String> {
    let fields = ["url", "openUrl", "image_url", "audio_url", "video_url"];
    [Some(media), media.get("source").and_then(Value::as_object)].into_iter().flatten()
        .flat_map(|media| fields.into_iter().filter_map(move |field| media.get(field).and_then(Value::as_str)))
        .chain(media.get("source").and_then(Value::as_str))
        .find_map(safe_native_media_reference)
}

fn safe_native_media_reference(reference: &str) -> Option<String> {
    let value = reference.trim();
    if !valid_media_reference_shape(value, MAX_MEDIA_REF_BYTES) || value.contains(['?', '#']) {
        return None;
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX) { return Some(value.to_owned()); }
    if value.starts_with(OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH) { return Some(format!("/{value}")); }
    let url = reqwest::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none()).then(|| url.to_string())
}

fn hidden_control_reply(message: &Map<String, Value>, text: &str) -> bool {
    let content = message.get("content");
    let has_visible_nontext = content.and_then(Value::as_array).is_some_and(|blocks| blocks.iter().any(|block| {
        !matches!(block.get("type").and_then(Value::as_str), Some("text" | "thinking" | "reasoning"))
    }));
    if has_visible_nontext { return false; }
    if message.get("text").and_then(Value::as_str).unwrap_or(text).trim() == "NO_REPLY" { return true; }
    if message.get("senderLabel").and_then(Value::as_str).is_some_and(|label| !label.trim().is_empty()) { return false; }
    let text = match content {
        Some(Value::Array(blocks)) => blocks.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str)).collect::<String>(),
        Some(Value::String(text)) => text.clone(),
        _ => text.to_owned(),
    };
    if !text.contains("HEARTBEAT_OK") { return false; }
    let original = heartbeat_edges(&text);
    let mut normalized = String::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find('<') {
        normalized.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else { rest = &rest[start..]; break; };
        normalized.push(' ');
        rest = &rest[start + end + 1..];
    }
    normalized.push_str(rest);
    let normalized = normalized.replace("&nbsp;", " ").replace("&NBSP;", " ");
    let normalized = normalized.trim().trim_matches(|ch| matches!(ch, '*' | '`' | '~' | '_'));
    let normalized = heartbeat_edges(normalized);
    let picked = if original.1 && !original.0.is_empty() { original } else { normalized };
    picked.1 && picked.0.encode_utf16().count() <= 300
}

fn heartbeat_edges(text: &str) -> (String, bool) {
    let mut text = text.trim().to_owned();
    let mut stripped = false;
    loop {
        if let Some(rest) = text.strip_prefix("HEARTBEAT_OK") {
            text = rest.trim_start().to_owned();
        } else if let Some(index) = text.rfind("HEARTBEAT_OK") {
            let tail = &text[index + "HEARTBEAT_OK".len()..];
            if tail.encode_utf16().count() > 4 || tail.chars().any(|ch| ch.is_ascii_alphanumeric() || ch == '_') { break; }
            let before = text[..index].trim_end();
            text = if before.is_empty() { String::new() } else { format!("{before}{tail}").trim_end().to_owned() };
        } else { break; }
        stripped = true;
    }
    (text.split_whitespace().collect::<Vec<_>>().join(" "), stripped)
}

pub(crate) fn decode_complete_text(value: &Value) -> Result<String, HistoryError> {
    let message = value.as_object().ok_or_else(HistoryError::malformed)?;
    if let Some(meta) = message.get("__openclaw").filter(|value| !value.is_null()) {
        let meta = meta.as_object().ok_or_else(HistoryError::malformed)?;
        if optional_alias_bool_message(meta, 0, "truncated", &["truncated"])?.unwrap_or(false) {
            return Err(message_error(0, "truncated", "incomplete_message", "boolean"));
        }
    }
    let text = display_content_text(0, required_message(message, 0, "content")?, 8_000_000)?;
    if text.encode_utf16().count() > 2_000_000 {
        return Err(message_error(0, "content", "text_too_large", "string"));
    }
    Ok(text)
}

fn display_content_text(index: usize, value: &Value, max_bytes: usize) -> Result<String, HistoryError> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => {
            let mut parts = Vec::new();
            let mut bytes = 0usize;
            for (block_index, block) in blocks.iter().enumerate() {
                let block = block.as_object().ok_or_else(|| block_error(index, block_index, "content[]", "expected_object", value_kind(block)))?;
                if block.get("type").and_then(Value::as_str).is_some_and(|kind| TEXT_BLOCK_TYPES.contains(&kind)) {
                    let text = string_block(required_block(block, index, block_index, "text")?, index, block_index, "text")?;
                    bytes = bytes.saturating_add(text.len()).saturating_add(usize::from(!parts.is_empty()));
                    if bytes > max_bytes { return Err(message_error(index, "content", "text_too_large", "string")); }
                    parts.push(text);
                }
            }
            join_display_text(index, parts.into_iter(), max_bytes)?
        }
        _ => return Err(message_error(index, "content", "expected_string_or_array", value_kind(value))),
    };
    if text.len() > max_bytes { return Err(message_error(index, "content", "text_too_large", "string")); }
    Ok(text)
}

fn join_display_text<'a>(index: usize, parts: impl Iterator<Item = &'a str>, max_bytes: usize) -> Result<String, HistoryError> {
    let mut text = String::new();
    for (part_index, part) in parts.enumerate() {
        if text.len().saturating_add(part.len()).saturating_add(usize::from(part_index > 0)) > max_bytes {
            return Err(message_error(index, "content", "text_too_large", "string"));
        }
        if part_index > 0 { text.push('\n'); }
        text.push_str(part);
    }
    Ok(text)
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
    let output_value = tool_result_output(message);
    let output = output_value.and_then(project_tool_payload);
    let details = tool_details(message, output_value);
    content.push(MessageContent::ToolResult {
        tool_name,
        tool_call_id: tool_call_id.map(str::to_owned),
        summary: non_empty_summary(text),
        output,
        details,
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
    if !valid_media_reference_shape(value, MAX_DELIVERY_MEDIA_REF_BYTES) {
        return None;
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX) {
        return Some(value.to_owned());
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH) {
        return Some(format!("/{value}"));
    }
    ((value.starts_with("https://") || value.starts_with("http://")) && !value.contains(['?', '#']))
        .then(|| value.to_owned())
}

fn valid_media_reference_shape(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
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

fn tool_result_output(object: &Map<String, Value>) -> Option<&Value> {
    let result = object.get("result");
    if result
        .and_then(Value::as_object)
        .is_some_and(|result| result.len() == 1 && result.contains_key("details"))
    {
        return object.get("content").or_else(|| object.get("output"));
    }
    result
        .or_else(|| object.get("output"))
        .or_else(|| object.get("partialResult"))
        .or_else(|| object.get("partial_result"))
        .or_else(|| object.get("content"))
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

fn tool_details(object: &Map<String, Value>, output_value: Option<&Value>) -> Option<Value> {
    project_tool_details([
        object
            .get("result")
            .and_then(|result| result.get("details")),
        output_value.and_then(|output| output.get("details")),
        object.get("details"),
    ])
}

fn project_tool_details(values: [Option<&Value>; 3]) -> Option<Value> {
    let mut details = Map::new();
    for value in values.into_iter().flatten() {
        let Some(object) = value.as_object() else {
            continue;
        };
        for key in [
            "browserTab",
            "changed",
            "created",
            "diff",
            "patch",
            "approvalReviews",
            "approvalReviewOutcome",
            "mcpAppPreview",
            "truncation",
            "fullOutputPath",
            "exitCode",
        ] {
            let projected = if key == "mcpAppPreview" {
                object.get(key).and_then(project_mcp_app_preview_value)
            } else {
                object.get(key).and_then(project_tool_detail_value)
            };
            if let Some(projected) = projected {
                details.insert(key.to_owned(), projected);
            }
        }
    }
    if details.is_empty() {
        return None;
    }
    let value = Value::Object(details);
    if tool_payload_contains_nul(&value) {
        return None;
    }
    let text = serde_json::to_string(&value).ok()?;
    (text.len() <= MAX_TOOL_PAYLOAD_BYTES).then_some(value)
}

fn project_mcp_app_preview_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut projected = Map::new();
    for key in [
        "kind",
        "surface",
        "render",
        "title",
        "preferredHeight",
        "url",
        "viewId",
        "sandbox",
        "boardWidgetName",
    ] {
        if let Some(value) = object.get(key).and_then(project_tool_detail_value) {
            projected.insert(key.to_owned(), value);
        }
    }
    if let Some(value) = object
        .get("mcpApp")
        .and_then(project_mcp_app_descriptor_value)
    {
        projected.insert("mcpApp".to_owned(), value);
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn project_mcp_app_descriptor_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut projected = Map::new();
    for key in [
        "viewId",
        "serverName",
        "toolName",
        "uiResourceUri",
        "toolCallId",
        "originSessionKey",
        "resultMetaState",
    ] {
        if let Some(value) = object.get(key).and_then(project_tool_detail_value) {
            projected.insert(key.to_owned(), value);
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn project_tool_detail_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.clone()),
        Value::Array(values) => Some(Value::Array(
            values
                .iter()
                .filter_map(project_tool_detail_value)
                .collect(),
        )),
        Value::Object(object) => {
            let mut projected = Map::new();
            for (key, value) in object {
                if key.contains('\0') || raw_tool_detail_key(key) {
                    continue;
                }
                if let Some(value) = project_tool_detail_value(value) {
                    projected.insert(key.clone(), value);
                }
            }
            Some(Value::Object(projected))
        }
    }
}

fn raw_tool_detail_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|char| *char != '_' && *char != '-')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "rawassistanttext"
            | "toolinput"
            | "tooloutput"
            | "toolresult"
            | "privatepayload"
            | "html"
            | "input"
            | "output"
    ) || normalized.contains("secret")
        || normalized.starts_with("raw")
        || normalized.starts_with("private")
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

fn optional_usize(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<usize>, HistoryError> {
    object
        .get(field)
        .map(|value| {
            let value = value
                .as_u64()
                .ok_or_else(|| payload_error(field, "expected_u64", value_kind(value)))?;
            usize::try_from(value).map_err(|_| payload_error(field, "too_large", "number"))
        })
        .transpose()
}

fn optional_bool(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<bool>, HistoryError> {
    object
        .get(field)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| payload_error(field, "expected_boolean", value_kind(value)))
        })
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn message_tool_delivery_omits_tokenized_public_media_urls() {
        let window = decode_window(
            json!({
                "messages": [{
                    "role": "toolResult",
                    "toolName": "message",
                    "content": [{
                        "type": "toolResult",
                        "toolName": "message",
                        "result": { "ok": true }
                    }],
                    "details": {
                        "sourceReplySink": "internal-ui",
                        "sourceReply": {
                            "text": "uploaded",
                            "mediaUrls": [
                                "https://cdn.example.test/image.png?token=secret",
                                "https://cdn.example.test/image.png#secret",
                                "https://cdn.example.test/image.png",
                                "/api/chat/media/outgoing/session/image.png",
                                "api/chat/media/outgoing/session/relative.png"
                            ]
                        }
                    }
                }]
            }),
            PageRequest::latest(),
        )
        .unwrap();

        let media = message_tool_delivery_media(&window);
        let references = media
            .iter()
            .map(|media| media.reference())
            .collect::<Vec<_>>();

        assert!(!references.contains(&"https://cdn.example.test/image.png?token=secret"));
        assert!(!references.contains(&"https://cdn.example.test/image.png#secret"));
        assert!(references.contains(&"https://cdn.example.test/image.png"));
        assert!(references.contains(&"/api/chat/media/outgoing/session/image.png"));
        assert!(references.contains(&"/api/chat/media/outgoing/session/relative.png"));
    }

    fn message_tool_delivery_media(window: &SessionWindow) -> &[MessageToolDeliveryMedia] {
        window
            .messages()
            .iter()
            .flat_map(|message| message.content())
            .find_map(|content| match content {
                MessageContent::MessageToolDelivery { media, .. } => Some(media.as_slice()),
                _ => None,
            })
            .unwrap()
    }
}
