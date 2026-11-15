use std::collections::{BTreeMap, BTreeSet};

use super::{
    TeamDecision, TeamDecisionCommand, TeamDecisionEvent, TeamDecisionEventSnapshot,
    TeamDecisionLedgerRestoreError, TeamDecisionLedgerSnapshot, TeamDecisionReceipt,
    TeamDecisionRecordError, TeamDecisionSnapshot,
};

#[derive(Clone, Debug, Default)]
pub struct TeamDecisionLedger {
    events: BTreeMap<String, Vec<TeamDecisionEvent>>,
    decision_keys: BTreeMap<(String, String), String>,
    event_positions: BTreeMap<String, (String, usize)>,
    undo: Option<BTreeMap<String, Option<TeamDecisionEvent>>>,
}

impl PartialEq for TeamDecisionLedger {
    fn eq(&self, other: &Self) -> bool {
        self.events == other.events
    }
}
impl Eq for TeamDecisionLedger {}

impl TeamDecisionLedger {
    pub fn record(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, TeamDecisionRecordError> {
        if let Some(existing) = self.decision(command.run_id(), command.idempotency_key()) {
            return if existing.command() == &command {
                Ok(TeamDecisionReceipt::replayed(existing.clone()))
            } else {
                Err(TeamDecisionRecordError::ConflictingIdempotencyKey)
            };
        }
        if self.event_positions.contains_key(command.decision_id()) {
            return Err(TeamDecisionRecordError::DuplicateDecisionId);
        }
        let sequence = self
            .events
            .get(command.run_id())
            .map_or(0, Vec::len)
            .checked_add(1)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(TeamDecisionRecordError::SequenceOverflow)?;
        let decision = TeamDecision::new(sequence, command);
        self.insert_event(TeamDecisionEvent::submitted(decision.clone()));
        Ok(TeamDecisionReceipt::recorded(decision))
    }

    pub fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&TeamDecision> {
        let id = self
            .decision_keys
            .get(&(run_id.to_owned(), idempotency_key.to_owned()))?;
        self.event(id).map(TeamDecisionEvent::decision)
    }

    pub fn decisions_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamDecision> {
        self.decision_keys
            .range((run_id.to_owned(), String::new())..)
            .take_while(move |((run, _), _)| run == run_id)
            .map(|(_, id)| {
                self.event(id)
                    .expect("decision index references its event")
                    .decision()
            })
    }

    pub fn decisions(&self) -> impl Iterator<Item = &TeamDecision> {
        self.decision_keys.values().map(|id| {
            self.event(id)
                .expect("decision index references its event")
                .decision()
        })
    }

    pub fn events_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamDecisionEvent> {
        self.events.get(run_id).into_iter().flatten()
    }

    pub fn snapshot(&self) -> TeamDecisionLedgerSnapshot {
        TeamDecisionLedgerSnapshot::from_durable(
            self.decisions().map(TeamDecisionSnapshot::from).collect(),
            self.events
                .values()
                .flatten()
                .map(TeamDecisionEventSnapshot::from)
                .collect(),
        )
    }

    pub(crate) fn decision_by_id(&self, run: &str, id: &str) -> Option<&TeamDecision> {
        self.event(id)
            .filter(|event| event.run_id() == run)
            .map(TeamDecisionEvent::decision)
    }

    pub(crate) fn event(&self, id: &str) -> Option<&TeamDecisionEvent> {
        let (run, position) = self.event_positions.get(id)?;
        self.events.get(run)?.get(*position)
    }

    fn insert_event(&mut self, event: TeamDecisionEvent) {
        if let Some(undo) = &mut self.undo {
            undo.entry(event.event_id().to_owned()).or_insert(None);
        }
        self.insert_event_value(event);
    }

    fn insert_event_value(&mut self, event: TeamDecisionEvent) {
        let run = event.run_id().to_owned();
        self.decision_keys.insert(
            (run.clone(), event.decision().idempotency_key().to_owned()),
            event.event_id().to_owned(),
        );
        let events = self.events.entry(run.clone()).or_default();
        let index = events.partition_point(|old| old.sequence() < event.sequence());
        events.insert(index, event);
        for (position, event) in events.iter().enumerate().skip(index) {
            self.event_positions
                .insert(event.event_id().to_owned(), (run.clone(), position));
        }
    }

    fn remove_event_value(&mut self, id: &str) -> Option<TeamDecisionEvent> {
        let (run, position) = self.event_positions.remove(id)?;
        let events = self
            .events
            .get_mut(&run)
            .expect("event index references its run");
        let event = events.remove(position);
        self.decision_keys
            .remove(&(run.clone(), event.decision().idempotency_key().to_owned()));
        for (position, event) in events.iter().enumerate().skip(position) {
            self.event_positions
                .insert(event.event_id().to_owned(), (run.clone(), position));
        }
        if events.is_empty() {
            self.events.remove(&run);
        }
        Some(event)
    }

    fn remove_event(&mut self, id: &str) {
        if let Some(previous) = self.remove_event_value(id)
            && let Some(undo) = &mut self.undo
        {
            undo.entry(id.to_owned()).or_insert(Some(previous));
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "decision transaction already active");
        self.undo = Some(BTreeMap::new());
    }

    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = (&str, &str)> {
        self.undo
            .iter()
            .flat_map(|undo| undo.iter())
            .flat_map(|(id, previous)| {
                let current = self.event(id).filter(|event| {
                    previous
                        .as_ref()
                        .is_none_or(|old| old.run_id() != event.run_id())
                });
                previous
                    .iter()
                    .chain(current)
                    .map(|event| (event.run_id(), event.decision().decision_id()))
            })
    }

    pub(crate) fn changed_event_ids(&self) -> impl Iterator<Item = &String> {
        self.undo.iter().flat_map(|undo| undo.keys())
    }

    pub(crate) fn commit_transaction(&mut self) {
        self.undo = None;
    }

    pub(crate) fn rollback_transaction(&mut self) {
        let Some(undo) = self.undo.take() else {
            return;
        };
        for id in undo.keys() {
            self.remove_event_value(id);
        }
        let mut previous = undo.into_values().flatten().collect::<Vec<_>>();
        previous.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for event in previous {
            self.insert_event_value(event);
        }
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        for event in self.events.remove(run_id).into_iter().flatten() {
            self.decision_keys.remove(&(
                run_id.to_owned(),
                event.decision().idempotency_key().to_owned(),
            ));
            self.event_positions.remove(event.event_id());
            if let Some(undo) = &mut self.undo {
                undo.entry(event.event_id().to_owned())
                    .or_insert(Some(event));
            }
        }
    }

    pub(crate) fn apply_changes(
        &mut self,
        changes: BTreeMap<String, Option<TeamDecisionEvent>>,
    ) -> Result<(), TeamDecisionLedgerRestoreError> {
        let changes = changes
            .into_iter()
            .filter(|(id, event)| self.event(id) != event.as_ref())
            .collect::<BTreeMap<_, _>>();
        let mut affected = BTreeMap::<
            &str,
            (BTreeSet<usize>, BTreeMap<u64, &TeamDecisionEvent>),
        >::new();
        for (id, replacement) in &changes {
            if let Some(event) = replacement {
                event
                    .validate()
                    .map_err(TeamDecisionLedgerRestoreError::InvalidEvent)?;
                if event.event_id() != id {
                    return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
                }
                if affected
                    .entry(event.run_id())
                    .or_default()
                    .1
                    .insert(event.sequence(), event)
                    .is_some()
                {
                    return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
                }
            }
            if let Some((run, position)) = self.event_positions.get(id) {
                affected.entry(run).or_default().0.insert(*position);
            }
        }
        let mut removed_runs = Vec::new();
        for (run, (removed, replacements)) in affected {
            let existing = self.events.get(run).map_or(&[][..], Vec::as_slice);
            let final_len = existing.len()
                .checked_sub(removed.len())
                .and_then(|len| len.checked_add(replacements.len()))
                .ok_or(TeamDecisionLedgerRestoreError::SequenceOverflow)?;
            // Unchanged history is already contiguous; only changed slots and the new tail can break it.
            if removed.range(final_len..).count() != existing.len().saturating_sub(final_len) {
                return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
            }
            let mut keys = BTreeSet::new();
            for (sequence, event) in replacements {
                let position = usize::try_from(sequence).ok()
                    .and_then(|value| value.checked_sub(1))
                    .ok_or(TeamDecisionLedgerRestoreError::EventSequenceGap)?;
                if position >= final_len || existing.get(position).is_some_and(|old| {
                    !changes.contains_key(old.event_id())
                }) {
                    return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
                }
                let key = event.decision().idempotency_key();
                if !keys.insert(key) || self.decision(run, key).is_some_and(|old| {
                    !changes.contains_key(old.decision_id())
                }) {
                    return Err(TeamDecisionLedgerRestoreError::DuplicateIdempotencyKey);
                }
            }
            if !existing.is_empty() && removed.len() == existing.len() {
                removed_runs.push(run.to_owned());
            }
        }
        for run in removed_runs {
            self.retain_without_run(&run);
        }
        for id in changes.keys() {
            self.remove_event(id);
        }
        let mut replacements = changes.into_values().flatten().collect::<Vec<_>>();
        replacements.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for event in replacements {
            self.insert_event(event);
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), TeamDecisionLedgerRestoreError> {
        let mut ids = BTreeSet::new();
        for (run, events) in &self.events {
            validate_run(run, events.iter())?;
            for (position, event) in events.iter().enumerate() {
                if !ids.insert(event.event_id()) {
                    return Err(TeamDecisionLedgerRestoreError::DuplicateEventId);
                }
                if self
                    .event_positions
                    .get(event.event_id())
                    .is_none_or(|(owner, index)| owner != run || *index != position)
                    || self
                        .decision_keys
                        .get(&(run.clone(), event.decision().idempotency_key().to_owned()))
                        .is_none_or(|id| id != event.event_id())
                {
                    return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
                }
            }
        }
        if self.event_positions.len() != ids.len() || self.decision_keys.len() != ids.len() {
            return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
        }
        Ok(())
    }

    pub fn restore(
        snapshot: TeamDecisionLedgerSnapshot,
    ) -> Result<Self, TeamDecisionLedgerRestoreError> {
        let mut decisions = snapshot.decisions;
        decisions.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        let mut by_key = BTreeMap::new();
        let mut ids = BTreeSet::new();
        let mut sequences = BTreeMap::<String, u64>::new();
        for item in decisions {
            item.command()
                .map_err(TeamDecisionLedgerRestoreError::InvalidCommand)?;
            let key = (item.run_id().to_owned(), item.idempotency_key().to_owned());
            if by_key.contains_key(&key) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateIdempotencyKey);
            }
            if !ids.insert((item.run_id().to_owned(), item.decision_id().to_owned())) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateDecisionId);
            }
            let expected = sequences.entry(item.run_id().to_owned()).or_default();
            *expected = expected
                .checked_add(1)
                .ok_or(TeamDecisionLedgerRestoreError::SequenceOverflow)?;
            if item.sequence() != *expected {
                return Err(TeamDecisionLedgerRestoreError::SequenceGap);
            }
            by_key.insert(key, item);
        }
        let mut ledger = Self::default();
        let mut events = snapshot.events;
        events.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for item in events {
            if ledger.event_positions.contains_key(item.event_id()) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateEventId);
            }
            let event = item
                .event()
                .map_err(TeamDecisionLedgerRestoreError::InvalidEvent)?;
            let expected = ledger
                .events
                .get(event.run_id())
                .map_or(0, Vec::len)
                .checked_add(1)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or(TeamDecisionLedgerRestoreError::SequenceOverflow)?;
            if event.sequence() != expected {
                return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
            }
            let key = (
                event.run_id().to_owned(),
                event.decision().idempotency_key().to_owned(),
            );
            if by_key.remove(&key).as_ref() != Some(item.decision()) {
                return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
            }
            ledger.insert_event_value(event);
        }
        if !by_key.is_empty() {
            return Err(TeamDecisionLedgerRestoreError::MissingDecisionEvent);
        }
        ledger.validate()?;
        Ok(ledger)
    }
}

fn validate_run<'a>(
    run: &str,
    events: impl Iterator<Item = &'a TeamDecisionEvent>,
) -> Result<(), TeamDecisionLedgerRestoreError> {
    let mut sequence = 0_u64;
    let mut keys = BTreeSet::new();
    for event in events {
        event
            .validate()
            .map_err(TeamDecisionLedgerRestoreError::InvalidEvent)?;
        if event.run_id() != run {
            return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
        }
        sequence = sequence
            .checked_add(1)
            .ok_or(TeamDecisionLedgerRestoreError::SequenceOverflow)?;
        if event.sequence() != sequence {
            return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
        }
        if !keys.insert(event.decision().idempotency_key()) {
            return Err(TeamDecisionLedgerRestoreError::DuplicateIdempotencyKey);
        }
    }
    Ok(())
}
