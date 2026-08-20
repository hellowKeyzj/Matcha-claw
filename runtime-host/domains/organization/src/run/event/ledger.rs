use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroU64,
};

use super::{
    CommandRecord, CommandRejection, CommandStatus, OpaqueId, RunCommand, TeamEvent,
    TeamEventPayload,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EventLedger {
    commands: BTreeMap<OpaqueId, Vec<CommandRecord>>,
    events: BTreeMap<OpaqueId, Vec<TeamEvent>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EventLedgerSnapshot {
    commands: Vec<CommandRecord>,
    events: Vec<TeamEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandReceipt {
    record: CommandRecord,
    events: Vec<TeamEvent>,
    replayed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecordCommandError {
    IdempotencyConflict,
    CommandIdConflict,
    RejectionConflict,
    InvalidEventId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreEventLedgerError {
    DuplicateCommandId,
    DuplicateIdempotencyKey,
    CommandSequenceGap,
    EventSequenceGap,
    DuplicateEventId,
    InvalidEventId,
    EventWithoutAcceptedCommand,
    AcceptedCommandWithoutEvent,
    EventDoesNotMatchCommand,
}

impl EventLedger {
    pub fn try_accept(
        &mut self,
        command: RunCommand,
    ) -> Result<CommandReceipt, RecordCommandError> {
        self.record(command, CommandStatus::Accepted, None)
    }

    pub fn accept(&mut self, command: RunCommand) -> CommandReceipt {
        self.try_accept(command)
            .expect("accepted commands must not violate immutable identity fences")
    }

    pub fn try_reject(
        &mut self,
        command: RunCommand,
        reason: CommandRejection,
    ) -> Result<CommandReceipt, RecordCommandError> {
        self.record(command, CommandStatus::Rejected, Some(reason))
    }

    pub fn reject(&mut self, command: RunCommand, reason: CommandRejection) -> CommandReceipt {
        self.try_reject(command, reason)
            .expect("rejected commands must not violate immutable identity fences")
    }

    pub fn events_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamEvent> {
        self.events
            .iter()
            .filter(move |(candidate, _)| candidate.as_str() == run_id)
            .flat_map(|(_, events)| events.iter())
    }

    pub(crate) fn command_by_idempotency(
        &self,
        run_id: &OpaqueId,
        idempotency_key: &OpaqueId,
    ) -> Option<&CommandRecord> {
        self.commands.get(run_id).and_then(|records| {
            records
                .iter()
                .find(|record| record.idempotency_key() == idempotency_key)
        })
    }

    pub fn append_approval_resolution(
        &mut self,
        run_id: OpaqueId,
        approval_id: OpaqueId,
        decision: crate::ApprovalDecision,
        idempotency_key: OpaqueId,
        resolved_at: u64,
    ) -> Result<TeamEvent, RecordCommandError> {
        let events = self.events.entry(run_id.clone()).or_default();
        let sequence = next_sequence(events.len()).expect("event sequence cannot overflow");
        let event = TeamEvent::approval_resolved(
            run_id,
            sequence,
            approval_id,
            decision,
            idempotency_key,
            resolved_at,
        )
        .map_err(|_| RecordCommandError::InvalidEventId)?;
        events.push(event.clone());
        Ok(event)
    }

    pub fn snapshot(&self) -> EventLedgerSnapshot {
        EventLedgerSnapshot {
            commands: self
                .commands
                .values()
                .flat_map(|records| records.iter().cloned())
                .collect(),
            events: self
                .events
                .values()
                .flat_map(|events| events.iter().cloned())
                .collect(),
        }
    }

    pub fn restore(snapshot: EventLedgerSnapshot) -> Result<Self, RestoreEventLedgerError> {
        let mut ledger = Self::default();
        let mut command_ids = BTreeSet::new();
        let mut keys = BTreeSet::new();
        for record in snapshot.commands {
            if !command_ids.insert((record.run_id().clone(), record.command_id().clone())) {
                return Err(RestoreEventLedgerError::DuplicateCommandId);
            }
            if !keys.insert((record.run_id().clone(), record.idempotency_key().clone())) {
                return Err(RestoreEventLedgerError::DuplicateIdempotencyKey);
            }
            let records = ledger.commands.entry(record.run_id().clone()).or_default();
            let expected = next_sequence(records.len()).expect("sequence length cannot overflow");
            if record.sequence() != expected.get() {
                return Err(RestoreEventLedgerError::CommandSequenceGap);
            }
            records.push(record);
        }

        let mut event_ids = BTreeSet::new();
        for event in snapshot.events {
            if !event_ids.insert(event.event_id().to_owned()) {
                return Err(RestoreEventLedgerError::DuplicateEventId);
            }
            let event_run_id = event.run_id_value().clone();
            let expected_sequence =
                next_sequence(ledger.events.get(&event_run_id).map_or(0, Vec::len))
                    .expect("event sequence length cannot overflow");
            if event.sequence() != expected_sequence.get() {
                return Err(RestoreEventLedgerError::EventSequenceGap);
            }
            match event.event_type() {
                super::TeamEventType::ApprovalResolved => {
                    if !approval_resolution_event_is_canonical(&event) {
                        return Err(RestoreEventLedgerError::EventDoesNotMatchCommand);
                    }
                }
                _ => {
                    let expected_event = expected_event_for(&ledger, &event)
                        .ok_or(RestoreEventLedgerError::EventWithoutAcceptedCommand)?;
                    if expected_event != event {
                        return Err(RestoreEventLedgerError::EventDoesNotMatchCommand);
                    }
                }
            }
            ledger.events.entry(event_run_id).or_default().push(event);
        }
        for (run_id, records) in &ledger.commands {
            let expected_event_count = records.iter().filter(|record| record.is_accepted()).count();
            let events = ledger
                .events
                .get(run_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let command_event_count = events
                .iter()
                .filter(|event| event.event_type() != super::TeamEventType::ApprovalResolved)
                .count();
            if command_event_count < expected_event_count {
                return Err(RestoreEventLedgerError::AcceptedCommandWithoutEvent);
            }
            if command_event_count != expected_event_count {
                return Err(RestoreEventLedgerError::EventDoesNotMatchCommand);
            }
        }
        Ok(ledger)
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.commands.retain(|key, _| key.as_str() != run_id);
        self.events.retain(|key, _| key.as_str() != run_id);
    }

    fn record(
        &mut self,
        command: RunCommand,
        status: CommandStatus,
        rejection_reason: Option<CommandRejection>,
    ) -> Result<CommandReceipt, RecordCommandError> {
        let run_id = command.run_id().clone();
        let records = self.commands.entry(run_id.clone()).or_default();
        if let Some(existing) = records
            .iter()
            .find(|record| record.idempotency_key() == command.idempotency_key())
        {
            return replay_or_conflict(existing, &command, status, rejection_reason);
        }
        if records
            .iter()
            .any(|record| record.command_id() == command.command_id())
        {
            return Err(RecordCommandError::CommandIdConflict);
        }

        let sequence = next_sequence(records.len()).expect("sequence length cannot overflow");
        let record = match (status, rejection_reason) {
            (CommandStatus::Accepted, None) => CommandRecord::accepted(sequence, command),
            (CommandStatus::Rejected, Some(reason)) => {
                CommandRecord::rejected(sequence, command, reason)
            }
            _ => return Err(RecordCommandError::RejectionConflict),
        };
        let events = if record.is_accepted() {
            let event = next_event(&run_id, records, self.events.get(&run_id), record.command())?;
            self.events.entry(run_id).or_default().push(event.clone());
            vec![event]
        } else {
            Vec::new()
        };
        records.push(record.clone());
        Ok(CommandReceipt {
            record,
            events,
            replayed: false,
        })
    }
}

impl CommandReceipt {
    pub fn record(&self) -> &CommandRecord {
        &self.record
    }

    pub fn events(&self) -> &[TeamEvent] {
        &self.events
    }

    pub fn is_replay(&self) -> bool {
        self.replayed
    }
}

impl EventLedgerSnapshot {
    pub(crate) fn from_durable(commands: Vec<CommandRecord>, events: Vec<TeamEvent>) -> Self {
        Self { commands, events }
    }

    pub fn commands(&self) -> &[CommandRecord] {
        &self.commands
    }

    pub fn events(&self) -> &[TeamEvent] {
        &self.events
    }

    #[cfg(test)]
    pub fn without_events(mut self) -> Self {
        self.events.clear();
        self
    }

    #[cfg(test)]
    pub fn with_second_event_for_first_accepted_command(mut self) -> Self {
        let command = self
            .commands
            .iter()
            .find(|record| record.is_accepted())
            .expect("snapshot contains an accepted command");
        let sequence = NonZeroU64::new(2).expect("event sequence is non-zero");
        self.events
            .push(TeamEvent::from_command(command.command(), sequence).unwrap());
        self
    }

    #[cfg(test)]
    pub fn with_event_id(mut self, index: usize, event_id: &str) -> Self {
        self.events[index] = self.events[index]
            .clone()
            .with_event_id(OpaqueId::try_new(event_id).unwrap());
        self
    }

    #[cfg(test)]
    pub fn with_event_causation_id(mut self, index: usize, causation_id: &str) -> Self {
        self.events[index] = self.events[index]
            .clone()
            .with_causation_id(OpaqueId::try_new(causation_id).unwrap());
        self
    }

    #[cfg(test)]
    pub fn with_event_sequence(mut self, index: usize, sequence: u64) -> Self {
        self.events[index] = self.events[index]
            .clone()
            .with_sequence(NonZeroU64::new(sequence).unwrap());
        self
    }
}

fn replay_or_conflict(
    existing: &CommandRecord,
    command: &RunCommand,
    status: CommandStatus,
    rejection_reason: Option<CommandRejection>,
) -> Result<CommandReceipt, RecordCommandError> {
    if existing.command() != command {
        return Err(RecordCommandError::IdempotencyConflict);
    }
    if existing.status() != status || existing.rejection_reason() != rejection_reason {
        return Err(RecordCommandError::RejectionConflict);
    }
    Ok(CommandReceipt {
        record: existing.clone(),
        events: Vec::new(),
        replayed: true,
    })
}

fn next_sequence(existing_count: usize) -> Option<NonZeroU64> {
    u64::try_from(existing_count)
        .ok()?
        .checked_add(1)
        .and_then(NonZeroU64::new)
}

fn next_event(
    run_id: &OpaqueId,
    records: &[CommandRecord],
    events: Option<&Vec<TeamEvent>>,
    command: &RunCommand,
) -> Result<TeamEvent, RecordCommandError> {
    let event_sequence =
        next_sequence(events.map_or(0, Vec::len)).expect("event sequence cannot overflow");
    let event = TeamEvent::from_command(command, event_sequence)
        .map_err(|_| RecordCommandError::InvalidEventId)?;
    if records.iter().any(|record| {
        record.is_accepted()
            && record.command_id() == command.command_id()
            && record.command() != command
    }) {
        return Err(RecordCommandError::CommandIdConflict);
    }
    let _ = run_id;
    Ok(event)
}

fn approval_resolution_event_is_canonical(event: &TeamEvent) -> bool {
    match event.payload() {
        TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => {
            event.causation_id() == approval_id.as_str()
                && event.event_id()
                    == format!(
                        "team-event-{}-approval-{}-{}",
                        event.run_id(),
                        approval_id.as_str(),
                        event.sequence()
                    )
                && decision.status() == *status
        }
        _ => false,
    }
}

fn expected_event_for(ledger: &EventLedger, event: &TeamEvent) -> Option<TeamEvent> {
    let record = ledger
        .commands
        .iter()
        .find(|(run_id, _)| run_id.as_str() == event.run_id())
        .and_then(|(_, records)| {
            records
                .iter()
                .find(|record| record.command_id().as_str() == event.causation_id())
        })?;
    if !record.is_accepted() || record.idempotency_key().as_str() != event.idempotency_key() {
        return None;
    }
    let expected_sequence = NonZeroU64::new(event.sequence())?;
    TeamEvent::from_command(record.command(), expected_sequence).ok()
}
