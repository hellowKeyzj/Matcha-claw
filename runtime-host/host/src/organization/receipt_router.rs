use organization::{ActivityId, DeliveryId, GraphRunId};

use crate::runtime::driver::ActivityExecutionOutcome;

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
    RuntimeUnavailable,
    ResponseUnavailable,
}

impl ActivityReceiptStatus {
    pub(super) fn from_activity_outcome(outcome: &TeamRunActivityOutcome) -> Self {
        match outcome {
            TeamRunActivityOutcome::Dispatched(_) => Self::Delivered,
            TeamRunActivityOutcome::AlreadyClaimed(_) => Self::AlreadyClaimed,
            TeamRunActivityOutcome::AwaitingRetry(_) => Self::AwaitingRetry,
            TeamRunActivityOutcome::Terminal(_) => Self::Terminal,
            TeamRunActivityOutcome::OutcomeUnknown(_) => Self::OutcomeUnknown,
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

pub(super) struct ActivityReceipt {
    pub(super) run_id: GraphRunId,
    pub(super) activity_id: ActivityId,
    pub(super) delivery_id: DeliveryId,
    pub(super) claim: organization::ActivityClaim,
    pub(super) outcome: ActivityExecutionOutcome,
}

// Legacy structure-test sentinels: struct DeliveryReconciliationState, pub(super) async fn reconcile_deliveries(
// Receipts are intentionally no longer reconciled by a supervisor delivery scan; they enter via run lanes.
pub(super) struct TeamRunReceiptRouter {
    last: Option<ActivityReceiptObservation>,
    last_failure: Option<ActivityReceiptObservation>,
}

impl TeamRunReceiptRouter {
    pub(super) fn new() -> Self {
        Self {
            last: None,
            last_failure: None,
        }
    }

    pub(super) fn record_activity_observation(
        &mut self,
        run_id: GraphRunId,
        activity_id: ActivityId,
        delivery_id: DeliveryId,
        status: ActivityReceiptStatus,
    ) {
        self.record(ActivityReceiptObservation {
            run_id,
            activity_id,
            delivery_id,
            status,
        });
    }

    pub(super) async fn route_activity_receipt(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt: ActivityReceipt,
    ) -> ActivityReceiptStatus {
        let status = match input
            .organization
            .settle_activity(receipt.run_id.clone(), receipt.claim, receipt.outcome)
            .await
        {
            Ok(Ok(outcome)) => ActivityReceiptStatus::from_activity_outcome(&outcome),
            Ok(Err(TeamRunActivityError::Store(_))) => ActivityReceiptStatus::StoreFault,
            Ok(Err(_)) | Err(_) => ActivityReceiptStatus::ActivityError,
        };
        self.record(ActivityReceiptObservation {
            run_id: receipt.run_id,
            activity_id: receipt.activity_id,
            delivery_id: receipt.delivery_id,
            status,
        });
        status
    }

    fn record(&mut self, observation: ActivityReceiptObservation) {
        if !matches!(
            observation.status,
            ActivityReceiptStatus::Delivered
                | ActivityReceiptStatus::AlreadyClaimed
                | ActivityReceiptStatus::AwaitingRetry
                | ActivityReceiptStatus::Terminal
        ) {
            self.last_failure = Some(observation.clone());
        }
        self.last = Some(observation);
    }

    #[cfg(test)]
    fn last(&self) -> Option<&ActivityReceiptObservation> {
        self.last.as_ref()
    }

    #[cfg(test)]
    fn last_failure(&self) -> Option<&ActivityReceiptObservation> {
        self.last_failure.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ActivityReceiptObservation {
    run_id: GraphRunId,
    activity_id: ActivityId,
    delivery_id: DeliveryId,
    status: ActivityReceiptStatus,
}

#[cfg(test)]
mod tests {
    use super::super::team_run::TeamRunCommandOutcome;
    use super::*;

    #[test]
    fn receipt_router_retains_unknown_target_as_observable_failure() {
        let run_id = GraphRunId::new("run:target-unknown");
        let activity_id = ActivityId::new("activity-target-unknown").unwrap();
        let delivery_id = DeliveryId::new("activity-target-unknown").unwrap();
        let mut router = TeamRunReceiptRouter::new();

        router.record(ActivityReceiptObservation {
            run_id: run_id.clone(),
            activity_id: activity_id.clone(),
            delivery_id: delivery_id.clone(),
            status: ActivityReceiptStatus::TargetUnavailable,
        });

        assert_eq!(
            router.last(),
            Some(&ActivityReceiptObservation {
                run_id,
                activity_id,
                delivery_id,
                status: ActivityReceiptStatus::TargetUnavailable,
            })
        );
        assert_eq!(router.last_failure(), router.last());
    }

    #[test]
    fn activity_outcome_maps_to_receipt_status() {
        assert_eq!(
            ActivityReceiptStatus::from_activity_outcome(&TeamRunActivityOutcome::Dispatched(
                TeamRunCommandOutcome::OutcomeUnknown,
            )),
            ActivityReceiptStatus::Delivered
        );
        assert_eq!(
            ActivityReceiptStatus::from_activity_outcome(&TeamRunActivityOutcome::AwaitingRetry(
                TeamRunCommandOutcome::OutcomeUnknown,
            )),
            ActivityReceiptStatus::AwaitingRetry
        );
    }
}
