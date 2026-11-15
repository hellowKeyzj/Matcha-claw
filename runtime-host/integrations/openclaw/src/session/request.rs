use std::collections::BTreeMap;

use serde_json::Value;
use sessions_module::{
    execution::{SessionRunReadCommand, SessionRunReadOutcome, SessionRunRecord, SessionRunSelector},
    ports::RuntimeOperationFailure,
    state::{MAX_ID_BYTES, MAX_INPUT_IDS, MAX_ITEMS, MAX_TEXT_BYTES, RunPhase, SessionIdentity, SessionInputReceipt},
};

use super::super::{
    protocol::{ChatHistoryParams, HistoryAnchor, HistoryPath, HistoryRelation, SessionKey},
    window::{self, Message, MessageRole, PageRequest},
};
use super::{OperationError, SessionOperation, next_request_id, payload, request};

impl SessionOperation {
    pub(crate) async fn check_work_pending(&self, identity: &SessionIdentity, endpoint_session_id: Option<&str>, generation: u64) -> Result<bool, RuntimeOperationFailure> {
        crate::port::validate_observation_identity(identity)?;
        let _native = self.gateway.observations.lock_native(identity).await;
        let epoch = {
            let entries = self.gateway.observations.entries.lock().expect("observation registry lock poisoned");
            let entry = entries.get(&crate::gateway::observation::identity_key(identity))
                .filter(|entry| entry.generation == generation && !entry.paused
                    && entry.source_epoch.is_some() && entry.subscribed_epoch == entry.source_epoch)
                .ok_or(RuntimeOperationFailure::Unavailable)?;
            entry.source_epoch.ok_or(RuntimeOperationFailure::Unavailable)?
        };
        if !self.gateway.observations.is_active(identity, generation, epoch) { return Err(RuntimeOperationFailure::Unavailable); }
        let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        let params = ChatHistoryParams::new(key).try_for_agent(identity.agent_id.clone())
            .and_then(|params| params.try_with_limit(1))
            .and_then(|params| params.try_with_max_chars(1))
            .map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        // No OrderedContext: ordered ingress returns the response without projecting history.
        let result = self.history_payload(params).await;
        if !self.gateway.observations.is_active(identity, generation, epoch) { return Err(RuntimeOperationFailure::Unavailable); }
        let payload = result.map_err(|error| match error {
            OperationError::Rejected | OperationError::GatewayRejected { .. } => RuntimeOperationFailure::TargetRejected,
            OperationError::Protocol | OperationError::UnknownResponse => RuntimeOperationFailure::Unknown,
            _ => RuntimeOperationFailure::Unavailable,
        })?;
        let native_session = payload.get("sessionId").and_then(Value::as_str).ok_or(RuntimeOperationFailure::Unknown)?;
        check_session(identity, endpoint_session_id, &payload, native_session).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
        if payload.pointer("/sessionInfo/agentId").and_then(Value::as_str) != Some(identity.agent_id.as_str())
            || payload.pointer("/sessionInfo/sessionId").and_then(Value::as_str) != Some(native_session)
        { return Err(RuntimeOperationFailure::TargetRejected); }
        let pending = payload.pointer("/sessionInfo/hasPendingWork").and_then(Value::as_bool).ok_or(RuntimeOperationFailure::Unknown)?;
        drop(_native);
        self.gateway.observations.await_ingress(identity, generation, epoch).await?;
        Ok(pending)
    }

    pub(crate) async fn read_request_run(&self, command: SessionRunReadCommand) -> SessionRunReadOutcome {
        if crate::port::validate_observation_identity(&command.identity).is_err() {
            return SessionRunReadOutcome::Rejected;
        }
        match self.request_run(&command).await {
            Ok(Some(record)) => SessionRunReadOutcome::Found(record),
            Ok(None) => SessionRunReadOutcome::NotFound,
            Err(OperationError::Rejected) => SessionRunReadOutcome::Rejected,
            Err(OperationError::Protocol | OperationError::UnknownResponse) => SessionRunReadOutcome::Unknown,
            Err(_) => SessionRunReadOutcome::Unavailable,
        }
    }

    async fn request_run(&self, command: &SessionRunReadCommand) -> Result<Option<SessionRunRecord>, OperationError> {
        let root = match &command.selector {
            SessionRunSelector::RunId(id) | SessionRunSelector::RequestId(id) => id,
        };
        let key = SessionKey::try_new(command.identity.session_key.clone()).map_err(|_| OperationError::Rejected)?;
        let params = ChatHistoryParams::new(key)
            .try_for_agent(command.identity.agent_id.clone())
            .and_then(|params| params.try_with_input_run_ids(vec![root.clone()]))
            .and_then(|params| params.try_with_max_chars(16_000))
            .map_err(|_| OperationError::Rejected)?;
        let initial = self.history_payload(params.clone().try_with_limit(1)?).await?;
        let mut snapshot = window::decode_window(initial.clone(), PageRequest::new(window::Direction::Latest, 1, None).expect("valid history page"))
            .map_err(|_| OperationError::Protocol)?;
        let native_session = snapshot.native_session_id().ok_or(OperationError::Protocol)?.to_owned();
        check_session(&command.identity, command.endpoint_session_id.as_deref(), &initial, &native_session)?;
        let pending = snapshot.state().work_pending().ok_or(OperationError::Protocol)?;
        let mut root_id = consumed_input(snapshot.take_input_receipts(), &initial, root)?;
        let mut root_sequence = None;
        for value in history_messages(&initial)? {
            if matches_root(value, root, root_id.as_deref()) {
                set_root(&mut root_id, &mut root_sequence, value)?;
            }
        }
        if pending && let Some(message_id) = root_id.clone().or_else(|| pending_message_id(&initial, root)) {
            return Ok(Some(run_record(root, message_id, RunPhase::Yielded, Vec::new())));
        }
        let total = window::decode_total_messages(&initial).map_err(|_| OperationError::Protocol)?;
        let anchor = snapshot.state().history_path().flatten().map(|path| path.anchor.clone()).ok_or(OperationError::Protocol)?;
        if anchor.session_id != native_session || snapshot.state().kind() != window::HistoryKind::Full {
            return Err(OperationError::Protocol);
        }
        let params = params.with_history_anchor(Some(anchor.clone()));
        let mut messages = Vec::new();
        let mut message_indices = BTreeMap::new();
        let mut last_execution: Option<(u64, Option<String>)> = None;
        let mut offset = 0;
        let mut found_root = false;
        let mut last_user_sequence = None;
        for _ in 0..MAX_ITEMS {
            let page = self.history_payload(params.clone().try_with_limit(MAX_ITEMS as u64)?.try_with_offset(offset as u64)?).await?;
            check_session(&command.identity, command.endpoint_session_id.as_deref(), &page, &native_session)?;
            check_snapshot(&page, &anchor, total)?;
            let values = history_messages(&page)?;
            let mut previous = 9_007_199_254_740_991;
            for value in values.iter().rev() {
                if matches_root(value, root, root_id.as_deref()) {
                    set_root(&mut root_id, &mut root_sequence, value)?;
                    found_root = true;
                    if root_sequence.is_some_and(|root| last_user_sequence.is_some_and(|sequence| sequence > root)) {
                        return Err(OperationError::Rejected);
                    }
                }
                let Some(sequence) = value.pointer("/__openclaw/seq").and_then(Value::as_u64) else {
                    if matches!(value.get("role").and_then(Value::as_str), Some("user" | "assistant")) {
                        return Err(OperationError::Protocol);
                    }
                    continue;
                };
                if sequence > previous { return Err(OperationError::Protocol); }
                previous = sequence;
                if pending || root_sequence.is_some_and(|root| sequence <= root) { continue; }
                let role = value.get("role").and_then(Value::as_str);
                if role == Some("user") && !synthetic_input(value)? {
                    if root_sequence.is_some() { return Err(OperationError::Rejected); }
                    last_user_sequence = last_user_sequence.max(Some(sequence));
                    continue;
                }
                let message = decode_message(value)?;
                if role == Some("user") || formal_assistant(&message, value) {
                    let run = if role == Some("user") {
                        value.pointer("/__openclaw/runId").and_then(Value::as_str)
                    } else { message.identity_run_id() }.filter(|run| valid_id(run)).map(str::to_owned);
                    if last_execution.as_ref().is_none_or(|last| sequence > last.0) { last_execution = Some((sequence, run)); }
                    else if last_execution.as_ref().is_some_and(|last| sequence == last.0 && last.1 != run) { return Err(OperationError::Protocol); }
                }
                if !formal_assistant(&message, value) || message.hidden_control_reply() || message.text().is_empty() && !message.truncated() { continue; }
                let message_id = message.identity_message_id().ok_or(OperationError::Protocol)?;
                if let Some(index) = message_indices.get(message_id) {
                    if messages[*index] != message { return Err(OperationError::Protocol); }
                } else {
                    if messages.len() == MAX_ITEMS || !valid_id(message_id) { return Err(OperationError::Protocol); }
                    message_indices.insert(message_id.to_owned(), messages.len());
                    messages.push(message);
                }
            }
            if found_root { break; }
            let has_more = page.get("hasMore").and_then(Value::as_bool).ok_or(OperationError::Protocol)?;
            if !has_more { return Err(OperationError::Protocol); }
            let next = page.get("nextOffset").and_then(Value::as_u64).ok_or(OperationError::Protocol)?;
            if next <= offset as u64 || next > total as u64 { return Err(OperationError::Protocol); }
            offset = next as usize;
        }
        if !found_root { return Err(OperationError::Protocol); }
        let message_id = root_id.ok_or(OperationError::Protocol)?;
        if pending { return Ok(Some(run_record(root, message_id, RunPhase::Yielded, Vec::new()))); }
        let root_sequence = root_sequence.ok_or(OperationError::Protocol)?;
        let mut assistant_texts = Vec::with_capacity(messages.len());
        let mut remaining = MAX_ITEMS * MAX_TEXT_BYTES;
        for message in messages.into_iter().rev() {
            let sequence = message.identity_sequence().ok_or(OperationError::Protocol)?;
            if sequence <= root_sequence { continue; }
            let text = if message.truncated() {
                let full = self.message_text(&command.identity, message.identity_message_id().ok_or(OperationError::Protocol)?).await?;
                if full.sequence != sequence || !full.is_assistant
                    || full.run_id.as_deref().is_some_and(|run| message.identity_run_id() != Some(run))
                {
                    return Err(OperationError::Protocol);
                }
                full.text
            } else { message.text().to_owned() };
            remaining = remaining.checked_sub(text.len()).ok_or(OperationError::Protocol)?;
            assistant_texts.push(text);
        }
        let last_execution = last_execution.filter(|last| last.0 > root_sequence).unwrap_or((root_sequence, Some(root.clone())));
        let last_run = last_execution.1.as_deref().filter(|run| valid_id(run)).ok_or(OperationError::Protocol)?;
        let phase = match row_phase(&initial)? {
            Some(phase) if initial.pointer("/sessionInfo/lastRunId").and_then(Value::as_str) == Some(last_run) => phase,
            _ => self.wait_run_phase(last_run).await?,
        };
        let final_payload = self.history_payload(params.try_with_limit(1)?.with_history_anchor(Some(anchor.clone()))).await?;
        check_session(&command.identity, command.endpoint_session_id.as_deref(), &final_payload, &native_session)?;
        check_snapshot(&final_payload, &anchor, total)?;
        if final_payload.pointer("/sessionInfo/hasPendingWork").and_then(Value::as_bool) != Some(false)
            || final_payload.pointer("/sessionInfo/lastRunId") != initial.pointer("/sessionInfo/lastRunId")
            || final_payload.pointer("/sessionInfo/status") != initial.pointer("/sessionInfo/status")
        { return Err(OperationError::Protocol); }
        Ok(Some(run_record(root, message_id, phase, assistant_texts)))
    }

    async fn wait_run_phase(&self, run_id: &str) -> Result<RunPhase, OperationError> {
        let id = next_request_id("agent-wait")?;
        let query = request(&id, "agent.wait", serde_json::json!({ "runId": run_id, "timeoutMs": 0 }))?;
        let value = payload(&id, self.gateway.rpc_query(query).await?)?;
        if value.get("runId").and_then(Value::as_str) != Some(run_id)
            || value.get("pendingError").and_then(Value::as_bool) == Some(true)
            || value.get("yielded").and_then(Value::as_bool) == Some(true)
            || value.get("stopReason").and_then(Value::as_str) == Some("restart")
        { return Err(OperationError::Protocol); }
        let status = value.get("status").and_then(Value::as_str).ok_or(OperationError::Protocol)?;
        if !matches!(status, "ok" | "error" | "timeout") { return Err(OperationError::Protocol); }
        let stop = value.get("stopReason").and_then(Value::as_str).map(str::trim);
        let liveness = value.get("livenessState").and_then(Value::as_str).map(str::trim);
        if value.get("timeoutPhase").and_then(Value::as_str).is_some_and(|phase| matches!(phase.trim(), "preflight" | "provider" | "post_turn"))
            || status == "timeout" && value.get("providerStarted").and_then(Value::as_bool) == Some(true)
        { return Ok(RunPhase::Failed); }
        if stop == Some("superseded") { return Ok(RunPhase::Cancelled); }
        if liveness.is_some_and(|state| state.eq_ignore_ascii_case("blocked")) { return Ok(RunPhase::Failed); }
        if stop == Some("aborted") || status != "ok" && matches!(stop, Some("rpc" | "stop")) {
            return Ok(RunPhase::Cancelled);
        }
        if status != "ok" && stop == Some("auth-revoked") { return Ok(RunPhase::Cancelled); }
        if liveness.is_some_and(|state| state.eq_ignore_ascii_case("abandoned")) { return Ok(RunPhase::Failed); }
        match status {
            "ok" => Ok(RunPhase::Completed),
            "error" => Ok(RunPhase::Failed),
            _ => Err(OperationError::Protocol),
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && value.trim() == value && !value.chars().any(char::is_control)
}

fn run_record(root: &str, message_id: String, phase: RunPhase, assistant_texts: Vec<String>) -> SessionRunRecord {
    SessionRunRecord { run_id: root.to_owned(), message_id, request_id: Some(root.to_owned()), phase,
        measurement: sessions_module::execution::SessionRunMeasurement::Unavailable, assistant_texts }
}

fn history_messages(payload: &Value) -> Result<&[Value], OperationError> {
    payload.get("messages").and_then(Value::as_array).filter(|messages| messages.len() <= MAX_ITEMS)
        .map(Vec::as_slice).ok_or(OperationError::Protocol)
}

fn decode_message(value: &Value) -> Result<Message, OperationError> {
    let envelope = serde_json::json!({ "message": value });
    window::decode_event_message(None, envelope.as_object().expect("message envelope"))
        .map_err(|_| OperationError::Protocol)
}

fn matches_root(message: &Value, root: &str, message_id: Option<&str>) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
        && (message.pointer("/__openclaw/id").and_then(Value::as_str).is_some_and(|id| Some(id) == message_id)
            || message.pointer("/__openclaw/runId").and_then(Value::as_str) == Some(root)
            || message.pointer("/__openclaw/idempotencyKey").or_else(|| message.get("idempotencyKey"))
                .and_then(Value::as_str).and_then(|id| id.strip_suffix(":user")) == Some(root))
}

fn set_root(id: &mut Option<String>, sequence: &mut Option<u64>, message: &Value) -> Result<(), OperationError> {
    let message_id = message.pointer("/__openclaw/id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or(OperationError::Protocol)?;
    let seq = message.pointer("/__openclaw/seq").and_then(Value::as_u64).filter(|seq| *seq > 0 && *seq <= 9_007_199_254_740_991).ok_or(OperationError::Protocol)?;
    if message.get("role").and_then(Value::as_str) != Some("user")
        || id.as_deref().is_some_and(|id| id != message_id) || sequence.is_some_and(|known| known != seq)
    { return Err(OperationError::Protocol); }
    *id = Some(message_id.to_owned());
    *sequence = Some(seq);
    Ok(())
}

fn consumed_input(receipts: Option<Vec<SessionInputReceipt>>, payload: &Value, root: &str) -> Result<Option<String>, OperationError> {
    let mut message_id = None;
    for receipt in receipts.unwrap_or_default() {
        match receipt {
            SessionInputReceipt::Consumed { input_id, message_id: id } if input_id == root => { message_id = Some(id); }
            SessionInputReceipt::Pending { input_id, .. } if input_id == root => {}
            _ => return Err(OperationError::Protocol),
        }
    }
    if let Some(values) = payload.get("inputConsumptions") {
        let values = values.as_array().filter(|values| values.len() <= MAX_INPUT_IDS).ok_or(OperationError::Protocol)?;
        for value in values {
            if value.get("runId").and_then(Value::as_str) != Some(root) { return Err(OperationError::Protocol); }
            let id = value.get("consumedByEventId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or(OperationError::Protocol)?;
            if message_id.as_deref().is_some_and(|known| known != id) { return Err(OperationError::Protocol); }
            message_id = Some(id.to_owned());
        }
    }
    Ok(message_id)
}

fn pending_message_id(payload: &Value, root: &str) -> Option<String> {
    let mut matching = payload.pointer("/pendingInputs/items")?.as_array()?.iter()
        .filter(|input| input.get("runId").and_then(Value::as_str) == Some(root));
    let id = matching.next()?.pointer("/message/__openclaw/id")?.as_str().filter(|id| valid_id(id))?;
    matching.next().is_none().then(|| id.to_owned())
}

fn synthetic_input(message: &Value) -> Result<bool, OperationError> {
    match message.pointer("/provenance/kind").and_then(Value::as_str) {
        Some("internal_system") => Ok(true),
        Some("inter_session") => {
            let tool = message.pointer("/provenance/sourceTool").and_then(Value::as_str).map(|tool| tool.trim().to_ascii_lowercase());
            if matches!(tool.as_deref(), Some("agent_harness_task" | "image_generate" | "music_generate" | "video_generate" | "exec_approval_followup" | "subagent_announce" | "subagent_settle" | "subagent_interrupted_resume")) {
                Ok(true)
            } else { Err(OperationError::Protocol) }
        }
        Some("external_user") => Ok(false),
        None if message.get("provenance").is_none_or(Value::is_null) => {
            let decoded = decode_message(message)?;
            if decoded.input_id().is_some() { Ok(false) } else { Err(OperationError::Protocol) }
        }
        _ => Err(OperationError::Protocol),
    }
}

fn formal_assistant(message: &Message, value: &Value) -> bool {
    message.role() == MessageRole::Assistant
        && !(value.get("provider").and_then(Value::as_str) == Some("openclaw")
            && matches!(value.get("model").and_then(Value::as_str), Some("delivery-mirror" | "gateway-injected")))
        && value.get("openclawDeliveryMirror").is_none() && value.get("openclawMessageToolMirror").is_none()
}

fn row_phase(payload: &Value) -> Result<Option<RunPhase>, OperationError> {
    match payload.pointer("/sessionInfo/status").and_then(Value::as_str) {
        Some("done") => Ok(Some(RunPhase::Completed)),
        Some("failed" | "timeout") => Ok(Some(RunPhase::Failed)),
        Some("killed") => Ok(Some(RunPhase::Cancelled)),
        Some("running" | "queued") | None => Ok(None),
        _ => Err(OperationError::Protocol),
    }
}

fn check_session(identity: &SessionIdentity, endpoint_session_id: Option<&str>, payload: &Value, native_session: &str) -> Result<(), OperationError> {
    if !valid_id(native_session) || payload.get("sessionKey").and_then(Value::as_str) != Some(identity.session_key.as_str())
        || payload.get("sessionId").and_then(Value::as_str) != Some(native_session)
        || endpoint_session_id.is_some_and(|id| id != native_session)
        || payload.pointer("/sessionInfo/agentId").and_then(Value::as_str).is_some_and(|agent| agent != identity.agent_id)
    { return Err(OperationError::Rejected); }
    Ok(())
}

fn check_snapshot(payload: &Value, anchor: &HistoryAnchor, total: usize) -> Result<(), OperationError> {
    let path: HistoryPath = serde_json::from_value(payload.get("historyPath").cloned().ok_or(OperationError::Protocol)?)
        .map_err(|_| OperationError::Protocol)?;
    if window::decode_total_messages(payload).map_err(|_| OperationError::Protocol)? != total
        || path.anchor != *anchor || path.previous.as_ref() != Some(anchor)
        || path.relation != Some(HistoryRelation::Exact) || payload.get("kind").is_some()
    { return Err(OperationError::Protocol); }
    Ok(())
}
