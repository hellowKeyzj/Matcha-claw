use super::{Activity, ActivityClaim, ActivityFailure, ActivityPhase};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityClaimOutcome {
    Claimed(ActivityClaim),
    AlreadyClaimed(ActivityClaim),
    Terminal(ActivityPhase),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityDispatchOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivitySettlement {
    TerminalObserved {
        observed_at: u64,
    },
    Completed {
        completed_at: u64,
    },
    RetryScheduled {
        retry_at: u64,
        observed_at: u64,
        failure: ActivityFailure,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivitySettlementOutcome {
    TerminalObserved,
    Completed,
    RetryScheduled,
    Failed,
    OutcomeUnknown,
    Cancelled,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityTransitionError {
    StaleClaim,
    NotClaimed { phase: ActivityPhase },
    NotDispatched { phase: ActivityPhase },
    CannotSettle { phase: ActivityPhase },
}

pub fn claim_activity(activity: &mut Activity, claimed_at: u64) -> ActivityClaimOutcome {
    match activity.phase().clone() {
        ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. } => {
            ActivityClaimOutcome::Claimed(activity.start_claim(claimed_at))
        }
        ActivityPhase::Claimed(_) | ActivityPhase::Dispatched(_) => {
            ActivityClaimOutcome::AlreadyClaimed(claim_from_active(activity))
        }
        phase => ActivityClaimOutcome::Terminal(phase),
    }
}

pub fn dispatch_activity(
    activity: &mut Activity,
    claim: &ActivityClaim,
    dispatched_at: u64,
) -> Result<ActivityDispatchOutcome, ActivityTransitionError> {
    let active_claim =
        activity
            .active_claim()
            .ok_or_else(|| ActivityTransitionError::NotClaimed {
                phase: activity.phase().clone(),
            })?;
    if active_claim != claim {
        return Err(ActivityTransitionError::StaleClaim);
    }
    if matches!(activity.phase(), ActivityPhase::Dispatched(_)) {
        return Ok(ActivityDispatchOutcome::Replayed);
    }
    activity.mark_dispatched(claim.clone(), dispatched_at);
    Ok(ActivityDispatchOutcome::Recorded)
}

pub fn settle_activity(
    activity: &mut Activity,
    claim: &ActivityClaim,
    settlement: ActivitySettlement,
) -> Result<ActivitySettlementOutcome, ActivityTransitionError> {
    let active_claim =
        activity
            .active_claim()
            .ok_or_else(|| ActivityTransitionError::CannotSettle {
                phase: activity.phase().clone(),
            })?;
    if active_claim != claim {
        return Err(ActivityTransitionError::StaleClaim);
    }

    match (activity.phase(), settlement) {
        (ActivityPhase::Dispatched(_), ActivitySettlement::TerminalObserved { observed_at }) => {
            activity.mark_terminal_observed(observed_at);
            Ok(ActivitySettlementOutcome::TerminalObserved)
        }
        (ActivityPhase::Dispatched(_), ActivitySettlement::Completed { completed_at }) => {
            activity.mark_completed(completed_at);
            Ok(ActivitySettlementOutcome::Completed)
        }
        (
            ActivityPhase::Dispatched(_),
            ActivitySettlement::RetryScheduled {
                retry_at,
                observed_at,
                failure,
            },
        ) => {
            if activity.schedule_retry(retry_at, observed_at, failure) {
                Ok(ActivitySettlementOutcome::RetryScheduled)
            } else {
                Ok(ActivitySettlementOutcome::Failed)
            }
        }
        (ActivityPhase::Dispatched(_), ActivitySettlement::Failed { failed_at, failure }) => {
            activity.mark_failed(failed_at, failure);
            Ok(ActivitySettlementOutcome::Failed)
        }
        (ActivityPhase::Dispatched(_), ActivitySettlement::OutcomeUnknown { observed_at }) => {
            activity.mark_outcome_unknown(observed_at);
            Ok(ActivitySettlementOutcome::OutcomeUnknown)
        }
        (ActivityPhase::Dispatched(_), ActivitySettlement::Cancelled { cancelled_at }) => {
            activity.cancel(cancelled_at);
            Ok(ActivitySettlementOutcome::Cancelled)
        }
        (_, _) => Err(ActivityTransitionError::NotDispatched {
            phase: activity.phase().clone(),
        }),
    }
}

pub(crate) fn resolve_terminal_observed_activity(
    activity: &mut Activity,
    settlement: ActivitySettlement,
) -> Result<ActivitySettlementOutcome, ActivityTransitionError> {
    match (activity.phase(), settlement) {
        (
            ActivityPhase::TerminalObserved { .. },
            ActivitySettlement::Completed { completed_at },
        ) => {
            activity.mark_completed(completed_at);
            Ok(ActivitySettlementOutcome::Completed)
        }
        (
            ActivityPhase::TerminalObserved { .. },
            ActivitySettlement::Failed { failed_at, failure },
        ) => {
            activity.mark_failed(failed_at, failure);
            Ok(ActivitySettlementOutcome::Failed)
        }
        (_, _) => Err(ActivityTransitionError::CannotSettle {
            phase: activity.phase().clone(),
        }),
    }
}

pub fn recover_interrupted_activity(
    activity: &mut Activity,
    observed_at: u64,
) -> ActivitySettlementOutcome {
    if activity.active_claim().is_some() {
        activity.mark_outcome_unknown(observed_at);
        return ActivitySettlementOutcome::OutcomeUnknown;
    }
    ActivitySettlementOutcome::Replayed
}

fn claim_from_active(activity: &Activity) -> ActivityClaim {
    activity
        .active_claim()
        .expect("active phase always exposes an activity claim")
        .clone()
}
