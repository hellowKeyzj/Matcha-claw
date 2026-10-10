use std::collections::{BTreeMap, BTreeSet};

use super::{
    TeamDecision, TeamDecisionCommand, TeamDecisionEvent, TeamDecisionEventSnapshot,
    TeamDecisionLedgerRestoreError, TeamDecisionLedgerSnapshot, TeamDecisionReceipt,
    TeamDecisionRecordError, TeamDecisionReducer, TeamDecisionReducerError, TeamDecisionSnapshot,
    TeamDecisionState,
};

#[derive(Clone, Debug, Default)]
pub struct TeamDecisionLedger {
    state: TeamDecisionState,
    events: BTreeMap<String, Vec<TeamDecisionEvent>>,
    decision_keys: BTreeMap<(String, String), String>,
    event_positions: BTreeMap<String, (String, usize)>,
    undo: Option<DecisionUndo>,
}

#[derive(Clone, Debug, Default)]
struct DecisionUndo {
    decisions: BTreeMap<(String, String), Option<TeamDecision>>,
    events: BTreeMap<String, Option<TeamDecisionEvent>>,
}

impl PartialEq for TeamDecisionLedger {
    fn eq(&self, other: &Self) -> bool {
        self.state == other.state && self.events == other.events
    }
}
impl Eq for TeamDecisionLedger {}

impl TeamDecisionLedger {
    pub fn record(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, TeamDecisionRecordError> {
        if let Some(existing) = self
            .state
            .decision(command.run_id(), command.idempotency_key())
        {
            return if existing.command() == &command {
                Ok(TeamDecisionReceipt::replayed(existing.clone()))
            } else {
                Err(TeamDecisionRecordError::ConflictingIdempotencyKey)
            };
        }
        if self.decision_keys.contains_key(&(
            command.run_id().to_owned(),
            command.decision_id().to_owned(),
        )) || self.event_positions.contains_key(command.decision_id())
        {
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
        let event = TeamDecisionEvent::submitted(decision.clone());
        self.put_decision(decision.clone());
        self.put_event(event);
        Ok(TeamDecisionReceipt::recorded(decision))
    }

    pub fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&TeamDecision> {
        self.state.decision(run_id, idempotency_key)
    }

    pub fn decisions_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamDecision> {
        self.state.decisions_for_run(run_id)
    }

    pub fn decisions(&self) -> impl Iterator<Item = &TeamDecision> {
        self.state.decisions()
    }

    pub fn events_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamDecisionEvent> {
        self.events.get(run_id).into_iter().flatten()
    }

    pub fn snapshot(&self) -> TeamDecisionLedgerSnapshot {
        TeamDecisionLedgerSnapshot::from_durable(
            self.state
                .decisions()
                .map(TeamDecisionSnapshot::from)
                .collect(),
            self.events
                .values()
                .flatten()
                .map(TeamDecisionEventSnapshot::from)
                .collect(),
        )
    }

    pub(crate) fn decision_by_id(&self, run: &str, id: &str) -> Option<&TeamDecision> {
        let key = self.decision_keys.get(&(run.to_owned(), id.to_owned()))?;
        self.state.decision(run, key)
    }

    pub(crate) fn event(&self, id: &str) -> Option<&TeamDecisionEvent> {
        let (run, position) = self.event_positions.get(id)?;
        self.events.get(run)?.get(*position)
    }

    fn put_decision(&mut self, decision: TeamDecision) {
        let key = (
            decision.run_id().to_owned(),
            decision.idempotency_key().to_owned(),
        );
        if let Some(undo) = &mut self.undo {
            undo.decisions
                .entry(key.clone())
                .or_insert_with(|| self.state.decisions.get(&key).cloned());
        }
        if let Some(previous) = self.state.decisions.insert(key.clone(), decision.clone()) {
            self.decision_keys.remove(&(
                previous.run_id().to_owned(),
                previous.decision_id().to_owned(),
            ));
        }
        self.decision_keys.insert(
            (
                decision.run_id().to_owned(),
                decision.decision_id().to_owned(),
            ),
            key.1,
        );
    }

    fn put_event(&mut self, event: TeamDecisionEvent) {
        let id = event.event_id().to_owned();
        let previous = self.event(&id).cloned();
        if let Some(undo) = &mut self.undo {
            undo.events.entry(id.clone()).or_insert(previous);
        }
        self.remove_event_value(&id);
        let run = event.run_id().to_owned();
        let events = self.events.entry(run.clone()).or_default();
        let index = events.partition_point(|old| old.sequence() < event.sequence());
        events.insert(index, event);
        for (position, event) in events.iter().enumerate().skip(index) {
            self.event_positions
                .insert(event.event_id().to_owned(), (run.clone(), position));
        }
    }

    pub(crate) fn restore_decision(
        &mut self,
        snapshot: TeamDecisionSnapshot,
    ) -> Result<(), TeamDecisionLedgerRestoreError> {
        let command = snapshot
            .command()
            .map_err(TeamDecisionLedgerRestoreError::InvalidCommand)?;
        if snapshot.sequence() == 0 {
            return Err(TeamDecisionLedgerRestoreError::SequenceGap);
        }
        if self
            .decision_by_id(command.run_id(), command.decision_id())
            .is_some_and(|old| old.idempotency_key() != command.idempotency_key())
        {
            return Err(TeamDecisionLedgerRestoreError::DuplicateDecisionId);
        }
        if self
            .decision(command.run_id(), command.idempotency_key())
            .is_some_and(|old| old.decision_id() != command.decision_id())
        {
            return Err(TeamDecisionLedgerRestoreError::DuplicateIdempotencyKey);
        }
        self.put_decision(TeamDecision::from_durable(snapshot.sequence(), command));
        Ok(())
    }

    pub(crate) fn restore_event(
        &mut self,
        snapshot: TeamDecisionEventSnapshot,
    ) -> Result<(), TeamDecisionLedgerRestoreError> {
        let event = snapshot
            .event()
            .map_err(TeamDecisionLedgerRestoreError::InvalidEvent)?;
        if self
            .event(event.event_id())
            .is_some_and(|old| old.run_id() != event.run_id())
        {
            return Err(TeamDecisionLedgerRestoreError::DuplicateEventId);
        }
        if event.sequence() == 0 {
            return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
        }
        self.put_event(event);
        Ok(())
    }

    pub(crate) fn remove_decision(&mut self, run: &str, id: &str) {
        if let Some(idempotency) = self.decision_keys.remove(&(run.to_owned(), id.to_owned())) {
            let key = (run.to_owned(), idempotency);
            if let Some(old) = self.state.decisions.remove(&key)
                && let Some(undo) = &mut self.undo
            {
                undo.decisions.entry(key).or_insert(Some(old));
            }
        }
    }

    fn remove_event_value(&mut self, id: &str) {
        if let Some((run, position)) = self.event_positions.remove(id) {
            let events = self
                .events
                .get_mut(&run)
                .expect("event index references its run");
            events.remove(position);
            for (position, event) in events.iter().enumerate().skip(position) {
                self.event_positions
                    .insert(event.event_id().to_owned(), (run.clone(), position));
            }
            if events.is_empty() {
                self.events.remove(&run);
            }
        }
    }

    pub(crate) fn remove_event(&mut self, id: &str) {
        let previous = self.event(id).cloned();
        if previous.is_none() {
            return;
        }
        if let Some(undo) = &mut self.undo {
            undo.events.entry(id.to_owned()).or_insert(previous);
        }
        self.remove_event_value(id);
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "decision transaction already active");
        self.undo = Some(DecisionUndo::default());
    }
    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = &(String, String)> {
        self.undo.iter().flat_map(|undo| undo.decisions.keys())
    }
    pub(crate) fn changed_decision_ids(&self) -> impl Iterator<Item = (String, String)> {
        self.undo
            .iter()
            .flat_map(|undo| undo.decisions.iter())
            .filter_map(|(key, previous)| {
                previous
                    .as_ref()
                    .or_else(|| self.state.decisions.get(key))
                    .map(|decision| {
                        (
                            decision.run_id().to_owned(),
                            decision.decision_id().to_owned(),
                        )
                    })
            })
    }
    pub(crate) fn changed_event_ids(&self) -> impl Iterator<Item = &String> {
        self.undo.iter().flat_map(|undo| undo.events.keys())
    }
    pub(crate) fn commit_transaction(&mut self) {
        self.undo = None;
    }
    pub(crate) fn rollback_transaction(&mut self) {
        let Some(undo) = self.undo.take() else {
            return;
        };
        for (key, previous) in undo.decisions {
            if let Some(current) = self.state.decisions.remove(&key) {
                self.decision_keys.remove(&(
                    current.run_id().to_owned(),
                    current.decision_id().to_owned(),
                ));
            }
            if let Some(previous) = previous {
                self.put_decision(previous);
            }
        }
        for id in undo.events.keys() {
            self.remove_event_value(id);
        }
        for previous in undo.events.into_values().flatten() {
            self.put_event(previous);
        }
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        for event in self.events.remove(run_id).into_iter().flatten() {
            self.remove_decision(run_id, event.decision().decision_id());
            self.event_positions.remove(event.event_id());
            if let Some(undo) = &mut self.undo {
                undo.events
                    .entry(event.event_id().to_owned())
                    .or_insert(Some(event));
            }
        }
    }

    pub fn restore(
        snapshot: TeamDecisionLedgerSnapshot,
    ) -> Result<Self, TeamDecisionLedgerRestoreError> {
        let mut ledger = Self::default();
        let mut decisions = snapshot.decisions;
        decisions.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        let mut keys = BTreeSet::new();
        let mut ids = BTreeSet::new();
        for item in decisions {
            let command = item
                .command()
                .map_err(TeamDecisionLedgerRestoreError::InvalidCommand)?;
            let key = (
                command.run_id().to_owned(),
                command.idempotency_key().to_owned(),
            );
            if !keys.insert(key) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateIdempotencyKey);
            }
            if !ids.insert((
                command.run_id().to_owned(),
                command.decision_id().to_owned(),
            )) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateDecisionId);
            }
            let event =
                TeamDecisionEvent::submitted(TeamDecision::from_durable(item.sequence(), command));
            TeamDecisionReducer::default()
                .reduce(&mut ledger.state, &event)
                .map_err(|error| match error {
                    TeamDecisionReducerError::SequenceGap => {
                        TeamDecisionLedgerRestoreError::SequenceGap
                    }
                    TeamDecisionReducerError::SequenceOverflow => {
                        TeamDecisionLedgerRestoreError::SequenceOverflow
                    }
                    TeamDecisionReducerError::DuplicateDecisionId => {
                        TeamDecisionLedgerRestoreError::DuplicateDecisionId
                    }
                    TeamDecisionReducerError::ConflictingIdempotencyKey
                    | TeamDecisionReducerError::InvalidEvent => {
                        TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision
                    }
                })?;
        }
        let mut event_ids = BTreeSet::new();
        let mut event_decisions = BTreeSet::new();
        let mut expected_event_sequence: BTreeMap<String, u64> = BTreeMap::new();
        let mut events = snapshot.events;
        events.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for item in events {
            if !event_ids.insert(item.event_id().to_owned()) {
                return Err(TeamDecisionLedgerRestoreError::DuplicateEventId);
            }
            let event = item
                .event()
                .map_err(TeamDecisionLedgerRestoreError::InvalidEvent)?;
            let expected = expected_event_sequence
                .entry(event.run_id().to_owned())
                .or_insert(1);
            if event.sequence() != *expected {
                return Err(TeamDecisionLedgerRestoreError::EventSequenceGap);
            }
            *expected = expected
                .checked_add(1)
                .ok_or(TeamDecisionLedgerRestoreError::SequenceOverflow)?;
            let decision_key = (
                event.run_id().to_owned(),
                event.decision().idempotency_key().to_owned(),
            );
            if !event_decisions.insert(decision_key.clone()) {
                return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
            }
            let Some(decision) = ledger.state.decision(&decision_key.0, &decision_key.1) else {
                return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
            };
            if decision != event.decision() {
                return Err(TeamDecisionLedgerRestoreError::EventDoesNotMatchDecision);
            }
            ledger
                .events
                .entry(event.run_id().to_owned())
                .or_default()
                .push(event);
        }
        if ledger.state.decisions().any(|decision| {
            !ledger
                .events_for_run(decision.run_id())
                .any(|event| event.decision() == decision)
        }) {
            return Err(TeamDecisionLedgerRestoreError::MissingDecisionEvent);
        }
        for decision in ledger.state.decisions.values() {
            ledger.decision_keys.insert(
                (
                    decision.run_id().to_owned(),
                    decision.decision_id().to_owned(),
                ),
                decision.idempotency_key().to_owned(),
            );
        }
        for (run, events) in &ledger.events {
            for (position, event) in events.iter().enumerate() {
                ledger
                    .event_positions
                    .insert(event.event_id().to_owned(), (run.clone(), position));
            }
        }
        Ok(ledger)
    }
}
