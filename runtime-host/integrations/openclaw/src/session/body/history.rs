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
        let prefix = self.persisted.iter().filter(|message| prefix.is_some_and(|(floor, start)|
            message.identity_sequence().is_some_and(|sequence| sequence > floor && sequence < start)))
            .map(|row| row.id.clone()).collect::<HashSet<_>>();
        self.items.retain(|item| !self.history_ids.contains(item.item_id()) || prefix.contains(item.item_id()));
        self.persisted.retain(|row| !self.history_ids.contains(&row.id) || prefix.contains(&row.id));
        self.history_ids.retain(|id| prefix.contains(id));
    }

    pub(in crate::session) fn apply_history(&mut self, previous: &[SessionItem]) -> Option<()> {
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
