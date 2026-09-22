use std::fmt;

use super::{
    Activity, ActivityClaim, ActivityDispatch, ActivityFailure, ActivityId, ActivityPhase,
    ActivityRequest, ActivityRequestError,
};

#[derive(Clone, Eq, PartialEq)]
pub struct ActivitySnapshot {
    facts: ActivityRequest,
    phase: ActivityPhaseSnapshot,
    completed_attempts: u32,
    next_claim_generation: u64,
}

impl fmt::Debug for ActivitySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivitySnapshot")
            .field("facts", &self.facts)
            .field("phase", &self.phase)
            .field("completed_attempts", &self.completed_attempts)
            .field("next_claim_generation", &self.next_claim_generation)
            .finish()
    }
}

impl ActivitySnapshot {
    pub(crate) fn new(
        facts: ActivityRequest,
        phase: ActivityPhaseSnapshot,
        completed_attempts: u32,
        next_claim_generation: u64,
    ) -> Self {
        Self {
            facts,
            phase,
            completed_attempts,
            next_claim_generation,
        }
    }

    pub fn facts(&self) -> &ActivityRequest {
        &self.facts
    }

    pub fn phase(&self) -> &ActivityPhaseSnapshot {
        &self.phase
    }

    pub const fn completed_attempts(&self) -> u32 {
        self.completed_attempts
    }

    pub const fn next_claim_generation(&self) -> u64 {
        self.next_claim_generation
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum ActivityPhaseSnapshot {
    Pending,
    Claimed(ActivityClaimSnapshot),
    Dispatched(ActivityDispatchSnapshot),
    RetryScheduled {
        retry_at: u64,
        failure: ActivityFailure,
    },
    TerminalObserved {
        observed_at: u64,
    },
    Completed {
        completed_at: u64,
    },
    Failed {
        failed_at: u64,
        failure: ActivityFailure,
    },
    OutcomeUnknown {
        observed_at: u64,
    },
    Cancelled {
        cancelled_at: u64,
    },
}

#[derive(Clone, Eq, PartialEq)]
pub struct ActivityClaimSnapshot {
    activity_id: ActivityId,
    attempt: u32,
    generation: u64,
    claimed_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ActivityDispatchSnapshot {
    claim: ActivityClaimSnapshot,
    dispatched_at: u64,
}

impl fmt::Debug for ActivityPhaseSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::Claimed(claim) => formatter.debug_tuple("Claimed").field(claim).finish(),
            Self::Dispatched(dispatch) => {
                formatter.debug_tuple("Dispatched").field(dispatch).finish()
            }
            Self::RetryScheduled { retry_at, failure } => formatter
                .debug_struct("RetryScheduled")
                .field("retry_at", retry_at)
                .field("failure", failure)
                .finish(),
            Self::TerminalObserved { observed_at } => formatter
                .debug_struct("TerminalObserved")
                .field("observed_at", observed_at)
                .finish(),
            Self::Completed { completed_at } => formatter
                .debug_struct("Completed")
                .field("completed_at", completed_at)
                .finish(),
            Self::Failed { failed_at, failure } => formatter
                .debug_struct("Failed")
                .field("failed_at", failed_at)
                .field("failure", failure)
                .finish(),
            Self::OutcomeUnknown { observed_at } => formatter
                .debug_struct("OutcomeUnknown")
                .field("observed_at", observed_at)
                .finish(),
            Self::Cancelled { cancelled_at } => formatter
                .debug_struct("Cancelled")
                .field("cancelled_at", cancelled_at)
                .finish(),
        }
    }
}

impl fmt::Debug for ActivityClaimSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityClaimSnapshot")
            .field("activity_id", &"<redacted>")
            .field("attempt", &self.attempt)
            .field("generation", &self.generation)
            .field("claimed_at", &self.claimed_at)
            .finish()
    }
}

impl fmt::Debug for ActivityDispatchSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityDispatchSnapshot")
            .field("claim", &self.claim)
            .field("dispatched_at", &self.dispatched_at)
            .finish()
    }
}

impl ActivityClaimSnapshot {
    pub fn new(activity_id: ActivityId, attempt: u32, generation: u64, claimed_at: u64) -> Self {
        Self {
            activity_id,
            attempt,
            generation,
            claimed_at,
        }
    }

    pub fn activity_id(&self) -> &ActivityId {
        &self.activity_id
    }

    pub const fn attempt(&self) -> u32 {
        self.attempt
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn claimed_at(&self) -> u64 {
        self.claimed_at
    }
}

impl ActivityDispatchSnapshot {
    pub fn new(claim: ActivityClaimSnapshot, dispatched_at: u64) -> Self {
        Self {
            claim,
            dispatched_at,
        }
    }

    pub fn claim(&self) -> &ActivityClaimSnapshot {
        &self.claim
    }

    pub const fn dispatched_at(&self) -> u64 {
        self.dispatched_at
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum RestoreActivityError {
    InvalidRequest(ActivityRequestError),
    InvalidCompletedAttempts,
    InvalidNextClaimGeneration,
    PendingAttemptMismatch,
    ClaimedAttemptMismatch,
    ClaimedGenerationMismatch,
    DispatchedAttemptMismatch,
    DispatchedGenerationMismatch,
    TerminalAttemptMismatch,
}

impl fmt::Debug for RestoreActivityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(error) => formatter
                .debug_tuple("InvalidRequest")
                .field(error)
                .finish(),
            Self::InvalidCompletedAttempts => formatter.write_str("InvalidCompletedAttempts"),
            Self::InvalidNextClaimGeneration => formatter.write_str("InvalidNextClaimGeneration"),
            Self::PendingAttemptMismatch => formatter.write_str("PendingAttemptMismatch"),
            Self::ClaimedAttemptMismatch => formatter.write_str("ClaimedAttemptMismatch"),
            Self::ClaimedGenerationMismatch => formatter.write_str("ClaimedGenerationMismatch"),
            Self::DispatchedAttemptMismatch => formatter.write_str("DispatchedAttemptMismatch"),
            Self::DispatchedGenerationMismatch => {
                formatter.write_str("DispatchedGenerationMismatch")
            }
            Self::TerminalAttemptMismatch => formatter.write_str("TerminalAttemptMismatch"),
        }
    }
}

impl Activity {
    pub fn snapshot(&self) -> ActivitySnapshot {
        ActivitySnapshot::new(
            self.facts.clone(),
            ActivityPhaseSnapshot::from_phase(&self.phase),
            self.completed_attempts,
            self.next_claim_generation,
        )
    }

    pub fn restore(snapshot: ActivitySnapshot) -> Result<Self, RestoreActivityError> {
        validate_snapshot(&snapshot)?;
        Ok(Self {
            facts: snapshot.facts,
            phase: snapshot.phase.into_phase(),
            completed_attempts: snapshot.completed_attempts,
            next_claim_generation: snapshot.next_claim_generation,
        })
    }
}

impl ActivityPhaseSnapshot {
    fn from_phase(phase: &ActivityPhase) -> Self {
        match phase {
            ActivityPhase::Pending => Self::Pending,
            ActivityPhase::Claimed(claim) => {
                Self::Claimed(ActivityClaimSnapshot::from_claim(claim))
            }
            ActivityPhase::Dispatched(dispatch) => {
                Self::Dispatched(ActivityDispatchSnapshot::from_dispatch(dispatch))
            }
            ActivityPhase::RetryScheduled { retry_at, failure } => Self::RetryScheduled {
                retry_at: *retry_at,
                failure: *failure,
            },
            ActivityPhase::TerminalObserved { observed_at } => Self::TerminalObserved {
                observed_at: *observed_at,
            },
            ActivityPhase::Completed { completed_at } => Self::Completed {
                completed_at: *completed_at,
            },
            ActivityPhase::Failed { failed_at, failure } => Self::Failed {
                failed_at: *failed_at,
                failure: *failure,
            },
            ActivityPhase::OutcomeUnknown { observed_at } => Self::OutcomeUnknown {
                observed_at: *observed_at,
            },
            ActivityPhase::Cancelled { cancelled_at } => Self::Cancelled {
                cancelled_at: *cancelled_at,
            },
        }
    }

    fn into_phase(self) -> ActivityPhase {
        match self {
            Self::Pending => ActivityPhase::Pending,
            Self::Claimed(claim) => ActivityPhase::Claimed(claim.into_claim()),
            Self::Dispatched(dispatch) => ActivityPhase::Dispatched(dispatch.into_dispatch()),
            Self::RetryScheduled { retry_at, failure } => {
                ActivityPhase::RetryScheduled { retry_at, failure }
            }
            Self::TerminalObserved { observed_at } => {
                ActivityPhase::TerminalObserved { observed_at }
            }
            Self::Completed { completed_at } => ActivityPhase::Completed { completed_at },
            Self::Failed { failed_at, failure } => ActivityPhase::Failed { failed_at, failure },
            Self::OutcomeUnknown { observed_at } => ActivityPhase::OutcomeUnknown { observed_at },
            Self::Cancelled { cancelled_at } => ActivityPhase::Cancelled { cancelled_at },
        }
    }
}

impl ActivityClaimSnapshot {
    fn from_claim(claim: &ActivityClaim) -> Self {
        Self::new(
            claim.activity_id().clone(),
            claim.attempt(),
            claim.generation(),
            claim.claimed_at(),
        )
    }

    fn into_claim(self) -> ActivityClaim {
        ActivityClaim::restore(
            self.activity_id,
            self.attempt,
            self.generation,
            self.claimed_at,
        )
    }
}

impl ActivityDispatchSnapshot {
    fn from_dispatch(dispatch: &ActivityDispatch) -> Self {
        Self::new(
            ActivityClaimSnapshot::from_claim(dispatch.claim()),
            dispatch.dispatched_at(),
        )
    }

    fn into_dispatch(self) -> ActivityDispatch {
        ActivityDispatch::restore(self.claim.into_claim(), self.dispatched_at)
    }
}

fn validate_snapshot(snapshot: &ActivitySnapshot) -> Result<(), RestoreActivityError> {
    snapshot
        .facts
        .validate()
        .map_err(RestoreActivityError::InvalidRequest)?;

    if snapshot.next_claim_generation == 0 || snapshot.next_claim_generation == u64::MAX {
        return Err(RestoreActivityError::InvalidNextClaimGeneration);
    }
    if snapshot.completed_attempts > snapshot.facts.max_attempts {
        return Err(RestoreActivityError::InvalidCompletedAttempts);
    }

    let claim_generation = u64::from(snapshot.completed_attempts) + 1;
    let next_generation_after_claim = claim_generation + 1;

    match &snapshot.phase {
        ActivityPhaseSnapshot::Pending => {
            if snapshot.completed_attempts != 0 || snapshot.next_claim_generation != 1 {
                return Err(RestoreActivityError::PendingAttemptMismatch);
            }
        }
        ActivityPhaseSnapshot::Claimed(claim) => {
            validate_active_claim(snapshot, claim).map_err(|error| match error {
                ActiveClaimError::Attempt => RestoreActivityError::ClaimedAttemptMismatch,
                ActiveClaimError::Generation => RestoreActivityError::ClaimedGenerationMismatch,
            })?;
        }
        ActivityPhaseSnapshot::Dispatched(dispatch) => {
            validate_active_claim(snapshot, dispatch.claim()).map_err(|error| match error {
                ActiveClaimError::Attempt => RestoreActivityError::DispatchedAttemptMismatch,
                ActiveClaimError::Generation => RestoreActivityError::DispatchedGenerationMismatch,
            })?;
        }
        ActivityPhaseSnapshot::RetryScheduled { .. } => {
            if snapshot.completed_attempts == 0
                || snapshot.completed_attempts >= snapshot.facts.max_attempts
                || snapshot.next_claim_generation != claim_generation
            {
                return Err(RestoreActivityError::TerminalAttemptMismatch);
            }
        }
        ActivityPhaseSnapshot::TerminalObserved { .. }
        | ActivityPhaseSnapshot::Completed { .. }
        | ActivityPhaseSnapshot::Failed { .. }
        | ActivityPhaseSnapshot::OutcomeUnknown { .. } => {
            if snapshot.completed_attempts == 0
                || snapshot.next_claim_generation != claim_generation
            {
                return Err(RestoreActivityError::TerminalAttemptMismatch);
            }
        }
        ActivityPhaseSnapshot::Cancelled { .. } => {
            if snapshot.next_claim_generation != claim_generation
                && snapshot.next_claim_generation != next_generation_after_claim
            {
                return Err(RestoreActivityError::TerminalAttemptMismatch);
            }
        }
    }
    Ok(())
}

enum ActiveClaimError {
    Attempt,
    Generation,
}

fn validate_active_claim(
    snapshot: &ActivitySnapshot,
    claim: &ActivityClaimSnapshot,
) -> Result<(), ActiveClaimError> {
    if snapshot.completed_attempts >= snapshot.facts.max_attempts
        || claim.activity_id() != &snapshot.facts.activity_id
        || claim.attempt() != snapshot.completed_attempts + 1
    {
        return Err(ActiveClaimError::Attempt);
    }
    let claim_generation = u64::from(snapshot.completed_attempts) + 1;
    let next_generation_after_claim = claim_generation + 1;
    if claim.generation() != claim_generation
        || snapshot.next_claim_generation != next_generation_after_claim
    {
        return Err(ActiveClaimError::Generation);
    }
    Ok(())
}
