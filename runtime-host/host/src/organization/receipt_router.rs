use std::collections::BTreeSet;

use organization::{ActivityId, DeliveryId, GraphRunId};
use tokio::task::JoinSet;

use crate::runtime::driver::{ActivityExecutionOutcome, NativeRunSettled, OwnedRuntimeFuture};

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
    terminal_watches: TerminalWatches,
    last: Option<ActivityReceiptObservation>,
    last_failure: Option<ActivityReceiptObservation>,
}

impl TeamRunReceiptRouter {
    pub(super) fn new() -> Self {
        Self {
            terminal_watches: TerminalWatches::new(),
            last: None,
            last_failure: None,
        }
    }

    pub(super) async fn start_terminal_recovery(&mut self, input: &TeamRunCoordinatorInput) {
        self.terminal_watches.start_recovery(input).await;
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
        if matches!(status, ActivityReceiptStatus::Delivered) {
            self.terminal_watches
                .start(input, receipt.run_id.clone(), receipt.delivery_id.clone())
                .await;
        }
        self.record(ActivityReceiptObservation {
            run_id: receipt.run_id,
            activity_id: receipt.activity_id,
            delivery_id: receipt.delivery_id,
            status,
        });
        status
    }

    pub(super) fn has_terminal_watches(&self) -> bool {
        !self.terminal_watches.is_empty()
    }

    pub(super) async fn next_terminal_watch(&mut self) -> Option<TerminalWatchObservation> {
        self.terminal_watches.join_next().await
    }

    pub(super) async fn cancel_native_terminal_watches(&mut self) {
        self.terminal_watches.cancel().await;
    }

    pub(super) async fn cancel(&mut self) {
        self.terminal_watches.cancel().await;
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

#[derive(Clone, Debug, Eq, PartialEq)]
enum TerminalWatchCompletion {
    Terminal(NativeRunSettled),
    OutcomeUnknown,
}

struct TerminalWatches {
    watched_delivery_ids: BTreeSet<DeliveryId>,
    tasks: JoinSet<(GraphRunId, DeliveryId, TerminalWatchCompletion)>,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct TerminalWatchObservation {
    pub(super) run_id: GraphRunId,
    pub(super) delivery_id: DeliveryId,
    pub(super) settled: NativeRunSettled,
}

impl TerminalWatches {
    fn new() -> Self {
        Self {
            watched_delivery_ids: BTreeSet::new(),
            tasks: JoinSet::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    async fn start_recovery(&mut self, input: &TeamRunCoordinatorInput) {
        let Ok(delivery_ids) = input.organization.terminal_observation_deliveries().await else {
            return;
        };
        for delivery_id in delivery_ids {
            let Ok(Some(target)) = input
                .organization
                .native_terminal_target(delivery_id.clone())
                .await
            else {
                continue;
            };
            self.start(input, target.graph_run_id().clone(), delivery_id)
                .await;
        }
    }

    async fn start(
        &mut self,
        input: &TeamRunCoordinatorInput,
        run_id: GraphRunId,
        delivery_id: DeliveryId,
    ) {
        let Ok(Some(target)) = input
            .organization
            .native_terminal_target(delivery_id.clone())
            .await
        else {
            return;
        };
        if target.graph_run_id() != &run_id {
            return;
        }
        let watch = watch_native_terminal(input, target);
        if !self.watched_delivery_ids.insert(delivery_id.clone()) {
            return;
        }
        self.tasks.spawn(async move {
            let completion = match watch.await {
                Some(status) => TerminalWatchCompletion::Terminal(status),
                None => TerminalWatchCompletion::OutcomeUnknown,
            };
            (run_id, delivery_id, completion)
        });
    }

    async fn join_next(&mut self) -> Option<TerminalWatchObservation> {
        let completed = self.tasks.join_next().await?;
        let Ok((run_id, delivery_id, completion)) = completed else {
            return None;
        };
        match completion {
            TerminalWatchCompletion::Terminal(settled) => Some(TerminalWatchObservation {
                run_id,
                delivery_id,
                settled,
            }),
            TerminalWatchCompletion::OutcomeUnknown => None,
        }
    }

    async fn cancel(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.watched_delivery_ids.clear();
    }
}

fn watch_native_terminal(
    input: &TeamRunCoordinatorInput,
    target: organization::NativeTerminalReceiptTarget,
) -> OwnedRuntimeFuture<Option<NativeRunSettled>> {
    let Some(driver) = input.runtime_directory.lookup_reference(target.endpoint()) else {
        return Box::pin(async { None });
    };
    match driver.team_terminal_ops() {
        Some(ops) => ops.watch_terminal(target),
        None => Box::pin(async { None }),
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

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

    #[tokio::test]
    async fn unknown_watch_completion_remains_deduplicated_without_automatic_retry() {
        let run_id = GraphRunId::new("run:terminal-watch-unknown");
        let delivery_id = DeliveryId::new("terminal-watch-unknown").unwrap();
        let other_delivery_id = DeliveryId::new("terminal-watch-other").unwrap();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        assert!(
            watches
                .watched_delivery_ids
                .insert(other_delivery_id.clone())
        );
        watches.tasks.spawn({
            let delivery_id = delivery_id.clone();
            let run_id = run_id.clone();
            async move { (run_id, delivery_id, TerminalWatchCompletion::OutcomeUnknown) }
        });

        assert_eq!(watches.join_next().await, None);
        assert!(!watches.watched_delivery_ids.insert(delivery_id));
        assert!(!watches.watched_delivery_ids.insert(other_delivery_id));
        assert!(watches.tasks.is_empty());
    }

    #[tokio::test]
    async fn terminal_watch_completion_remains_deduplicated_for_the_router_lifetime() {
        let run_id = GraphRunId::new("run:terminal-watch-once");
        let delivery_id = DeliveryId::new("terminal-watch-once").unwrap();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        watches.tasks.spawn({
            let delivery_id = delivery_id.clone();
            let run_id = run_id.clone();
            async move {
                (
                    run_id,
                    delivery_id,
                    TerminalWatchCompletion::Terminal(NativeRunSettled {
                        status: organization::NativeTerminalStatus::Completed,
                        final_assistant_text: Some("<team_message>ok</team_message>".to_owned()),
                    }),
                )
            }
        });

        assert_eq!(
            watches.join_next().await,
            Some(TerminalWatchObservation {
                run_id,
                delivery_id: delivery_id.clone(),
                settled: NativeRunSettled {
                    status: organization::NativeTerminalStatus::Completed,
                    final_assistant_text: Some("<team_message>ok</team_message>".to_owned()),
                },
            })
        );
        assert!(watches.watched_delivery_ids.contains(&delivery_id));
        assert!(watches.tasks.is_empty());
    }

    #[tokio::test]
    async fn receipt_router_shutdown_cancels_and_forgets_terminal_watches() {
        let run_id = GraphRunId::new("run:terminal-watch-shutdown");
        let delivery_id = DeliveryId::new("terminal-watch-shutdown").unwrap();
        let (release, release_receiver) = oneshot::channel::<()>();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        watches.tasks.spawn(async move {
            let _ = release_receiver.await;
            (run_id, delivery_id, TerminalWatchCompletion::OutcomeUnknown)
        });

        watches.cancel().await;
        drop(release);

        assert!(watches.watched_delivery_ids.is_empty());
        assert!(watches.tasks.is_empty());
    }
}
