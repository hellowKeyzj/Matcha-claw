use super::*;

impl Body {
    pub(in crate::session) fn begin_update(&mut self) {
        self.evicted.clear();
    }

    pub(in crate::session) fn rebuild_history(&mut self, prefix: Option<(u64, u64)>, reset_scope: bool) {
        if reset_scope {
            let next_id = self.next_id;
            *self = Self { next_id, ..Self::default() };
            return;
        }
        self.history_rebuilding = true;
        let prefix = self.persisted.iter().filter(|message| prefix.is_some_and(|(floor, start)|
            message.identity_sequence().is_some_and(|sequence| sequence > floor && sequence < start)))
            .map(|row| row.id.clone()).collect::<HashSet<_>>();
        self.items.retain(|item| !self.history_ids.contains(item.item_id()) || prefix.contains(item.item_id()));
        self.persisted.retain(|row| !self.history_ids.contains(&row.id) || prefix.contains(&row.id));
        self.history_ids.retain(|id| prefix.contains(id));
    }

    pub(super) fn merge_history(&mut self, previous: &[SessionItem]) {
        let native = self.persisted.iter().map(|row| row.id.as_str()).collect::<HashSet<_>>();
        let previous_ids = previous.iter().map(SessionItem::item_id).collect::<HashSet<_>>();
        let mut retained = HashMap::new();
        let mut history = Vec::new();
        for item in std::mem::take(&mut self.items) {
            if previous_ids.contains(item.item_id()) && !native.contains(item.item_id()) {
                retained.insert(item.item_id().to_owned(), item);
            } else { history.push(item); }
        }
        let mut positions = history.iter().enumerate().map(|(index, item)|
            (item.item_id().to_owned(), index + 1)).collect::<HashMap<_, _>>();
        for (index, item) in history.iter().enumerate() {
            if let SessionItem::AssistantTurn { message_id: Some(_), segments, .. } = item {
                for segment in segments {
                    if let SessionContent::ToolUse { tool_call_id, .. } = segment {
                        // Durable tool rows also stand in for their retired live placeholders.
                        positions.entry(format!("oc:tool:{tool_call_id}")).or_insert(index + 1);
                    }
                }
            }
        }
        for thinking in self.streams.values().flat_map(|stream| &stream.thinking) {
            if let Some(position) = thinking.replacement.as_ref().and_then(|id| positions.get(id)).copied() {
                for id in &thinking.items { positions.entry(id.clone()).or_insert(position); }
            }
        }
        let mut gaps = (0..=history.len()).map(|_| Vec::new()).collect::<Vec<_>>();
        let mut gap = 0;
        for old in previous {
            if let Some(item) = retained.remove(old.item_id()) { gaps[gap].push(item); }
            else if let Some(position) = positions.get(old.item_id()) { gap = *position; }
        }
        // Preserve display neighbours before terminal adoption can split or replace them.
        for (items, row) in gaps.into_iter().zip(history.into_iter().map(Some).chain([None])) {
            self.items.extend(items);
            self.items.extend(row);
        }
    }

    pub(in crate::session) fn apply_history(&mut self, previous: &[SessionItem]) -> Option<()> {
        self.history_rebuilding = false;
        self.reconcile_terminals()?;
        // A removed history row may have been a live slice's placement anchor.
        for stream in self.streams.values_mut() {
            for part in stream.all_parts_mut() {
                if let Some(after) = part.after.as_deref()
                    && !self.items.iter().any(|item| item.item_id() == after)
                    && let Some(index) = previous.iter().position(|item| item.item_id() == after)
                {
                    part.after = previous[..index].iter().rev().find(|old|
                        self.items.iter().any(|item| item.item_id() == old.item_id()))
                        .map(|item| item.item_id().to_owned());
                }
            }
        }
        self.reconcile_all(false)?;
        self.check()
    }

    pub(in crate::session) fn finish_history(&mut self, previous: &[SessionItem]) {
        for item in previous {
            if !self.items.iter().any(|current| current.item_id() == item.item_id())
                && !self.evicted.iter().any(|id| id == item.item_id())
            {
                self.evicted.push(item.item_id().to_owned());
            }
        }
        self.evicted.retain(|id| previous.iter().any(|item| item.item_id() == id)
            && !self.items.iter().any(|item| item.item_id() == id));
    }

    pub(in crate::session) fn history_start(&self, previous: &Self, floor: u64, start: u64) -> u64 {
        let floor = previous.persisted.iter().filter(|row|
            previous.history_ids.contains(&row.id) && self.evicted.contains(&row.id))
            .filter_map(|row| row.identity_sequence()).filter(|sequence| *sequence <= start)
            .max().unwrap_or(floor).max(floor);
        self.persisted.iter().filter(|row| self.history_ids.contains(&row.id))
            .filter_map(|row| row.identity_sequence()).filter(|sequence| *sequence > floor && *sequence <= start)
            .min().map_or(start, |sequence| sequence - 1)
    }

    pub(in crate::session) fn retired_item_ids(&self) -> Vec<String> {
        let mut ids = self.evicted.clone();
        for id in &self.retired {
            if !ids.contains(id) && !self.items.iter().any(|item| item.item_id() == id) {
                ids.push(id.clone());
            }
        }
        ids.truncate(200);
        ids
    }
}
