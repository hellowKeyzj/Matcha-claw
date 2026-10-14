use std::fmt;

use crate::run::graph::{ExecutionFence, GraphRunId, NodeExecutionId, NodeId};

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ActivityId(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityIdError {
    Blank,
}

impl fmt::Debug for ActivityId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActivityId(<redacted>)")
    }
}

impl ActivityId {
    pub fn new(value: impl Into<String>) -> Result<Self, ActivityIdError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ActivityIdError::Blank);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ActivityTarget(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityTargetError {
    Blank,
}

impl fmt::Debug for ActivityTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActivityTarget(<redacted>)")
    }
}

impl ActivityTarget {
    pub fn new(value: impl Into<String>) -> Result<Self, ActivityTargetError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ActivityTargetError::Blank);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum ActivityKind {
    AgentTask {
        task_id: String,
        role_id: String,
        session_ref: String,
        prompt: String,
    },
    Control {
        action: String,
    },
}

impl fmt::Debug for ActivityKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AgentTask { .. } => formatter
                .debug_struct("AgentTask")
                .field("task_id", &"<redacted>")
                .field("role_id", &"<redacted>")
                .field("prompt", &"<redacted>")
                .finish(),
            Self::Control { .. } => formatter
                .debug_struct("Control")
                .field("action", &"<redacted>")
                .finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ActivityRequest {
    pub activity_id: ActivityId,
    pub run_id: GraphRunId,
    pub node_id: NodeId,
    pub node_execution_id: NodeExecutionId,
    pub fence: ExecutionFence,
    pub activity_kind: ActivityKind,
    pub target: ActivityTarget,
    pub idempotency_key: String,
    pub created_at: u64,
    pub max_attempts: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityRequestError {
    BlankRunId,
    BlankNodeId,
    BlankNodeExecutionId,
    BlankFence,
    FenceMismatch,
    BlankTaskId,
    BlankRoleId,
    InvalidSessionRef,
    BlankPrompt,
    BlankControlAction,
    BlankIdempotencyKey,
    ZeroMaxAttempts,
}

impl fmt::Debug for ActivityRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityRequest")
            .field("activity_id", &"<redacted>")
            .field("run_id", &"<redacted>")
            .field("node_id", &"<redacted>")
            .field("node_execution_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("activity_kind", &self.activity_kind)
            .field("target", &"<redacted>")
            .field("idempotency_key", &"<redacted>")
            .field("created_at", &self.created_at)
            .field("max_attempts", &self.max_attempts)
            .finish()
    }
}

impl ActivityRequest {
    pub fn validate(&self) -> Result<(), ActivityRequestError> {
        if self.run_id.as_str().trim().is_empty() {
            return Err(ActivityRequestError::BlankRunId);
        }
        if self.node_id.as_str().trim().is_empty() {
            return Err(ActivityRequestError::BlankNodeId);
        }
        if self.node_execution_id.as_str().trim().is_empty() {
            return Err(ActivityRequestError::BlankNodeExecutionId);
        }
        if self.fence.attempt_id().as_str().trim().is_empty()
            || self.fence.node_execution_id().as_str().trim().is_empty()
        {
            return Err(ActivityRequestError::BlankFence);
        }
        if self.fence.node_execution_id() != &self.node_execution_id {
            return Err(ActivityRequestError::FenceMismatch);
        }
        validate_kind(&self.activity_kind)?;
        if self.idempotency_key.trim().is_empty() {
            return Err(ActivityRequestError::BlankIdempotencyKey);
        }
        if self.max_attempts == 0 {
            return Err(ActivityRequestError::ZeroMaxAttempts);
        }
        Ok(())
    }
}

fn validate_kind(kind: &ActivityKind) -> Result<(), ActivityRequestError> {
    match kind {
        ActivityKind::AgentTask {
            task_id,
            role_id,
            session_ref,
            prompt,
        } => {
            if task_id.trim().is_empty() {
                return Err(ActivityRequestError::BlankTaskId);
            }
            if role_id.trim().is_empty() {
                return Err(ActivityRequestError::BlankRoleId);
            }
            if crate::RoleSessionRef::try_new(session_ref.clone()).is_err() {
                return Err(ActivityRequestError::InvalidSessionRef);
            }
            if prompt.trim().is_empty() {
                return Err(ActivityRequestError::BlankPrompt);
            }
        }
        ActivityKind::Control { action } => {
            if action.trim().is_empty() {
                return Err(ActivityRequestError::BlankControlAction);
            }
        }
    }
    Ok(())
}

#[derive(Clone, Eq, PartialEq)]
pub struct Activity {
    pub(super) facts: ActivityRequest,
    pub(super) phase: ActivityPhase,
    pub(super) completed_attempts: u32,
    pub(super) next_claim_generation: u64,
    pub(super) settlement_proof: Option<SettlementProof>,
    pub(super) native_terminal_claim: Option<ActivityClaim>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SettlementProof {
    pub(crate) claim: ActivityClaim,
    pub(crate) receipt: crate::DeliveryReceipt,
    pub(crate) settlement: Option<super::ActivitySettlement>,
    pub(crate) delivery_outcome: crate::DeliveryResolution,
    pub(crate) activity_outcome: Option<super::ActivitySettlementOutcome>,
}

impl SettlementProof {
    pub(crate) fn valid_for(&self, activity: &Activity) -> bool {
        let claim = &self.claim;
        if claim.activity_id() != &activity.facts.activity_id
            || claim.attempt() == 0
            || claim.attempt() > activity.facts.max_attempts
            || claim.generation() != u64::from(claim.attempt())
            || claim.generation().checked_add(1) != Some(activity.next_claim_generation)
            || activity.native_terminal_claim.as_ref().is_some_and(|stored| stored != claim)
        {
            return false;
        }
        let unsettled = (self.settlement.is_none()
            && (activity.active_claim() == Some(claim)
                || matches!(activity.phase(), ActivityPhase::Cancelled { .. })))
            || (matches!(self.receipt, crate::DeliveryReceipt::OutcomeUnknown { .. })
                && activity.native_terminal_claim.as_ref() == Some(claim)
                && matches!(activity.phase(), ActivityPhase::Cancelled { .. }));
        if activity.active_claim().is_some() && activity.active_claim() != Some(claim) {
            return false;
        }
        if activity.completed_attempts != claim.attempt()
            && !(unsettled && activity.completed_attempts == claim.attempt() - 1)
        {
            return false;
        }
        use crate::{DeliveryReceipt as R, DeliveryResolution as D};
        let delivery_outcome = match &self.receipt {
            R::Accepted { accepted_at, .. } if *accepted_at == claim.claimed_at() => D::Delivered,
            R::Rejected { failure, observed_at } if *observed_at == claim.claimed_at() => {
                if failure.is_retryable() && claim.attempt() < activity.facts.max_attempts {
                    D::RetryScheduled {
                        retry_at: crate::run::delivery::delivery_retry_at(*observed_at),
                    }
                } else {
                    D::Failed
                }
            }
            R::OutcomeUnknown { observed_at } if *observed_at == claim.claimed_at() => {
                D::OutcomeUnknown
            }
            _ => return false,
        };
        use super::ActivitySettlement as S;
        let matching_settlement = match (&self.receipt, &self.settlement) {
            (R::Accepted { .. }, None) => true,
            (
                R::Rejected {
                    failure: crate::DeliveryFailure::Unavailable,
                    observed_at,
                },
                Some(S::RetryScheduled {
                    retry_at,
                    observed_at: settled_at,
                    failure: ActivityFailure::Unavailable,
                }),
            )
            | (
                R::Rejected {
                    failure: crate::DeliveryFailure::TimedOut,
                    observed_at,
                },
                Some(S::RetryScheduled {
                    retry_at,
                    observed_at: settled_at,
                    failure: ActivityFailure::TimedOut,
                }),
            ) => settled_at == observed_at
                && *retry_at == crate::run::delivery::delivery_retry_at(*observed_at),
            (
                R::Rejected {
                    failure: crate::DeliveryFailure::PolicyRejected,
                    observed_at,
                },
                Some(S::Failed {
                    failed_at,
                    failure: ActivityFailure::Rejected,
                }),
            ) => failed_at == observed_at,
            (
                R::OutcomeUnknown { observed_at },
                Some(S::OutcomeUnknown { observed_at: settled_at }),
            ) => settled_at == observed_at,
            _ => false,
        };
        if !matching_settlement || self.delivery_outcome != delivery_outcome {
            return false;
        }
        let mut settled = Activity {
            facts: activity.facts.clone(),
            phase: ActivityPhase::Dispatched(ActivityDispatch {
                claim: claim.clone(),
                dispatched_at: claim.claimed_at(),
            }),
            completed_attempts: claim.attempt() - 1,
            next_claim_generation: activity.next_claim_generation,
            settlement_proof: None,
            native_terminal_claim: None,
        };
        let outcome = self
            .settlement
            .clone()
            .map(|settlement| super::settle_activity(&mut settled, claim, settlement))
            .transpose();
        let Ok(outcome) = outcome else {
            return false;
        };
        if self.activity_outcome != outcome {
            return false;
        }
        match &self.receipt {
            R::Accepted { .. } => true,
            R::OutcomeUnknown { observed_at } => match activity.phase() {
                ActivityPhase::OutcomeUnknown { observed_at: stored } => observed_at == stored,
                ActivityPhase::TerminalObserved { .. } | ActivityPhase::Completed { .. }
                    | ActivityPhase::Failed { .. } | ActivityPhase::Cancelled { .. } => true,
                _ => false,
            },
            R::Rejected { .. } => activity.phase == settled.phase
                || (matches!(settled.phase, ActivityPhase::RetryScheduled { .. })
                    && matches!(activity.phase, ActivityPhase::Cancelled { .. })),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum ActivityPhase {
    Pending,
    Claimed(ActivityClaim),
    Dispatched(ActivityDispatch),
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
pub struct ActivityClaim {
    activity_id: ActivityId,
    attempt: u32,
    generation: u64,
    claimed_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ActivityDispatch {
    claim: ActivityClaim,
    dispatched_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityFailure {
    Rejected,
    Unavailable,
    TimedOut,
}

impl ActivityFailure {
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::Unavailable | Self::TimedOut)
    }
}

impl fmt::Debug for ActivityClaim {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityClaim")
            .field("activity_id", &"<redacted>")
            .field("attempt", &self.attempt)
            .field("generation", &self.generation)
            .field("claimed_at", &self.claimed_at)
            .finish()
    }
}

impl fmt::Debug for ActivityDispatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityDispatch")
            .field("activity_id", &"<redacted>")
            .field("attempt", &self.claim.attempt)
            .field("generation", &self.claim.generation)
            .field("claimed_at", &self.claim.claimed_at)
            .field("dispatched_at", &self.dispatched_at)
            .finish()
    }
}

impl fmt::Debug for ActivityPhase {
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

impl fmt::Debug for Activity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Activity")
            .field("facts", &self.facts)
            .field("phase", &self.phase)
            .field("completed_attempts", &self.completed_attempts)
            .field("next_claim_generation", &self.next_claim_generation)
            .finish()
    }
}

impl Activity {
    pub fn request(facts: ActivityRequest) -> Result<Self, ActivityRequestError> {
        facts.validate()?;
        Ok(Self {
            facts,
            phase: ActivityPhase::Pending,
            completed_attempts: 0,
            next_claim_generation: 1,
            settlement_proof: None,
            native_terminal_claim: None,
        })
    }

    pub fn facts(&self) -> &ActivityRequest {
        &self.facts
    }

    pub(crate) fn settlement_proof(&self) -> Option<&SettlementProof> {
        self.settlement_proof.as_ref()
    }

    pub(crate) fn record_settlement_proof(&mut self, proof: SettlementProof) -> bool {
        if !proof.valid_for(self) || self.settlement_proof.is_some() {
            return false;
        }
        self.settlement_proof = Some(proof);
        true
    }

    pub(crate) fn native_terminal_claim(&self) -> Option<&ActivityClaim> {
        self.native_terminal_claim.as_ref()
    }

    pub(crate) fn retain_native_terminal_claim(&mut self, claim: &ActivityClaim) -> bool {
        if self.active_claim() != Some(claim)
            || !matches!(self.phase(), ActivityPhase::Dispatched(_))
            || self.native_terminal_claim.as_ref().is_some_and(|stored| stored != claim)
        {
            return false;
        }
        self.native_terminal_claim = Some(claim.clone());
        true
    }

    pub(crate) fn valid_native_terminal_claim(&self) -> bool {
        let Some(claim) = self.native_terminal_claim.as_ref() else {
            return true;
        };
        claim.activity_id() == &self.facts.activity_id
            && claim.attempt() > 0
            && claim.attempt() <= self.facts.max_attempts
            && claim.generation() == u64::from(claim.attempt())
            && claim.generation().checked_add(1) == Some(self.next_claim_generation)
            && self.settlement_proof.as_ref().is_none_or(|proof| &proof.claim == claim)
            && match self.phase() {
                ActivityPhase::TerminalObserved { .. } | ActivityPhase::Completed { .. }
                    | ActivityPhase::Failed { .. } => self.completed_attempts == claim.attempt(),
                ActivityPhase::Cancelled { .. } => {
                    self.completed_attempts == claim.attempt()
                        || self.completed_attempts == claim.attempt() - 1
                }
                _ => false,
            }
    }

    pub fn phase(&self) -> &ActivityPhase {
        &self.phase
    }

    pub fn completed_attempts(&self) -> u32 {
        self.completed_attempts
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            &self.phase,
            ActivityPhase::TerminalObserved { .. }
                | ActivityPhase::Completed { .. }
                | ActivityPhase::Failed { .. }
                | ActivityPhase::OutcomeUnknown { .. }
                | ActivityPhase::Cancelled { .. }
        )
    }

    pub fn cancel(&mut self, cancelled_at: u64) {
        if !self.is_terminal() {
            self.phase = ActivityPhase::Cancelled { cancelled_at };
        }
    }

    pub(crate) fn start_claim(&mut self, claimed_at: u64) -> ActivityClaim {
        let claim = ActivityClaim {
            activity_id: self.facts.activity_id.clone(),
            attempt: self.completed_attempts + 1,
            generation: self.next_claim_generation,
            claimed_at,
        };
        self.next_claim_generation += 1;
        self.settlement_proof = None;
        self.native_terminal_claim = None;
        self.phase = ActivityPhase::Claimed(claim.clone());
        claim
    }

    pub(crate) fn mark_dispatched(
        &mut self,
        claim: ActivityClaim,
        dispatched_at: u64,
    ) -> ActivityDispatch {
        let dispatch = ActivityDispatch {
            claim,
            dispatched_at,
        };
        self.phase = ActivityPhase::Dispatched(dispatch.clone());
        dispatch
    }

    pub(crate) fn schedule_retry(
        &mut self,
        retry_at: u64,
        observed_at: u64,
        failure: ActivityFailure,
    ) -> bool {
        self.close_active_attempt();
        if self.completed_attempts < self.facts.max_attempts {
            self.phase = ActivityPhase::RetryScheduled { retry_at, failure };
            true
        } else {
            self.phase = ActivityPhase::Failed {
                failed_at: observed_at,
                failure,
            };
            false
        }
    }

    pub(crate) fn confirm_unknown_native_terminal(
        &mut self,
        terminal: crate::NativeTerminalStatus,
        observed_at: u64,
    ) {
        if matches!(self.phase, ActivityPhase::OutcomeUnknown { .. }) {
            self.phase = if terminal == crate::NativeTerminalStatus::Cancelled {
                ActivityPhase::Cancelled {
                    cancelled_at: observed_at,
                }
            } else {
                ActivityPhase::TerminalObserved { observed_at }
            };
        }
    }

    pub(crate) fn mark_terminal_observed(&mut self, observed_at: u64) {
        self.close_active_attempt();
        self.phase = ActivityPhase::TerminalObserved { observed_at };
    }

    pub(crate) fn mark_completed(&mut self, completed_at: u64) {
        self.close_active_attempt();
        self.phase = ActivityPhase::Completed { completed_at };
    }

    pub(crate) fn mark_failed(&mut self, failed_at: u64, failure: ActivityFailure) {
        self.close_active_attempt();
        self.phase = ActivityPhase::Failed { failed_at, failure };
    }

    pub(crate) fn mark_outcome_unknown(&mut self, observed_at: u64) {
        self.close_active_attempt();
        self.phase = ActivityPhase::OutcomeUnknown { observed_at };
    }

    pub(crate) fn active_claim(&self) -> Option<&ActivityClaim> {
        match &self.phase {
            ActivityPhase::Claimed(claim) => Some(claim),
            ActivityPhase::Dispatched(dispatch) => Some(dispatch.claim()),
            _ => None,
        }
    }

    fn close_active_attempt(&mut self) {
        if self.active_claim().is_some() {
            self.completed_attempts += 1;
        }
    }
}

impl ActivityClaim {
    pub(crate) fn restore(
        activity_id: ActivityId,
        attempt: u32,
        generation: u64,
        claimed_at: u64,
    ) -> Self {
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

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn claimed_at(&self) -> u64 {
        self.claimed_at
    }
}

impl ActivityDispatch {
    pub(super) fn restore(claim: ActivityClaim, dispatched_at: u64) -> Self {
        Self {
            claim,
            dispatched_at,
        }
    }

    pub fn claim(&self) -> &ActivityClaim {
        &self.claim
    }

    pub fn dispatched_at(&self) -> u64 {
        self.dispatched_at
    }
}
