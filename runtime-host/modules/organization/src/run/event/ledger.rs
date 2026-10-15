use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroU64,
};

use super::{
    CommandRecord, CommandRejection, CommandStatus, OpaqueId, RunCommand, TeamEvent,
    TeamEventPayload,
};

#[derive(Clone, Debug, Default)]
pub struct EventLedger {
    commands: BTreeMap<OpaqueId, Vec<CommandRecord>>,
    events: BTreeMap<OpaqueId, Vec<TeamEvent>>,
    event_ids: BTreeSet<String>,
    transaction: Option<BTreeMap<OpaqueId, EventUndo>>,
}

#[derive(Clone, Debug)]
struct EventUndo {
    commands: usize,
    events: usize,
    removed: Option<(Vec<CommandRecord>, Vec<TeamEvent>)>,
}

impl PartialEq for EventLedger {
    fn eq(&self, other: &Self) -> bool {
        self.commands == other.commands && self.events == other.events
    }
}

impl Eq for EventLedger {}

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
    pub(crate) fn begin_transaction(&mut self) {
        if self.transaction.is_none() { self.transaction = Some(BTreeMap::new()); }
    }

    pub(crate) fn commit_transaction(&mut self) { self.transaction = None; }

    pub(crate) fn rollback_transaction(&mut self) {
        let Some(transaction) = self.transaction.take() else { return };
        for (run, undo) in transaction {
            if let Some(events) = self.events.get(&run) {
                for event in events.iter().skip(undo.events) { self.event_ids.remove(event.event_id()); }
            }
            if let Some((commands, events)) = undo.removed {
                self.event_ids.extend(events.iter().take(undo.events).map(|event| event.event_id().to_owned()));
                self.commands.insert(run.clone(), commands);
                self.events.insert(run.clone(), events);
            }
            if undo.commands == 0 { self.commands.remove(&run); }
            else if let Some(commands) = self.commands.get_mut(&run) { commands.truncate(undo.commands); }
            if undo.events == 0 { self.events.remove(&run); }
            else if let Some(events) = self.events.get_mut(&run) { events.truncate(undo.events); }
        }
    }

    fn touch(&mut self, run: &OpaqueId) {
        if let Some(transaction) = &mut self.transaction {
            transaction.entry(run.clone()).or_insert_with(|| EventUndo {
                commands: self.commands.get(run).map_or(0, Vec::len),
                events: self.events.get(run).map_or(0, Vec::len),
                removed: None,
            });
        }
    }

    pub(crate) fn changed_runs(&self) -> impl Iterator<Item = &OpaqueId> {
        self.transaction.iter().flat_map(|transaction| transaction.keys())
    }

    pub(crate) fn new_commands(&self, run: &OpaqueId) -> &[CommandRecord] {
        let start = self.transaction.as_ref().and_then(|transaction| transaction.get(run)).map_or(0, |undo| undo.commands);
        self.commands.get(run).map_or(&[], |records| &records[start.min(records.len())..])
    }

    pub(crate) fn new_events(&self, run: &OpaqueId) -> &[TeamEvent] {
        let start = self.transaction.as_ref().and_then(|transaction| transaction.get(run)).map_or(0, |undo| undo.events);
        self.events.get(run).map_or(&[], |records| &records[start.min(records.len())..])
    }

    pub(crate) fn removed_commands(&self, run: &OpaqueId) -> &[CommandRecord] {
        self.transaction.as_ref().and_then(|transaction| transaction.get(run))
            .and_then(|undo| undo.removed.as_ref().map(|(commands, _)| &commands[..undo.commands]))
            .unwrap_or_default()
    }

    pub(crate) fn removed_events(&self, run: &OpaqueId) -> &[TeamEvent] {
        self.transaction.as_ref().and_then(|transaction| transaction.get(run))
            .and_then(|undo| undo.removed.as_ref().map(|(_, events)| &events[..undo.events]))
            .unwrap_or_default()
    }

    pub(crate) fn commands_for_run(&self, run: &OpaqueId) -> &[CommandRecord] {
        self.commands.get(run).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn events_for_run_id(&self, run: &OpaqueId) -> &[TeamEvent] {
        self.events.get(run).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn replay(&self, command: &RunCommand) -> Result<Option<CommandReceipt>, RecordCommandError> {
        if let Some(existing) = self.command_by_idempotency(command.run_id(), command.idempotency_key()) {
            return replay_or_conflict(existing, command, CommandStatus::Accepted, None).map(Some);
        }
        if self.commands_for_run(command.run_id()).iter().any(|record| record.command_id() == command.command_id()) {
            return Err(RecordCommandError::CommandIdConflict);
        }
        Ok(None)
    }

    pub(crate) fn import_command(&mut self, record: CommandRecord) -> Result<(), RestoreEventLedgerError> {
        let records = self.commands.entry(record.run_id().clone()).or_default();
        let index = usize::try_from(record.sequence()).ok().and_then(|value| value.checked_sub(1))
            .ok_or(RestoreEventLedgerError::CommandSequenceGap)?;
        if index < records.len() {
            return if records[index] == record { Ok(()) } else { Err(RestoreEventLedgerError::DuplicateCommandId) };
        }
        if index != records.len() { return Err(RestoreEventLedgerError::CommandSequenceGap); }
        if records.iter().any(|old| old.command_id() == record.command_id()) {
            return Err(RestoreEventLedgerError::DuplicateCommandId);
        }
        if records.iter().any(|old| old.idempotency_key() == record.idempotency_key()) {
            return Err(RestoreEventLedgerError::DuplicateIdempotencyKey);
        }
        records.push(record);
        Ok(())
    }

    pub(crate) fn import_event(&mut self, event: TeamEvent) -> Result<(), RestoreEventLedgerError> {
        let run = event.run_id_value().clone();
        let index = usize::try_from(event.sequence()).ok().and_then(|value| value.checked_sub(1))
            .ok_or(RestoreEventLedgerError::EventSequenceGap)?;
        let records = self.events.get(&run).map_or(&[][..], Vec::as_slice);
        if index < records.len() {
            return if records[index] == event { Ok(()) } else { Err(RestoreEventLedgerError::DuplicateEventId) };
        }
        if index != records.len() { return Err(RestoreEventLedgerError::EventSequenceGap); }
        if event.event_type() == super::TeamEventType::ApprovalResolved {
            if !approval_resolution_event_is_canonical(&event) { return Err(RestoreEventLedgerError::EventDoesNotMatchCommand); }
        } else if expected_event_for(self, &event).as_ref() != Some(&event) {
            return Err(RestoreEventLedgerError::EventDoesNotMatchCommand);
        }
        if !self.event_ids.insert(event.event_id().to_owned()) { return Err(RestoreEventLedgerError::DuplicateEventId); }
        self.events.entry(run).or_default().push(event);
        Ok(())
    }

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
        self.touch(&run_id);
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
        if !self.event_ids.insert(event.event_id().to_owned()) { return Err(RecordCommandError::InvalidEventId); }
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

        for event in snapshot.events {
            if !ledger.event_ids.insert(event.event_id().to_owned()) {
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
        let Ok(run) = OpaqueId::try_new(run_id) else { return };
        self.touch(&run);
        let commands = self.commands.remove(&run).unwrap_or_default();
        let events = self.events.remove(&run).unwrap_or_default();
        for event in &events { self.event_ids.remove(event.event_id()); }
        if let Some(undo) = self.transaction.as_mut().and_then(|transaction| transaction.get_mut(&run)) {
            undo.removed.get_or_insert((commands, events));
        }
    }

    fn record(
        &mut self,
        command: RunCommand,
        status: CommandStatus,
        rejection_reason: Option<CommandRejection>,
    ) -> Result<CommandReceipt, RecordCommandError> {
        let run_id = command.run_id().clone();
        self.touch(&run_id);
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
            let event_sequence = next_sequence(self.events.get(&run_id).map_or(0, Vec::len))
                .expect("event sequence cannot overflow");
            let event = TeamEvent::from_command(record.command(), event_sequence)
                .map_err(|_| RecordCommandError::InvalidEventId)?;
            if !self.event_ids.insert(event.event_id().to_owned()) { return Err(RecordCommandError::InvalidEventId); }
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
    if !command_replay_matches(existing.command(), command) {
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

fn command_replay_matches(existing: &RunCommand, command: &RunCommand) -> bool {
    existing.run_id() == command.run_id()
        && existing.command_id() == command.command_id()
        && existing.idempotency_key() == command.idempotency_key()
        && existing.payload() == command.payload()
}

fn next_sequence(existing_count: usize) -> Option<NonZeroU64> {
    u64::try_from(existing_count)
        .ok()?
        .checked_add(1)
        .and_then(NonZeroU64::new)
}

fn approval_resolution_event_is_canonical(event: &TeamEvent) -> bool {
    match event.payload() {
        TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => {
            let Ok(expected_event_id) = super::model::team_event_id(
                super::model::TeamEventIdentityKind::Approval,
                event.run_id(),
                approval_id.as_str(),
                event.sequence(),
            ) else {
                return false;
            };
            event.causation_id() == approval_id.as_str()
                && event.event_id() == expected_event_id.as_str()
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
