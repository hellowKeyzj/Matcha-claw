use super::*;

#[derive(Clone)]
pub(super) struct Provisional {
    pub id: String,
    pub keyed: bool,
    role: MessageRole,
    imported: bool,
    external_source: Option<String>,
    pub native_id: Option<String>,
    stream_id: Option<String>,
    key: Option<String>,
    run: Option<String>,
    sequence: Option<u64>,
    segment: Option<(String, Option<String>)>,
    after_sequence: Option<Option<u64>>,
    after_boundary_run_id: Option<String>,
    terminal: bool,
    pub fallback: Option<super::super::window::StreamFallback>,
    display_content: super::super::protocol::DisplayContent,
    source: Option<u64>,
    error_stop: bool,
    tool_continuation: bool,
    run_terminal: bool,
    mirrored: bool,
}

impl Provisional {
    pub(super) fn commentary(id: &str, run: &str, after_boundary_run_id: Option<String>) -> Self {
        Self { id: id.to_owned(), keyed: true, role: MessageRole::Assistant, imported: false, external_source: None,
            native_id: None, stream_id: None, key: None, run: Some(run.to_owned()), sequence: None,
            segment: Some((id.to_owned(), Some(run.to_owned()))), after_sequence: None, after_boundary_run_id,
            terminal: false, fallback: None,
            display_content: super::super::protocol::DisplayContent::Empty, source: None, error_stop: false,
            tool_continuation: false, run_terminal: false, mirrored: false }
    }

    pub(super) fn new(id: String, message: &Message) -> Self {
        Self {
            id, keyed: false, role: message.role(), imported: message.is_imported(),
            external_source: message.external_source().map(str::to_owned),
            native_id: message.identity_message_id().map(str::to_owned),
            stream_id: message.identity_stream_id().map(str::to_owned),
            key: message.idempotency_key().map(str::to_owned),
            run: message.identity_run_id().map(str::to_owned), sequence: message.identity_sequence(),
            segment: message.display_item_id().map(|id| (id.to_owned(), message.identity_run_id().or(message.run_id()).map(str::to_owned))),
            after_sequence: message.after_sequence(),
            after_boundary_run_id: message.stream_fallback().and_then(|fallback| fallback.after_boundary_run_id.clone()),
            terminal: false, fallback: None,
            display_content: message.projection_content().clone(), source: None,
            error_stop: message.stop_reason() == Some("error"),
            tool_continuation: message.content().iter().any(|content| matches!(content, super::super::window::MessageContent::ToolUse { .. }))
                || (message.stop_reason() == Some("toolUse") && message.final_message_identity().is_none()),
            run_terminal: message.run_terminal(), mirrored: message.mirror_origin().is_some(),
        }
    }

    pub(super) fn final_message(id: String, message: &Message, source: Option<u64>) -> Self {
        Self { terminal: true, source, ..Self::new(id, message) }
    }

    pub(super) fn persisted(row: &Persisted) -> Self {
        Self { terminal: row.source.is_some(), source: row.source, ..Self::new(row.id.clone(), row) }
    }

    pub(super) fn materialized(id: String, fallback: super::super::window::StreamFallback) -> Self {
        Self { id, keyed: fallback.item_id.is_some(), role: MessageRole::Assistant, imported: false, external_source: None,
            native_id: None, stream_id: None, key: None, run: None, sequence: None,
            segment: fallback.item_id.as_ref().map(|id| (id.clone(), fallback.run_id.clone())),
            after_sequence: None, after_boundary_run_id: fallback.after_boundary_run_id.clone(), terminal: false, fallback: Some(fallback),
            display_content: super::super::protocol::DisplayContent::Empty, source: None, error_stop: false,
            tool_continuation: false, run_terminal: false, mirrored: false }
    }

    pub(super) fn is_materialized(&self) -> bool { self.fallback.is_some() }

    pub(super) fn is_terminal(&self) -> bool { self.terminal }

    pub(super) fn fallback_after_boundary_run_id(&self) -> Option<&str> { self.after_boundary_run_id.as_deref() }

    pub(super) fn diagnostic_for_run(&self, run: &str, error: Option<&str>, current_source: Option<u64>) -> bool {
        let current_message = current_source.is_some() && self.source == current_source;
        (self.run.as_deref() == Some(run) || current_message) && (self.error_stop || current_message)
            && self.display_content.is_error_message(error)
    }

    fn transcript(&self, other: &Self) -> bool {
        if self.role != other.role { return false; }
        if self.imported || other.imported {
            if !self.imported || !other.imported { return false; }
            return if self.external_source.is_some() || other.external_source.is_some() {
                self.external_source.is_some() && self.external_source == other.external_source
            } else { self.sequence.is_some() && self.sequence == other.sequence };
        }
        if self.native_id.is_some() || other.native_id.is_some() {
            self.native_id.is_some() && self.native_id == other.native_id
        } else { self.sequence.is_some() && self.sequence == other.sequence }
    }

    fn fragment(&self, other: &Self) -> bool {
        self.role == MessageRole::Assistant && other.role == MessageRole::Assistant && !self.imported && !other.imported
            && self.segment.is_none() && other.segment.is_none()
            && ((self.native_id.is_none() && self.sequence.is_none()) || (other.native_id.is_none() && other.sequence.is_none()))
            && self.stream_id.is_some() && self.stream_id == other.stream_id
            && self.run.as_ref().zip(other.run.as_ref()).is_none_or(|(left, right)| left == right)
    }

    fn receipt(&self, other: &Self) -> bool {
        self.role == MessageRole::Assistant && other.role == MessageRole::Assistant && !self.imported && !other.imported
            && self.key.is_some() && self.key == other.key
            && self.stream_id.as_ref().zip(other.stream_id.as_ref()).is_none_or(|(left, right)| left == right)
            && ((self.native_id.is_none() && self.sequence.is_none()) || (other.native_id.is_none() && other.sequence.is_none()))
    }

    fn matches(&self, current: &Self, live: bool, snapshot: bool) -> bool {
        if self.transcript(current) || self.fragment(current) || self.receipt(current) { return true; }
        if self.stream_id.as_ref().zip(current.stream_id.as_ref()).is_some_and(|(left, right)| left != right) { return false; }
        if self.role != current.role || self.imported || current.imported { return false; }
        if self.native_id.is_none() || current.native_id.is_some() { return false; }
        if self.role == MessageRole::Assistant {
            if current.sequence.is_none() && self.segment.as_ref().is_some_and(|(_, run)| run.is_some() && self.segment == current.segment) { return true; }
            let after = match current.after_sequence {
                None => true, Some(None) => false, Some(Some(boundary)) => self.sequence.is_some_and(|seq| seq > boundary),
            };
            if live && current.sequence.is_none() && after
                && (!current.terminal || !self.tool_continuation)
                && self.run.is_some() && self.run == current.run && (!self.mirrored || self.run_terminal)
            { return true; }
        }
        snapshot && live && current.sequence.is_some() && self.sequence == current.sequence
    }
}

pub(super) fn exact(left: &Message, right: &Message) -> bool {
    Provisional::new(String::new(), left).transcript(&Provisional::new(String::new(), right))
}

impl Body {
    fn selection(&self, entry: &Provisional, snapshot: &[Provisional]) -> Option<usize> {
        let mut matches = snapshot.iter().enumerate().filter(|(_, row)| row.matches(entry, !entry.is_materialized(), true));
        let (index, _) = matches.next()?;
        matches.next().is_none().then_some(index)
    }

    pub(super) fn message_identity(&self, message: &Message, live: bool) -> Option<String> {
        self.provisional_identity(&Provisional::new(String::new(), message), live)
    }

    pub(super) fn provisional_identity(&self, incoming: &Provisional, live: bool) -> Option<String> {
        let entries = self.persisted.iter().map(|row| (Provisional::persisted(row), !self.history_ids.contains(&row.id)))
            .chain(self.streams.values().flat_map(|stream| stream.provisional.iter().cloned().map(|entry| {
                let live = !entry.is_materialized();
                (entry, live)
            })))
            .collect::<Vec<_>>();
        if let Some((entry, _)) = entries.iter().find(|(entry, _)| entry.transcript(incoming)) { return Some(entry.id.clone()); }
        let fragments = entries.iter().filter(|(entry, _)| entry.fragment(incoming)).collect::<Vec<_>>();
        if !fragments.is_empty() { return (fragments.len() == 1).then(|| fragments[0].0.id.clone()); }
        if !live && incoming.segment.is_none() { return None; }
        let receipts = entries.iter().filter(|(entry, _)| entry.receipt(incoming)).collect::<Vec<_>>();
        if !receipts.is_empty() { return (receipts.len() == 1).then(|| receipts[0].0.id.clone()); }
        let mut matches = entries.iter().filter(|(entry, live)| {
            let (durable, provisional, provisional_live) = if incoming.native_id.is_some() { (incoming, entry, *live) } else { (entry, incoming, true) };
            durable.matches(provisional, provisional_live, false)
        });
        let (entry, _) = matches.next()?;
        matches.next().is_none().then(|| entry.id.clone())
    }

    pub(in crate::session) fn promote_history(&mut self, previous: &[SessionItem]) -> Option<()> {
        self.merge_history(previous);
        let snapshot = self.persisted.iter().filter(|row| self.history_ids.contains(&row.id) && !row.hidden_control_reply())
            .map(|row| Provisional::persisted(row)).collect::<Vec<_>>();
        let mut entries = self.streams.values().flat_map(|stream| stream.provisional.iter().cloned()).collect::<Vec<_>>();
        let persisted = self.persisted.iter().filter(|row| !self.history_ids.contains(&row.id))
            .filter(|row| !entries.iter().any(|entry| entry.id == row.id))
            .map(|row| Provisional::persisted(row)).collect::<Vec<_>>();
        entries.extend(persisted);
        for entry in entries {
            let candidates = snapshot.iter().filter(|row| row.id != entry.id).cloned().collect::<Vec<_>>();
            if let Some(index) = self.selection(&entry, &candidates) { self.adopt_entry(entry, &candidates[index])?; }
            else if entry.is_materialized() {
                self.items.retain(|item| item.item_id() != entry.id);
                for stream in self.streams.values_mut() { stream.provisional.retain(|current| current.id != entry.id); }
                if !self.evicted.contains(&entry.id) { self.evicted.push(entry.id); }
            }
        }
        self.history_rebuilding = false;
        Some(())
    }

    pub(super) fn adopt_entry(&mut self, entry: Provisional, replacement: &Provisional) -> Option<()> {
        let id = entry.id.clone();
        if entry.fragment(replacement) {
            self.items.retain(|item| item.item_id() != id);
            for stream in self.streams.values_mut() {
                stream.provisional.retain(|entry| entry.id != id);
                if stream.thinking.iter().any(|thinking| thinking.stream_id == entry.stream_id) {
                    if !stream.anchors.contains(&id) { stream.anchors.push(id.clone()); }
                    for thinking in &mut stream.thinking {
                        if thinking.stream_id == entry.stream_id {
                            thinking.replacement = Some(replacement.id.clone());
                            if !thinking.items.contains(&id) { thinking.items.push(id.clone()); }
                        }
                    }
                }
            }
            if !self.retired.contains(&id) { self.retired.push(id.clone()); }
        } else if let Some(run) = entry.run.as_deref() {
            self.streams.entry(run.to_owned()).or_default();
            self.retire_provisional(run, &id)?;
        } else if let Some(index) = self.items.iter().position(|item| item.item_id() == id) {
            let mut item = self.items.remove(index);
            if let SessionItem::AssistantTurn { item_id, message_id, text, segments, .. } = &mut item {
                segments.retain(|segment| matches!(segment, SessionContent::Thinking { .. }));
                if !segments.is_empty() {
                    self.next_id = self.next_id.checked_add(1)?;
                    *item_id = format!("oc:live:{}", self.next_id);
                    *message_id = None; text.clear();
                    self.items.insert(index, item);
                }
            }
        }
        for stream in self.streams.values_mut() {
            stream.provisional.retain(|current| current.id != id);
            for part in stream.all_parts_mut() {
                if part.after.as_deref() == Some(&id) { part.after = Some(replacement.id.clone()); }
            }
        }
        self.persisted.retain(|row| row.id != id);
        self.history_ids.remove(&id);
        if !self.evicted.contains(&id) { self.evicted.push(id); }
        Some(())
    }
}
