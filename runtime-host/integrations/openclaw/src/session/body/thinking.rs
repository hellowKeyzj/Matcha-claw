use super::*;

impl Body {
    pub(in crate::session) fn thinking(&mut self, run: &str, activity: &SessionActivity) -> Option<CanonicalSessionChange> {
        let old = self.items.clone();
        self.accept_live(run);
        let super::super::protocol::SessionActivityKind::Thinking { text } = activity.kind() else { return None; };
        let (text, replace) = if activity.stream_id().is_some() || activity.is_reasoning_snapshot() == Some(true) {
            (text.as_str(), true)
        } else if let Some(delta) = activity.thinking_delta() {
            (delta, false)
        } else { (text.as_str(), true) };
        self.thinking_chunk(run, activity.stream_id(), text, replace)?;
        self.check()?;
        Some(self.replacement(old))
    }

    pub(super) fn owns_thinking(&self, message: &Message) -> bool {
        message.role() == MessageRole::Assistant && !message.is_imported() && message.display_item_id().is_none()
            && message.identity_stream_id().is_some_and(|id| self.streams.iter().any(|(run, stream)|
                message.identity_run_id().is_none_or(|owner| owner == run)
                    && stream.thinking.iter().any(|thinking| thinking.stream_id.as_deref() == Some(id))))
    }

    pub(super) fn thinking_chunk(&mut self, run: &str, stream_id: Option<&str>, text: &str, replace: bool) -> Option<()> {
        let status = self.status(run);
        if status != ItemStatus::Streaming { return Some(()); }
        if let Some(message) = stream_id.and_then(|id| self.persisted.iter().find(|message|
            message.role() == MessageRole::Assistant && !message.is_imported() && message.display_item_id().is_none()
                && message.identity_stream_id() == Some(id)
                && message.content().iter().any(|content| matches!(content, super::super::window::MessageContent::Thinking { text } if !text.is_empty()))))
            && self.items.iter().any(|item| item.item_id() == message.id)
        { return Some(()); }
        let stream = self.streams.entry(run.to_owned()).or_default();
        let index = if let Some(index) = stream.thinking.iter().position(|thinking| thinking.stream_id.as_deref() == stream_id) {
            index
        } else {
            if text.is_empty() { return Some(()); }
            stream.thinking.push(Thinking { stream_id: stream_id.map(str::to_owned), text: String::new(), items: Vec::new(), replacement: None });
            stream.thinking.len() - 1
        };
        let thinking = &mut stream.thinking[index];
        if thinking.replacement.is_some() { return Some(()); }
        let tail = if replace { text.strip_prefix(&thinking.text) } else { Some(text) };
        if trace::enabled() {
            trace::log_unscoped("oc.body.thinking.input", || serde_json::json!({ "commitState": "candidate_only",
                "runHash": trace::fingerprint(run), "streamHash": stream_id.map(trace::fingerprint), "replace": replace,
                "input": trace::text_shape(text), "baseline": trace::text_shape(&thinking.text), "tail": tail.map(trace::text_shape),
                "itemHashes": thinking.items.iter().map(|id| trace::fingerprint(id)).collect::<Vec<_>>() }));
        }
        let mut redirected = None;
        if let Some(tail) = tail {
            if tail.is_empty() { return Some(()); }
            thinking.text.push_str(tail);
            if let Some(SessionItem::AssistantTurn { item_id, segments, .. }) = self.items.last_mut()
                && thinking.items.contains(item_id)
                && let [SessionContent::Thinking { text }] = segments.as_mut_slice()
            {
                text.push_str(tail);
            } else {
                self.next_id = self.next_id.checked_add(1)?;
                let id = format!("oc:live:{}", self.next_id);
                self.items.push(SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                    status, text: String::new(), segments: vec![SessionContent::Thinking { text: tail.to_owned() }] });
                stream.anchors.push(id.clone());
                thinking.items.push(id);
            }
        } else {
            let replaced = if stream_id.is_some() { thinking.items.clone() } else {
                self.items.last().filter(|item| thinking.items.iter().any(|id| id == item.item_id()))
                    .map(|item| vec![item.item_id().to_owned()]).unwrap_or_default()
            };
            let first = self.items.iter().position(|item| replaced.iter().any(|id| id == item.item_id()));
            let id = replaced.first().cloned();
            let after = first.and_then(|index| index.checked_sub(1)).map(|index| self.items[index].item_id().to_owned());
            redirected = Some((replaced.clone(), if text.is_empty() { after } else { id.clone() }));
            self.items.retain(|item| !replaced.iter().any(|id| id == item.item_id()));
            stream.anchors.retain(|anchor| !replaced.contains(anchor));
            thinking.items.retain(|id| !replaced.contains(id));
            thinking.text = text.to_owned();
            if !text.is_empty() {
                let id = if let Some(id) = id { id } else {
                    self.next_id = self.next_id.checked_add(1)?;
                    format!("oc:live:{}", self.next_id)
                };
                let item = SessionItem::AssistantTurn { item_id: id.clone(), run_id: Some(run.to_owned()), message_id: None,
                    status, text: String::new(), segments: vec![SessionContent::Thinking { text: text.to_owned() }] };
                self.items.insert(first.unwrap_or(self.items.len()).min(self.items.len()), item);
                stream.anchors.push(id.clone());
                thinking.items.push(id);
            }
        }
        if let Some((removed, after)) = redirected {
            for stream in self.streams.values_mut() {
                for part in stream.all_parts_mut() {
                    if part.after.as_ref().is_some_and(|id| removed.contains(id)) { part.after = after.clone(); }
                }
            }
        }
        self.reconcile(run)
    }

    pub(super) fn adopt_thinking(&mut self, message: &Message, replacement: &str) {
        if !self.owns_thinking(message)
            || !message.content().iter().any(|content| matches!(content, super::super::window::MessageContent::Thinking { text } if !text.is_empty()))
        { return; }
        let mut ids = Vec::new();
        for (run, stream) in &mut self.streams {
            if message.identity_run_id().is_some_and(|owner| owner != run) { continue; }
            for thinking in &mut stream.thinking {
                if thinking.stream_id.as_deref() == message.identity_stream_id() {
                    thinking.replacement = Some(replacement.to_owned());
                    thinking.text.clear();
                    ids.extend(thinking.items.iter().cloned());
                }
            }
        }
        if ids.is_empty() { return; }
        let first = self.items.iter().position(|item| ids.iter().any(|id| id == item.item_id()));
        self.items.retain(|item| !ids.iter().any(|id| id == item.item_id()));
        for stream in self.streams.values_mut() {
            for part in stream.all_parts_mut() {
                if part.after.as_ref().is_some_and(|after| ids.contains(after)) { part.after = Some(replacement.to_owned()); }
            }
        }
        for id in &ids {
            if !self.retired.contains(id) { self.retired.push(id.clone()); }
        }
        if let Some(first) = first && let Some(index) = self.items.iter().position(|item| item.item_id() == replacement) {
            let item = self.items.remove(index);
            self.items.insert(first.min(index).min(self.items.len()), item);
        }
        if trace::enabled() {
            trace::log_unscoped("oc.body.thinking.adopted", || serde_json::json!({ "commitState": "candidate_only",
                "streamHash": message.identity_stream_id().map(trace::fingerprint), "messageHash": message.identity_message_id().map(trace::fingerprint),
                "replacementItemHash": trace::fingerprint(replacement), "retiredItemHashes": ids.iter().map(|id| trace::fingerprint(id)).collect::<Vec<_>>() }));
        }
    }
}
