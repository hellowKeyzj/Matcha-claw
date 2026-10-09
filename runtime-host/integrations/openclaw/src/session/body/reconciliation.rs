use super::*;

pub(super) fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(super) fn advance<'a>(previous: Option<&'a str>, text: &'a str) -> Option<&'a str> {
    if text.trim_matches(whitespace).is_empty() { previous }
    else if previous.is_none_or(|previous| text.starts_with(previous)) { Some(text) }
    else { previous }
}

fn visible<'a>(text: &'a str, previous: Option<&str>) -> &'a str {
    previous.filter(|previous| !previous.is_empty()).and_then(|previous| text.strip_prefix(previous))
        .map_or(text, |tail| tail.trim_start_matches(whitespace))
}

pub(super) fn tail_length<'a>(texts: impl Iterator<Item = &'a str>, text: &str) -> usize {
    let mut prefix = 0;
    for persisted in texts.filter(|text| !text.is_empty()) {
        let remaining = &text[prefix..];
        if remaining.starts_with(persisted) { prefix += persisted.len(); }
        else if persisted.starts_with(remaining) { return 0; }
        else {
            let trimmed = remaining.trim_start_matches(whitespace);
            let gap = remaining.len() - trimmed.len();
            if prefix > 0 && gap > 0 && trimmed.starts_with(persisted) { prefix += gap + persisted.len(); }
            else if prefix > 0 && gap > 0 && persisted.starts_with(trimmed) { return 0; }
            else if prefix > 0 { break; }
        }
    }
    text.len() - prefix
}

fn user_run(message: &Message) -> Option<&str> {
    (message.role() == MessageRole::User).then(|| message.run_id()).flatten()
}

fn interval(messages: &[Persisted], run: &str, part: &Part) -> (usize, usize) {
    let after = part.after_boundary_run_id.as_deref().and_then(|run| messages.iter().position(|message| user_run(message) == Some(run)));
    let boundary = part.boundary_run_id.as_deref().and_then(|run| messages.iter().position(|message| user_run(message) == Some(run)));
    if let Some(end) = boundary {
        let start = after.map_or_else(|| messages[..end].iter().rposition(|message| message.role() == MessageRole::User).map_or(0, |index| index + 1), |index| index + 1);
        return (start, end);
    }
    if let Some(floor) = after.or_else(|| messages.iter().position(|message| user_run(message) == Some(run))) {
        return (floor + 1, messages.iter().enumerate().skip(floor + 1).find(|(_, message)| message.role() == MessageRole::User)
            .map_or(messages.len(), |(index, _)| index));
    }
    (messages.iter().rposition(|message| message.role() == MessageRole::User).map_or(0, |index| index + 1), messages.len())
}

fn replacement(messages: &[Persisted], run: &str, part: &Part, text: &str, rendered: &str) -> bool {
    let (start, end) = interval(messages, run, part);
    [text, rendered].iter().any(|text| {
        let text = text.trim_matches(whitespace);
        !text.is_empty() && tail_length(messages[start.min(end)..end].iter().filter(|message|
            message.role() == MessageRole::Assistant && message.run_id().is_none_or(|owner| owner == run)
                && !message.hidden_control_reply() && message.display_item_id().is_none())
            .map(|message| message.text().trim_matches(whitespace)), text) == 0
    })
}

fn observed_coverage<'a>(messages: &'a [Persisted], run: &str, part: &Part, text: &str, start: usize) -> (usize, Option<&'a str>) {
    let (mut floor, mut end) = interval(messages, run, part);
    let owns_tool = |row: &Persisted, id: &str| row.content().iter().any(|block| matches!(block,
        super::super::window::MessageContent::ToolUse { tool_call_id: Some(tool), .. } if tool == id));
    if let Some(tool) = &part.before_tool
        && let Some(index) = messages[floor.min(end)..end].iter().position(|row| owns_tool(row, tool))
    { end = floor + index + 1; }
    let mut anchor = part.after_boundary_run_id.as_deref().and_then(|boundary|
        messages.iter().find(|row| user_run(row) == Some(boundary))).map(|row| row.id.as_str());
    let mut offset = if anchor.is_some() { part.start } else { 0 };
    if let Some(tool) = &part.after_tool {
        if let Some(index) = messages[floor.min(end)..end].iter().position(|row| owns_tool(row, tool)) {
            anchor = Some(messages[floor + index].id.as_str());
            floor += index + 1;
            offset = part.start;
        } else if messages[floor.min(end)..end].iter().any(|row| row.event_run_id() == Some(run)
            && row.role() == MessageRole::Assistant && row.identity_run_id() == Some(run))
        {
            offset = part.start;
        }
    }
    let rows = messages[floor.min(end)..end].iter().filter(|row| row.role() == MessageRole::Assistant
        && row.identity_run_id() == Some(run) && row.identity_message_id().is_some() && !row.is_imported()
        && !row.hidden_control_reply() && row.display_item_id().is_none()
        && (row.mirror_origin().is_none() || row.run_terminal()));
    let mut covered = offset;
    for row in rows.filter(|row| !row.text().is_empty()) {
        let remaining = &text[covered..part.end];
        let remaining = if covered > 0 { remaining.trim_start_matches(whitespace) } else { remaining };
        if remaining.is_empty() { break; }
        if remaining.starts_with(row.text()) {
            covered = part.end - remaining.len() + row.text().len();
            anchor = Some(row.id.as_str());
        } else if row.text().starts_with(remaining) {
            covered = part.end;
            anchor = Some(row.id.as_str());
            break;
        } else if covered > offset { break; }
    }
    (covered.max(start), anchor)
}

fn cumulative_tail(messages: &[&Persisted], text: &str, run: &str) -> usize {
    let start = messages.iter().position(|message| message.role() == MessageRole::Assistant
        && message.run_id() == Some(run) && message.display_item_id().is_none() && !message.text().is_empty()
        && (text.starts_with(message.text()) || message.text().starts_with(text)))
        .unwrap_or_else(|| messages.iter().rposition(|message| message.role() == MessageRole::User).map_or(0, |index| index + 1));
    tail_length(messages[start..].iter().filter(|message| message.role() == MessageRole::Assistant
        && message.run_id().is_none_or(|owner| owner == run) && message.display_item_id().is_none())
        .map(|message| message.text()), text)
}

impl Body {
    pub(super) fn rollover(&mut self, run: &str, boundary: Option<&str>, tool: bool) -> Option<()> {
        let Some(stream) = self.streams.get_mut(run) else { return Some(()); };
        let previous = stream.latest_boundary_run_id.clone();
        let selected = boundary.map(|boundary| {
            let floor = previous.as_deref().unwrap_or(run);
            let floor = self.persisted.iter().position(|message| user_run(message) == Some(floor));
            let end = self.persisted.iter().position(|message| user_run(message) == Some(boundary));
            floor.zip(end).filter(|(floor, end)| floor < end).and_then(|(floor, end)|
                self.persisted[floor + 1..end].iter().find_map(|row| user_run(row))).unwrap_or(boundary).to_owned()
        });
        if let Some(selected) = &selected {
            let start = previous.as_deref().map_or(0, |previous| stream.closed.iter()
                .rposition(|closed| closed.boundary_run_id.as_deref() == Some(previous)).map_or_else(||
                    stream.closed.iter().position(|closed| closed.after_boundary_run_id.as_deref() == Some(previous)).unwrap_or(stream.closed.len()), |index| index + 1));
            for closed in &mut stream.closed[start..] {
                if closed.boundary_run_id.is_none() {
                    closed.boundary_run_id = Some(selected.clone());
                    for part in &mut closed.parts { part.boundary_run_id = Some(selected.clone()); }
                }
            }
        }
        if let Some(text) = stream.text.take() {
            let mut parts = std::mem::take(&mut stream.parts);
            if !text.trim_matches(whitespace).is_empty() {
                for part in &mut parts { part.boundary_run_id = selected.clone(); }
                stream.closed.push(Closed { text, parts, after_boundary_run_id: previous.clone(),
                    boundary_run_id: selected.clone(), tool_boundary: tool });
            } else {
                for part in parts {
                    if let Some(id) = part.id {
                        for other in stream.all_parts_mut() {
                            if other.after.as_deref() == Some(&id) { other.after = part.after.clone(); }
                        }
                        self.items.retain(|item| item.item_id() != id);
                        if self.retired.contains(&id) { stream.anchors.push(id); }
                    }
                }
            }
        }
        if let Some(boundary) = boundary { stream.latest_boundary_run_id = Some(boundary.to_owned()); }
        stream.boundary = true;
        stream.body_closed = true;
        Some(())
    }

    pub(super) fn persisted_steer(&mut self, message: &Message) -> Option<()> {
        let Some(target) = message.steer_target_run_id().filter(|_| message.role() == MessageRole::User) else { return Some(()); };
        let Some(boundary) = message.run_id() else { return Some(()); };
        let active = message.has_active_run() == Some(true) || (message.has_active_run().is_none() && self.live_run() == Some(target));
        let current = self.live_run();
        let latest = self.persisted.iter().rev().find(|row| row.role() == MessageRole::User
            && row.steer_target_run_id() == Some(target) && row.run_id().is_some()).and_then(|row| row.run_id());
        if active && current.is_none_or(|current| current == target || current == boundary) && latest == Some(boundary)
            && self.streams.get(target).is_none_or(|stream| stream.latest_boundary_run_id.as_deref() != Some(boundary))
        {
            self.live_run = Some(target.to_owned());
            self.streams.entry(target.to_owned()).or_default();
            self.rollover(target, Some(boundary), false)?;
        }
        Some(())
    }

    pub(super) fn reconcile_all(&mut self, live: bool) -> Option<()> {
        let runs = self.streams.keys().cloned().collect::<Vec<_>>();
        for run in runs { self.reconcile_mode(&run, live && self.live_run() == Some(run.as_str()), None)?; }
        Some(())
    }

    pub(super) fn reconcile(&mut self, run: &str) -> Option<()> {
        self.reconcile_mode(run, self.live_run() == Some(run), None)
    }

    pub(super) fn reconcile_mode(&mut self, run: &str, live: bool, history_end: Option<usize>) -> Option<()> {
        let status = self.status(run);
        let keyed_required = self.live_run() == Some(run);
        let Some(stream) = self.streams.get_mut(run) else { return Some(()); };
        if stream.text.as_deref().is_some_and(|text| stream.closed.iter().any(|closed|
            (closed.tool_boundary || closed.boundary_run_id.is_some()) && !closed.text.is_empty()
                && text.starts_with(&closed.text)))
        {
            for part in stream.all_parts_mut() { part.observed = true; }
        }
        let mut current_replaced = false;
        if live {
            let rows = self.persisted.iter().filter(|message| message.role() == MessageRole::Assistant
                && message.identity_message_id().is_some() && !message.is_imported() && message.run_id() == Some(run)
                && message.display_item_id().is_none()).collect::<Vec<_>>();
            let prefix = stream.text().filter(|text| !text.is_empty()).map(|text| {
                let remaining = cumulative_tail(&rows, text, run);
                &text[..text.len() - remaining]
            }).filter(|prefix| !prefix.is_empty());
            if let Some(prefix) = prefix {
                current_replaced = stream.text.as_deref().is_some_and(|text| prefix.len() == text.len());
                let replaced = stream.closed.iter().enumerate().filter_map(|(index, closed)|
                    prefix.starts_with(&closed.text).then_some(index)).collect::<Vec<_>>();
                let accumulated = if stream.text.is_none() { stream.text() } else { stream.accumulated_text() };
                let observed = (advance(accumulated, prefix) != accumulated).then(|| prefix.to_owned());
                for index in replaced {
                    for part in &mut stream.closed[index].parts {
                        if part.observed { continue; }
                        if let Some(id) = &part.id {
                            self.items.retain(|item| item.item_id() != id);
                            part.covered = part.end;
                            if !self.retired.contains(id) { self.retired.push(id.clone()); }
                        }
                    }
                }
                if let Some(prefix) = observed { stream.observe_prefix(prefix, None); }
            }
        }
        if let Some(end) = history_end {
            let boundary = self.persisted.get(end).and_then(|row| user_run(row)).map(str::to_owned);
            if let Some(text) = stream.text.as_deref() {
                let rows = self.persisted[..end].iter().collect::<Vec<_>>();
                let remaining = cumulative_tail(&rows, text, run);
                let prefix = &text[..text.len() - remaining];
                if boundary.is_some() || advance(stream.accumulated_text(), prefix) != stream.accumulated_text() {
                    let prefix = prefix.to_owned();
                    if !prefix.is_empty() { stream.observe_prefix(prefix, boundary.clone()); }
                    if let Some(boundary) = boundary {
                        stream.latest_boundary_run_id = Some(boundary.clone());
                        for part in &mut stream.parts { part.after_boundary_run_id = Some(boundary.clone()); }
                    }
                }
            }
        }
        let mut previous = None;
        let mut display = Vec::new();
        for (closed_index, closed) in stream.closed.iter().enumerate() {
            let tail = visible(&closed.text, previous);
            for (index, part) in closed.parts.iter().enumerate() {
                let mut start = part.start.max(closed.text.len() - tail.len()).min(part.end);
                let coverage = part.observed.then(|| observed_coverage(&self.persisted, run, part, &closed.text, start));
                if let Some((covered, _)) = coverage { start = start.max(part.covered).max(covered); }
                let rendered = closed.text.get(start..part.end)?;
                let empty = rendered.trim_matches(whitespace).is_empty();
                display.push((Some(closed_index), index, start, part.end, empty,
                    !part.observed && !empty && replacement(&self.persisted, run, part, &closed.text, rendered),
                    coverage.and_then(|(_, anchor)| anchor.map(str::to_owned))));
            }
            previous = advance(previous, &closed.text);
        }
        if let Some(text) = stream.text.as_deref() {
            let tail = visible(text, previous);
            for (index, part) in stream.parts.iter().enumerate() {
                let mut start = part.start.max(text.len() - tail.len()).min(part.end);
                let coverage = part.observed.then(|| observed_coverage(&self.persisted, run, part, text, start));
                if let Some((covered, _)) = coverage { start = start.max(part.covered).max(covered); }
                let rendered = text.get(start..part.end)?;
                let empty = rendered.trim_matches(whitespace).is_empty();
                display.push((None, index, start, part.end, empty,
                    !part.observed && ((!empty && !live && replacement(&self.persisted, run, part, text, rendered)) || current_replaced),
                    coverage.and_then(|(_, anchor)| anchor.map(str::to_owned))));
            }
        }
        let all_replaced = display.iter().all(|(closed, index, _, _, empty, replaced, _)| {
            let part = match closed { Some(closed) => &stream.closed[*closed].parts[*index], None => &stream.parts[*index] };
            *empty || *replaced || part.id.as_ref().is_some_and(|id| self.retired.contains(id))
        }) && (!keyed_required || self.items.iter().all(|item| {
            let SessionItem::AssistantTurn { item_id, run_id: Some(owner), message_id: None, text, segments, .. } = item else { return true; };
            owner != run || text.trim_matches(whitespace).is_empty()
                || !matches!(segments.as_slice(), [SessionContent::Text { .. }])
                || stream.all_parts().any(|part| part.id.as_ref() == Some(item_id))
        }));
        let mut close_current = false;
        for (closed_index, part_index, start, end, empty, replaced, anchor) in display {
            let (parts, text) = if let Some(index) = closed_index {
                let closed = &mut stream.closed[index];
                (&mut closed.parts, closed.text.as_str())
            } else { (&mut stream.parts, stream.text.as_deref()?) };
            let part = &mut parts[part_index];
            let id = part.id.as_ref()?;
            if let Some(anchor) = anchor {
                part.after = Some(anchor.clone());
                if let Some(index) = self.items.iter().position(|item| item.item_id() == id)
                    && let Some(after) = self.items.iter().position(|item| item.item_id() == anchor)
                {
                    let target = if part.content_before { after } else { after + 1 };
                    let target = target - usize::from(index < target);
                    if index != target {
                        let item = self.items.remove(index);
                        self.items.insert(target, item);
                    }
                }
            }
            let index = self.items.iter().position(|item| item.item_id() == id);
            if part.observed {
                part.covered = start;
                if let Some(index) = index {
                    if let SessionItem::AssistantTurn { text: current, segments, status: current_status, .. } = &mut self.items[index] {
                        let rendered = text.get(start..end)?;
                        if current != rendered {
                            let mut skip = current.len().saturating_sub(rendered.len());
                            if current.ends_with(rendered) {
                                segments.retain_mut(|segment| {
                                    let SessionContent::Text { text } = segment else { return true; };
                                    let removed = skip.min(text.len());
                                    skip -= removed;
                                    text.drain(..removed);
                                    !text.is_empty()
                                });
                            } else if let Some(tail) = rendered.strip_prefix(current.as_str()) {
                                if let Some(SessionContent::Text { text }) = segments.iter_mut().rev().find(|segment| matches!(segment, SessionContent::Text { .. })) {
                                    text.push_str(tail);
                                } else { segments.push(SessionContent::Text { text: tail.to_owned() }); }
                            }
                            *current = rendered.to_owned();
                        }
                        *current_status = status;
                        if !segments.is_empty() { continue; }
                    }
                    self.items.remove(index);
                }
                if empty || self.retired.contains(id) {
                    if !self.retired.contains(id) { self.retired.push(id.clone()); }
                    continue;
                }
            }
            if replaced {
                close_current |= !live && history_end.is_none() && all_replaced && closed_index.is_none();
                part.covered = part.end;
                if !self.retired.contains(id) { self.retired.push(id.clone()); }
            }
            if self.retired.contains(id) || empty {
                if let Some(index) = index { self.items.remove(index); }
            } else {
                part.covered = start;
                let rendered = text.get(start..end)?;
                if let Some(index) = index {
                    if matches!(&self.items[index], SessionItem::AssistantTurn { text, status: current_status, segments, .. }
                        if text == rendered && *current_status == status
                            && matches!(segments.as_slice(), [SessionContent::Text { text }] if text == rendered)) { continue; }
                    if let SessionItem::AssistantTurn { text, status: current_status, segments, .. } = &mut self.items[index]
                        && let [SessionContent::Text { text: segment }] = segments.as_mut_slice()
                        && let Some(tail) = rendered.strip_prefix(text.as_str())
                    {
                        text.push_str(tail);
                        segment.push_str(tail);
                        *current_status = status;
                        continue;
                    }
                }
                let item = SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                    text: rendered.to_owned(), status, segments: vec![SessionContent::Text { text: rendered.to_owned() }] };
                if let Some(index) = index { self.items[index] = item; }
                else {
                    let placement = part.after.as_deref().map_or(Some(0), |after|
                        self.items.iter().position(|item| item.item_id() == after).map(|index| index + 1))?;
                    self.items.insert(placement, item);
                }
            }
        }
        if close_current { self.rollover(run, None, false)?; }
        Some(())
    }
}
