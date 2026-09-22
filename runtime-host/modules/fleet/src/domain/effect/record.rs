use std::time::{Duration, SystemTime};

use crate::{
    domain::command::{CommandAttempt, CommandId},
    domain::target::FleetTargetSelector,
};

use super::{
    identity::{EffectIdentity, PhaseKey},
    state::{EffectState, EffectTransition, EffectTransitionError, checked_deadline},
};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ProviderKind {
    Ssh,
    Docker,
    Kubernetes,
    OpenClaw,
    MatchaAgent,
    Custom,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiptOutcome {
    Delivered,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectReceipt {
    attempt: CommandAttempt,
    outcome: ReceiptOutcome,
}

impl EffectReceipt {
    pub fn delivered(attempt: CommandAttempt) -> Self {
        Self {
            attempt,
            outcome: ReceiptOutcome::Delivered,
        }
    }

    pub fn rejected(attempt: CommandAttempt) -> Self {
        Self {
            attempt,
            outcome: ReceiptOutcome::Rejected,
        }
    }

    pub fn attempt(&self) -> &CommandAttempt {
        &self.attempt
    }

    pub const fn outcome(&self) -> ReceiptOutcome {
        self.outcome
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectRecord {
    identity: EffectIdentity,
    target: FleetTargetSelector,
    desired_revision: u64,
    provider_kind: ProviderKind,
    deadline: SystemTime,
    attempt: Option<CommandAttempt>,
    state: EffectState,
    last_outcome: Option<ReceiptOutcome>,
}

impl EffectRecord {
    pub fn restore(
        identity: EffectIdentity,
        target: FleetTargetSelector,
        desired_revision: u64,
        provider_kind: ProviderKind,
        deadline: SystemTime,
        attempt: Option<CommandAttempt>,
        state: EffectState,
        last_outcome: Option<ReceiptOutcome>,
    ) -> Result<Self, EffectTransitionError> {
        if desired_revision == 0 || deadline < SystemTime::UNIX_EPOCH {
            return Err(EffectTransitionError::InvalidRecord);
        }
        let requires_attempt = matches!(
            state,
            EffectState::InFlight
                | EffectState::Delivered
                | EffectState::OutcomeUnknown
                | EffectState::Rejected
        );
        if requires_attempt && attempt.is_none() {
            return Err(EffectTransitionError::MissingAttempt);
        }
        match (state, last_outcome) {
            (EffectState::Delivered, Some(ReceiptOutcome::Delivered))
            | (EffectState::Rejected, Some(ReceiptOutcome::Rejected))
            | (EffectState::Pending | EffectState::InFlight | EffectState::OutcomeUnknown, None) => {
            }
            _ => return Err(EffectTransitionError::InvalidRecord),
        }
        Ok(Self {
            identity,
            target,
            desired_revision,
            provider_kind,
            deadline,
            attempt,
            state,
            last_outcome,
        })
    }

    pub fn new(
        operation_id: CommandId,
        phase_key: PhaseKey,
        target: FleetTargetSelector,
        desired_revision: u64,
        provider_kind: ProviderKind,
        deadline: SystemTime,
    ) -> Self {
        Self {
            identity: EffectIdentity::new(operation_id, phase_key),
            target,
            desired_revision,
            provider_kind,
            deadline,
            attempt: None,
            state: EffectState::Pending,
            last_outcome: None,
        }
    }

    pub fn with_timeout(
        operation_id: CommandId,
        phase_key: PhaseKey,
        target: FleetTargetSelector,
        desired_revision: u64,
        provider_kind: ProviderKind,
        now: SystemTime,
        timeout: Duration,
    ) -> Result<Self, EffectTransitionError> {
        let deadline = checked_deadline(now, timeout)?;
        Ok(Self::new(
            operation_id,
            phase_key,
            target,
            desired_revision,
            provider_kind,
            deadline,
        ))
    }

    pub fn identity(&self) -> &EffectIdentity {
        &self.identity
    }

    pub fn operation_id(&self) -> &CommandId {
        self.identity.operation_id()
    }

    pub fn phase_key(&self) -> &PhaseKey {
        self.identity.phase_key()
    }

    pub fn target(&self) -> &FleetTargetSelector {
        &self.target
    }

    pub const fn desired_revision(&self) -> u64 {
        self.desired_revision
    }

    pub const fn provider_kind(&self) -> ProviderKind {
        self.provider_kind
    }

    pub const fn deadline(&self) -> SystemTime {
        self.deadline
    }

    pub const fn state(&self) -> EffectState {
        self.state
    }

    pub fn attempt(&self) -> Option<&CommandAttempt> {
        self.attempt.as_ref()
    }

    pub const fn last_outcome(&self) -> Option<ReceiptOutcome> {
        self.last_outcome
    }

    pub fn begin(&mut self) -> Result<EffectTransition, EffectTransitionError> {
        if self.state != EffectState::Pending {
            return Err(EffectTransitionError::InvalidTransition);
        }
        let attempt = match &self.attempt {
            Some(current) => current
                .next()
                .ok_or(EffectTransitionError::AttemptOverflow)?,
            None => CommandAttempt::first(),
        };
        self.attempt = Some(attempt.clone());
        self.last_outcome = None;
        self.state = EffectState::InFlight;
        Ok(EffectTransition::Began { attempt })
    }

    pub fn apply_receipt(
        &mut self,
        receipt: &EffectReceipt,
    ) -> Result<EffectTransition, EffectTransitionError> {
        let current = self
            .attempt
            .as_ref()
            .ok_or(EffectTransitionError::MissingAttempt)?;
        if receipt.attempt != *current {
            return Err(EffectTransitionError::StaleAttempt);
        }
        if self.state.is_terminal() && self.last_outcome == Some(receipt.outcome) {
            return Ok(EffectTransition::Idempotent);
        }
        if self.state != EffectState::InFlight {
            return Err(EffectTransitionError::InvalidTransition);
        }
        self.last_outcome = Some(receipt.outcome);
        self.state = match receipt.outcome {
            ReceiptOutcome::Delivered => EffectState::Delivered,
            ReceiptOutcome::Rejected => EffectState::Rejected,
        };
        Ok(match receipt.outcome {
            ReceiptOutcome::Delivered => EffectTransition::Delivered,
            ReceiptOutcome::Rejected => EffectTransition::Rejected,
        })
    }

    pub fn expire(&mut self, now: SystemTime) -> Result<EffectTransition, EffectTransitionError> {
        if self.state != EffectState::InFlight {
            return Err(EffectTransitionError::InvalidTransition);
        }
        if now < self.deadline {
            return Err(EffectTransitionError::DeadlineNotReached);
        }
        self.state = EffectState::OutcomeUnknown;
        Ok(EffectTransition::OutcomeUnknown)
    }

    pub fn mark_unknown(
        &mut self,
        attempt: &CommandAttempt,
    ) -> Result<EffectTransition, EffectTransitionError> {
        let current = self
            .attempt
            .as_ref()
            .ok_or(EffectTransitionError::MissingAttempt)?;
        if attempt != current {
            return Err(EffectTransitionError::StaleAttempt);
        }
        if self.state != EffectState::InFlight {
            return Err(EffectTransitionError::InvalidTransition);
        }
        self.state = EffectState::OutcomeUnknown;
        Ok(EffectTransition::OutcomeUnknown)
    }

    pub fn authorize_replay(&mut self) -> Result<EffectTransition, EffectTransitionError> {
        if self.state != EffectState::OutcomeUnknown {
            return Err(EffectTransitionError::InvalidTransition);
        }
        self.state = EffectState::Pending;
        Ok(EffectTransition::ReplayAuthorized)
    }
}
