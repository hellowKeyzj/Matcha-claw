use super::*;

#[derive(Clone)]
pub(super) struct Provisional {
    pub id: String,
    pub keyed: bool,
    role: MessageRole,
    imported: bool,
    run: Option<String>,
    sequence: Option<u64>,
    segment: Option<(String, String)>,
    after_sequence: Option<Option<u64>>,
}

impl Provisional {
    pub(super) fn new(id: String, message: &Message) -> Self {
        Self {
            id,
            keyed: false,
            role: message.role(),
            imported: message.is_imported(),
            run: message.identity_run_id().map(str::to_owned),
            sequence: message.identity_sequence(),
            segment: message.display_item_id().zip(message.run_id()).map(|(id, run)| (id.to_owned(), run.to_owned())),
            after_sequence: message.after_sequence(),
        }
    }
}

pub(super) fn exact(left: &Message, right: &Message) -> bool {
    if left.role() != right.role() || left.is_imported() || right.is_imported() { return false; }
    match (left.identity_message_id(), right.identity_message_id()) {
        (Some(left), Some(right)) => left == right,
        (None, None) => left.identity_sequence().is_some() && left.identity_sequence() == right.identity_sequence(),
        _ => false,
    }
}

fn matches(durable: &Message, provisional: &Provisional, live: bool) -> bool {
    if durable.role() != provisional.role || durable.is_imported() || provisional.imported { return false; }
    if durable.identity_message_id().is_none() {
        return durable.identity_sequence().is_some() && durable.identity_sequence() == provisional.sequence;
    }
    if durable.role() != MessageRole::Assistant || provisional.sequence.is_some() { return false; }
    if provisional.segment.as_ref().is_some_and(|(id, run)| durable.display_item_id() == Some(id.as_str()) && durable.run_id() == Some(run.as_str())) {
        return true;
    }
    let after_boundary = match provisional.after_sequence {
        None => true,
        Some(None) => false,
        Some(Some(boundary)) => durable.identity_sequence().is_some_and(|seq| seq > boundary),
    };
    live && after_boundary && durable.identity_run_id().is_some()
        && durable.identity_run_id() == provisional.run.as_deref()
        && (durable.mirror_origin().is_none() || durable.run_terminal())
}

fn matches_history(durable: &Message, provisional: &Provisional) -> bool {
    matches(durable, provisional, true)
        || (durable.role() == provisional.role && !durable.is_imported() && !provisional.imported
            && durable.identity_message_id().is_some() && provisional.sequence.is_some()
            && durable.identity_sequence() == provisional.sequence)
}

impl Body {
    pub(super) fn durable_owns(&self, message: &Message) -> bool {
        if message.identity_message_id().is_some() {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.final.durable_owns", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": message.identity_run_id().map(trace::fingerprint), "sdkIdPresent": true,
                    "candidateCountCapped2": null, "moreThanOne": null, "owns": false, "reason": "sdk_id_present" }));
            }
            return false;
        }
        let incoming = Provisional::new(String::new(), message);
        let mut candidates = self.persisted.iter().filter(|row| row.identity_message_id().is_some() && matches(row, &incoming, true)
            && self.items.iter().any(|item| item.item_id() == row.id));
        let first = candidates.next();
        let more_than_one = first.is_some() && candidates.next().is_some();
        let owns = first.is_some() && !more_than_one;
        if super::super::trace::enabled() {
            super::super::trace::log_unscoped("runtime.openclaw.body.final.durable_owns", serde_json::json!({ "commitState": "candidate_only",
                "runHash": message.identity_run_id().map(trace::fingerprint), "sdkIdPresent": false,
                "sdkSeq": message.identity_sequence(), "afterSequenceState": match message.after_sequence() { None => "missing", Some(None) => "null", Some(Some(_)) => "number" },
                "afterSequence": message.after_sequence().flatten(),
                "candidateCountCapped2": usize::from(first.is_some()) + usize::from(more_than_one),
                "moreThanOne": more_than_one, "owns": owns, "reason": if owns { "unique" } else if more_than_one { "many" } else { "zero" },
                "firstMessageHash": first.and_then(|row| row.identity_message_id()).map(trace::fingerprint) }));
        }
        owns
    }

    pub(super) fn live_identity(&self, message: &Message) -> Option<String> {
        if let Some(row) = self.persisted.iter().find(|row| exact(row, message)) { return Some(row.id.clone()); }
        let incoming = Provisional::new(String::new(), message);
        let mut candidates = self.persisted.iter().filter(|row| {
            if row.identity_message_id().is_some() && message.identity_message_id().is_none() {
                matches(row, &incoming, true)
            } else if row.identity_message_id().is_none() && message.identity_message_id().is_some() {
                matches(message, &Provisional::new(row.id.clone(), row), !self.history_ids.contains(&row.id))
            } else { false }
        }).map(|row| row.id.as_str()).chain(self.streams.values().flat_map(|stream| &stream.provisional)
            .filter(|entry| matches(message, entry, true)).map(|entry| entry.id.as_str()));
        let id = candidates.next()?;
        candidates.next().is_none().then(|| id.to_owned())
    }

    pub(in crate::session) fn promote_history(&mut self, messages: &[(&Message, String)]) -> Option<()> {
        let retired = self.streams.iter().flat_map(|(run, stream)| stream.provisional.iter().filter_map(|entry| {
            let mut candidates = messages.iter().filter(|(row, _)| matches_history(row, entry));
            (candidates.next().is_some() && candidates.next().is_none()).then(|| (run.clone(), entry.id.clone()))
        })).collect::<Vec<_>>();
        for (run, id) in retired { self.retire_provisional(&run, &id)?; }
        let promoted = self.persisted.iter().filter(|current| !self.history_ids.contains(&current.id)).filter_map(|current| {
            let provisional = Provisional::new(current.id.clone(), current);
            let mut candidates = messages.iter().filter(|(row, _)| exact(row, current)
                || (current.identity_message_id().is_none() && matches_history(row, &provisional))
                || (current.identity_message_id().is_some() && row.identity_message_id().is_none()
                    && matches(current, &Provisional::new(String::new(), row), false)));
            let (_, replacement) = candidates.next()?;
            if candidates.next().is_some() { return None; }
            Some((current.id.clone(), replacement.clone(), current.identity_message_id().is_none()))
        }).collect::<Vec<_>>();
        for (id, replacement, provisional) in promoted {
            for stream in self.streams.values_mut() {
                for part in stream.all_parts_mut() {
                    if part.after.as_deref() == Some(&id) { part.after = Some(replacement.clone()); }
                }
            }
            if let Some(index) = self.items.iter().position(|item| item.item_id() == id) {
                let mut item = self.items.remove(index);
                if provisional && let SessionItem::AssistantTurn { item_id, message_id, text, segments, run_id, .. } = &mut item {
                    segments.retain(|segment| matches!(segment, SessionContent::Thinking { .. }));
                    text.clear();
                    if !segments.is_empty() {
                        self.next_id = self.next_id.checked_add(1)?;
                        *item_id = format!("oc:live:{}", self.next_id);
                        *message_id = None;
                        if let Some(stream) = run_id.as_ref().and_then(|run| self.streams.get_mut(run)) {
                            stream.anchors.push(item_id.clone());
                        }
                        self.items.insert(index, item);
                    }
                }
            }
            self.persisted.retain(|row| row.id != id);
            if !self.evicted.contains(&id) { self.evicted.push(id); }
        }
        Some(())
    }
}
