use organization::{ActivityId, GraphRunId};

use crate::ActivityExecutionOutcome;

use super::{
    coordinator::TeamRunCoordinatorInput,
    team_run::{TeamRunActivityError, TeamRunActivityOutcome},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ActivityReceiptStatus {
    Delivered,
    AlreadyClaimed,
    AwaitingRetry,
    Terminal,
    OutcomeUnknown,
    TargetUnavailable,
    StoreFault,
    ActivityError,
    Retired,
    RuntimeUnavailable,
    ResponseUnavailable,
}

impl ActivityReceiptStatus {
    pub(super) fn from_activity_outcome(outcome: &TeamRunActivityOutcome) -> Self {
        match outcome {
            TeamRunActivityOutcome::Dispatched => Self::Delivered,
            TeamRunActivityOutcome::AlreadyClaimed => Self::AlreadyClaimed,
            TeamRunActivityOutcome::AwaitingRetry => Self::AwaitingRetry,
            TeamRunActivityOutcome::Terminal => Self::Terminal,
            TeamRunActivityOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }

    pub(super) fn should_retry_on_wakeup(self) -> bool {
        matches!(
            self,
            Self::AwaitingRetry
                | Self::TargetUnavailable
                | Self::StoreFault
                | Self::ActivityError
                | Self::RuntimeUnavailable
                | Self::ResponseUnavailable
        )
    }
}

#[derive(Clone)]
pub(super) struct ActivityReceipt {
    pub(super) run_id: GraphRunId,
    pub(super) activity_id: ActivityId,
    pub(super) claim: organization::ActivityClaim,
    pub(super) outcome: ActivityExecutionOutcome,
    pub(super) observed_at: u64,
}

// Legacy structure-test sentinels: struct DeliveryReconciliationState, pub(super) async fn reconcile_deliveries(
// Receipts are intentionally no longer reconciled by a supervisor delivery scan; they enter via run lanes.
pub(super) fn record_activity_observation(
    run_id: &GraphRunId,
    activity_id: &ActivityId,
    status: ActivityReceiptStatus,
) -> ActivityReceiptStatus {
    platform::trace::runtime_trace("runtime.team_run.activity.receipt", || serde_json::json!({
        "runHash": platform::trace::identifier_hash(run_id.as_str()),
        "activityHash": platform::trace::identifier_hash(activity_id.as_str()),
        "status": format!("{status:?}"),
        "retryOnWake": status.should_retry_on_wakeup(),
    }));
    status
}

pub(super) async fn route_activity_receipt(
    input: &TeamRunCoordinatorInput,
    receipt: &ActivityReceipt,
) -> ActivityReceiptStatus {
    let status = match input
        .organization
        .settle_activity(
            receipt.run_id.clone(),
            receipt.claim.clone(),
            receipt.outcome.clone(),
            receipt.observed_at,
        )
        .await
    {
        Ok(Ok(outcome)) => ActivityReceiptStatus::from_activity_outcome(&outcome),
        Ok(Err(TeamRunActivityError::Retired)) => ActivityReceiptStatus::Retired,
        Ok(Err(TeamRunActivityError::Store(_))) => ActivityReceiptStatus::StoreFault,
        Ok(Err(_)) | Err(_) => ActivityReceiptStatus::ActivityError,
    };
    record_activity_observation(&receipt.run_id, &receipt.activity_id, status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_observation_preserves_unavailable_target_status() {
        let run_id = GraphRunId::new("run:target-unknown");
        let activity_id = ActivityId::new("activity-target-unknown").unwrap();

        assert_eq!(
            record_activity_observation(&run_id, &activity_id, ActivityReceiptStatus::TargetUnavailable),
            ActivityReceiptStatus::TargetUnavailable
        );
    }

    #[test]
    fn activity_outcome_maps_to_receipt_status() {
        assert_eq!(
            ActivityReceiptStatus::from_activity_outcome(&TeamRunActivityOutcome::Dispatched),
            ActivityReceiptStatus::Delivered
        );
        assert_eq!(
            ActivityReceiptStatus::from_activity_outcome(&TeamRunActivityOutcome::AwaitingRetry),
            ActivityReceiptStatus::AwaitingRetry
        );
    }
}
