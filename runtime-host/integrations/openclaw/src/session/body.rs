use std::collections::{HashMap, HashSet};

use sessions_module::state::{ItemAnchor, ItemStatus, RunPhase, SessionContent, SessionItem};
use sessions_module::trace;

use super::{adapters::timeline::{OpenClawReplayProjection, transcript_session_item}, projection::{AssistantTurnChunkKind, CanonicalSessionChange}, protocol::{ChatEvent, SessionActivity}, window::{Message, MessageRole}};

mod history;
mod identity;
mod placement;
mod reconciliation;
mod terminal;

use identity::Provisional;

#[derive(Clone, Default)]
pub(super) struct Body {
    pub items: Vec<SessionItem>,
    streams: HashMap<String, Stream>,
    persisted: Vec<Persisted>,
    history_ids: HashSet<String>,
    pub terminal: Vec<(String, RunPhase)>,
    pub retired: Vec<String>,
    next_id: u64,
    evicted: Vec<String>,
    live_run: Option<String>,
    terminal_marker: Option<TerminalMarker>,
    accepted_finals: HashSet<String>,
    last_terminal_run: Option<String>,
}

#[derive(Clone)]
struct Persisted {
    id: String,
    message: Message,
}

impl std::ops::Deref for Persisted {
    type Target = Message;

    fn deref(&self) -> &Message { &self.message }
}

#[derive(Clone)]
struct TerminalMarker {
    message_id: String,
    run_id: String,
    history_applied: bool,
}

#[derive(Clone, Default)]
struct Stream {
    text: Option<String>,
    thinking: String,
    latest_boundary_run_id: Option<String>,
    latest_tool: Option<String>,
    parts: Vec<Part>,
    closed: Vec<Closed>,
    boundary: bool,
    body_closed: bool,
    anchors: Vec<String>,
    provisional: Vec<Provisional>,
}

#[derive(Clone)]
struct Part {
    id: Option<String>,
    start: usize,
    end: usize,
    covered: usize,
    observed: bool,
    content_before: bool,
    after_tool: Option<String>,
    before_tool: Option<String>,
    after: Option<String>,
    after_boundary_run_id: Option<String>,
    boundary_run_id: Option<String>,
}

#[derive(Clone)]
struct Closed {
    text: String,
    parts: Vec<Part>,
    after_boundary_run_id: Option<String>,
    boundary_run_id: Option<String>,
    tool_boundary: bool,
}

impl Stream {
    fn accumulated_text(&self) -> Option<&str> {
        self.closed.iter().map(|closed| closed.text.as_str()).fold(None, reconciliation::advance)
    }

    fn text(&self) -> Option<&str> {
        self.text.as_deref().or_else(|| self.accumulated_text())
    }

    fn all_parts(&self) -> impl Iterator<Item = &Part> {
        self.closed.iter().flat_map(|closed| &closed.parts).chain(&self.parts)
    }

    fn all_parts_mut(&mut self) -> impl Iterator<Item = &mut Part> {
        self.closed.iter_mut().flat_map(|closed| &mut closed.parts).chain(&mut self.parts)
    }

    fn part_count(&self) -> usize {
        self.closed.len() + self.closed.iter().map(|closed| closed.parts.len()).sum::<usize>() + self.parts.len()
    }

    fn observe_prefix(&mut self, text: String, boundary: Option<String>) {
        if let Some(last) = self.closed.last_mut().filter(|closed| closed.parts.is_empty()
            && closed.boundary_run_id.is_none() && !closed.tool_boundary)
        {
            last.text = text;
            last.boundary_run_id = boundary;
        } else {
            self.closed.push(Closed { text, parts: Vec::new(), after_boundary_run_id: None,
                boundary_run_id: boundary, tool_boundary: false });
        }
    }

    fn text_bytes(&self) -> usize {
        self.text.as_ref().map_or(0, String::len) + self.closed.iter().map(|closed| closed.text.len()).sum::<usize>()
    }
}

impl Body {
    pub(super) fn trace_committed(&self, stage: &str) {
        if trace::enabled() {
            trace::log_unscoped(stage, serde_json::json!({
                "commitState": "committed", "items": trace::items_shape(&self.items), "persistedCount": self.persisted.len(),
                "streamsTotal": self.streams.len(), "streamsSummarized": self.streams.len().min(200), "streamsTruncated": self.streams.len() > 200,
                "streams": self.streams.iter().take(200).map(|(run, stream)| serde_json::json!({
                    "runHash": trace::fingerprint(run), "acceptedBaseline": stream.text().map(trace::text_shape),
                    "currentBaseline": stream.text.as_deref().map(trace::text_shape), "closedBaseline": stream.accumulated_text().map(trace::text_shape),
                    "closedCount": stream.closed.len(), "currentPartCount": stream.parts.len(),
                    "thinkingBaseline": trace::text_shape(&stream.thinking), "boundary": stream.boundary,
                    "partsTotal": stream.part_count(), "partsSummarized": stream.part_count().min(200), "partsTruncated": stream.part_count() > 200,
                    "parts": stream.parts.iter().take(200).map(|part| serde_json::json!({
                        "itemHash": part.id.as_deref().map(trace::fingerprint), "startUtf8": part.start, "endUtf8": part.end })).collect::<Vec<_>>(),
                    "anchorsCount": stream.anchors.len(),
                })).collect::<Vec<_>>(),
                "terminalMarkerPresence": self.terminal_marker.is_some(),
                "markerRunHash": self.terminal_marker.as_ref().map(|marker| trace::fingerprint(&marker.run_id)),
                "markerMessageHash": self.terminal_marker.as_ref().map(|marker| trace::fingerprint(&marker.message_id)),
                "historyApplied": self.terminal_marker.as_ref().map(|marker| marker.history_applied), "pending": self.needs_terminal_history(),
                "terminalCount": self.terminal.len(), "retiredTotal": self.retired.len(), "retiredSummarized": self.retired.len().min(200),
                "retiredTruncated": self.retired.len() > 200, "retiredHashes": self.retired.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>() }));
        }
    }

    pub(super) fn live_run(&self) -> Option<&str> {
        self.live_run.as_deref()
    }

    pub(super) fn stream_text(&self, run: &str) -> Option<&str> {
        self.streams.get(run).and_then(Stream::text)
    }

    pub(super) fn terminal_reply_recovery(&self, run: &str) -> (bool, Vec<String>) {
        let mut replies = Vec::new();
        for signature in self.persisted.iter().filter(|message| message.role() == MessageRole::Assistant && message.run_id() == Some(run))
            .filter_map(|row| row.terminal_reply_signature())
        {
            if !replies.iter().any(|reply| reply == signature) { replies.push(signature.to_owned()); }
        }
        (self.accepted_finals.contains(run), replies)
    }

    pub(super) fn needs_terminal_history(&self) -> bool {
        self.terminal_marker.as_ref().is_some_and(|marker| !marker.history_applied)
    }

    pub fn observe(&mut self, changes: &[CanonicalSessionChange], chat: Option<&ChatEvent>, cache: &OpenClawReplayProjection) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        self.reconcile_tool_refs(cache);
        let terminal_chat = chat.filter(|chat| matches!(chat.state, super::protocol::ChatState::Final | super::protocol::ChatState::Aborted | super::protocol::ChatState::Error));
        let final_message = terminal_chat.and_then(|chat| chat.final_message.as_ref());
        if let Some(chat) = terminal_chat {
            let run = chat.run_id.as_str();
            let owned = self.live_run().is_none_or(|current| current == run);
            if (chat.terminal_outcome() == Some(super::events::TerminalOutcome::Completed) || chat.is_yielded()) && let Some(message) = final_message {
                if message.content().iter().any(|content| match content {
                    super::window::MessageContent::Text { text } => !text.trim_matches(reconciliation::whitespace).is_empty(),
                    super::window::MessageContent::Thinking { .. } => false,
                    _ => true,
                }) {
                    self.accepted_finals.insert(run.to_owned());
                }
            }
            if !owned {
                if chat.state == super::protocol::ChatState::Final && let Some(message) = final_message {
                    if !message.hidden_control_reply() { self.apply_live_message(message, cache)?; }
                }
            } else if chat.is_yielded() {
                if let Some(message) = final_message { self.finish_message(run, message, super::events::TerminalOutcome::Completed, cache)?; }
                self.rollover(run, None, false)?;
                if self.live_run() == Some(run) { self.live_run = None; }
            }
        }
        for change in changes {
            match change {
                CanonicalSessionChange::RunStarted { run_id } | CanonicalSessionChange::RunProgress { run_id, .. } => {
                    self.accept_live(run_id.as_str());
                }
                CanonicalSessionChange::AssistantTurnChunk { run_id, message_id, kind, text, replace, status } => {
                    if terminal_chat.is_some() { continue; }
                    self.accept_live(run_id.as_str());
                    if let Some(message_id) = message_id {
                        self.keyed_chunk(run_id.as_str(), message_id.as_str(), *kind, text, *replace, *status)?;
                    } else {
                        self.chunk(run_id.as_str(), *kind, text, *replace)?;
                    }
                }
                CanonicalSessionChange::ToolActivity { run_id, tool_id, tool_name, .. } => {
                    self.accept_live(run_id.as_str());
                    let tool_call_id = super::adapters::timeline::tool_call_id(Some(run_id.as_str()), tool_id.as_str());
                    let id = format!("oc:tool:{tool_call_id}");
                    let stream = self.streams.entry(run_id.as_str().to_owned()).or_default();
                    let first_anchor = !stream.anchors.contains(&id);
                    if first_anchor {
                        for part in &mut stream.parts { part.before_tool = Some(tool_id.as_str().to_owned()); }
                        self.rollover(run_id.as_str(), None, true)?;
                        self.streams.get_mut(run_id.as_str())?.latest_tool = Some(tool_id.as_str().to_owned());
                    }
                    if !self.items.iter().any(|item| matches!(item, SessionItem::AssistantTurn { segments, .. }
                        if segments.iter().any(|segment| matches!(segment, SessionContent::ToolUse { tool_call_id: existing, .. } if existing == &tool_call_id))))
                        && !self.streams.values().any(|stream| stream.anchors.contains(&id))
                    {
                        let item = SessionItem::AssistantTurn {
                            item_id: id.clone(), run_id: Some(run_id.as_str().to_owned()), message_id: None,
                            text: String::new(), status: self.status(run_id.as_str()),
                            segments: vec![SessionContent::ToolUse { name: tool_name.clone().unwrap_or_else(|| tool_id.as_str().to_owned()), tool_call_id }],
                        };
                        let stream = self.streams.entry(run_id.as_str().to_owned()).or_default();
                        stream.boundary = true;
                        self.items.push(item);
                    }
                    if first_anchor { self.streams.get_mut(run_id.as_str())?.anchors.push(id); }
                }
                CanonicalSessionChange::Terminal { run_id, outcome, .. } => {
                    self.reconcile(run_id.as_str())?;
                    if let Some(message) = final_message {
                        self.finish_message(run_id.as_str(), message, *outcome, cache)?;
                    } else if *outcome == super::events::TerminalOutcome::Completed && self.history_applied_for_run(run_id.as_str()) {
                        self.retire_body(run_id.as_str())?;
                    }
                    if self.live_run.as_deref().is_none_or(|current| current == run_id.as_str()) { self.last_terminal_run = Some(run_id.as_str().to_owned()); }
                    if self.live_run.as_deref() == Some(run_id.as_str()) { self.live_run = None; }
                    if let Some(stream) = self.streams.get_mut(run_id.as_str()) { stream.body_closed = true; stream.boundary = true; }
                    let phase = match outcome {
                        super::events::TerminalOutcome::Completed => RunPhase::Completed,
                        super::events::TerminalOutcome::Aborted => RunPhase::Cancelled,
                        super::events::TerminalOutcome::Error => RunPhase::Failed,
                    };
                    if !self.terminal.iter().any(|(run, _)| run == run_id.as_str()) {
                        self.terminal.push((run_id.as_str().to_owned(), phase));
                    }
                    let status = self.status(run_id.as_str());
                    if trace::enabled() {
                        trace::log_unscoped("oc.body.terminal", serde_json::json!({ "commitState": "candidate_only",
                            "runHash": trace::fingerprint(run_id.as_str()), "phase": phase, "status": status,
                            "finalMessagePresent": final_message.is_some(),
                            "noMessageBranch": final_message.is_none().then(|| if *outcome == super::events::TerminalOutcome::Completed
                                && self.history_applied_for_run(run_id.as_str()) { "retire_body" } else { "preserve_tail" }) }));
                    }
                    for item in &mut self.items {
                        if let SessionItem::AssistantTurn { run_id: Some(run), status: current, .. } = item {
                            if run == run_id.as_str() { *current = status; }
                        }
                    }
                }
                _ => {}
            }
        }
        self.check()?;
        Some(self.replacement(old))
    }

    pub fn live_message(&mut self, message: &Message, cache: &OpenClawReplayProjection) -> Option<(CanonicalSessionChange, bool)> {
        let old = self.items.clone();
        self.remember_terminal(message);
        let previous = message.role() == MessageRole::Assistant && message.identity_sequence().is_some()
            && message.identity_run_id().zip(self.live_run()).is_some_and(|(run, active)| run != active);
        let producer = message.identity_run_id().filter(|run| message.event_run_id() == Some(*run));
        let finishing = self.live_run().filter(|active| producer.is_none_or(|run| run == *active))
            .or_else(|| self.last_terminal_run.as_deref().filter(|run| self.live_run().is_none()
                && producer.map_or_else(|| self.items.iter().any(|item| matches!(item,
                    SessionItem::AssistantTurn { run_id: Some(owner), text, .. }
                        if owner == *run && !text.trim().is_empty() && text.trim() == message.text().trim())), |producer| producer == *run)));
        let owner = message.role() == MessageRole::Assistant && message.identity_message_id().is_some() && !message.is_imported()
            && (producer.is_some() || (message.identity_run_id().is_none() && message.has_active_run() != Some(true)))
            && finishing.is_some();
        if (message.role() != MessageRole::User && !previous && !owner)
            || (message.is_imported() && !message.import_sequence_proven())
            || (message.identity_message_id().is_none() && message.identity_sequence().is_none() && !message.has_send_identity())
        {
            if trace::enabled() {
                trace::log_unscoped("oc.body.live_message.rejected", serde_json::json!({
                    "reason": "missing_sdk_identity", "sdkSequencePresent": message.identity_sequence().is_some(),
                    "runHash": message.identity_run_id().map(trace::fingerprint), "activeRunHash": self.live_run().map(trace::fingerprint),
                    "compatMessageIdPresent": message.message_id().is_some(), "text": trace::text_shape(message.text()) }));
            }
            return Some((self.replacement(old), false));
        }
        self.message(message, cache).map(|replacement| (replacement, true))
    }

    fn remember_terminal(&mut self, message: &Message) {
        if message.has_active_run() == Some(true) || message.role() != MessageRole::Assistant || message.is_imported() { return; }
        if let Some(run) = self.live_run() && let Some(id) = message.identity_message_id() {
            self.terminal_marker = Some(TerminalMarker { message_id: id.to_owned(),
                run_id: message.event_client_run_id().or(message.event_run_id()).unwrap_or(run).to_owned(), history_applied: false });
        }
    }

    pub fn message(&mut self, message: &Message, cache: &OpenClawReplayProjection) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        let marker_run = self.live_run().filter(|_| message.has_active_run() != Some(true)
            && message.role() == MessageRole::Assistant && !message.is_imported() && message.identity_message_id().is_some())
            .map(|run| message.event_client_run_id().or(message.event_run_id()).unwrap_or(run).to_owned());
        let pending_before = super::trace::enabled().then(|| self.needs_terminal_history());
        if super::trace::enabled() {
            let live_match = message.run_id().is_some_and(|run| self.live_run() == Some(run));
            let provisional = message.run_id().is_some_and(|run| self.streams.get(run).is_some_and(|stream| !stream.provisional.is_empty()));
            super::trace::log_unscoped("runtime.openclaw.body.message.marker_admission", serde_json::json!({ "commitState": "candidate_only",
                "runHash": message.run_id().map(trace::fingerprint), "messageHash": message.message_id().map(trace::fingerprint),
                "hasActiveRun": message.has_active_run(), "runPresent": message.run_id().is_some(),
                "assistant": message.role() == MessageRole::Assistant, "imported": message.is_imported(),
                "originPresent": message.origin().is_some(), "displayPresent": message.display_item_id().is_some(),
                "idPresent": message.message_id().is_some(), "liveRunMatch": live_match, "provisionalPresent": provisional,
                "eligible": marker_run.is_some(), "pendingBefore": pending_before,
                "reason": if message.run_id().is_none() { "missing_run" } else if message.has_active_run() == Some(true) { "active_run" }
                    else if message.role() != MessageRole::Assistant { "not_assistant" } else if message.is_imported() { "imported" }
                    else if message.origin().is_some() { "origin" } else if message.display_item_id().is_some() { "display" }
                    else if message.message_id().is_none() { "missing_id" } else if !live_match && !provisional { "no_live_or_provisional" }
                    else { "eligible" } }));
        }
        self.apply_live_message(message, cache)?;
        let marker_set = marker_run.is_some() && message.identity_message_id().is_some();
        self.remember_terminal(message);
        let checked = self.check();
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.body.message.marker_result", serde_json::json!({ "commitState": "candidate_only",
                "markerSet": marker_set, "checkPassed": checked.is_some(), "pendingBefore": pending_before,
                "pendingAfter": self.needs_terminal_history(), "terminalMarkerPresence": self.terminal_marker.is_some(),
                "markerRunHash": self.terminal_marker.as_ref().map(|marker| trace::fingerprint(&marker.run_id)),
                "markerMessageHash": self.terminal_marker.as_ref().map(|marker| trace::fingerprint(&marker.message_id)),
                "historyApplied": self.terminal_marker.as_ref().map(|marker| marker.history_applied) }));
        }
        checked?;
        Some(self.replacement(old))
    }

    pub(super) fn apply_live_message(&mut self, message: &Message, cache: &OpenClawReplayProjection) -> Option<bool> {
        self.apply_message(message, true, cache).map(|id| id.is_some())
    }

    pub(super) fn apply_message(&mut self, message: &Message, live: bool, cache: &OpenClawReplayProjection) -> Option<Option<String>> {
        self.reconcile_tool_refs(cache);
        if trace::enabled() {
            trace::log_unscoped("oc.body.message.input", serde_json::json!({ "commitState": "candidate_only",
                "role": format!("{:?}", message.role()), "text": trace::text_shape(message.text()),
                "messageHash": message.message_id().map(trace::fingerprint), "displayItemHash": message.display_item_id().map(trace::fingerprint),
                "runHash": message.run_id().map(trace::fingerprint), "sequence": message.sequence(), "hasOrigin": message.origin().is_some(),
                "contentCount": message.content().len(), "itemsCount": self.items.len(),
                "persistedAdmission": message.role() == MessageRole::Assistant && message.display_item_id().is_none()
                    && message.message_id().is_some() && message.sequence().is_some() && message.run_id().is_some() && message.origin().is_none(),
                "persistedUpdateExisting": self.persisted.iter().any(|row| row.message_id() == message.message_id()),
                "reasons": ([
                    (message.role() != MessageRole::Assistant).then_some("not_assistant"),
                    message.display_item_id().is_some().then_some("display_identity"),
                    message.message_id().is_none().then_some("missing_message_id"),
                    message.sequence().is_none().then_some("missing_sequence"),
                    message.run_id().is_none().then_some("missing_run_id"),
                    message.origin().is_some().then_some("has_origin"),
                ].into_iter().flatten().collect::<Vec<_>>()) }));
        }
        let mut item = transcript_session_item(message, self.items.len(), cache);
        let existing = live.then(|| self.live_identity(message)).flatten();
        if message.identity_message_id().is_none() && existing.as_ref().is_some_and(|id|
            self.persisted.iter().any(|row| &row.id == id && row.identity_message_id().is_some()))
        { return Some(existing); }
        let mut insert = None;
        if let Some(id) = &existing
            && let Some(run) = self.streams.iter().find(|(_, stream)| stream.provisional.iter().any(|entry| &entry.id == id))
                .map(|(run, _)| run.clone())
        {
            insert = self.items.iter().position(|item| item.item_id() == id);
            self.retire_provisional(&run, id)?;
            self.retired.retain(|retired| retired != id);
        }
        if let Some(item) = &mut item {
            let id = if let Some(id) = existing.clone() { id } else if
                message.display_item_id().or(message.message_id()).or(message.origin()).is_none()
                || self.items.iter().any(|old| old.item_id() == item.item_id())
                || self.persisted.iter().any(|row| row.id == item.item_id())
            {
                loop {
                    self.next_id = self.next_id.checked_add(1)?;
                    let id = format!("oc:live:{}", self.next_id);
                    if !self.items.iter().any(|item| item.item_id() == id)
                        && !self.persisted.iter().any(|row| row.id == id) { break id; }
                }
            } else { item.item_id().to_owned() };
            match item {
                SessionItem::UserMessage { item_id, .. } | SessionItem::AssistantTurn { item_id, .. }
                | SessionItem::System { item_id, .. } => *item_id = id,
            }
        }
        let projected_id = item.as_ref().map(|item| item.item_id().to_owned());
        if trace::enabled() {
            trace::log_unscoped("oc.body.message.projection", serde_json::json!({ "commitState": "candidate_only",
                "item": item.as_ref().map(trace::item_shape), "projected": item.is_some(),
                "existingIndex": item.as_ref().and_then(|item| self.items.iter().position(|old| old.item_id() == item.item_id())),
                "reason": if item.is_some() { "projected" } else if message.role() == MessageRole::ToolResult { "tool_result_no_display" } else { "content_segment_budget" } }));
        }
        if let Some(item) = item {
            let id = item.item_id().to_owned();
            if let Some(index) = self.items.iter().position(|candidate| candidate.item_id() == id) {
                self.items[index] = item;
            } else {
                self.items.insert(insert.unwrap_or(self.items.len()).min(self.items.len()), item);
            }
            if live { self.history_ids.remove(&id); } else { self.history_ids.insert(id.clone()); }
            for stream in self.streams.values_mut() {
                stream.provisional.retain(|entry| entry.id != id);
            }
            if let Some(SessionItem::AssistantTurn { message_id: Some(_), segments, .. }) = self.items.iter().find(|item| item.item_id() == id) {
                let tool_ids = segments.iter().filter_map(|segment| match segment {
                    SessionContent::ToolUse { tool_call_id, .. } => Some(format!("oc:tool:{tool_call_id}")),
                    _ => None,
                }).collect::<Vec<_>>();
                let mut first = None;
                for tool_id in tool_ids {
                    if let Some(index) = self.items.iter().position(|item| matches!(item,
                        SessionItem::AssistantTurn { item_id, message_id: None, .. } if item_id == &tool_id))
                    {
                        first = Some(first.map_or(index, |first: usize| first.min(index)));
                        if trace::enabled() {
                            trace::log_unscoped("oc.body.message.tool_retired", serde_json::json!({ "commitState": "candidate_only",
                                "toolItemHash": trace::fingerprint(&tool_id), "replacementItemHash": trace::fingerprint(&id),
                                "index": index, "oldItem": trace::item_shape(&self.items[index]), "alreadyRetired": self.retired.contains(&tool_id) }));
                        }
                        for stream in self.streams.values_mut() {
                            for part in stream.all_parts_mut() {
                                if part.after.as_deref() == Some(tool_id.as_str()) { part.after = Some(id.clone()); }
                            }
                        }
                        self.items.remove(index);
                        if !self.retired.contains(&tool_id) { self.retired.push(tool_id); }
                    }
                }
                if let Some(first) = first {
                    let index = self.items.iter().position(|item| item.item_id() == id)?;
                    let item = self.items.remove(index);
                    let index = first.min(index).min(self.items.len());
                    self.items.insert(index, item);
                }
            }
        }
        // Physical sequence orders native slots; display replacement never changes the producer baseline.
        let slot = projected_id.clone().or(existing).or_else(|| message.display_item_id().or(message.message_id()).map(str::to_owned));
        if let Some(mut id) = slot {
            if projected_id.is_none() && (!live || !self.persisted.iter().any(|row| row.id == id && identity::exact(row, message))) {
                while self.persisted.iter().any(|row| row.id == id) || self.items.iter().any(|item| item.item_id() == id) {
                    self.next_id = self.next_id.checked_add(1)?;
                    id = format!("oc:live:{}", self.next_id);
                }
            }
            if live { self.history_ids.remove(&id); } else { self.history_ids.insert(id.clone()); }
            let row = Persisted { id: id.clone(), message: message.clone() };
            if let Some(index) = self.persisted.iter().position(|row| row.id == id) {
                self.persisted[index] = row;
            } else { self.persisted.push(row); }
            self.persisted.sort_by_key(|row| row.sequence());
            if trace::enabled() {
                trace::log_unscoped("oc.body.message.persisted", serde_json::json!({ "commitState": "candidate_only",
                    "messageHash": message.message_id().map(trace::fingerprint), "runHash": message.run_id().map(trace::fingerprint),
                    "sequence": message.sequence(), "persistedCount": self.persisted.len() }));
            }
            if live { self.persisted_steer(message)?; }
            let native = self.persisted.iter().map(|row| row.id.as_str()).collect::<Vec<_>>();
            let slots = self.items.iter().enumerate().filter_map(|(index, item)| native.contains(&item.item_id()).then_some(index)).collect::<Vec<_>>();
            let authoritative = native.iter().filter_map(|id| self.items.iter().find(|item| item.item_id() == *id).cloned()).collect::<Vec<_>>();
            // Native sequence orders only native slots, never surviving live or keyed items.
            for (index, item) in slots.into_iter().zip(authoritative) { self.items[index] = item; }
            if live { self.reconcile_all(true)?; }
        }
        if let Some(run) = message.run_id() {
            if self.terminal.iter().any(|(id, _)| id == run) {
                let status = self.status(run);
                if trace::enabled() {
                    trace::log_unscoped("oc.body.message.terminal", serde_json::json!({ "commitState": "candidate_only",
                        "runHash": trace::fingerprint(run), "status": status, "decision": "preserve_terminal_fence" }));
                }
                for item in &mut self.items {
                    if let SessionItem::AssistantTurn { run_id: Some(id), status: current, .. } = item {
                        if id == run { *current = status; }
                    }
                }
            }
        }
        self.check()?;
        Some(projected_id.filter(|id| self.items.iter().any(|item| item.item_id() == id)))
    }

    pub(super) fn apply_cumulative(&mut self, run: &str, text: &str) -> Option<()> {
        if trace::enabled() {
            let previous = self.streams.get(run).map_or("", |stream| stream.text().unwrap_or(""));
            let terminal = self.terminal.iter().any(|(id, _)| id == run);
            trace::log_unscoped("oc.body.cumulative.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "input": trace::text_shape(text), "baseline": trace::text_shape(previous),
                "terminal": terminal, "empty": text.is_empty(), "shorter": text.len() < previous.len(), "equal": text == previous,
                "prefix": text.starts_with(previous), "tail": text.strip_prefix(previous).map(trace::text_shape),
                "decision": if terminal { "terminal_unchanged" } else if !text.starts_with(previous) { "preserve_live" }
                    else if text.is_empty() { "empty" } else if text == previous { "equal_unchanged" } else { "observe_growth" } }));
        }
        if self.terminal.iter().any(|(id, _)| id == run) { return Some(()); }
        let previous = self.streams.get(run).map_or("", |stream| stream.text().unwrap_or(""));
        if !text.starts_with(previous) { return Some(()); }
        let retained = self.streams.get(run).is_some_and(|stream| stream.text.is_some() || !stream.closed.is_empty());
        let end = if retained { self.persisted.len() } else {
            self.persisted.iter().rposition(|message| message.role() == MessageRole::User
                && message.steer_target_run_id() == Some(run) && message.run_id().is_some()).unwrap_or(self.persisted.len())
        };
        let run = super::protocol::RunId::try_new(run.to_owned()).ok()?;
        self.accept_live(run.as_str());
        self.chunk_at(run.as_str(), AssistantTurnChunkKind::Text, text, true, Some(end))?;
        self.check()
    }

    fn chunk(&mut self, run: &str, kind: AssistantTurnChunkKind, text: &str, replace: bool) -> Option<()> {
        self.chunk_at(run, kind, text, replace, None)
    }

    fn chunk_at(&mut self, run: &str, kind: AssistantTurnChunkKind, text: &str, replace: bool, history_end: Option<usize>) -> Option<()> {
        let status = self.status(run);
        if trace::enabled() {
            let stream = self.streams.get(run);
            trace::log_unscoped("oc.body.chunk.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "kind": format!("{kind:?}"), "replace": replace, "status": status,
                "input": trace::text_shape(text), "baseline": stream.and_then(Stream::text).map(trace::text_shape),
                "currentBaseline": stream.and_then(|stream| stream.text.as_deref()).map(trace::text_shape),
                "closedBaseline": stream.and_then(Stream::accumulated_text).map(trace::text_shape),
                "closedCount": stream.map_or(0, |stream| stream.closed.len()), "currentPartCount": stream.map_or(0, |stream| stream.parts.len()),
                "historyEnd": history_end }));
        }
        if status != ItemStatus::Streaming { return Some(()); }
        let stream = self.streams.entry(run.to_owned()).or_default();
        if kind == AssistantTurnChunkKind::Text {
            let unchanged = if replace { stream.text() == Some(text) } else { text.is_empty() };
            if unchanged {
                if stream.text.is_none() { stream.text = Some(stream.accumulated_text().unwrap_or("").to_owned()); }
                return self.reconcile_mode(run, history_end.is_none() && self.live_run() == Some(run), history_end);
            }
            if stream.text.is_none() { stream.text = Some(stream.accumulated_text().unwrap_or("").to_owned()); }
            let current = stream.text.as_mut()?;
            let start = current.len();
            let tail = if replace { text.strip_prefix(current.as_str()) } else { Some(text) };
            let growth = tail.is_some();
            let open = stream.parts.len().checked_sub(1);
            if let Some(tail) = tail { current.push_str(tail); }
            else {
                let preserves = open.is_some_and(|index| text.starts_with(&current[..stream.parts[index].start]));
                if !preserves {
                    let insertion = open.and_then(|index| stream.parts[index].id.as_deref()).and_then(|id|
                        self.items.iter().position(|item| item.item_id() == id));
                    let id = open.and_then(|index| stream.parts[index].id.clone()).filter(|id| !self.retired.contains(id));
                    self.items.retain(|item| !stream.parts.iter().any(|part| part.id.as_deref() == Some(item.item_id())));
                    stream.anchors.extend(stream.parts.iter()
                        .filter_map(|part| part.id.as_ref()).filter(|id| self.retired.contains(id)).cloned());
                    stream.parts.clear();
                    let after = insertion.map(|index| index.min(self.items.len())).unwrap_or(self.items.len())
                        .checked_sub(1).map(|index| self.items[index].item_id().to_owned());
                    stream.parts.push(Part { id, start: 0, end: text.len(), covered: 0, observed: false, content_before: false,
                        after_tool: stream.latest_tool.clone(), before_tool: None, after, after_boundary_run_id: stream.latest_boundary_run_id.clone(), boundary_run_id: None });
                }
                current.clear(); current.push_str(text);
            }
            let open = stream.parts.len().checked_sub(1);
            if let Some(index) = open.filter(|_| !growth || !stream.boundary) {
                let part = &mut stream.parts[index];
                if part.id.as_ref().is_none_or(|id| self.retired.contains(id)) && !current.is_empty() {
                    if let Some(id) = part.id.take() { stream.anchors.push(id); }
                    self.next_id = self.next_id.checked_add(1)?;
                    part.id = Some(format!("oc:live:{}", self.next_id));
                }
                part.end = current.len();
                if !growth { part.observed = false; }
                if !part.observed { part.covered = part.start; }
            } else if !current.is_empty() {
                self.next_id = self.next_id.checked_add(1)?;
                let part_start = if open.is_some() || !stream.closed.is_empty() { start } else { 0 };
                stream.parts.push(Part { id: Some(format!("oc:live:{}", self.next_id)),
                    start: part_start, end: current.len(), covered: start, observed: false, content_before: false,
                    after_tool: stream.latest_tool.clone(), before_tool: None,
                    after: self.items.last().map(|item| item.item_id().to_owned()),
                    after_boundary_run_id: stream.latest_boundary_run_id.clone(), boundary_run_id: None });
            }
            stream.boundary = false;
            stream.body_closed = false;
            return self.reconcile_mode(run, history_end.is_none() && self.live_run() == Some(run), history_end);
        }
        let tail = if replace { text.strip_prefix(&stream.thinking) } else { Some(text) };
        if let Some(tail) = tail {
            if tail.is_empty() { return Some(()); }
            stream.thinking.push_str(tail);
            if let Some(SessionItem::AssistantTurn { item_id, segments, .. }) = self.items.last_mut()
                && stream.anchors.contains(item_id)
                && let [SessionContent::Thinking { text }] = segments.as_mut_slice()
            {
                text.push_str(tail);
                return Some(());
            }
            self.next_id = self.next_id.checked_add(1)?;
            let id = format!("oc:live:{}", self.next_id);
            self.items.push(SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                status, text: String::new(), segments: vec![SessionContent::Thinking { text: tail.to_owned() }] });
            stream.anchors.push(id);
        } else {
            let open = self.items.last().filter(|item| matches!(item,
                SessionItem::AssistantTurn { item_id, run_id: Some(owner), segments, .. }
                    if owner == run && stream.anchors.contains(item_id)
                        && matches!(segments.as_slice(), [SessionContent::Thinking { .. }])))
                .map(|item| item.item_id().to_owned());
            if let Some(id) = &open {
                self.items.pop();
                stream.anchors.retain(|anchor| anchor != id);
            }
            stream.thinking = text.to_owned();
            if !text.is_empty() {
                let id = if let Some(id) = open { id } else {
                    self.next_id = self.next_id.checked_add(1)?;
                    format!("oc:live:{}", self.next_id)
                };
                self.items.push(SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                    status, text: String::new(), segments: vec![SessionContent::Thinking { text: text.to_owned() }] });
                stream.anchors.push(id);
            }
        }
        self.reconcile(run)
    }

    fn keyed_chunk(&mut self, run: &str, id: &str, kind: AssistantTurnChunkKind, text: &str, replace: bool,
        status: super::projection::AssistantTurnStatus) -> Option<()> {
        if trace::enabled() {
            let existing = self.items.iter().position(|item| item.item_id() == id);
            trace::log_unscoped("oc.body.keyed_chunk.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(id), "kind": format!("{kind:?}"),
                "replace": replace, "status": format!("{status:?}"), "input": trace::text_shape(text), "empty": text.is_empty(),
                "index": existing, "baselineItem": existing.map(|index| trace::item_shape(&self.items[index])) }));
        }
        if self.terminal.iter().any(|(owner, _)| owner == run) || self.retired.iter().any(|retired| retired == id) { return Some(()); }
        let index = if let Some(index) = self.items.iter().position(|item| item.item_id() == id) {
            index
        } else {
            self.items.push(SessionItem::AssistantTurn { item_id: id.to_owned(), run_id: Some(run.to_owned()),
                message_id: Some(id.to_owned()), text: String::new(), status: ItemStatus::Streaming, segments: Vec::new() });
            self.items.len() - 1
        };
        if trace::enabled() {
            let decision = match &self.items[index] {
                SessionItem::AssistantTurn { run_id: Some(owner), message_id: Some(message), status: current, .. } => {
                    if owner != run || message != id { "reject_identity" }
                    else if matches!(current, ItemStatus::Final | ItemStatus::Aborted | ItemStatus::Error) { "terminal_unchanged" }
                    else { "accept_status" }
                }
                _ => "reject_item_shape",
            };
            trace::log_unscoped("oc.body.keyed_chunk.admission", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(id), "index": index, "decision": decision }));
        }
        let SessionItem::AssistantTurn { run_id: Some(owner), message_id: Some(message), text: current, segments, status: current_status, .. }
            = &mut self.items[index] else { return None; };
        if owner != run || message != id { return None; }
        if matches!(current_status, ItemStatus::Final | ItemStatus::Aborted | ItemStatus::Error) { return Some(()); }
        *current_status = match status {
            super::projection::AssistantTurnStatus::Streaming => ItemStatus::Streaming,
            super::projection::AssistantTurnStatus::WaitingForTool => ItemStatus::WaitingForTool,
            super::projection::AssistantTurnStatus::Final => ItemStatus::Final,
            super::projection::AssistantTurnStatus::Aborted => ItemStatus::Aborted,
            super::projection::AssistantTurnStatus::Error => ItemStatus::Error,
        };
        let previous = match kind {
            AssistantTurnChunkKind::Text => current.clone(),
            AssistantTurnChunkKind::Thinking => segments.iter().filter_map(|segment| match segment {
                SessionContent::Thinking { text } => Some(text.as_str()), _ => None,
            }).collect::<String>(),
        };
        let tail = if replace { text.strip_prefix(&previous) } else { Some(text) };
        let text = if let Some(tail) = tail {
            tail
        } else {
            segments.retain(|segment| !matches!((kind, segment),
                (AssistantTurnChunkKind::Text, SessionContent::Text { .. })
                | (AssistantTurnChunkKind::Thinking, SessionContent::Thinking { .. })));
            if kind == AssistantTurnChunkKind::Text { current.clear(); }
            text
        };
        if !text.is_empty() {
            let segment = match kind {
                AssistantTurnChunkKind::Text => {
                    current.push_str(text);
                    SessionContent::Text { text: text.to_owned() }
                }
                AssistantTurnChunkKind::Thinking => SessionContent::Thinking { text: text.to_owned() },
            };
            match (segments.last_mut(), &segment) {
                (Some(SessionContent::Text { text: current }), SessionContent::Text { text })
                | (Some(SessionContent::Thinking { text: current }), SessionContent::Thinking { text }) => current.push_str(text),
                _ => segments.push(segment),
            }
        }
        if trace::enabled() {
            trace::log_unscoped("oc.body.keyed_chunk.baseline", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(id), "candidateItem": trace::item_shape(&self.items[index]) }));
        }
        Some(())
    }

    pub fn preamble_activity(&mut self, run: &str, id: &str) -> Option<CanonicalSessionChange> {
        let persisted = self.persisted.iter().any(|message| message.display_item_id().or_else(|| message.message_id()) == Some(id)
            && message.run_id() == Some(run) && message.identity_message_id().is_some());
        let old = self.items.clone();
        let status = self.status(run);
        if status != ItemStatus::Streaming || self.retired.iter().any(|retired| retired == id) { return Some(self.replacement(old)); }
        if persisted { return Some(self.replacement(old)); }
        self.accept_live(run);
        let index = self.items.iter().position(|item| item.item_id() == id);
        if let Some(index) = index
            && !matches!(&self.items[index], SessionItem::AssistantTurn { run_id: Some(owner), .. } if owner == run)
        { return None; }
        self.streams.entry(run.to_owned()).or_default();
        self.reconcile(run)?;
        self.check()?;
        Some(self.replacement(old))
    }

    fn reconcile_tool_refs(&mut self, cache: &OpenClawReplayProjection) {
        for message in self.persisted.iter().filter(|message| message.run_id().is_none()) {
            let id = message.id.as_str();
            let Some(item) = self.items.iter_mut().find(|item| item.item_id() == id) else { continue; };
            let segments = match item {
                SessionItem::AssistantTurn { segments, .. } => segments,
                SessionItem::UserMessage { content, .. } => content,
                _ => continue,
            };
            for native_id in message.content().iter().filter_map(|content| match content {
                super::window::MessageContent::ToolUse { tool_call_id: Some(id), .. }
                | super::window::MessageContent::ToolResult { tool_call_id: Some(id), .. } => Some(id.as_str()),
                _ => None,
            }) {
                let unknown = super::adapters::timeline::tool_call_id(None, native_id);
                let resolved = cache.transcript_tool_id(message, native_id);
                if resolved == unknown { continue; }
                for segment in segments.iter_mut() {
                    if let SessionContent::ToolUse { tool_call_id, .. } | SessionContent::ToolResult { tool_call_id, .. } = segment
                        && *tool_call_id == unknown
                    { *tool_call_id = resolved.clone(); }
                }
            }
        }
    }

    fn accept_live(&mut self, run: &str) {
        if self.status(run) == ItemStatus::Streaming && self.live_run.as_deref().is_none_or(|current| current == run) { self.live_run = Some(run.to_owned()); }
    }

    pub(super) fn thinking(&mut self, run: &str, activity: &SessionActivity) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        self.accept_live(run);
        let super::protocol::SessionActivityKind::Thinking { text } = activity.kind() else { return None; };
        let (text, replace) = if activity.is_reasoning_snapshot() == Some(true) {
            (text.as_str(), true)
        } else if let Some(delta) = activity.thinking_delta() {
            (delta, false)
        } else { (text.as_str(), true) };
        self.chunk(run, AssistantTurnChunkKind::Thinking, text, replace)?;
        self.check()?;
        Some(self.replacement(old))
    }

    fn status(&self, run: &str) -> ItemStatus {
        match self.terminal.iter().find(|(id, _)| id == run).map(|(_, phase)| phase) {
            Some(RunPhase::Cancelled) => ItemStatus::Aborted,
            Some(RunPhase::Failed) => ItemStatus::Error,
            Some(_) => ItemStatus::Final,
            None => ItemStatus::Streaming,
        }
    }

    fn check(&mut self) -> Option<()> {
        placement::compose(&mut self.items, &self.persisted);
        while self.items.len() > 200 {
            if trace::enabled() {
                let available = self.items.iter().any(|item| match item {
                    SessionItem::AssistantTurn { run_id, status, .. } => matches!(status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted)
                        && run_id.as_ref().is_none_or(|run| !self.streams.contains_key(run) || self.terminal.iter().any(|(id, _)| id == run)),
                    SessionItem::UserMessage { status, .. } | SessionItem::System { status, .. } => matches!(status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted),
                });
                if !available {
                    trace::log_unscoped("oc.body.check.failed", serde_json::json!({ "commitState": "candidate_only",
                        "reason": "no_evictable_item", "itemsCount": self.items.len(), "items": trace::items_shape(&self.items) }));
                }
            }
            let index = self.items.iter().position(|item| match item {
                SessionItem::AssistantTurn { run_id, status, .. } => matches!(status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted)
                    && run_id.as_ref().is_none_or(|run| !self.streams.contains_key(run) || self.terminal.iter().any(|(id, _)| id == run)),
                SessionItem::UserMessage { status, .. } | SessionItem::System { status, .. } => matches!(status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted),
            })?;
            if trace::enabled() {
                trace::log_unscoped("oc.body.check.evicted", serde_json::json!({ "commitState": "candidate_only",
                    "index": index, "item": trace::item_shape(&self.items[index]), "itemsCount": self.items.len() }));
            }
            let item = self.items.remove(index);
            if !self.evicted.iter().any(|id| id == item.item_id()) { self.evicted.push(item.item_id().to_owned()); }
            self.history_ids.remove(item.item_id());
            self.persisted.retain(|row| row.id != item.item_id());
        }
        self.history_ids.retain(|id| self.items.iter().any(|item| item.item_id() == id)
            || self.persisted.iter().any(|row| &row.id == id));
        let visible = &self.items;
        for stream in self.streams.values_mut() {
            stream.provisional.retain(|entry| visible.iter().any(|item| item.item_id() == entry.id));
        }
        self.streams.retain(|run, stream| visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run))
            || !self.terminal.iter().any(|(id, _)| id == run)
            || (self.terminal_marker.as_ref().is_some_and(|marker| &marker.run_id == run)
                && stream.anchors.iter().any(|id| self.retired.contains(id))));
        while self.terminal.len() > 200 {
            if trace::enabled() && !self.terminal.iter().any(|(run, _)| !visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run))) {
                trace::log_unscoped("oc.body.check.failed", serde_json::json!({ "commitState": "candidate_only",
                    "reason": "no_evictable_terminal", "terminalCount": self.terminal.len(), "itemsCount": visible.len() }));
            }
            let index = self.terminal.iter().position(|(run, _)| !visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run)))?;
            self.terminal.remove(index);
        }
        self.accepted_finals.retain(|run| self.streams.contains_key(run) || self.terminal.iter().any(|(id, _)| id == run));
        self.retired.retain(|id| self.streams.values().any(|stream| stream.all_parts().any(|part| part.id.as_ref() == Some(id))
            || stream.anchors.contains(&id)));
        if trace::enabled() {
            let valid = self.items.len() <= 200 && self.persisted.len() <= 200 && self.streams.len() <= 200
                && self.terminal.len() <= 200 && self.retired.len() <= 200
                && self.streams.values().all(|stream| stream.part_count() <= 200 && stream.anchors.len() <= 200                    && stream.text_bytes() <= 1_000_000 && stream.thinking.len() <= 1_000_000);
            trace::log_unscoped(if valid { "oc.body.check.accepted" } else { "oc.body.check.failed" }, serde_json::json!({ "commitState": "candidate_only",
                "reason": if valid { "within_budget" } else { "budget_exceeded" }, "itemsCount": self.items.len(),
                "persistedCount": self.persisted.len(), "streamsCount": self.streams.len(), "terminalCount": self.terminal.len(), "retiredCount": self.retired.len(),
                "itemsExceeded": self.items.len() > 200, "persistedExceeded": self.persisted.len() > 200, "streamsExceeded": self.streams.len() > 200,
                "terminalExceeded": self.terminal.len() > 200, "retiredExceeded": self.retired.len() > 200,
                "streamBudgetExceeded": self.streams.values().any(|stream| stream.part_count() > 200 || stream.anchors.len() > 200
                    || stream.text_bytes() > 1_000_000 || stream.thinking.len() > 1_000_000),
                "streamsTotal": self.streams.len(), "streamsSummarized": self.streams.len().min(200), "streamsTruncated": self.streams.len() > 200,
                "streams": self.streams.iter().take(200).map(|(run, stream)| serde_json::json!({
                    "runHash": trace::fingerprint(run), "partsCount": stream.part_count(), "anchorsCount": stream.anchors.len(),
                    "textUtf8Bytes": stream.text_bytes(), "thinkingUtf8Bytes": stream.thinking.len(),
                    "partsExceeded": stream.part_count() > 200, "anchorsExceeded": stream.anchors.len() > 200,
                    "textExceeded": stream.text_bytes() > 1_000_000, "thinkingExceeded": stream.thinking.len() > 1_000_000,
                })).collect::<Vec<_>>() }));
        }
        (self.items.len() <= 200 && self.persisted.len() <= 200 && self.streams.len() <= 200
            && self.terminal.len() <= 200 && self.retired.len() <= 200
            && self.streams.values().all(|stream| stream.part_count() <= 200 && stream.anchors.len() <= 200                && stream.text_bytes() <= 1_000_000 && stream.thinking.len() <= 1_000_000))
            .then_some(())
    }

    fn replacement(&self, old: Vec<SessionItem>) -> CanonicalSessionChange {
        let evicted = self.evicted.iter().map(String::as_str).collect::<HashSet<_>>();
        let remaining = old.iter().filter(|item| !evicted.contains(item.item_id())).collect::<Vec<_>>();
        let prefix = remaining.iter().zip(&self.items).take_while(|(old, new)| **old == *new).count();
        let suffix = remaining[prefix..].iter().rev().zip(self.items[prefix..].iter().rev())
            .take_while(|(old, new)| **old == *new).count();
        let old_item_ids = remaining[prefix..remaining.len() - suffix].iter().map(|item| item.item_id().to_owned())
            .chain(old.iter().filter(|item| evicted.contains(item.item_id())).map(|item| item.item_id().to_owned())).collect::<Vec<_>>();
        let anchor = prefix.checked_sub(1).map_or(ItemAnchor::Start, |index|
            ItemAnchor::After { item_id: remaining[index].item_id().to_owned() });
        let items = self.items[prefix..self.items.len() - suffix].to_vec();
        if trace::enabled() {
            let old_item_ids_count = old_item_ids.len();
            trace::log_unscoped("oc.body.replacement", serde_json::json!({ "commitState": "candidate_only",
                "anchor": match &anchor { ItemAnchor::Start => "start", ItemAnchor::After { .. } => "after" },
                "anchorHash": match &anchor { ItemAnchor::Start => None, ItemAnchor::After { item_id } => Some(trace::fingerprint(item_id)) },
                "changed": !old_item_ids.is_empty() || !items.is_empty(),
                "oldItems": { "count": old_item_ids_count, "truncated": old_item_ids_count > 200,
                    "values": remaining[prefix..remaining.len() - suffix].iter().copied()
                        .chain(old.iter().filter(|item| evicted.contains(item.item_id()))).take(200).map(trace::item_shape).collect::<Vec<_>>() },
                "newItems": trace::items_shape(&items),
                "oldItemHashes": old_item_ids.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "oldItemIdsTotal": old_item_ids_count, "oldItemIdsSummarized": old_item_ids_count.min(200), "oldItemIdsTruncated": old_item_ids_count > 200,
                "retiredHashes": self.retired.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "retiredTotal": self.retired.len(), "retiredSummarized": self.retired.len().min(200), "retiredTruncated": self.retired.len() > 200,
                "evictedHashes": self.evicted.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "evictedTotal": self.evicted.len(), "evictedSummarized": self.evicted.len().min(200), "evictedTruncated": self.evicted.len() > 200 }));
        }
        CanonicalSessionChange::ItemsReplaced { old_item_ids, anchor, items }
    }
}
