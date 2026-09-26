use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

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
    ScheduleChanged,
    ActivityCompleted(CompletedActivity),
    Request(Option<TeamRunCoordinatorRequest>),
}

struct TeamRunSupervisor {
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
        if let Ok(run_ids) = input.organization.active_run_ids().await {
            self.run_actors
                .wake_active_runs(input, run_ids, now, retry_deferred)
                .await;
        }
    }

    async fn cancel_and_join(&mut self, input: &TeamRunCoordinatorInput) {
        self.run_actors
            .cancel_and_join(input, &mut self.receipt_router)
            .await;
    }
}

pub(super) async fn run(
    mut input: TeamRunCoordinatorInput,
    mut requests: mpsc::Receiver<TeamRunCoordinatorRequest>,
    cancellation: CancellationToken,
) {
    let mut requests_open = true;
    let mut schedule_changes = input.organization.subscribe_schedule_changes();
    let mut team_trigger_cron = TeamTriggerCron::default();
    let mut supervisor = TeamRunSupervisor::new(&input);
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
            &mut input.admission_changes,
            &mut schedule_changes,
            &mut supervisor.run_actors,
            &mut maintenance,
            &cancellation,
        )
        .await
        {
            Next::Shutdown => {
                supervisor.cancel_and_join(&input).await;
                return;
            }
            Next::Tick | Next::AdmissionChanged => {
                reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
            }
            Next::ScheduleChanged => {
                if input.admission.is_admitted() {
                    supervisor
                        .wake_active_runs(&input, now_seconds(), false)
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
                        .wake_active_runs(&input, now_seconds(), false)
                        .await;
                }
            }
            Next::Request(Some(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)) => {
                if input.admission.is_admitted() {
                    let _ = input.organization.recover_materialization_receipts().await;
                }
            }
            Next::Request(None) => requests_open = false,
        }
    }
}

async fn next(
    requests: &mut mpsc::Receiver<TeamRunCoordinatorRequest>,
    requests_open: &mut bool,
    admission_changes: &mut tokio::sync::watch::Receiver<super::coordinator::AdmissionState>,
    schedule_changes: &mut tokio::sync::watch::Receiver<()>,
    run_actors: &mut TeamRunActors,
    maintenance: &mut tokio::time::Interval,
    cancellation: &CancellationToken,
) -> Next {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Next::Shutdown,
        request = requests.recv(), if *requests_open => Next::Request(request),
        changed = admission_changes.changed() => match changed {
            Ok(()) => Next::AdmissionChanged,
            Err(_) => Next::Shutdown,
        },
        _ = maintenance.tick() => Next::Tick,
        completion = run_actors.next_completion() => Next::ActivityCompleted(completion),
        changed = schedule_changes.changed() => match changed {
            Ok(()) => Next::ScheduleChanged,
            Err(_) => Next::Shutdown,
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
    let now = now_seconds();
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
    for reconciliation in cron.reconcile(triggers, now) {
        let CronReconciliation::Due(plan) = reconciliation else {
            continue;
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

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::watch;

    #[tokio::test]
    async fn fact_change_wakes_without_waiting_for_maintenance() {
        let (_requests, mut requests) = mpsc::channel(1);
        let (_admission, mut admission) =
            watch::channel(super::super::coordinator::AdmissionState::Changed);
        let (changes, mut changes_rx) = watch::channel(());
        let mut actors = TeamRunActors::default();
        let mut maintenance = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(30),
            Duration::from_secs(30),
        );
        changes.send_replace(());
        changes.send_replace(());
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
            Next::ScheduleChanged
        ));
        assert!(!changes_rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn shutdown_precedes_a_pending_fact_change() {
        let (_requests, mut requests) = mpsc::channel(1);
        let (_admission, mut admission) =
            watch::channel(super::super::coordinator::AdmissionState::Changed);
        let (changes, mut changes_rx) = watch::channel(());
        let mut actors = TeamRunActors::default();
        let mut maintenance = tokio::time::interval(Duration::from_secs(30));
        let cancellation = CancellationToken::new();
        changes.send_replace(());
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
