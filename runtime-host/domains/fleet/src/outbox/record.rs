use std::fmt;

use crate::{command::CommandId, target::FleetTargetSelector};
use platform::endpoint::NativeAgentId;

use super::DispatchId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchIntent {
    dispatch_id: DispatchId,
    command_id: CommandId,
    agent_id: NativeAgentId,
    target: Option<FleetTargetSelector>,
}

impl DispatchIntent {
    pub fn new(dispatch_id: DispatchId, command_id: CommandId, agent_id: NativeAgentId) -> Self {
        Self {
            dispatch_id,
            command_id,
            agent_id,
            target: None,
        }
    }

    pub fn for_target(
        dispatch_id: DispatchId,
        command_id: CommandId,
        agent_id: NativeAgentId,
        target: FleetTargetSelector,
    ) -> Self {
        Self {
            dispatch_id,
            command_id,
            agent_id,
            target: Some(target),
        }
    }

    pub fn dispatch_id(&self) -> &DispatchId {
        &self.dispatch_id
    }

    pub fn command_id(&self) -> &CommandId {
        &self.command_id
    }

    pub fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub fn target(&self) -> Option<&FleetTargetSelector> {
        self.target.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchPhase {
    Pending,
    InFlight,
    OutcomeUnknown,
    Delivered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchAttempt {
    sequence: u64,
}

impl DispatchAttempt {
    pub fn try_new(sequence: u64) -> Result<Self, InvalidDispatchAttempt> {
        if sequence == 0 {
            return Err(InvalidDispatchAttempt);
        }
        Ok(Self { sequence })
    }

    pub(super) const fn first() -> Self {
        Self { sequence: 1 }
    }

    pub(super) fn next(&self) -> Option<Self> {
        self.sequence
            .checked_add(1)
            .map(|sequence| Self { sequence })
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDispatchAttempt;

impl fmt::Display for InvalidDispatchAttempt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("dispatch attempt sequence must be positive")
    }
}

impl std::error::Error for InvalidDispatchAttempt {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchReceipt {
    dispatch_id: DispatchId,
    attempt: DispatchAttempt,
}

impl DispatchReceipt {
    pub fn dispatch_id(&self) -> &DispatchId {
        &self.dispatch_id
    }

    pub fn attempt(&self) -> &DispatchAttempt {
        &self.attempt
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxRecord {
    intent: DispatchIntent,
    phase: DispatchPhase,
    attempt: Option<DispatchAttempt>,
}

impl OutboxRecord {
    pub(super) fn pending(intent: DispatchIntent) -> Self {
        Self {
            intent,
            phase: DispatchPhase::Pending,
            attempt: None,
        }
    }

    pub fn restore(
        intent: DispatchIntent,
        phase: DispatchPhase,
        attempt: Option<DispatchAttempt>,
    ) -> Result<Self, InvalidOutboxRecordState> {
        if matches!(
            phase,
            DispatchPhase::InFlight | DispatchPhase::OutcomeUnknown | DispatchPhase::Delivered
        ) && attempt.is_none()
        {
            return Err(InvalidOutboxRecordState);
        }

        Ok(Self {
            intent,
            phase,
            attempt,
        })
    }

    pub fn intent(&self) -> &DispatchIntent {
        &self.intent
    }

    pub const fn phase(&self) -> DispatchPhase {
        self.phase
    }

    pub fn attempt(&self) -> Option<&DispatchAttempt> {
        self.attempt.as_ref()
    }

    pub(super) fn matches_attempt(&self, attempt: &DispatchAttempt) -> bool {
        self.attempt.as_ref() == Some(attempt)
    }

    pub(super) fn begin_attempt(&mut self) -> Result<DispatchAttempt, AttemptOverflow> {
        let attempt = match &self.attempt {
            Some(attempt) => attempt.next().ok_or(AttemptOverflow)?,
            None => DispatchAttempt::first(),
        };
        self.phase = DispatchPhase::InFlight;
        self.attempt = Some(attempt.clone());
        Ok(attempt)
    }

    pub(super) fn mark_outcome_unknown(&mut self) {
        self.phase = DispatchPhase::OutcomeUnknown;
    }

    pub(super) fn recover_after_restore(&mut self) {
        if self.phase == DispatchPhase::InFlight {
            self.mark_outcome_unknown();
        }
    }

    pub(super) fn authorize_replay(&mut self) {
        self.phase = DispatchPhase::Pending;
    }

    pub(super) fn deliver(&mut self, attempt: &DispatchAttempt) -> Option<DispatchReceipt> {
        if !matches!(
            self.phase,
            DispatchPhase::InFlight | DispatchPhase::OutcomeUnknown
        ) || !self.matches_attempt(attempt)
        {
            return None;
        }
        self.phase = DispatchPhase::Delivered;
        Some(DispatchReceipt {
            dispatch_id: self.intent.dispatch_id.clone(),
            attempt: attempt.clone(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidOutboxRecordState;

impl fmt::Display for InvalidOutboxRecordState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("outbox record phase requires a delivery attempt")
    }
}

impl std::error::Error for InvalidOutboxRecordState {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AttemptOverflow;
