use super::*;

type ContentIdentity = ([u8; 32], [u8; 32]);

#[derive(Clone)]
pub(super) struct Provisional {
    pub id: String,
    pub keyed: bool,
    role: MessageRole,
    imported: bool,
    native_id: Option<String>,
    key: Option<String>,
    run: Option<String>,
    sequence: Option<u64>,
    segment: Option<(String, Option<String>)>,
    after_sequence: Option<Option<u64>>,
    content: Option<ContentIdentity>,
    tool_continuation: bool,
    tool_stop: bool,
    terminal_stop: bool,
    run_terminal: bool,
    mirrored: bool,
}

#[derive(Clone)]
pub(super) struct InferredTerminal {
    entry: Provisional,
    item: SessionItem,
    matched: Provisional,
    thinking_id: Option<String>,
}

impl Provisional {
    pub(super) fn new(id: String, message: &Message) -> Self {
        Self {
            id, keyed: false, role: message.role(), imported: message.is_imported(),
            native_id: message.identity_message_id().map(str::to_owned),
            key: message.idempotency_key().map(str::to_owned),
            run: message.identity_run_id().map(str::to_owned), sequence: message.identity_sequence(),
            segment: message.display_item_id().map(|id| (id.to_owned(), message.identity_run_id().or(message.run_id()).map(str::to_owned))),
            after_sequence: message.after_sequence(), content: message.final_content_identity(),
            tool_continuation: message.tool_continuation(), tool_stop: message.stop_reason() == Some("toolUse") && !message.tool_continuation(),
            terminal_stop: message.terminal_stop(), run_terminal: message.run_terminal(), mirrored: message.mirror_origin().is_some(),
        }
    }

    fn segment_id(&self) -> Option<&str> { self.segment.as_ref().map(|(id, _)| id.as_str()) }

    fn transcript(&self, other: &Self) -> bool {
        if self.role != other.role { return false; }
        if self.imported || other.imported { return false; }
        if self.native_id.is_some() || other.native_id.is_some() {
            self.native_id.is_some() && self.native_id == other.native_id
        } else { self.sequence.is_some() && self.sequence == other.sequence }
    }

    fn receipt(&self, other: &Self) -> bool {
        self.role == MessageRole::Assistant && other.role == MessageRole::Assistant && !self.imported && !other.imported
            && self.key.is_some() && self.key == other.key
            && ((self.native_id.is_none() && self.sequence.is_none()) || (other.native_id.is_none() && other.sequence.is_none()))
    }

    fn matches(&self, current: &Self, live: bool, snapshot: bool) -> bool {
        if self.segment_id() != current.segment_id() { return false; }
        if self.transcript(current) || self.receipt(current) { return true; }
        if self.role == MessageRole::Assistant && current.role == MessageRole::Assistant
            && self.key.is_some() && current.key.is_some() && self.key != current.key { return false; }
        if self.role != current.role || self.imported || current.imported { return false; }
        if self.native_id.is_none() || current.native_id.is_some() { return false; }
        if self.role == MessageRole::Assistant {
            if current.sequence.is_none() && self.segment.as_ref().is_some_and(|(_, run)| run.is_some() && self.segment == current.segment) { return true; }
            let after = match current.after_sequence {
                None => true, Some(None) => false, Some(Some(boundary)) => self.sequence.is_some_and(|seq| seq > boundary),
            };
            if live && self.segment.is_none() && !self.tool_continuation && current.sequence.is_none() && after
                && self.run.is_some() && self.run == current.run && (!self.mirrored || self.run_terminal)
                && (!self.tool_stop || (self.content.is_some() && self.content == current.content))
            { return true; }
        }
        snapshot && live && current.sequence.is_some() && self.sequence == current.sequence
    }
}

pub(super) fn exact(left: &Message, right: &Message) -> bool {
    let left = Provisional::new(String::new(), left);
    let right = Provisional::new(String::new(), right);
    left.segment_id() == right.segment_id() && left.transcript(&right)
}

impl Body {
    fn terminal_candidate(&self, entry: &Provisional) -> bool {
        entry.role == MessageRole::Assistant && entry.native_id.is_none() && entry.sequence.is_none()
            && entry.run.as_ref().and_then(|run| self.streams.get(run)).is_some_and(|stream| stream.terminal_observed)
    }

    fn unsequenced_terminal(&self, entry: &Provisional) -> bool {
        self.terminal_candidate(entry) && entry.content.is_some()
            && entry.run.as_ref().and_then(|run| self.streams.get(run)).is_some_and(|stream| stream.final_content == entry.content)
    }

    fn positional_tools_after(&self, run: Option<&str>, id: &str) -> bool {
        let Some(start) = self.items.iter().position(|item| item.item_id() == id) else { return false; };
        self.items[start + 1..].iter().take_while(|item| !matches!(item, SessionItem::UserMessage { .. })).any(|item|
            matches!(item, SessionItem::AssistantTurn { run_id, segments, .. } if run_id.as_deref() == run
                && segments.iter().any(|segment| matches!(segment, SessionContent::ToolUse { .. }))))
    }

    fn terminal_match(&self, entry: &Provisional, snapshot: &[Provisional]) -> Option<(usize, bool)> {
        if !self.unsequenced_terminal(entry) { return None; }
        let first_user = snapshot.iter().position(|row| row.run == entry.run && row.role == MessageRole::User);
        let last_assistant = snapshot.iter().rposition(|row| row.run == entry.run && row.role == MessageRole::Assistant);
        let mut matches = snapshot.iter().enumerate().filter(|(index, row)| {
            if !row.matches(entry, true, true) || row.content != entry.content { return false; }
            let same_run = entry.run.is_some() && row.run == entry.run;
            let last = same_run && last_assistant == Some(*index)
                && !snapshot[*index + 1..].iter().any(|later| later.run == entry.run && later.role == MessageRole::ToolResult)
                && !self.positional_tools_after(entry.run.as_deref(), &row.id);
            row.run_terminal || (same_run && row.terminal_stop) || (row.tool_stop && last)
                || (last && first_user.is_some_and(|user| user < *index))
        });
        let (index, row) = matches.next()?;
        matches.next().is_none().then_some((index, !row.run_terminal && !row.terminal_stop))
    }

    fn selection(&self, entry: &Provisional, snapshot: &[Provisional], live: bool) -> Option<(usize, bool)> {
        // Transcript identity wins; a receipt cannot choose between durable occurrences.
        if let Some(index) = snapshot.iter().position(|row| row.segment_id() == entry.segment_id() && row.transcript(entry)) { return Some((index, false)); }
        let receipts = snapshot.iter().enumerate().filter(|(_, row)| row.segment_id() == entry.segment_id() && row.receipt(entry))
            .map(|(index, _)| index).collect::<Vec<_>>();
        if !receipts.is_empty() { return (receipts.len() == 1).then(|| (receipts[0], false)); }
        if self.terminal_candidate(entry) { return self.terminal_match(entry, snapshot); }
        let mut matches = snapshot.iter().enumerate().filter(|(_, row)| row.matches(entry, live, true)
            && !row.tool_stop && (row.content.is_some() && row.content == entry.content || entry.sequence.is_some()));
        let (index, _) = matches.next()?;
        matches.next().is_none().then_some((index, false))
    }

    pub(super) fn live_identity(&self, message: &Message) -> Option<String> {
        let incoming = Provisional::new(String::new(), message);
        let entries = self.persisted.iter().map(|row| (Provisional::new(row.id.clone(), row), !self.history_ids.contains(&row.id)))
            .chain(self.streams.values().flat_map(|stream| stream.provisional.iter().cloned().map(|entry| (entry, true))))
            .collect::<Vec<_>>();
        if let Some((entry, _)) = entries.iter().find(|(entry, _)| entry.segment_id() == incoming.segment_id() && entry.transcript(&incoming)) { return Some(entry.id.clone()); }
        let receipts = entries.iter().filter(|(entry, _)| entry.segment_id() == incoming.segment_id() && entry.receipt(&incoming)).collect::<Vec<_>>();
        if !receipts.is_empty() { return (receipts.len() == 1).then(|| receipts[0].0.id.clone()); }
        let mut matches = entries.iter().filter(|(entry, live)| {
            let (durable, provisional, provisional_live) = if incoming.native_id.is_some() { (&incoming, entry, *live) } else { (entry, &incoming, true) };
            // Unsequenced terminal adoption is decided against the complete durable snapshot below.
            !self.terminal_candidate(provisional) && !durable.tool_stop
                && durable.content.is_some() && durable.content == provisional.content && durable.matches(provisional, provisional_live, false)
        });
        let (entry, _) = matches.next()?;
        matches.next().is_none().then(|| entry.id.clone())
    }

    fn snapshot(&self) -> Vec<Provisional> {
        self.persisted.iter().filter(|row| row.identity_message_id().is_some() || row.identity_sequence().is_some())
            .filter(|row| !row.hidden_control_reply()).map(|row| Provisional::new(row.id.clone(), row)).collect()
    }

    pub(super) fn reconcile_terminals(&mut self) -> Option<()> {
        if self.history_rebuilding { return Some(()); }
        let snapshot = self.snapshot();
        self.reconcile_inferred(&snapshot)?;
        self.promote_entries(&snapshot, true)
    }

    pub(in crate::session) fn promote_history(&mut self, _messages: &[(&Message, String)]) -> Option<()> {
        let snapshot = self.persisted.iter().filter(|row| self.history_ids.contains(&row.id) && !row.hidden_control_reply())
            .map(|row| Provisional::new(row.id.clone(), row)).collect::<Vec<_>>();
        self.reconcile_inferred(&snapshot)?;
        self.promote_entries(&snapshot, false)?;
        self.history_rebuilding = false;
        Some(())
    }

    fn promote_entries(&mut self, snapshot: &[Provisional], terminal_only: bool) -> Option<()> {
        let mut entries = self.streams.values().flat_map(|stream| stream.provisional.iter().cloned()).collect::<Vec<_>>();
        let persisted = self.persisted.iter().filter(|row| !self.history_ids.contains(&row.id))
            .filter(|row| !entries.iter().any(|entry| entry.id == row.id))
            .map(|row| Provisional::new(row.id.clone(), row)).collect::<Vec<_>>();
        entries.extend(persisted);
        for entry in entries {
            if terminal_only && !self.terminal_candidate(&entry) { continue; }
            let candidates = snapshot.iter().filter(|row| row.id != entry.id).cloned().collect::<Vec<_>>();
            let Some((index, inferred)) = self.selection(&entry, &candidates, true) else { continue; };
            let replacement = &candidates[index];
            if inferred && entry.run.as_ref().and_then(|run| self.streams.get(run)).is_some_and(|stream| stream.inferred.is_some()) { continue; }
            self.adopt_entry(entry, replacement, inferred)?;
        }
        Some(())
    }

    fn adopt_entry(&mut self, entry: Provisional, replacement: &Provisional, inferred: bool) -> Option<()> {
        let id = entry.id.clone();
        let run = entry.run.clone();
        if inferred {
            let Some(index) = self.items.iter().position(|item| item.item_id() == id) else { return Some(()); };
            let mut item = self.items.remove(index);
            if let SessionItem::AssistantTurn { status, .. } = &mut item {
                if !matches!(*status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted) { *status = ItemStatus::Final; }
            }
            let mut thinking = item.clone();
            let mut thinking_id = None;
            if let SessionItem::AssistantTurn { item_id, message_id, text, segments, .. } = &mut thinking {
                segments.retain(|segment| matches!(segment, SessionContent::Thinking { .. }));
                if !segments.is_empty() {
                    self.next_id = self.next_id.checked_add(1)?;
                    *item_id = format!("oc:live:{}", self.next_id);
                    *message_id = None; text.clear();
                    thinking_id = Some(item_id.clone());
                    self.items.insert(index, thinking);
                }
            }
            let stream = self.streams.get_mut(run.as_deref()?)?;
            stream.provisional.retain(|entry| entry.id != id);
            if let Some(id) = &thinking_id { stream.anchors.push(id.clone()); }
            stream.inferred = Some(InferredTerminal { entry, item, matched: replacement.clone(), thinking_id });
            if !stream.anchors.contains(&id) { stream.anchors.push(id.clone()); }
            if !self.retired.contains(&id) { self.retired.push(id.clone()); }
        } else if let Some(run) = run.as_deref() {
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
            for part in stream.all_parts_mut() {
                if part.after.as_deref() == Some(&id) { part.after = Some(replacement.id.clone()); }
            }
        }
        self.persisted.retain(|row| row.id != id);
        self.history_ids.remove(&id);
        if !self.evicted.contains(&id) { self.evicted.push(id); }
        Some(())
    }

    fn reconcile_inferred(&mut self, snapshot: &[Provisional]) -> Option<()> {
        let runs = self.streams.keys().cloned().collect::<Vec<_>>();
        for run in runs {
            let Some(inferred) = self.streams.get_mut(&run)?.inferred.take() else { continue; };
            // Full removal/filtering is authoritative, not evidence against terminal position.
            let remains = snapshot.iter().any(|row| row.transcript(&inferred.matched)
                && self.items.iter().any(|item| item.item_id() == row.id));
            let terminal = self.selection(&inferred.entry, snapshot, true);
            if remains && terminal.is_some_and(|(_, inferred)| inferred) {
                self.streams.get_mut(&run)?.inferred = Some(inferred);
            } else if remains && terminal.is_none() {
                let mut item = inferred.item;
                let status = self.status(&run);
                if let SessionItem::AssistantTurn { status: current, .. } = &mut item {
                    if status != ItemStatus::Streaming { *current = status; }
                }
                if let Some(id) = &inferred.thinking_id { self.items.retain(|item| item.item_id() != id); }
                let candidate = snapshot.iter().find(|row| row.transcript(&inferred.matched))?;
                let start = self.items.iter().position(|item| item.item_id() == candidate.id)?;
                let end = self.items.iter().enumerate().skip(start + 1).find(|(_, item)| matches!(item, SessionItem::UserMessage { .. }))
                    .map_or(self.items.len(), |(index, _)| index);
                let insert = self.items[start..end].iter().rposition(|item|
                    matches!(item, SessionItem::AssistantTurn { run_id: Some(owner), .. } if owner == &run)
                        || snapshot.iter().any(|row| row.id == item.item_id() && row.run.as_deref() == Some(&run)))
                    .map_or(start + 1, |index| start + index + 1);
                let id = inferred.entry.id.clone();
                self.retired.retain(|retired| retired != &id);
                self.evicted.retain(|evicted| evicted != &id);
                self.items.insert(insert, item);
                let stream = self.streams.get_mut(&run)?;
                if let Some(id) = inferred.thinking_id { stream.anchors.retain(|anchor| anchor != &id); }
                stream.provisional.push(inferred.entry);
            }
        }
        Some(())
    }

    pub(super) fn evict_inferred(&mut self, id: &str) {
        for stream in self.streams.values_mut() {
            if stream.inferred.as_ref().is_some_and(|inferred| inferred.matched.id == id || inferred.entry.id == id) { stream.inferred = None; }
        }
    }
}
