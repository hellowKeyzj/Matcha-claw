use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime},
};

use super::{
    CommandAttempt, CommandCancellation, CommandFailure, CommandId, CommandIntent, CommandState,
    CommandTransitionError, IdempotencyKey,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRecord {
    intent: CommandIntent,
    state: CommandState,
    attempt: Option<CommandAttempt>,
    last_failure: Option<CommandFailure>,
    updated_at: SystemTime,
}

impl CommandRecord {
    pub fn queued(intent: CommandIntent) -> Self {
        let queued_at = intent.queued_at();
        Self {
            intent,
            state: CommandState::Queued { queued_at },
            attempt: None,
            last_failure: None,
            updated_at: queued_at,
        }
    }

    pub fn restore(
        intent: CommandIntent,
        state: CommandState,
        attempt: Option<CommandAttempt>,
        last_failure: Option<CommandFailure>,
        updated_at: SystemTime,
    ) -> Result<Self, RestoreCommandError> {
        if updated_at < intent.queued_at() {
            return Err(RestoreCommandError::UpdatedBeforeQueued);
        }
        if state_at(&state) != updated_at {
            return Err(RestoreCommandError::StateUpdatedMismatch);
        }
        if state_requires_attempt(&state) && attempt.is_none() {
            return Err(RestoreCommandError::MissingAttempt);
        }
        match &state {
            CommandState::Failed { failure, .. } if last_failure != Some(*failure) => {
                return Err(RestoreCommandError::FailureMismatch);
            }
            CommandState::Failed { .. } => {}
            _ if last_failure.is_some() => return Err(RestoreCommandError::UnexpectedFailure),
            _ => {}
        }
        Ok(Self {
            intent,
            state,
            attempt,
            last_failure,
            updated_at,
        })
    }

    pub fn intent(&self) -> &CommandIntent {
        &self.intent
    }

    pub fn state(&self) -> &CommandState {
        &self.state
    }

    pub fn attempt(&self) -> Option<&CommandAttempt> {
        self.attempt.as_ref()
    }

    pub const fn last_failure(&self) -> Option<CommandFailure> {
        self.last_failure
    }

    pub const fn updated_at(&self) -> SystemTime {
        self.updated_at
    }

    fn start(&self, at: SystemTime) -> Result<StartRecordOutcome, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        match &self.state {
            CommandState::Queued { .. } => {
                let attempt = self.attempt.clone().unwrap_or_else(CommandAttempt::first);
                Ok(StartRecordOutcome::Started(
                    self.updated(
                        CommandState::Running { started_at: at },
                        Some(attempt.clone()),
                    ),
                    attempt,
                ))
            }
            CommandState::Running { .. } => Ok(StartRecordOutcome::AlreadyRunning(
                self.attempt
                    .clone()
                    .expect("running commands always retain an attempt"),
            )),
            CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. }
            | CommandState::TimedOut { .. }
            | CommandState::OutcomeUnknown { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn succeed(
        &self,
        attempt: &CommandAttempt,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        if self.attempt.as_ref() != Some(attempt) {
            return Ok(RecordTransition::StaleAttempt);
        }
        match &self.state {
            CommandState::Running { .. } | CommandState::OutcomeUnknown { .. } => {
                Ok(RecordTransition::Transitioned(self.updated(
                    CommandState::Succeeded { completed_at: at },
                    self.attempt.clone(),
                )))
            }
            CommandState::Succeeded { .. } => Ok(RecordTransition::Unchanged),
            CommandState::Queued { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. }
            | CommandState::TimedOut { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn fail(
        &self,
        attempt: &CommandAttempt,
        failure: CommandFailure,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        let matching_queued_attempt = matches!(&self.state, CommandState::Queued { .. })
            && self
                .attempt
                .as_ref()
                .map_or(attempt.sequence() == 1, |current| current == attempt);
        let matching_queued_rejection =
            failure == CommandFailure::Rejected && matching_queued_attempt;
        if self.attempt.as_ref() != Some(attempt) && !matching_queued_rejection {
            return Ok(RecordTransition::StaleAttempt);
        }
        match &self.state {
            CommandState::Running { .. } | CommandState::OutcomeUnknown { .. } => {
                Ok(RecordTransition::Transitioned(self.updated_with_failure(
                    CommandState::Failed {
                        completed_at: at,
                        failure,
                    },
                    self.attempt.clone(),
                    Some(failure),
                )))
            }
            CommandState::Queued { .. } if matching_queued_rejection => {
                Ok(RecordTransition::Transitioned(self.updated_with_failure(
                    CommandState::Failed {
                        completed_at: at,
                        failure,
                    },
                    Some(attempt.clone()),
                    Some(failure),
                )))
            }
            CommandState::Failed {
                failure: current_failure,
                ..
            } if *current_failure == failure => Ok(RecordTransition::Unchanged),
            CommandState::Queued { .. }
            | CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. }
            | CommandState::TimedOut { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn mark_outcome_unknown(
        &self,
        attempt: &CommandAttempt,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        let matching_queued_attempt = matches!(&self.state, CommandState::Queued { .. })
            && self
                .attempt
                .as_ref()
                .map_or(attempt.sequence() == 1, |current| current == attempt);
        if self.attempt.as_ref() != Some(attempt) && !matching_queued_attempt {
            return Ok(RecordTransition::StaleAttempt);
        }
        match &self.state {
            CommandState::Running { .. } => Ok(RecordTransition::Transitioned(self.updated(
                CommandState::OutcomeUnknown { observed_at: at },
                self.attempt.clone(),
            ))),
            CommandState::Queued { .. } if matching_queued_attempt => {
                Ok(RecordTransition::Transitioned(self.updated(
                    CommandState::OutcomeUnknown { observed_at: at },
                    Some(attempt.clone()),
                )))
            }
            CommandState::OutcomeUnknown { .. } => Ok(RecordTransition::Unchanged),
            CommandState::Queued { .. }
            | CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. }
            | CommandState::TimedOut { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn cancel(
        &self,
        reason: Option<CommandCancellation>,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        match &self.state {
            CommandState::Queued { .. } | CommandState::Running { .. } => {
                Ok(RecordTransition::Transitioned(self.updated(
                    CommandState::Cancelled {
                        completed_at: at,
                        reason,
                    },
                    self.attempt.clone(),
                )))
            }
            CommandState::Cancelled { .. } => Ok(RecordTransition::Unchanged),
            CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::TimedOut { .. }
            | CommandState::OutcomeUnknown { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn cancel_with_attempt(
        &self,
        attempt: &CommandAttempt,
        reason: Option<CommandCancellation>,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        if self.attempt.as_ref() != Some(attempt) {
            return Ok(RecordTransition::StaleAttempt);
        }
        match &self.state {
            CommandState::Running { .. } | CommandState::OutcomeUnknown { .. } => {
                Ok(RecordTransition::Transitioned(self.updated(
                    CommandState::Cancelled {
                        completed_at: at,
                        reason,
                    },
                    self.attempt.clone(),
                )))
            }
            CommandState::Cancelled { .. } => Ok(RecordTransition::Unchanged),
            CommandState::Queued { .. }
            | CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::TimedOut { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn time_out_with_attempt(
        &self,
        attempt: &CommandAttempt,
        timeout: Duration,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        if self.attempt.as_ref() != Some(attempt) {
            return Ok(RecordTransition::StaleAttempt);
        }
        match &self.state {
            CommandState::Running { .. } | CommandState::OutcomeUnknown { .. } => {
                Ok(RecordTransition::Transitioned(self.updated(
                    CommandState::TimedOut {
                        completed_at: at,
                        timeout,
                    },
                    self.attempt.clone(),
                )))
            }
            CommandState::TimedOut { .. } => Ok(RecordTransition::Unchanged),
            CommandState::Queued { .. }
            | CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn time_out(
        &self,
        timeout: Duration,
        at: SystemTime,
    ) -> Result<RecordTransition, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        match &self.state {
            CommandState::Queued { .. } => Ok(RecordTransition::Transitioned(self.updated(
                CommandState::TimedOut {
                    completed_at: at,
                    timeout,
                },
                self.attempt.clone(),
            ))),
            CommandState::Running { .. } => Ok(RecordTransition::Transitioned(self.updated(
                CommandState::OutcomeUnknown { observed_at: at },
                self.attempt.clone(),
            ))),
            CommandState::TimedOut { .. } | CommandState::OutcomeUnknown { .. } => {
                Ok(RecordTransition::Unchanged)
            }
            CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::Cancelled { .. } => Err(CommandTransitionError::InvalidTransition),
        }
    }

    fn authorize_replay(&self, at: SystemTime) -> Result<Self, CommandTransitionError> {
        self.ensure_not_backdated(at)?;
        if !matches!(&self.state, CommandState::OutcomeUnknown { .. }) {
            return Err(CommandTransitionError::InvalidTransition);
        }
        let next_attempt = self
            .attempt
            .as_ref()
            .expect("outcome-unknown commands always retain an attempt")
            .next()
            .ok_or(CommandTransitionError::AttemptOverflow)?;
        Ok(self.updated(CommandState::Queued { queued_at: at }, Some(next_attempt)))
    }

    fn is_timed_out(&self, now: SystemTime, timeout: Duration) -> bool {
        self.state
            .active_since()
            .and_then(|active_since| now.duration_since(active_since).ok())
            .is_some_and(|elapsed| elapsed >= timeout)
    }

    fn ensure_not_backdated(&self, at: SystemTime) -> Result<(), CommandTransitionError> {
        if at < self.updated_at {
            Err(CommandTransitionError::BackdatedTransition)
        } else {
            Ok(())
        }
    }

    fn updated(&self, state: CommandState, attempt: Option<CommandAttempt>) -> Self {
        self.updated_with_failure(state, attempt, self.last_failure)
    }

    fn updated_with_failure(
        &self,
        state: CommandState,
        attempt: Option<CommandAttempt>,
        last_failure: Option<CommandFailure>,
    ) -> Self {
        Self {
            intent: self.intent.clone(),
            updated_at: state_at(&state),
            state,
            attempt,
            last_failure,
        }
    }
}

enum StartRecordOutcome {
    Started(CommandRecord, CommandAttempt),
    AlreadyRunning(CommandAttempt),
}

enum RecordTransition {
    Transitioned(CommandRecord),
    Unchanged,
    StaleAttempt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoreCommandError {
    UpdatedBeforeQueued,
    StateUpdatedMismatch,
    MissingAttempt,
    FailureMismatch,
    UnexpectedFailure,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CommandLedger {
    commands: BTreeMap<CommandId, CommandRecord>,
    command_ids_by_idempotency_key: BTreeMap<IdempotencyKey, CommandId>,
}

impl CommandLedger {
    pub fn restore(
        records: impl IntoIterator<Item = CommandRecord>,
    ) -> Result<Self, RestoreLedgerError> {
        let mut ledger = Self::default();
        for record in records {
            let command_id = record.intent().command_id().clone();
            let idempotency_key = record.intent().idempotency_key().clone();
            if ledger.commands.contains_key(&command_id) {
                return Err(RestoreLedgerError::DuplicateCommandId(command_id));
            }
            if ledger
                .command_ids_by_idempotency_key
                .contains_key(&idempotency_key)
            {
                return Err(RestoreLedgerError::DuplicateIdempotencyKey(idempotency_key));
            }
            ledger
                .command_ids_by_idempotency_key
                .insert(idempotency_key, command_id.clone());
            ledger.commands.insert(command_id, record);
        }
        Ok(ledger)
    }

    pub fn submit(&mut self, intent: CommandIntent) -> SubmitOutcome {
        if let Some(command_id) = self
            .command_ids_by_idempotency_key
            .get(intent.idempotency_key())
        {
            return SubmitOutcome::Duplicate(
                self.commands
                    .get(command_id)
                    .expect("idempotency key index always references a command")
                    .clone(),
            );
        }

        if self.commands.contains_key(intent.command_id()) {
            return SubmitOutcome::DuplicateCommandId(intent.command_id().clone());
        }

        let record = CommandRecord::queued(intent);
        self.command_ids_by_idempotency_key.insert(
            record.intent().idempotency_key().clone(),
            record.intent().command_id().clone(),
        );
        self.commands
            .insert(record.intent().command_id().clone(), record.clone());
        SubmitOutcome::Submitted(record)
    }

    pub fn record(&self, command_id: &CommandId) -> Option<&CommandRecord> {
        self.commands.get(command_id)
    }

    pub fn records(&self) -> impl Iterator<Item = &CommandRecord> {
        self.commands.values()
    }

    pub fn start(&mut self, command_id: &CommandId, at: SystemTime) -> StartOutcome {
        let Some(record) = self.commands.get(command_id) else {
            return StartOutcome::NotFound;
        };
        match record.start(at) {
            Ok(StartRecordOutcome::Started(next, attempt)) => {
                self.commands.insert(command_id.clone(), next.clone());
                StartOutcome::Started {
                    record: next,
                    attempt,
                }
            }
            Ok(StartRecordOutcome::AlreadyRunning(attempt)) => StartOutcome::AlreadyRunning {
                record: record.clone(),
                attempt,
            },
            Err(error) => StartOutcome::Rejected(error),
        }
    }

    pub fn succeed(
        &mut self,
        command_id: &CommandId,
        attempt: &CommandAttempt,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply_attempt(command_id, at, |record| record.succeed(attempt, at))
    }

    pub fn fail(
        &mut self,
        command_id: &CommandId,
        attempt: &CommandAttempt,
        failure: CommandFailure,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply_attempt(command_id, at, |record| record.fail(attempt, failure, at))
    }

    pub fn mark_outcome_unknown(
        &mut self,
        command_id: &CommandId,
        attempt: &CommandAttempt,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply_attempt(command_id, at, |record| {
            record.mark_outcome_unknown(attempt, at)
        })
    }

    pub fn cancel(
        &mut self,
        command_id: &CommandId,
        reason: Option<CommandCancellation>,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply(command_id, |record| record.cancel(reason, at))
    }

    pub fn cancel_with_attempt(
        &mut self,
        command_id: &CommandId,
        attempt: &CommandAttempt,
        reason: Option<CommandCancellation>,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply_attempt(command_id, at, |record| {
            record.cancel_with_attempt(attempt, reason, at)
        })
    }

    pub fn time_out_with_attempt(
        &mut self,
        command_id: &CommandId,
        attempt: &CommandAttempt,
        timeout: Duration,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply_attempt(command_id, at, |record| {
            record.time_out_with_attempt(attempt, timeout, at)
        })
    }

    pub fn authorize_replay(
        &mut self,
        command_id: &CommandId,
        at: SystemTime,
    ) -> TransitionOutcome {
        self.apply(command_id, |record| {
            record
                .authorize_replay(at)
                .map(RecordTransition::Transitioned)
        })
    }

    pub fn reap_timeouts(&mut self, now: SystemTime, timeout: Duration) -> Vec<CommandRecord> {
        let command_ids: Vec<_> = self
            .commands
            .iter()
            .filter(|(_, record)| record.is_timed_out(now, timeout))
            .map(|(command_id, _)| command_id.clone())
            .collect();

        command_ids
            .into_iter()
            .filter_map(|command_id| {
                match self.apply(&command_id, |record| record.time_out(timeout, now)) {
                    TransitionOutcome::Transitioned(record) => Some(record),
                    TransitionOutcome::Unchanged(_)
                    | TransitionOutcome::StaleAttempt(_)
                    | TransitionOutcome::NotFound
                    | TransitionOutcome::Rejected(_) => None,
                }
            })
            .collect()
    }

    fn apply_attempt(
        &mut self,
        command_id: &CommandId,
        at: SystemTime,
        transition: impl FnOnce(&CommandRecord) -> Result<RecordTransition, CommandTransitionError>,
    ) -> TransitionOutcome {
        let Some(record) = self.commands.get(command_id) else {
            return TransitionOutcome::NotFound;
        };
        if at < record.updated_at() {
            return TransitionOutcome::Rejected(CommandTransitionError::BackdatedTransition);
        }
        self.apply(command_id, transition)
    }

    fn apply(
        &mut self,
        command_id: &CommandId,
        transition: impl FnOnce(&CommandRecord) -> Result<RecordTransition, CommandTransitionError>,
    ) -> TransitionOutcome {
        let Some(record) = self.commands.get(command_id) else {
            return TransitionOutcome::NotFound;
        };
        let current = record.clone();
        match transition(&current) {
            Ok(RecordTransition::Transitioned(next)) => {
                self.commands.insert(command_id.clone(), next.clone());
                TransitionOutcome::Transitioned(next)
            }
            Ok(RecordTransition::Unchanged) => TransitionOutcome::Unchanged(current),
            Ok(RecordTransition::StaleAttempt) => TransitionOutcome::StaleAttempt(current),
            Err(error) => TransitionOutcome::Rejected(error),
        }
    }
}

fn state_requires_attempt(state: &CommandState) -> bool {
    matches!(
        state,
        CommandState::Running { .. }
            | CommandState::Succeeded { .. }
            | CommandState::Failed { .. }
            | CommandState::OutcomeUnknown { .. }
    )
}

fn state_at(state: &CommandState) -> SystemTime {
    match state {
        CommandState::Queued { queued_at } => *queued_at,
        CommandState::Running { started_at } => *started_at,
        CommandState::Succeeded { completed_at }
        | CommandState::Failed { completed_at, .. }
        | CommandState::Cancelled { completed_at, .. }
        | CommandState::TimedOut { completed_at, .. } => *completed_at,
        CommandState::OutcomeUnknown { observed_at } => *observed_at,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmitOutcome {
    Submitted(CommandRecord),
    Duplicate(CommandRecord),
    DuplicateCommandId(CommandId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartOutcome {
    Started {
        record: CommandRecord,
        attempt: CommandAttempt,
    },
    AlreadyRunning {
        record: CommandRecord,
        attempt: CommandAttempt,
    },
    NotFound,
    Rejected(CommandTransitionError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransitionOutcome {
    Transitioned(CommandRecord),
    Unchanged(CommandRecord),
    StaleAttempt(CommandRecord),
    NotFound,
    Rejected(CommandTransitionError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreLedgerError {
    DuplicateCommandId(CommandId),
    DuplicateIdempotencyKey(IdempotencyKey),
}
