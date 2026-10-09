use super::*;
use crate::session::events::TerminalOutcome;

impl Body {
    pub(super) fn finish_observed(&mut self, run: &str, message: &Message, cache: &OpenClawReplayProjection) -> Option<bool> {
        let Some(stream) = self.streams.get(run) else { return Some(false); };
        if message.identity_message_id().is_some() || message.identity_sequence().is_some()
            || message.display_item_id().is_some() || message.is_imported() || message.hidden_control_reply()
            || message.identity_run_id() != Some(run) || message.after_sequence() == Some(None)
            || message.text().is_empty() || stream.text() != Some(message.text())
            || !stream.closed.iter().any(|closed| closed.tool_boundary || closed.boundary_run_id.is_some())
            || !stream.all_parts().any(|part| part.id.is_some())
        { return Some(false); }
        let Some(SessionItem::AssistantTurn { mut segments, .. }) = transcript_session_item(message, self.items.len(), cache) else {
            return Some(false);
        };
        let stream = self.streams.get_mut(run)?;
        let last = stream.all_parts().last()?.id.clone();
        segments.retain(|segment| !matches!(segment, SessionContent::ToolUse { tool_call_id, .. }
            if self.items.iter().any(|item| matches!(item, SessionItem::AssistantTurn { item_id, segments, .. }
                if !stream.all_parts().any(|part| part.id.as_ref() == Some(item_id))
                    && segments.iter().any(|existing| matches!(existing, SessionContent::ToolUse { tool_call_id: id, .. } if id == tool_call_id))))));
        for part in stream.all_parts_mut() {
            part.observed = true;
            let mut position = 0;
            part.content_before = false;
            let projected = segments.iter().filter_map(|segment| {
                if let SessionContent::Text { text } = segment {
                    let begin = position + message.text()[position..].find(text.as_str())?;
                    let end = begin + text.len();
                    let from = part.covered.max(part.start).max(position).min(end);
                    let to = part.end.min(end);
                    position = end;
                    return (from < to).then(|| SessionContent::Text { text: message.text()[from..to].to_owned() });
                }
                let belongs = position >= part.start && (position < part.end || (part.id == last && position == part.end));
                if belongs && position == part.start { part.content_before = true; }
                belongs.then(|| segment.clone())
            }).collect::<Vec<_>>();
            if projected.is_empty() { continue; }
            let text = projected.iter().filter_map(|segment| match segment { SessionContent::Text { text } => Some(text.as_str()), _ => None }).collect();
            let id = part.id.as_ref()?;
            if let Some(SessionItem::AssistantTurn { text: current_text, segments: current, .. }) = self.items.iter_mut().find(|item| item.item_id() == id) {
                *current_text = text;
                *current = projected;
            } else {
                self.next_id = self.next_id.checked_add(1)?;
                let id = format!("oc:live:{}", self.next_id);
                part.id = Some(id.clone());
                self.items.push(SessionItem::AssistantTurn { item_id: id, run_id: Some(run.to_owned()), message_id: None,
                    text, status: ItemStatus::Final, segments: projected });
            }
        }
        self.reconcile(run)?;
        Some(true)
    }

    pub(super) fn finish_message(&mut self, run: &str, message: &Message, outcome: TerminalOutcome, cache: &OpenClawReplayProjection) -> Option<()> {
        let retired_before = super::super::trace::enabled().then_some(self.retired.len());
        if super::super::trace::enabled() {
            super::super::trace::log_unscoped("runtime.openclaw.body.final.input", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "outcome": format!("{outcome:?}"), "hidden": message.hidden_control_reply(),
                "historyApplied": self.history_applied_for_run(run), "sdkIdPresent": message.identity_message_id().is_some(),
                "sdkMessageHash": message.identity_message_id().map(trace::fingerprint), "identityRunHash": message.identity_run_id().map(trace::fingerprint),
                "seq": message.sequence(), "sdkSeq": message.identity_sequence(),
                "afterSequenceState": match message.after_sequence() { None => "missing", Some(None) => "null", Some(Some(_)) => "number" },
                "afterSequence": message.after_sequence().flatten(), "pending": self.needs_terminal_history(),
                "durableSelector": if outcome != TerminalOutcome::Completed { "skipped_outcome" } else if message.hidden_control_reply() { "skipped_hidden" }
                    else if self.history_applied_for_run(run) { "skipped_history" } else { "evaluated_next" } }));
        }
        let thinking = message.content().iter().filter_map(|content| match content {
            crate::session::window::MessageContent::Thinking { text } => Some(text.as_str()), _ => None,
        }).collect::<String>();
        if !thinking.is_empty() {
            self.items.retain(|item| !matches!(item, SessionItem::AssistantTurn { run_id: Some(owner), message_id: None, segments, .. }
                if owner == run && matches!(segments.as_slice(), [SessionContent::Thinking { .. }])));
            if let Some(stream) = self.streams.get_mut(run) {
                stream.anchors.retain(|id| self.retired.contains(id) || self.items.iter().any(|item| item.item_id() == id));
                stream.thinking.clear();
            }
        }
        if self.finish_observed(run, message, cache)? { return Some(()); }
        if outcome == TerminalOutcome::Completed && self.history_applied_for_run(run)
        {
            self.retire_body(run)?;
            if !thinking.is_empty() { self.chunk(run, AssistantTurnChunkKind::Thinking, &thinking, true)?; }
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.final.result", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": trace::fingerprint(run), "branch": "suppress", "retiredAdded": self.retired.len().saturating_sub(retired_before.unwrap_or(0)) }));
            }
            return Some(());
        }
        if message.hidden_control_reply() { return Some(()); }
        let boundary = (outcome == TerminalOutcome::Completed).then(|| self.terminal_boundary(run, message.text())).flatten();
        let tail = boundary.as_ref().map(|(boundary, prefix, discard)| {
            (boundary.clone(), message.text()[*prefix..].trim_start_matches(reconciliation::whitespace).to_owned(), discard.clone())
        });
        if let Some((_, _, discard)) = &tail {
            let stream = self.streams.entry(run.to_owned()).or_default();
            let ids = stream.parts.iter().chain(discard.iter().flat_map(|index| &stream.closed[*index].parts))
                .filter_map(|part| part.id.clone()).collect::<Vec<_>>();
            self.items.retain(|item| !ids.iter().any(|id| id == item.item_id()));
            for part in stream.all_parts_mut() {
                if part.id.as_ref().is_some_and(|id| ids.contains(id)) {
                    part.covered = part.end;
                    if let Some(id) = &part.id && !self.retired.contains(id) { self.retired.push(id.clone()); }
                }
            }
        }
        let terminal = tail.as_ref().map(|(boundary, text, _)| {
            let sequence = self.persisted.iter().find(|row| row.role() == MessageRole::User && row.run_id() == Some(boundary))
                .and_then(|row| row.identity_sequence());
            message.clone().with_terminal_text(text.clone(), sequence)
        });
        let message = terminal.as_ref().unwrap_or(message);
        if tail.is_some() && message.text().is_empty() {
            if !thinking.is_empty() { self.chunk(run, AssistantTurnChunkKind::Thinking, &thinking, true)?; }
            return Some(());
        }
        let Some(mut item) = transcript_session_item(message, self.items.len(), cache) else {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.final.result", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": trace::fingerprint(run), "branch": "no_projection", "retiredAdded": self.retired.len().saturating_sub(retired_before.unwrap_or(0)) }));
            }
            return Some(());
        };
        let terminal_text = if outcome == TerminalOutcome::Completed { message.text().trim_matches(reconciliation::whitespace) } else { message.text().trim() };
        if terminal_text.is_empty() && matches!(&item, SessionItem::AssistantTurn { segments, .. }
            if segments.iter().all(|segment| matches!(segment, SessionContent::Text { text } | SessionContent::Thinking { text } if text.trim().is_empty()))) {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.final.result", serde_json::json!({ "commitState": "candidate_only",
                    "runHash": trace::fingerprint(run), "branch": "empty", "retiredAdded": self.retired.len().saturating_sub(retired_before.unwrap_or(0)) }));
            }
            return Some(());
        }
        let mut removed = Vec::new();
        let mut insert = self.items.len();
        if outcome == TerminalOutcome::Completed {
            let after_boundary = tail.as_ref().map(|(boundary, _, _)| boundary.as_str())
                .or_else(|| self.streams.get(run).and_then(|stream| stream.all_parts().filter(|part|
                    part.id.as_ref().is_some_and(|id| self.items.iter().any(|item| item.item_id() == id)))
                    .last().and_then(|part| part.after_boundary_run_id.as_deref())))
                .or_else(|| self.streams.get(run).and_then(|stream| stream.latest_boundary_run_id.as_deref()));
            let (start, end) = self.terminal_interval(run, after_boundary);
            insert = end;
            let mut current = Vec::new();
            let mut cursor = 0;
            for item in &self.items[start..end] {
                let Some((keyed, is_current)) = self.terminal_fallback(run, item) else { continue; };
                let SessionItem::AssistantTurn { text, .. } = item else { continue; };
                let visible = text.trim_matches(reconciliation::whitespace);
                if keyed {
                    if !visible.is_empty() && visible == terminal_text { removed.push(item.item_id().to_owned()); }
                    continue;
                }
                if is_current { current.push(item.item_id().to_owned()); }
                let remaining = terminal_text[cursor..].trim_start_matches(reconciliation::whitespace);
                if !visible.is_empty() && remaining.starts_with(visible) {
                    cursor = terminal_text.len() - remaining.len() + visible.len();
                    removed.push(item.item_id().to_owned());
                } else if cursor > 0 { break; }
            }
            if removed.is_empty() && current.len() == 1 { removed.extend(current); }
        } else {
            let stream = self.streams.entry(run.to_owned()).or_default();
            let current = (!stream.body_closed).then(|| stream.parts.last().and_then(|part| part.id.clone())).flatten();
            let mut cursor = 0;
            let visible = self.items.iter().filter_map(|item| match item {
                SessionItem::AssistantTurn { run_id: Some(owner), text, .. }
                    if owner == run && stream.all_parts().any(|part| part.id.as_deref() == Some(item.item_id())) && !text.trim().is_empty() => Some(text.trim()),
                _ => None,
            }).collect::<Vec<_>>();
            let replaces = outcome != TerminalOutcome::Error || (!visible.is_empty() && visible.iter().enumerate().all(|(index, text)| {
                let Some(offset) = terminal_text[cursor..].find(text) else { return false; };
                if index == 0 && offset != 0 { return false; }
                cursor += offset + text.len();
                true
            }));
            if replaces {
                cursor = 0;
                for part in stream.all_parts() {
                    let Some(id) = &part.id else { continue; };
                    let Some(SessionItem::AssistantTurn { text, .. }) = self.items.iter().find(|item| item.item_id() == id) else { continue; };
                    let visible = text.trim();
                    let remaining = terminal_text[cursor..].trim_start();
                    if !visible.is_empty() && remaining.starts_with(visible) {
                        cursor = terminal_text.len() - remaining.len() + visible.len();
                        removed.push(id.clone());
                    }
                }
                if outcome == TerminalOutcome::Aborted || removed.is_empty() {
                    if let Some(current) = current { removed.push(current); }
                }
            }
        }
        let first = self.items.iter().position(|item| removed.iter().any(|id| id == item.item_id()));
        self.items.retain(|item| !removed.iter().any(|id| id == item.item_id()));
        let stream = self.streams.entry(run.to_owned()).or_default();
        for part in stream.all_parts_mut() {
            if let Some(id) = &part.id && removed.contains(id) { part.covered = part.end; }
        }
        for id in &removed {
            if !self.retired.contains(id) { self.retired.push(id.clone()); }
            if !stream.anchors.contains(id) { stream.anchors.push(id.clone()); }
        }
        if outcome == TerminalOutcome::Completed && self.durable_owns(message) {
            if !thinking.is_empty() { self.chunk(run, AssistantTurnChunkKind::Thinking, &thinking, true)?; }
            return Some(());
        }
        let id = if let Some(id) = message.display_item_id().or_else(|| message.identity_message_id())
            && !self.items.iter().any(|item| item.item_id() == id)
        { id.to_owned() } else {
            loop {
                self.next_id = self.next_id.checked_add(1)?;
                let id = format!("oc:live:{}", self.next_id);
                if !self.items.iter().any(|item| item.item_id() == id) { break id; }
            }
        };
        if let SessionItem::AssistantTurn { item_id, run_id, message_id, .. } = &mut item {
            *item_id = id.clone();
            *run_id = Some(run.to_owned());
            *message_id = message.message_id().map(str::to_owned);
        }
        if message.identity_message_id().is_some() {
            self.apply_live_message(message, cache)?;
        } else {
            if let Some(index) = self.items.iter().position(|item| item.item_id() == id) { self.items[index] = item; }
            else { self.items.insert(first.unwrap_or(insert).min(self.items.len()), item); }
            let stream = self.streams.get_mut(run)?;
            stream.provisional.retain(|entry| entry.id != id);
            stream.provisional.push(Provisional::new(id, message));
        }
        if super::super::trace::enabled() {
            super::super::trace::log_unscoped("runtime.openclaw.body.final.result", serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "branch": if message.identity_message_id().is_some() { "physical_apply" } else { "provisional_materialize" },
                "retiredAdded": self.retired.len().saturating_sub(retired_before.unwrap_or(0)), "partsRemoved": removed.len(),
                "provisionalCount": self.streams.get(run).map_or(0, |stream| stream.provisional.len()) }));
        }
        Some(())
    }

    fn terminal_fallback(&self, run: &str, item: &SessionItem) -> Option<(bool, bool)> {
        let SessionItem::AssistantTurn { run_id, text, segments, .. } = item else { return None; };
        let id = item.item_id();
        if self.retired.iter().any(|retired| retired == id) { return None; }
        if let Some(fallback) = self.persisted.iter().find(|row|
            row.id == id).and_then(|row| row.stream_fallback())
        {
            return Some((fallback.item_id.is_some(), fallback.source == super::super::window::StreamFallbackSource::Current));
        }
        let stream = self.streams.get(run)?;
        if let Some(part) = stream.all_parts().find(|part| part.id.as_deref() == Some(id)) {
            if part.observed { return None; }
            return Some((false, !stream.body_closed && stream.parts.iter().any(|part| part.id.as_deref() == Some(id))));
        }
        if run_id.as_deref() == Some(run) && !text.is_empty()
            && segments.iter().all(|segment| matches!(segment, SessionContent::Text { .. } | SessionContent::Thinking { .. }))
            && !stream.provisional.iter().any(|entry| entry.id == id && !entry.keyed)
            && !self.persisted.iter().any(|row| row.id == id)
        { return Some((true, false)); }
        None
    }

    fn terminal_interval(&self, run: &str, after_boundary: Option<&str>) -> (usize, usize) {
        let floor = after_boundary.and_then(|boundary| self.items.iter().position(|item| self.user_run(item) == Some(boundary)))
            .or_else(|| self.items.iter().position(|item| self.user_run(item) == Some(run)));
        if let Some(floor) = floor {
            let end = self.items.iter().enumerate().skip(floor + 1).find(|(_, item)| matches!(item, SessionItem::UserMessage { .. }))
                .map_or(self.items.len(), |(index, _)| index);
            (floor + 1, end)
        } else {
            (self.items.iter().rposition(|item| matches!(item, SessionItem::UserMessage { .. })).map_or(0, |index| index + 1), self.items.len())
        }
    }

    fn user_run<'a>(&'a self, item: &SessionItem) -> Option<&'a str> {
        if !matches!(item, SessionItem::UserMessage { .. }) { return None; }
        self.persisted.iter().find(|row| row.role() == MessageRole::User && row.id == item.item_id()).and_then(|row| row.run_id())
    }

    fn terminal_boundary(&self, run: &str, text: &str) -> Option<(String, usize, Vec<usize>)> {
        let mut accumulated = None;
        let mut advancing = Vec::new();
        let mut live = None;
        if let Some(stream) = self.streams.get(run) {
            let marker = stream.latest_boundary_run_id.as_ref().filter(|boundary|
                !stream.closed.iter().any(|closed| closed.boundary_run_id.as_ref() == Some(boundary)));
            let mut marker_seen = false;
            for (index, closed) in stream.closed.iter().enumerate() {
                if let Some(boundary) = marker && !marker_seen && closed.after_boundary_run_id.as_ref() == Some(boundary) {
                    if let Some(prefix) = accumulated { live = Some((boundary.clone(), prefix, advancing.clone())); }
                    marker_seen = true;
                }
                let next = reconciliation::advance(accumulated, &closed.text);
                if next != accumulated { advancing.push(index); }
                accumulated = next;
                if let Some(boundary) = &closed.boundary_run_id && let Some(prefix) = accumulated {
                    live = Some((boundary.clone(), prefix, advancing.clone()));
                }
            }
            if let Some(boundary) = marker && !marker_seen && let Some(prefix) = accumulated {
                live = Some((boundary.clone(), prefix, advancing));
            }
        }
        if let Some((boundary, prefix, _)) = &live && text.starts_with(prefix) {
            return Some((boundary.clone(), prefix.len(), Vec::new()));
        }
        let boundary = self.persisted.iter().rev().find(|row| row.role() == MessageRole::User && row.steer_target_run_id() == Some(run))?.run_id()?;
        let end = self.items.iter().position(|item| self.user_run(item) == Some(boundary))?;
        let start = self.items[..end].iter().position(|item| matches!(item,
            SessionItem::AssistantTurn { run_id: Some(owner), text: persisted, .. }
                if owner == run && !persisted.is_empty() && (text.starts_with(persisted) || persisted.starts_with(text)))
            && !self.terminal_fallback(run, item).is_some_and(|(keyed, _)| keyed))
            .unwrap_or_else(|| self.items[..end].iter().rposition(|item| matches!(item, SessionItem::UserMessage { .. })).map_or(0, |index| index + 1));
        let texts = self.items[start..end].iter().filter_map(|item| {
            let SessionItem::AssistantTurn { run_id, text, .. } = item else { return None; };
            (run_id.as_deref().is_none_or(|owner| owner == run)
                && !self.terminal_fallback(run, item).is_some_and(|(keyed, _)| keyed)).then_some(text.as_str())
        });
        let prefix = text.len() - reconciliation::tail_length(texts, text);
        (prefix > 0).then(|| (boundary.to_owned(), prefix, live.map_or_else(Vec::new, |(_, _, indexes)| indexes)))
    }

    pub(in crate::session) fn confirm_terminal_history(&mut self, messages: &[&Message]) -> Option<()> {
        let Some(marker) = self.terminal_marker.as_ref() else {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", serde_json::json!({ "commitState": "candidate_only",
                    "result": "no_marker", "pendingBefore": false, "pendingAfter": false }));
            }
            return Some(());
        };
        let exact = messages.iter().any(|message| message.role() == MessageRole::Assistant && !message.is_imported()
            && message.identity_message_id() == Some(marker.message_id.as_str()));
        let visible = exact && self.persisted.iter().any(|row| row.identity_message_id() == Some(marker.message_id.as_str())
            && self.history_ids.contains(&row.id) && self.items.iter().any(|item| item.item_id() == row.id));
        if !visible {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", serde_json::json!({ "commitState": "candidate_only",
                    "result": if exact { "visible_missing" } else { "exact_missing" }, "exact": exact, "visible": exact.then_some(visible),
                    "markerRunHash": trace::fingerprint(&marker.run_id), "markerMessageHash": trace::fingerprint(&marker.message_id),
                    "historyApplied": marker.history_applied, "pendingBefore": self.needs_terminal_history(), "pendingAfter": self.needs_terminal_history() }));
            }
            return Some(());
        }
        let pending_before = super::super::trace::enabled().then(|| self.needs_terminal_history());
        let retired_before = super::super::trace::enabled().then_some(self.retired.len());
        let run = marker.run_id.clone();
        self.terminal_marker.as_mut()?.history_applied = true;
        self.retire_terminal(&run)?;
        let checked = self.check();
        if super::super::trace::enabled() {
            super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", serde_json::json!({ "commitState": "candidate_only",
                "result": "confirmed", "checkPassed": checked.is_some(), "exact": exact, "visible": visible,
                "markerRunHash": trace::fingerprint(&run), "markerMessageHash": self.terminal_marker.as_ref().map(|marker| trace::fingerprint(&marker.message_id)),
                "historyApplied": self.terminal_marker.as_ref().map(|marker| marker.history_applied),
                "pendingBefore": pending_before, "pendingAfter": self.needs_terminal_history(),
                "retiredAdded": self.retired.len().saturating_sub(retired_before.unwrap_or(0)) }));
        }
        checked
    }

    pub(super) fn history_applied_for_run(&self, run: &str) -> bool {
        self.terminal_marker.as_ref().is_some_and(|marker| marker.run_id == run && marker.history_applied)
    }

    fn retire_terminal(&mut self, run: &str) -> Option<()> {
        let ids = self.streams.get(run).map(|stream| stream.provisional.iter().filter(|entry| !entry.keyed)
            .map(|entry| entry.id.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for id in ids { self.retire_provisional(run, &id)?; }
        Some(())
    }

    pub(super) fn retire_provisional(&mut self, run: &str, id: &str) -> Option<()> {
        let stream = self.streams.get_mut(run)?;
        stream.provisional.retain(|entry| entry.id != id);
        if let Some(index) = self.items.iter().position(|item| item.item_id() == id) {
            let mut item = self.items.remove(index);
            if let SessionItem::AssistantTurn { item_id, message_id, text, segments, .. } = &mut item {
                segments.retain(|segment| matches!(segment, SessionContent::Thinking { .. }));
                text.clear();
                if !segments.is_empty() {
                    self.next_id = self.next_id.checked_add(1)?;
                    *item_id = format!("oc:live:{}", self.next_id);
                    *message_id = None;
                    stream.anchors.push(item_id.clone());
                    self.items.insert(index, item);
                }
            }
        }
        if !self.retired.iter().any(|retired| retired == id) { self.retired.push(id.to_owned()); }
        if !stream.anchors.iter().any(|anchor| anchor == id) { stream.anchors.push(id.to_owned()); }
        Some(())
    }

    pub(super) fn retire_body(&mut self, run: &str) -> Option<()> {
        self.retire_terminal(run)?;
        let Some(stream) = self.streams.get_mut(run) else { return Some(()); };
        self.items.retain(|item| !stream.all_parts().any(|part| !part.observed && part.id.as_deref() == Some(item.item_id())));
        for part in stream.all_parts_mut().filter(|part| !part.observed) {
            part.covered = part.end;
            if let Some(id) = &part.id && !self.retired.contains(id) { self.retired.push(id.clone()); }
        }
        Some(())
    }
}
