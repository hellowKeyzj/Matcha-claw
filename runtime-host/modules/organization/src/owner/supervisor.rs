use std::time::{Duration, SystemTime, UNIX_EPOCH};

use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::run::event::TeamRunWake;

use super::{
    coordinator::{TeamRunCoordinatorInput, TeamRunCoordinatorRequest},
    receipt_router::TeamRunReceiptRouter,
    run_actor::{CompletedActivity, TeamRunActors},
    team_run::{CronReconciliation, TeamTriggerCron},
};

enum Next {
    Shutdown,
    Tick,
    AdmissionChanged,
    ScheduleChanged(TeamRunWake),
    ActivityCompleted(CompletedActivity),
    Request(Option<TeamRunCoordinatorRequest>),
}

pub(super) struct TeamRunSupervisor {
    run_actors: TeamRunActors,
    receipt_router: TeamRunReceiptRouter,
}

impl TeamRunSupervisor {
    fn new(_input: &TeamRunCoordinatorInput) -> Self {
        Self {
            run_actors: TeamRunActors::default(),
            receipt_router: TeamRunReceiptRouter::new(),
        }
    }

    async fn wake_active_runs(
        &mut self,
        input: &TeamRunCoordinatorInput,
        now: u64,
        retry_deferred: bool,
    ) {
        runtime_trace("runtime.team_run.active_runs.begin", || json!({
            "schedulerNow": now,
            "clockUnit": "milliseconds",
            "retryDeferred": retry_deferred,
        }));
        if retry_deferred {
            self.run_actors.retry_settlements(input, &mut self.receipt_router).await;
        }
        match input.organization.active_run_ids().await {
            Ok(run_ids) => {
                runtime_trace("runtime.team_run.active_runs.result", || json!({
                    "outcome": "returned",
                    "runCount": run_ids.len(),
                }));
                self.run_actors
                    .wake_active_runs(input, run_ids, now, retry_deferred)
                    .await;
            }
            Err(_) => runtime_trace("runtime.team_run.active_runs.result", || json!({
                "outcome": "owner_unavailable",
            })),
        }
    }

    pub(super) async fn retry_settlements(&mut self, input: &TeamRunCoordinatorInput) {
        self.run_actors.retry_settlements(input, &mut self.receipt_router).await;
    }

    pub(super) fn has_pending_settlements(&self) -> bool {
        self.run_actors.has_pending_settlements()
    }

    async fn cancel_and_join(&mut self, input: &TeamRunCoordinatorInput) {
        self.run_actors
            .cancel_and_join(input, &mut self.receipt_router)
            .await;
    }
}

pub(super) async fn run<T: Send + Sync + 'static>(
    input: TeamRunCoordinatorInput,
    mut admission_changes: tokio::sync::watch::Receiver<T>,
    mut requests: mpsc::Receiver<TeamRunCoordinatorRequest>,
    cancellation: CancellationToken,
) -> TeamRunSupervisor {
    let mut requests_open = true;
    let mut schedule_changes = input.organization.subscribe_schedule_changes();
    let mut team_trigger_cron = TeamTriggerCron::default();
    let mut supervisor = TeamRunSupervisor::new(&input);
    runtime_trace("runtime.team_run.coordinator.started", || json!({
        "admitted": input.admission.is_admitted(),
    }));
    reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
    let mut maintenance = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        match next(
            &mut requests,
            &mut requests_open,
            &mut admission_changes,
            &mut schedule_changes,
            &mut supervisor.run_actors,
            &mut maintenance,
            &cancellation,
        )
        .await
        {
            Next::Shutdown => {
                supervisor.cancel_and_join(&input).await;
                runtime_trace("runtime.team_run.coordinator.stopped", || json!({}));
                return supervisor;
            }
            Next::Tick => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": "maintenance",
                    "admitted": input.admission.is_admitted(),
                }));
                reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
            }
            Next::AdmissionChanged => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": "admission_changed",
                    "admitted": input.admission.is_admitted(),
                }));
                reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
            }
            Next::ScheduleChanged(wake) => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": format!("{:?}", wake.reason()),
                    "runHash": wake.run_id().map(|id| identifier_hash(id.as_str())),
                    "admitted": input.admission.is_admitted(),
                }));
                supervisor.retry_settlements(&input).await;
                if input.admission.is_admitted() {
                    supervisor
                        .wake_active_runs(&input, now_millis(), false)
                        .await;
                }
            }
            Next::ActivityCompleted(completion) => {
                supervisor
                    .run_actors
                    .route_completion(&input, &mut supervisor.receipt_router, completion)
                    .await;
                if input.admission.is_admitted() {
                    supervisor
                        .wake_active_runs(&input, now_millis(), false)
                        .await;
                }
            }
            Next::Request(Some(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)) => {
                supervisor.run_actors.retry_settlements(&input, &mut supervisor.receipt_router).await;
                if input.admission.is_admitted() {
                    let _ = input.organization.recover_materialization_receipts().await;
                }
            }
            Next::Request(None) => requests_open = false,
        }
    }
}

async fn next<T>(
    requests: &mut mpsc::Receiver<TeamRunCoordinatorRequest>,
    requests_open: &mut bool,
    admission_changes: &mut tokio::sync::watch::Receiver<T>,
    schedule_changes: &mut tokio::sync::watch::Receiver<TeamRunWake>,
    run_actors: &mut TeamRunActors,
    maintenance: &mut tokio::time::Interval,
    cancellation: &CancellationToken,
) -> Next {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            runtime_trace("runtime.team_run.coordinator.stopping", || json!({ "reason": "cancelled" }));
            Next::Shutdown
        },
        request = requests.recv(), if *requests_open => Next::Request(request),
        changed = admission_changes.changed() => match changed {
            Ok(()) => Next::AdmissionChanged,
            Err(_) => {
                runtime_trace("runtime.team_run.coordinator.stopping", || json!({ "reason": "admission_closed" }));
                Next::Shutdown
            },
        },
        _ = maintenance.tick() => Next::Tick,
        completion = run_actors.next_completion() => Next::ActivityCompleted(completion),
        changed = schedule_changes.changed() => match changed {
            Ok(()) => Next::ScheduleChanged(schedule_changes.borrow().clone()),
            Err(_) => {
                runtime_trace("runtime.team_run.coordinator.stopping", || json!({ "reason": "schedule_closed" }));
                Next::Shutdown
            },
        },
    }
}

async fn reconcile(
    input: &TeamRunCoordinatorInput,
    team_trigger_cron: &mut TeamTriggerCron,
    supervisor: &mut TeamRunSupervisor,
) {
    if !input.admission.is_admitted() {
        return;
    }
    input.organization.retry_terminal_deliveries();
    let now = now_millis();
    reconcile_team_trigger_cron(input, team_trigger_cron, now).await;
    supervisor.wake_active_runs(input, now, true).await;
}

async fn reconcile_team_trigger_cron(
    input: &TeamRunCoordinatorInput,
    cron: &mut TeamTriggerCron,
    now: u64,
) {
    let Ok(triggers) = input.organization.trigger_list(None).await else {
        return;
    };
    // Cron slots and their idempotency keys use seconds; persisted run facts use milliseconds.
    for reconciliation in cron.reconcile(triggers, now / 1_000) {
        let plan = match reconciliation {
            CronReconciliation::Due(plan) => plan,
            CronReconciliation::InvalidSchedule {
                run_id,
                start_node_id,
            } => {
                runtime_trace("runtime.team_run.cron.invalid_schedule", || json!({
                    "runHash": identifier_hash(run_id.as_str()),
                    "nodeHash": identifier_hash(&start_node_id),
                }));
                continue;
            }
            CronReconciliation::AwaitingSlot | CronReconciliation::OutcomeUnknown => continue,
        };
        let request = plan.fire;
        if !matches!(
            input.organization.trigger_fire(request.clone(), now).await,
            Ok(Ok(_))
        ) {
            cron.unknown(&request);
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::watch;

    #[tokio::test]
    async fn fact_change_wakes_without_waiting_for_maintenance() {
        let (_requests, mut requests) = mpsc::channel(1);
        let (_admission, mut admission) = watch::channel(());
        let (changes, mut changes_rx) = watch::channel(TeamRunWake::new(
            crate::run::event::TeamRunWakeReason::GraphChanged,
            None,
        ));
        let mut actors = TeamRunActors::default();
        let mut maintenance = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(30),
            Duration::from_secs(30),
        );
        changes.send_replace(TeamRunWake::new(
            crate::run::event::TeamRunWakeReason::GraphChanged,
            None,
        ));
        changes.send_replace(TeamRunWake::new(
            crate::run::event::TeamRunWakeReason::NativeRunSettled,
            Some(organization::GraphRunId::new("run:one")),
        ));
        assert!(matches!(
            next(
                &mut requests,
                &mut true,
                &mut admission,
                &mut changes_rx,
                &mut actors,
                &mut maintenance,
                &CancellationToken::new()
            )
            .await,
            Next::ScheduleChanged(wake)
                if wake.reason()
                    == crate::run::event::TeamRunWakeReason::NativeRunSettled
                    && wake
                        .run_id()
                        .is_some_and(|run_id| run_id.as_str() == "run:one")
        ));
        assert!(!changes_rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn shutdown_precedes_a_pending_fact_change() {
        let (_requests, mut requests) = mpsc::channel(1);
        let (_admission, mut admission) = watch::channel(());
        let (changes, mut changes_rx) = watch::channel(TeamRunWake::new(
            crate::run::event::TeamRunWakeReason::GraphChanged,
            None,
        ));
        let mut actors = TeamRunActors::default();
        let mut maintenance = tokio::time::interval(Duration::from_secs(30));
        let cancellation = CancellationToken::new();
        changes.send_replace(TeamRunWake::new(
            crate::run::event::TeamRunWakeReason::GraphChanged,
            None,
        ));
        cancellation.cancel();
        assert!(matches!(
            next(
                &mut requests,
                &mut true,
                &mut admission,
                &mut changes_rx,
                &mut actors,
                &mut maintenance,
                &cancellation
            )
            .await,
            Next::Shutdown
        ));
    }
}
