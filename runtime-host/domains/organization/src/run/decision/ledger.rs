use std::collections::{BTreeMap, BTreeSet};

use super::{
    TeamDecision, TeamDecisionCommand, TeamDecisionEvent, TeamDecisionEventSnapshot,
    TeamDecisionLedgerRestoreError, TeamDecisionLedgerSnapshot, TeamDecisionReceipt,
    TeamDecisionRecordError, TeamDecisionReducer, TeamDecisionReducerError, TeamDecisionSnapshot,
    TeamDecisionState,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TeamDecisionLedger {
    state: TeamDecisionState,
    events: BTreeMap<String, Vec<TeamDecisionEvent>>,
}

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
        if self.state.decisions().any(|decision| {
            decision.run_id() == command.run_id() && decision.decision_id() == command.decision_id()
        }) {
            return Err(TeamDecisionRecordError::DuplicateDecisionId);
        }
        let sequence = self
            .state
            .decisions_for_run(command.run_id())
            .count()
            .checked_add(1)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(TeamDecisionRecordError::SequenceOverflow)?;
        let decision = TeamDecision::new(sequence, command);
        let event = TeamDecisionEvent::submitted(decision.clone());
        TeamDecisionReducer::default()
            .reduce(&mut self.state, &event)
            .map_err(map_reducer_error)?;
        self.events
            .entry(decision.run_id().to_owned())
            .or_default()
            .push(event);
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

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.state.retain_without_run(run_id);
        self.events.remove(run_id);
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
        Ok(ledger)
    }
}

fn map_reducer_error(error: TeamDecisionReducerError) -> TeamDecisionRecordError {
    match error {
        TeamDecisionReducerError::SequenceOverflow => TeamDecisionRecordError::SequenceOverflow,
        TeamDecisionReducerError::ConflictingIdempotencyKey => {
            TeamDecisionRecordError::ConflictingIdempotencyKey
        }
        TeamDecisionReducerError::DuplicateDecisionId => {
            TeamDecisionRecordError::DuplicateDecisionId
        }
        TeamDecisionReducerError::SequenceGap | TeamDecisionReducerError::InvalidEvent => {
            TeamDecisionRecordError::SequenceOverflow
        }
    }
}
