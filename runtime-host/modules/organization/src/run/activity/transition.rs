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
            ActivityClaimOutcome::AlreadyClaimed(clone_active_activity_claim(activity))
        }
        phase => ActivityClaimOutcome::Terminal(phase),
    }
}

pub fn dispatch_activity(
    activity: &mut Activity,
    claim: &ActivityClaim,
    dispatched_at: u64,
) -> Result<ActivityDispatchOutcome, ActivityTransitionError> {
    let active_claim = active_claim_for_dispatch(activity)?;
    ensure_current_activity_claim(&active_claim, claim)?;

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
    let active_claim = active_claim_for_settlement(activity)?;
    ensure_current_activity_claim(&active_claim, claim)?;

    if !matches!(activity.phase(), ActivityPhase::Dispatched(_)) {
        return Err(ActivityTransitionError::NotDispatched {
            phase: activity.phase().clone(),
        });
    }

    Ok(record_dispatched_activity_settlement(activity, settlement))
}

pub(crate) fn resolve_terminal_observed_activity(
    activity: &mut Activity,
    settlement: ActivitySettlement,
) -> Result<ActivitySettlementOutcome, ActivityTransitionError> {
    if !matches!(activity.phase(), ActivityPhase::TerminalObserved { .. }) {
        return Err(ActivityTransitionError::CannotSettle {
            phase: activity.phase().clone(),
        });
    }

    match settlement {
        ActivitySettlement::Completed { completed_at } => {
            activity.mark_completed(completed_at);
            Ok(ActivitySettlementOutcome::Completed)
        }
        ActivitySettlement::Failed { failed_at, failure } => {
            activity.mark_failed(failed_at, failure);
            Ok(ActivitySettlementOutcome::Failed)
        }
        _ => Err(ActivityTransitionError::CannotSettle {
            phase: activity.phase().clone(),
        }),
    }
}

pub fn recover_interrupted_activity(
    activity: &mut Activity,
    observed_at: u64,
) -> ActivitySettlementOutcome {
    if activity.active_claim().is_some() {
        record_activity_outcome_unknown_without_retry(activity, observed_at);
        return ActivitySettlementOutcome::OutcomeUnknown;
    }
    ActivitySettlementOutcome::Replayed
}

fn active_claim_for_dispatch(
    activity: &Activity,
) -> Result<ActivityClaim, ActivityTransitionError> {
    activity
        .active_claim()
        .cloned()
        .ok_or_else(|| ActivityTransitionError::NotClaimed {
            phase: activity.phase().clone(),
        })
}

fn active_claim_for_settlement(
    activity: &Activity,
) -> Result<ActivityClaim, ActivityTransitionError> {
    activity
        .active_claim()
        .cloned()
        .ok_or_else(|| ActivityTransitionError::CannotSettle {
            phase: activity.phase().clone(),
        })
}

fn ensure_current_activity_claim(
    active_claim: &ActivityClaim,
    submitted_claim: &ActivityClaim,
) -> Result<(), ActivityTransitionError> {
    if active_claim == submitted_claim {
        Ok(())
    } else {
        Err(ActivityTransitionError::StaleClaim)
    }
}

fn record_dispatched_activity_settlement(
    activity: &mut Activity,
    settlement: ActivitySettlement,
) -> ActivitySettlementOutcome {
    match settlement {
        ActivitySettlement::TerminalObserved { observed_at } => {
            activity.mark_terminal_observed(observed_at);
            ActivitySettlementOutcome::TerminalObserved
        }
        ActivitySettlement::Completed { completed_at } => {
            activity.mark_completed(completed_at);
            ActivitySettlementOutcome::Completed
        }
        ActivitySettlement::RetryScheduled {
            retry_at,
            observed_at,
            failure,
        } => schedule_activity_retry_or_fail(activity, retry_at, observed_at, failure),
        ActivitySettlement::Failed { failed_at, failure } => {
            activity.mark_failed(failed_at, failure);
            ActivitySettlementOutcome::Failed
        }
        ActivitySettlement::OutcomeUnknown { observed_at } => {
            record_activity_outcome_unknown_without_retry(activity, observed_at);
            ActivitySettlementOutcome::OutcomeUnknown
        }
        ActivitySettlement::Cancelled { cancelled_at } => {
            activity.cancel(cancelled_at);
            ActivitySettlementOutcome::Cancelled
        }
    }
}

fn schedule_activity_retry_or_fail(
    activity: &mut Activity,
    retry_at: u64,
    observed_at: u64,
    failure: ActivityFailure,
) -> ActivitySettlementOutcome {
    if activity.schedule_retry(retry_at, observed_at, failure) {
        ActivitySettlementOutcome::RetryScheduled
    } else {
        ActivitySettlementOutcome::Failed
    }
}

fn record_activity_outcome_unknown_without_retry(activity: &mut Activity, observed_at: u64) {
    activity.mark_outcome_unknown(observed_at);
}

fn clone_active_activity_claim(activity: &Activity) -> ActivityClaim {
    activity
        .active_claim()
        .expect("active phase always exposes an activity claim")
        .clone()
}
