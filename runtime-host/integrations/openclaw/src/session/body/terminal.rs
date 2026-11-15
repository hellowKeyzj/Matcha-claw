use super::*;
use crate::session::protocol::ChatState;

enum TerminalText {
    DisplayItem,
    MessageChunk,
    Stream { current: bool },
}

impl Body {
    pub(super) fn finish_message(&mut self, run: &str, message: &Message, state: ChatState, source: Option<u64>, cache: &OpenClawReplayProjection) -> Option<()> {
        let thinking = message.content().iter().filter_map(|content| match content {
            crate::session::window::MessageContent::Thinking { text } => Some(text.as_str()), _ => None,
        }).collect::<String>();
        if state == ChatState::Final && self.history_applied_for_run(run) {
            self.retire_body(run)?;
            if !thinking.is_empty() { self.thinking_chunk(run, message.identity_stream_id(), &thinking, true)?; }
            return Some(());
        }
        if message.hidden_control_reply() { return Some(()); }
        if !message.has_displayable_content() && thinking.is_empty() { return Some(()); }
        let boundary = (state == ChatState::Final).then(|| self.terminal_boundary(run, message.text())).flatten();
        let tail = boundary.as_ref().map(|(boundary, prefix, discard)| {
            (boundary.clone(), message.text()[*prefix..].trim_start_matches(reconciliation::whitespace).to_owned(), discard.clone())
        });
        if let Some((_, _, discard)) = &tail {
            let stream = self.streams.entry(run.to_owned()).or_default();
            let ids = stream.parts.iter().chain(discard.iter().flat_map(|index| &stream.closed[*index].parts))
                .filter_map(|part| part.id.clone()).collect::<Vec<_>>();
            self.items.retain(|item| !ids.iter().any(|id| id == item.item_id()));
            for id in ids {
                if !self.retired.contains(&id) { self.retired.push(id); }
            }
        }
        let terminal = tail.as_ref().map(|(boundary, text, _)| {
            let sequence = self.persisted.iter().find(|row| row.role() == MessageRole::User && row.run_id() == Some(boundary))
                .and_then(|row| row.identity_sequence());
            message.clone().with_terminal_text(text.clone(), sequence)
        });
        let message = terminal.as_ref().unwrap_or(message);
        if tail.is_some() && message.text().is_empty() && message.text_only_final() {
            if !thinking.is_empty() { self.thinking_chunk(run, message.identity_stream_id(), &thinking, true)?; }
            return Some(());
        }
        let Some(mut item) = transcript_session_item(message, self.items.len(), cache) else { return Some(()); };
        let incoming = Provisional::final_message(String::new(), message, source);
        let existing = self.provisional_identity(&incoming, true);
        let terminal_text = message.text().trim_matches(reconciliation::whitespace);
        let append_terminal = state != ChatState::Error || self.terminal_replaces_stream(run, terminal_text);
        if state == ChatState::Aborted && let Some(stream) = self.streams.get(run) {
            let mut previous = None;
            for closed in &stream.closed {
                let tail = reconciliation::visible(&closed.text, previous);
                for part in &closed.parts {
                    let start = part.start.max(closed.text.len() - tail.len()).min(part.end);
                    let rendered = closed.text.get(start..part.end)?;
                    if reconciliation::replacement(&self.persisted, run, part, &closed.text, rendered, Some(message))
                        && let Some(id) = &part.id
                    {
                        self.items.retain(|item| item.item_id() != id);
                        if !self.retired.contains(id) { self.retired.push(id.clone()); }
                    }
                }
                previous = reconciliation::advance(previous, &closed.text);
            }
        }
        if state == ChatState::Aborted || (state == ChatState::Error && append_terminal) {
            if let Some(stream) = self.streams.get_mut(run) {
                for part in &stream.parts {
                    if let Some(id) = &part.id {
                        self.items.retain(|item| item.item_id() != id);
                        if !self.retired.contains(id) { self.retired.push(id.clone()); }
                        if !stream.anchors.contains(id) { stream.anchors.push(id.clone()); }
                    }
                }
            }
        }
        let mut removed = Vec::new();
        let mut insert = self.items.len();
        if append_terminal {
            let after_boundary = tail.as_ref().map(|(boundary, _, _)| boundary.as_str())
                .or_else(|| self.items.iter().rev().find_map(|item| {
                    let fallback = self.persisted.iter().find(|row| row.id == item.item_id()).and_then(|row| row.stream_fallback())
                        .or_else(|| self.streams.values().flat_map(|stream| &stream.provisional)
                            .find(|entry| entry.id == item.item_id()).and_then(|entry| entry.fallback.as_ref()))?;
                    (fallback.item_id.is_none() && fallback.run_id.as_deref() == Some(run))
                        .then(|| fallback.after_boundary_run_id.as_deref()).flatten()
                }))
                .or_else(|| self.streams.get(run).and_then(|stream| stream.all_parts().filter(|part|
                    part.id.as_ref().is_some_and(|id| self.items.iter().any(|item| item.item_id() == id)))
                    .last().and_then(|part| part.after_boundary_run_id.as_deref())))
                .or_else(|| self.streams.get(run).and_then(|stream| stream.latest_boundary_run_id.as_deref()));
            let (start, end) = self.terminal_interval(run, after_boundary);
            insert = end;
            let mut current = Vec::new();
            let mut cursor = 0;
            for item in &self.items[start..end] {
                let Some(kind) = self.terminal_text(run, item) else { continue; };
                let SessionItem::AssistantTurn { text, .. } = item else { continue; };
                let visible = text.trim_matches(reconciliation::whitespace);
                let is_current = match kind {
                    TerminalText::DisplayItem | TerminalText::MessageChunk => {
                        if !visible.is_empty() && visible == terminal_text { removed.push(item.item_id().to_owned()); }
                        continue;
                    }
                    TerminalText::Stream { current } => current,
                };
                if is_current { current.push(item.item_id().to_owned()); }
                let remaining = terminal_text[cursor..].trim_start_matches(reconciliation::whitespace);
                if !visible.is_empty() && remaining.starts_with(visible) {
                    cursor = terminal_text.len() - remaining.len() + visible.len();
                    removed.push(item.item_id().to_owned());
                }
            }
            if removed.is_empty() && current.len() == 1 { removed.extend(current); }
        }
        let first = self.items.iter().position(|item| removed.iter().any(|id| id == item.item_id()));
        self.items.retain(|item| !removed.iter().any(|id| id == item.item_id()));
        self.persisted.retain(|row| !removed.contains(&row.id));
        self.history_ids.retain(|id| !removed.contains(id));
        for stream in self.streams.values_mut() {
            stream.provisional.retain(|entry| !removed.contains(&entry.id));
        }
        let stream = self.streams.entry(run.to_owned()).or_default();
        for id in &removed {
            if !self.retired.contains(id) { self.retired.push(id.clone()); }
            if !stream.anchors.contains(id) { stream.anchors.push(id.clone()); }
        }
        if message.identity_message_id().is_none() && existing.as_ref().is_some_and(|id|
            self.persisted.iter().any(|row| &row.id == id && row.identity_message_id().is_some()))
        { return Some(()); }
        if message.identity_message_id().is_some() || message.identity_sequence().is_some() || message.identity_stream_id().is_some() {
            if let Some(id) = self.apply_identified_message(message, true, existing, cache)?
                && let Some(row) = self.persisted.iter_mut().find(|row| row.id == id)
            { row.source = source; row.terminal_owner = Some(run.to_owned()); }
            return Some(());
        }
        let id = if let Some(id) = existing { id } else if let Some(id) = message.display_item_id()
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
        if let Some(index) = self.items.iter().position(|item| item.item_id() == id) { self.items[index] = item; }
        else { self.items.insert(first.unwrap_or(insert).min(self.items.len()), item); }
        for stream in self.streams.values_mut() { stream.provisional.retain(|entry| entry.id != id); }
        self.streams.get_mut(run)?.provisional.push(Provisional::final_message(id, message, source));
        Some(())
    }

    pub(super) fn finish_stream(&mut self, run: &str) -> Option<()> {
        use crate::session::window::{StreamFallback, StreamFallbackSource};
        let Some(stream) = self.streams.get(run) else { return Some(()); };
        let mut materialized = Vec::new();
        for (text, parts, source) in stream.closed.iter().map(|closed|
            (closed.text.as_str(), closed.parts.as_slice(), StreamFallbackSource::Segment))
            .chain(stream.text.as_deref().map(|text| (text, stream.parts.as_slice(), StreamFallbackSource::Current)))
        {
            for part in parts {
                let Some(id) = &part.id else { continue; };
                if self.retired.contains(id) || !self.items.iter().any(|item| item.item_id() == id) { continue; }
                materialized.push(Provisional::materialized(id.clone(), StreamFallback {
                    source, replacement_text: text.to_owned(), item_id: None, run_id: Some(run.to_owned()),
                    after_boundary_run_id: part.after_boundary_run_id.clone(),
                }));
            }
        }
        for entry in stream.provisional.iter().filter(|entry| entry.keyed && !entry.is_materialized()) {
            let Some(SessionItem::AssistantTurn { text, .. }) = self.items.iter().find(|item| item.item_id() == entry.id) else { continue; };
            materialized.push(Provisional::materialized(entry.id.clone(), StreamFallback {
                source: StreamFallbackSource::Segment, replacement_text: text.clone(), item_id: Some(entry.id.clone()),
                run_id: Some(run.to_owned()), after_boundary_run_id: entry.fallback_after_boundary_run_id().map(str::to_owned),
            }));
        }
        let stream = self.streams.get_mut(run)?;
        for entry in materialized {
            stream.provisional.retain(|current| current.id != entry.id);
            stream.provisional.push(entry);
        }
        stream.text = None;
        stream.closed.clear();
        stream.parts.clear();
        stream.latest_boundary_run_id = None;
        stream.boundary = true;
        Some(())
    }

    fn terminal_replaces_stream(&self, run: &str, terminal_text: &str) -> bool {
        if terminal_text.is_empty() { return false; }
        let visible = self.items.iter().filter_map(|item| {
            let SessionItem::AssistantTurn { run_id: Some(owner), text, .. } = item else { return None; };
            (owner == run && !self.persisted.iter().any(|row| row.id == item.item_id())
                && self.terminal_text(run, item).is_some()
                && !self.streams.values().flat_map(|stream| &stream.provisional)
                    .any(|entry| entry.id == item.item_id() && entry.is_materialized())).then(|| text.trim_matches(reconciliation::whitespace))
                .filter(|text| !text.is_empty())
        }).collect::<Vec<_>>();
        let mut cursor = 0;
        !visible.is_empty() && visible.iter().enumerate().all(|(index, text)| {
            let Some(offset) = terminal_text[cursor..].find(*text) else { return false; };
            if index == 0 && offset != 0 { return false; }
            cursor += offset + text.len();
            true
        })
    }

    fn terminal_text(&self, run: &str, item: &SessionItem) -> Option<TerminalText> {
        let SessionItem::AssistantTurn { run_id, text, segments, .. } = item else { return None; };
        let id = item.item_id();
        if self.retired.iter().any(|retired| retired == id) { return None; }
        let fallback = self.persisted.iter().find(|row| row.id == id).and_then(|row| row.stream_fallback())
            .or_else(|| self.streams.values().flat_map(|stream| &stream.provisional)
                .find(|entry| entry.id == id).and_then(|entry| entry.fallback.as_ref()));
        if let Some(fallback) = fallback {
            return Some(if fallback.item_id.is_some() { TerminalText::DisplayItem }
                else { TerminalText::Stream { current: fallback.source == super::super::window::StreamFallbackSource::Current } });
        }
        let stream = self.streams.get(run)?;
        if stream.all_parts().any(|part| part.id.as_deref() == Some(id)) {
            return Some(TerminalText::Stream { current: stream.parts.iter().any(|part| part.id.as_deref() == Some(id)) });
        }
        if run_id.as_deref() == Some(run) && !text.is_empty()
            && segments.iter().all(|segment| matches!(segment, SessionContent::Text { .. } | SessionContent::Thinking { .. }))
            && !stream.provisional.iter().any(|entry| entry.id == id && !entry.keyed)
            && !self.persisted.iter().any(|row| row.id == id)
        {
            return Some(if stream.provisional.iter().any(|entry| entry.id == id && entry.keyed) { TerminalText::DisplayItem }
                else { TerminalText::MessageChunk });
        }
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
            && !matches!(self.terminal_text(run, item), Some(TerminalText::DisplayItem | TerminalText::MessageChunk)))
            .unwrap_or_else(|| self.items[..end].iter().rposition(|item| matches!(item, SessionItem::UserMessage { .. })).map_or(0, |index| index + 1));
        let texts = self.items[start..end].iter().filter_map(|item| {
            let SessionItem::AssistantTurn { run_id, text, .. } = item else { return None; };
            (run_id.as_deref().is_none_or(|owner| owner == run)
                && !matches!(self.terminal_text(run, item), Some(TerminalText::DisplayItem | TerminalText::MessageChunk))).then_some(text.as_str())
        });
        let prefix = text.len() - reconciliation::tail_length(texts, text);
        (prefix > 0).then(|| (boundary.to_owned(), prefix, live.map_or_else(Vec::new, |(_, _, indexes)| indexes)))
    }

    pub(in crate::session) fn confirm_terminal_history(&mut self, messages: &[&Message]) -> Option<()> {
        let Some(marker) = self.terminal_marker.as_ref() else {
            if super::super::trace::enabled() {
                super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", || serde_json::json!({ "commitState": "candidate_only",
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
                super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", || serde_json::json!({ "commitState": "candidate_only",
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
            super::super::trace::log_unscoped("runtime.openclaw.body.history.confirm", || serde_json::json!({ "commitState": "candidate_only",
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
        let mut ids = self.streams.get(run).map(|stream| stream.provisional.iter().filter(|entry| entry.is_terminal())
            .map(|entry| entry.id.clone()).collect::<Vec<_>>()).unwrap_or_default();
        ids.extend(self.persisted.iter().filter(|row| row.terminal_owner.as_deref() == Some(run)).map(|row| row.id.clone()));
        if ids.is_empty() { return Some(()); }
        self.streams.entry(run.to_owned()).or_default();
        for id in ids {
            self.retire_provisional(run, &id)?;
            self.persisted.retain(|row| row.id != id);
            self.history_ids.remove(&id);
        }
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
        self.items.retain(|item| !stream.all_parts().any(|part| part.id.as_deref() == Some(item.item_id())));
        for part in stream.all_parts() {
            if let Some(id) = &part.id && !self.retired.contains(id) { self.retired.push(id.clone()); }
        }
        Some(())
    }
}
