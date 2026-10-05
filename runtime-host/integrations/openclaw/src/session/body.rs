use std::collections::{HashMap, HashSet};

use sessions_module::state::{ItemAnchor, ItemStatus, RunPhase, SessionContent, SessionItem};
use sessions_module::trace;

use super::{adapters::timeline::transcript_session_item, projection::{AssistantTurnChunkKind, CanonicalSessionChange}, window::{Message, MessageRole}};

#[derive(Clone, Default)]
pub(super) struct Body {
    pub items: Vec<SessionItem>,
    streams: HashMap<String, Stream>,
    persisted: Vec<Message>,
    pub terminal: Vec<(String, RunPhase)>,
    pub retired: Vec<String>,
    next_id: u64,
    evicted: Vec<String>,
}

#[derive(Clone, Default)]
struct Stream {
    text: String,
    thinking: String,
    parts: Vec<Part>,
    boundary: bool,
    anchors: Vec<String>,
}

#[derive(Clone)]
struct Part {
    id: String,
    start: usize,
    end: usize,
}

impl Body {
    pub(super) fn trace_committed(&self, stage: &str) {
        if trace::enabled() {
            trace::log_unscoped(stage, serde_json::json!({
                "commitState": "committed", "items": trace::items_shape(&self.items), "persistedCount": self.persisted.len(),
                "streamsTotal": self.streams.len(), "streamsSummarized": self.streams.len().min(200), "streamsTruncated": self.streams.len() > 200,
                "streams": self.streams.iter().take(200).map(|(run, stream)| serde_json::json!({
                    "runHash": trace::fingerprint(run), "acceptedBaseline": trace::text_shape(&stream.text),
                    "thinkingBaseline": trace::text_shape(&stream.thinking), "boundary": stream.boundary,
                    "partsTotal": stream.parts.len(), "partsSummarized": stream.parts.len().min(200), "partsTruncated": stream.parts.len() > 200,
                    "parts": stream.parts.iter().take(200).map(|part| serde_json::json!({
                        "itemHash": trace::fingerprint(&part.id), "startUtf8": part.start, "endUtf8": part.end })).collect::<Vec<_>>(),
                    "anchorsCount": stream.anchors.len(),
                })).collect::<Vec<_>>(),
                "terminalCount": self.terminal.len(), "retiredTotal": self.retired.len(), "retiredSummarized": self.retired.len().min(200),
                "retiredTruncated": self.retired.len() > 200, "retiredHashes": self.retired.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>() }));
        }
    }

    pub fn observe(&mut self, changes: &[CanonicalSessionChange]) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        for change in changes {
            match change {
                CanonicalSessionChange::AssistantTurnChunk { run_id, message_id, kind, text, replace, status } => {
                    if let Some(message_id) = message_id {
                        self.keyed_chunk(run_id.as_str(), message_id.as_str(), *kind, text, *replace, *status)?;
                    } else {
                        self.chunk(run_id.as_str(), *kind, text, *replace)?;
                    }
                }
                CanonicalSessionChange::ToolActivity { run_id, tool_id, tool_name, .. } => {
                    let id = format!("oc:tool:{}", tool_id.as_str());
                    if !self.items.iter().any(|item| matches!(item, SessionItem::AssistantTurn { segments, .. }
                        if segments.iter().any(|segment| matches!(segment, SessionContent::ToolUse { tool_call_id, .. } if tool_call_id == tool_id.as_str()))))
                        && !self.streams.values().any(|stream| stream.anchors.contains(&id))
                    {
                        let item = SessionItem::AssistantTurn {
                            item_id: id, run_id: Some(run_id.as_str().to_owned()), message_id: None,
                            text: String::new(), status: self.status(run_id.as_str()),
                            segments: vec![SessionContent::ToolUse { name: tool_name.clone().unwrap_or_else(|| tool_id.as_str().to_owned()), tool_call_id: tool_id.as_str().to_owned() }],
                        };
                        let stream = self.streams.entry(run_id.as_str().to_owned()).or_default();
                        stream.anchors.push(item.item_id().to_owned());
                        self.items.push(item);
                    }
                    self.streams.entry(run_id.as_str().to_owned()).or_default().boundary = true;
                }
                CanonicalSessionChange::Terminal { run_id, outcome, .. } => {
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
                            "runHash": trace::fingerprint(run_id.as_str()), "phase": phase, "status": status }));
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

    pub fn message(&mut self, message: &Message) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        self.apply_message(message)?;
        Some(self.replacement(old))
    }

    pub(super) fn apply_message(&mut self, message: &Message) -> Option<()> {
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
        let item = transcript_session_item(message, self.items.len());
        if trace::enabled() {
            trace::log_unscoped("oc.body.message.projection", serde_json::json!({ "commitState": "candidate_only",
                "item": item.as_ref().map(trace::item_shape), "projected": item.is_some(),
                "existingIndex": item.as_ref().and_then(|item| self.items.iter().position(|old| old.item_id() == item.item_id())),
                "reason": if item.is_some() { "projected" } else if message.role() == MessageRole::ToolResult { "tool_result_no_display" } else { "content_segment_budget" } }));
        }
        if let Some(item) = item {
            let id = item.item_id().to_owned();
            if let Some(index) = self.items.iter().position(|candidate| candidate.item_id() == id) {
                if let (SessionItem::AssistantTurn { run_id: Some(old), .. }, SessionItem::AssistantTurn { run_id: Some(new), .. }) = (&self.items[index], &item)
                    && old != new
                { return None; }
                self.items[index] = item;
            } else {
                self.items.push(item);
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
        // Physical sequence orders native slots; body prefixes establish cumulative coverage.
        // Keyed commentary has its own display identity and never consumes this baseline.
        if message.role() == MessageRole::Assistant && message.display_item_id().is_none()
            && message.message_id().is_some() && message.sequence().is_some() && message.run_id().is_some()
            && message.origin().is_none()
        {
            if let Some(index) = self.persisted.iter().position(|row| row.message_id() == message.message_id()) {
                self.persisted[index] = message.clone();
            } else { self.persisted.push(message.clone()); }
            self.persisted.sort_by_key(|row| row.sequence());
            if trace::enabled() {
                trace::log_unscoped("oc.body.message.persisted", serde_json::json!({ "commitState": "candidate_only",
                    "messageHash": message.message_id().map(trace::fingerprint), "runHash": message.run_id().map(trace::fingerprint),
                    "sequence": message.sequence(), "persistedCount": self.persisted.len() }));
            }
            self.reconcile(message.run_id()?)?;
            let native = self.persisted.iter().filter_map(|message| message.message_id()).collect::<Vec<_>>();
            let slots = self.items.iter().enumerate().filter_map(|(index, item)| native.contains(&item.item_id()).then_some(index)).collect::<Vec<_>>();
            let authoritative = native.iter().filter_map(|id| self.items.iter().find(|item| item.item_id() == *id).cloned()).collect::<Vec<_>>();
            // Native sequence orders only native slots, never surviving live or keyed items.
            for (index, item) in slots.into_iter().zip(authoritative) { self.items[index] = item; }
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
        self.check()
    }

    pub(super) fn apply_cumulative(&mut self, run: &str, text: &str) -> Option<()> {
        if trace::enabled() {
            let previous = self.streams.get(run).map_or("", |stream| stream.text.as_str());
            let terminal = self.terminal.iter().any(|(id, _)| id == run);
            trace::log_unscoped("oc.body.cumulative.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "input": trace::text_shape(text), "baseline": trace::text_shape(previous),
                "terminal": terminal, "empty": text.is_empty(), "shorter": text.len() < previous.len(), "equal": text == previous,
                "prefix": text.starts_with(previous), "tail": text.strip_prefix(previous).map(trace::text_shape),
                "decision": if terminal { "terminal_unchanged" } else if !text.starts_with(previous) { "preserve_live" }
                    else if text.is_empty() { "empty" } else if text == previous { "equal_unchanged" } else { "observe_growth" } }));
        }
        if self.terminal.iter().any(|(id, _)| id == run) { return Some(()); }
        let previous = self.streams.get(run).map_or("", |stream| stream.text.as_str());
        if !text.starts_with(previous) { return Some(()); }
        let run = super::protocol::RunId::try_new(run.to_owned()).ok()?;
        self.chunk(run.as_str(), AssistantTurnChunkKind::Text, text, true)?;
        self.check()
    }

    fn chunk(&mut self, run: &str, kind: AssistantTurnChunkKind, text: &str, replace: bool) -> Option<()> {
        let status = self.status(run);
        if status != ItemStatus::Streaming { return Some(()); }
        let stream = self.streams.entry(run.to_owned()).or_default();
        let previous = match kind {
            AssistantTurnChunkKind::Text => &stream.text,
            AssistantTurnChunkKind::Thinking => &stream.thinking,
        };
        let tail = if replace { text.strip_prefix(previous.as_str()) } else { Some(text) };
        if trace::enabled() {
            trace::log_unscoped("oc.body.chunk.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "kind": format!("{kind:?}"), "replace": replace,
                "input": trace::text_shape(text), "baseline": trace::text_shape(previous),
                "decision": if tail.is_none() { "replace" } else if tail == Some("") { "unchanged" } else { "append_tail" } }));
        }
        if let Some(tail) = tail {
            if tail.is_empty() { return Some(()); }
            let start = stream.text.len();
            match kind {
                AssistantTurnChunkKind::Text => stream.text.push_str(tail),
                AssistantTurnChunkKind::Thinking => stream.thinking.push_str(tail),
            }
            if kind == AssistantTurnChunkKind::Text && !stream.boundary {
                if let Some(part) = stream.parts.last_mut() {
                    if let Some(SessionItem::AssistantTurn { text: current, segments, .. }) = self.items.iter_mut().find(|item| item.item_id() == part.id) {
                        current.push_str(tail);
                        if let Some(SessionContent::Text { text }) = segments.last_mut() { text.push_str(tail); }
                        part.end = stream.text.len();
                        return self.reconcile(run);
                    }
                }
            } else if kind == AssistantTurnChunkKind::Thinking {
                if let Some(SessionItem::AssistantTurn { item_id, segments, .. }) = self.items.last_mut()
                    && stream.anchors.contains(item_id)
                    && let [SessionContent::Thinking { text }] = segments.as_mut_slice()
                {
                    text.push_str(tail);
                    stream.boundary = true;
                    return Some(());
                }
            }
            self.next_id = self.next_id.checked_add(1)?;
            let id = format!("oc:live:{}", self.next_id);
            let segment = match kind {
                AssistantTurnChunkKind::Text => SessionContent::Text { text: tail.to_owned() },
                AssistantTurnChunkKind::Thinking => SessionContent::Thinking { text: tail.to_owned() },
            };
            self.items.push(SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None, status,
                text: if kind == AssistantTurnChunkKind::Text { tail.to_owned() } else { String::new() }, segments: vec![segment] });
            if kind == AssistantTurnChunkKind::Text { stream.parts.push(Part { id, start, end: stream.text.len() }); }
            else { stream.anchors.push(id); }
            stream.boundary = kind != AssistantTurnChunkKind::Text;
        } else if kind == AssistantTurnChunkKind::Text {
            let open = (!stream.boundary).then(|| stream.parts.last()).flatten()
                .filter(|part| self.items.iter().any(|item| item.item_id() == part.id)).cloned();
            if let Some(part) = &open
                && text.starts_with(stream.text.get(..part.start)?)
            {
                stream.text = text.to_owned();
                stream.parts.last_mut()?.end = text.len();
                if let Some(SessionItem::AssistantTurn { text: current, segments, .. }) = self.items.iter_mut().find(|item| item.item_id() == part.id) {
                    *current = text.get(part.start..)?.to_owned();
                    *segments = vec![SessionContent::Text { text: current.clone() }];
                }
            } else {
                // A full rewrite supplies no cross-tool text identity: keep anchors, replace transient text at the open slot.
                let index = open.as_ref().and_then(|part| self.items.iter().position(|item| item.item_id() == part.id));
                let insertion = index.map(|index| self.items[..index].iter().filter(|item|
                    !stream.parts.iter().any(|part| part.id == item.item_id())).count());
                self.items.retain(|item| !stream.parts.iter().any(|part| part.id == item.item_id()));
                stream.anchors.extend(stream.parts.iter().filter(|part| self.retired.contains(&part.id)).map(|part| part.id.clone()));
                stream.parts.clear();
                stream.text = text.to_owned();
                if !text.is_empty() {
                    let id = if let Some(part) = open { part.id } else {
                        self.next_id = self.next_id.checked_add(1)?;
                        format!("oc:live:{}", self.next_id)
                    };
                    let item = SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                        status, text: text.to_owned(), segments: vec![SessionContent::Text { text: text.to_owned() }] };
                    self.items.insert(insertion.unwrap_or(self.items.len()), item);
                    stream.parts.push(Part { id, start: 0, end: text.len() });
                }
                stream.boundary = text.is_empty();
            }
        } else {
            let ids = self.items.iter().filter_map(|item| match item {
                SessionItem::AssistantTurn { item_id, segments, .. } if stream.anchors.contains(item_id)
                    && matches!(segments.as_slice(), [SessionContent::Thinking { .. }]) => Some(item_id.clone()),
                _ => None,
            }).collect::<Vec<_>>();
            let open = self.items.last().filter(|item| ids.iter().any(|id| id == item.item_id())).map(|item| item.item_id().to_owned());
            self.items.retain(|item| !ids.iter().any(|id| id == item.item_id()));
            stream.anchors.retain(|id| !ids.contains(id));
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
            stream.boundary = true;
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
            if let Some(stream) = self.streams.get_mut(run) { stream.boundary = true; }
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
        self.streams.entry(run.to_owned()).or_default().boundary = true;
        Some(())
    }

    pub fn keyed(&mut self, run: &str, id: &str, text: &str) -> Option<CanonicalSessionChange> {
        if trace::enabled() {
            let existing = self.items.iter().find(|item| item.item_id() == id);
            let persisted = self.items.iter().any(|item| matches!(item, SessionItem::AssistantTurn { item_id, run_id: Some(owner), message_id: Some(_), .. } if item_id == id && owner == run));
            let previous = existing.and_then(|item| match item { SessionItem::AssistantTurn { text, .. } => Some(text.as_str()), _ => None });
            trace::log_unscoped("oc.body.keyed.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(id), "input": trace::text_shape(text),
                "baselineItem": existing.map(trace::item_shape), "status": self.status(run), "empty": text.is_empty(),
                "shorter": previous.map(|old| text.len() < old.len()), "equal": previous.map(|old| text == old),
                "prefix": previous.map(|old| text.starts_with(old)), "tail": previous.and_then(|old| text.strip_prefix(old)).map(trace::text_shape),
                "decision": if persisted { "persisted_unchanged" } else if text.is_empty() { if existing.is_some() { "remove" } else { "empty_absent" } }
                    else if existing.is_some() { "replace" } else { "insert" } }));
        }
        let old = self.items.clone();
        let status = self.status(run);
        if status != ItemStatus::Streaming || self.retired.iter().any(|retired| retired == id) { return Some(self.replacement(old)); }
        if self.items.iter().any(|item| matches!(item, SessionItem::AssistantTurn { item_id, run_id: Some(owner), message_id: Some(_), .. } if item_id == id && owner == run)) {
            return Some(self.replacement(old));
        }
        let index = self.items.iter().position(|item| item.item_id() == id);
        if let Some(index) = index
            && !matches!(&self.items[index], SessionItem::AssistantTurn { run_id: Some(owner), .. } if owner == run)
        { return None; }
        if text.is_empty() {
            if let Some(index) = index { self.items.remove(index); }
        } else {
            let item = SessionItem::AssistantTurn { item_id: id.to_owned(), run_id: Some(run.to_owned()), message_id: None,
                status, text: text.to_owned(), segments: vec![SessionContent::Text { text: text.to_owned() }] };
            if let Some(index) = index { self.items[index] = item; } else { self.items.push(item); }
        }
        self.streams.entry(run.to_owned()).or_default().boundary = true;
        self.check()?;
        Some(self.replacement(old))
    }

    fn reconcile(&mut self, run: &str) -> Option<()> {
        if trace::enabled() {
            trace::log_unscoped("oc.body.reconcile.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "hasStream": self.streams.contains_key(run),
                "baseline": self.streams.get(run).map(|stream| trace::text_shape(&stream.text)),
                "persistedCount": self.persisted.iter().filter(|message| message.run_id() == Some(run)).count(),
                "reason": if self.streams.contains_key(run) { "scan_intervals" } else { "no_stream" } }));
        }
        let Some(stream) = self.streams.get(run) else { return Some(()); };
        let mut covered = 0;
        let mut intervals = Vec::new();
        for message in self.persisted.iter().filter(|message| message.run_id() == Some(run)) {
            let text = message.text();
            if trace::enabled() {
                let remaining = stream.text.get(covered..);
                let tool = message.content().iter().any(|content| matches!(content, super::window::MessageContent::ToolUse { tool_call_id: Some(_), .. }));
                trace::log_unscoped("oc.body.reconcile.interval", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": trace::fingerprint(run), "messageHash": message.message_id().map(trace::fingerprint), "sequence": message.sequence(),
                    "coveredStartUtf8": covered, "nativeText": trace::text_shape(text), "remaining": remaining.map(trace::text_shape),
                    "hasTool": tool, "decision": if text.is_empty() { if tool { "tool_only_interval" } else { "empty_no_takeover" } }
                        else if remaining.is_none() { "invalid_covered_range" } else if remaining.is_some_and(|tail| tail.starts_with(text)) { "native_prefix" }
                        else if remaining.is_some_and(|tail| text.starts_with(tail)) { "native_covers_remaining" } else { "nonprefix_no_takeover" } }));
            }
            if text.is_empty() {
                if message.content().iter().any(|content| matches!(content, super::window::MessageContent::ToolUse { tool_call_id: Some(_), .. })) {
                    intervals.push(message.message_id()?);
                }
                continue;
            }
            let remaining = stream.text.get(covered..)?;
            if remaining.starts_with(text) {
                covered += text.len();
                intervals.push(message.message_id()?);
            } else if text.starts_with(remaining) {
                covered = stream.text.len();
                intervals.push(message.message_id()?);
                break;
            } else if covered > 0 {
                let trimmed = remaining.trim_start_matches(|ch: char| matches!(ch,
                    '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
                    | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
                let whitespace = remaining.len() - trimmed.len();
                if whitespace > 0 && trimmed.starts_with(text) {
                    covered += whitespace + text.len();
                    intervals.push(message.message_id()?);
                } else if whitespace > 0 && text.starts_with(trimmed) {
                    covered = stream.text.len();
                    intervals.push(message.message_id()?);
                    break;
                } else { break; }
            }
        }
        if trace::enabled() {
            trace::log_unscoped("oc.body.reconcile.coverage", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "coveredStartUtf8": 0, "coveredEndUtf8": covered,
                "intervalHashes": intervals.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "intervalsTotal": intervals.len(), "intervalsSummarized": intervals.len().min(200), "intervalsTruncated": intervals.len() > 200,
                "partialRemaining": stream.text.get(covered..).map(trace::text_shape),
                "decision": if intervals.is_empty() { "no_intervals_no_takeover" } else { "takeover" } }));
        }
        if intervals.is_empty() { return Some(()); }
        let mut first = None;
        for part in &stream.parts {
            if trace::enabled() {
                let index = self.items.iter().position(|item| item.item_id() == part.id);
                trace::log_unscoped("oc.body.reconcile.part", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(&part.id), "index": index,
                    "startUtf8": part.start, "endUtf8": part.end, "coveredEndUtf8": covered,
                    "oldItem": index.map(|index| trace::item_shape(&self.items[index])),
                    "partialRemaining": if part.start < covered && covered < part.end { stream.text.get(covered..part.end).map(trace::text_shape) } else { None },
                    "decision": if part.start >= covered { "outside_coverage" } else if index.is_none() { "item_absent" }
                        else if part.end <= covered { "retire" } else if stream.text.get(covered..part.end).is_none() { "reject_invalid_partial_range" } else { "partial_remaining" } }));
            }
            if part.start >= covered { continue; }
            let Some(index) = self.items.iter().position(|item| item.item_id() == part.id) else { continue; };
            first = Some(first.map_or(index, |first: usize| first.min(index)));
            if part.end <= covered {
                if trace::enabled() {
                    trace::log_unscoped("oc.body.reconcile.part_retired", serde_json::json!({ "commitState": "candidate_only",
                        "runHash": trace::fingerprint(run), "itemHash": trace::fingerprint(&part.id), "index": index,
                        "alreadyRetired": self.retired.contains(&part.id) }));
                }
                self.items.remove(index);
                if !self.retired.contains(&part.id) { self.retired.push(part.id.clone()); }
            } else if let SessionItem::AssistantTurn { text, segments, .. } = &mut self.items[index] {
                *text = stream.text.get(covered..part.end)?.to_owned();
                *segments = vec![SessionContent::Text { text: text.clone() }];
            }
        }
        if trace::enabled() {
            let missing_count = intervals.iter().filter(|id| !self.items.iter().any(|item| item.item_id() == **id)).count();
            trace::log_unscoped("oc.body.reconcile.order", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "firstRetiredIndex": first,
                "firstNativeIndex": self.items.iter().position(|item| intervals.contains(&item.item_id())),
                "decision": if missing_count > 0 { "reject_missing_native_item" } else if first.is_some() { "place_native_slots" } else { "order_native_slots" },
                "missingIntervalHashes": intervals.iter().filter(|id| !self.items.iter().any(|item| item.item_id() == **id)).take(200)
                    .map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "missingIntervalsTotal": missing_count, "missingIntervalsSummarized": missing_count.min(200), "missingIntervalsTruncated": missing_count > 200 }));
        }
        if let Some(first) = first {
            let index = self.items.iter().position(|item| intervals.contains(&item.item_id()))?;
            if first < index {
                let item = self.items.remove(index);
                self.items.insert(first, item);
            }
        }
        if trace::enabled() {
            trace::log_unscoped("oc.body.reconcile.output", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "coveredEndUtf8": covered, "partialRemaining": stream.text.get(covered..).map(trace::text_shape),
                "retiredHashes": self.retired.iter().take(200).map(|id| trace::fingerprint(id)).collect::<Vec<_>>(),
                "retiredTotal": self.retired.len(), "retiredSummarized": self.retired.len().min(200), "retiredTruncated": self.retired.len() > 200,
                "itemsCount": self.items.len() }));
        }
        Some(())
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
        self.evicted.clear();
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
            self.evicted.push(item.item_id().to_owned());
            self.persisted.retain(|message| message.display_item_id().or_else(|| message.message_id()) != Some(item.item_id()));
        }
        let visible = &self.items;
        self.streams.retain(|run, _| visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run))
            || !self.terminal.iter().any(|(id, _)| id == run));
        while self.terminal.len() > 200 {
            if trace::enabled() && !self.terminal.iter().any(|(run, _)| !visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run))) {
                trace::log_unscoped("oc.body.check.failed", serde_json::json!({ "commitState": "candidate_only",
                    "reason": "no_evictable_terminal", "terminalCount": self.terminal.len(), "itemsCount": visible.len() }));
            }
            let index = self.terminal.iter().position(|(run, _)| !visible.iter().any(|item| matches!(item, SessionItem::AssistantTurn { run_id: Some(id), .. } if id == run)))?;
            self.terminal.remove(index);
        }
        self.retired.retain(|id| self.streams.values().any(|stream| stream.parts.iter().any(|part| &part.id == id)
            || stream.anchors.contains(&id)));
        if trace::enabled() {
            let valid = self.items.len() <= 200 && self.persisted.len() <= 200 && self.streams.len() <= 200
                && self.terminal.len() <= 200 && self.retired.len() <= 200
                && self.streams.values().all(|stream| stream.parts.len() <= 200 && stream.anchors.len() <= 200
                    && stream.text.len() <= 1_000_000 && stream.thinking.len() <= 1_000_000);
            trace::log_unscoped(if valid { "oc.body.check.accepted" } else { "oc.body.check.failed" }, serde_json::json!({ "commitState": "candidate_only",
                "reason": if valid { "within_budget" } else { "budget_exceeded" }, "itemsCount": self.items.len(),
                "persistedCount": self.persisted.len(), "streamsCount": self.streams.len(), "terminalCount": self.terminal.len(), "retiredCount": self.retired.len(),
                "itemsExceeded": self.items.len() > 200, "persistedExceeded": self.persisted.len() > 200, "streamsExceeded": self.streams.len() > 200,
                "terminalExceeded": self.terminal.len() > 200, "retiredExceeded": self.retired.len() > 200,
                "streamBudgetExceeded": self.streams.values().any(|stream| stream.parts.len() > 200 || stream.anchors.len() > 200
                    || stream.text.len() > 1_000_000 || stream.thinking.len() > 1_000_000),
                "streamsTotal": self.streams.len(), "streamsSummarized": self.streams.len().min(200), "streamsTruncated": self.streams.len() > 200,
                "streams": self.streams.iter().take(200).map(|(run, stream)| serde_json::json!({
                    "runHash": trace::fingerprint(run), "partsCount": stream.parts.len(), "anchorsCount": stream.anchors.len(),
                    "textUtf8Bytes": stream.text.len(), "thinkingUtf8Bytes": stream.thinking.len(),
                    "partsExceeded": stream.parts.len() > 200, "anchorsExceeded": stream.anchors.len() > 200,
                    "textExceeded": stream.text.len() > 1_000_000, "thinkingExceeded": stream.thinking.len() > 1_000_000,
                })).collect::<Vec<_>>() }));
        }
        (self.items.len() <= 200 && self.persisted.len() <= 200 && self.streams.len() <= 200
            && self.terminal.len() <= 200 && self.retired.len() <= 200
            && self.streams.values().all(|stream| stream.parts.len() <= 200 && stream.anchors.len() <= 200
                && stream.text.len() <= 1_000_000 && stream.thinking.len() <= 1_000_000))
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
