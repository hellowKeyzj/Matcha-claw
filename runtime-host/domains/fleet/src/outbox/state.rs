use std::collections::BTreeMap;

use crate::command::CommandId;

use super::{
    DispatchAttempt, DispatchId, DispatchIntent, DispatchPhase, DispatchReceipt, OutboxRecord,
    record::AttemptOverflow,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Outbox {
    records: BTreeMap<DispatchId, OutboxRecord>,
    dispatches_by_command_id: BTreeMap<CommandId, DispatchId>,
}

impl Outbox {
    pub fn restore(records: impl IntoIterator<Item = OutboxRecord>) -> Result<Self, RestoreError> {
        let mut outbox = Self::default();

        for mut record in records {
            let dispatch_id = record.intent().dispatch_id().clone();
            let command_id = record.intent().command_id().clone();

            if outbox.records.contains_key(&dispatch_id) {
                return Err(RestoreError::DuplicateDispatchId(dispatch_id));
            }
            if outbox.dispatches_by_command_id.contains_key(&command_id) {
                return Err(RestoreError::DuplicateCommandId(command_id));
            }

            record.recover_after_restore();
            outbox
                .dispatches_by_command_id
                .insert(command_id, dispatch_id.clone());
            outbox.records.insert(dispatch_id, record);
        }

        Ok(outbox)
    }

    pub fn insert(&mut self, intent: DispatchIntent) -> InsertOutcome {
        if self.records.contains_key(intent.dispatch_id()) {
            return InsertOutcome::DuplicateDispatchId(intent.dispatch_id().clone());
        }
        if self
            .dispatches_by_command_id
            .contains_key(intent.command_id())
        {
            return InsertOutcome::DuplicateCommandId(intent.command_id().clone());
        }

        self.dispatches_by_command_id
            .insert(intent.command_id().clone(), intent.dispatch_id().clone());
        self.records
            .insert(intent.dispatch_id().clone(), OutboxRecord::pending(intent));
        InsertOutcome::Inserted
    }

    pub fn record(&self, dispatch_id: &DispatchId) -> Option<&OutboxRecord> {
        self.records.get(dispatch_id)
    }

    pub fn dispatch_id_for_command(&self, command_id: &CommandId) -> Option<&DispatchId> {
        self.dispatches_by_command_id.get(command_id)
    }

    pub fn record_for_command(&self, command_id: &CommandId) -> Option<&OutboxRecord> {
        self.dispatch_id_for_command(command_id)
            .and_then(|dispatch_id| self.records.get(dispatch_id))
    }

    pub fn records(&self) -> impl Iterator<Item = &OutboxRecord> {
        self.records.values()
    }

    pub fn begin_delivery(&mut self, dispatch_id: &DispatchId) -> BeginDeliveryOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return BeginDeliveryOutcome::NotFound;
        };

        match record.phase() {
            DispatchPhase::Pending => match record.begin_attempt() {
                Ok(attempt) => BeginDeliveryOutcome::Begun(attempt),
                Err(AttemptOverflow) => BeginDeliveryOutcome::AttemptOverflow,
            },
            DispatchPhase::InFlight => BeginDeliveryOutcome::AlreadyInFlight(
                record
                    .attempt()
                    .cloned()
                    .expect("in-flight record has attempt"),
            ),
            DispatchPhase::OutcomeUnknown => BeginDeliveryOutcome::OutcomeUnknown,
            DispatchPhase::Delivered => BeginDeliveryOutcome::AlreadyDelivered,
        }
    }

    pub fn acknowledge_delivery(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
    ) -> AcknowledgeDeliveryOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return AcknowledgeDeliveryOutcome::NotFound;
        };

        match record.deliver(attempt) {
            Some(receipt) => AcknowledgeDeliveryOutcome::Delivered(receipt),
            None if record.phase() == DispatchPhase::Delivered
                && record.matches_attempt(attempt) =>
            {
                AcknowledgeDeliveryOutcome::AlreadyDelivered
            }
            None => AcknowledgeDeliveryOutcome::StaleAttempt,
        }
    }

    pub fn mark_delivery_outcome_unknown(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
    ) -> ReplayOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return ReplayOutcome::NotFound;
        };

        if record.phase() != DispatchPhase::InFlight || !record.matches_attempt(attempt) {
            return ReplayOutcome::Unchanged;
        }

        record.mark_outcome_unknown();
        ReplayOutcome::Authorized
    }

    pub fn recover_interrupted_delivery(&mut self, dispatch_id: &DispatchId) -> RecoveryOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return RecoveryOutcome::NotFound;
        };

        if record.phase() != DispatchPhase::InFlight {
            return RecoveryOutcome::Unchanged;
        }

        record.mark_outcome_unknown();
        RecoveryOutcome::OutcomeUnknown
    }

    pub(crate) fn authorize_replay(&mut self, dispatch_id: &DispatchId) -> ReplayOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return ReplayOutcome::NotFound;
        };

        if record.phase() != DispatchPhase::OutcomeUnknown {
            return ReplayOutcome::Unchanged;
        }

        record.authorize_replay();
        ReplayOutcome::Authorized
    }

    pub(crate) fn authorize_replay_after_command_unknown(
        &mut self,
        dispatch_id: &DispatchId,
    ) -> ReplayOutcome {
        let Some(record) = self.records.get_mut(dispatch_id) else {
            return ReplayOutcome::NotFound;
        };

        if record.phase() != DispatchPhase::Delivered {
            return ReplayOutcome::Unchanged;
        }

        record.authorize_replay();
        ReplayOutcome::Authorized
    }

    pub fn pending(&self) -> impl Iterator<Item = &OutboxRecord> {
        self.records
            .values()
            .filter(|record| record.phase() == DispatchPhase::Pending)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InsertOutcome {
    Inserted,
    DuplicateDispatchId(DispatchId),
    DuplicateCommandId(CommandId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreError {
    DuplicateDispatchId(DispatchId),
    DuplicateCommandId(CommandId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginDeliveryOutcome {
    Begun(DispatchAttempt),
    AlreadyInFlight(DispatchAttempt),
    OutcomeUnknown,
    AlreadyDelivered,
    NotFound,
    AttemptOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcknowledgeDeliveryOutcome {
    Delivered(DispatchReceipt),
    AlreadyDelivered,
    NotFound,
    StaleAttempt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryOutcome {
    OutcomeUnknown,
    Unchanged,
    NotFound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayOutcome {
    Authorized,
    Unchanged,
    NotFound,
}
