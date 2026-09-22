use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    coordinator::{TeamRunCoordinatorInput, TeamRunCoordinatorRequest},
    receipt_router::TeamRunReceiptRouter,
    run_actor::TeamRunActors,
    team_run::{CronReconciliation, TeamTriggerCron},
};

enum Next {
    Shutdown,
    Tick,
    AdmissionChanged,
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

    async fn wake_active_runs(&mut self, input: &TeamRunCoordinatorInput, now: u64) {
        if let Ok(run_ids) = input.organization.active_run_ids().await {
            self.run_actors
                .wake_active_runs(input, &mut self.receipt_router, run_ids, now)
                .await;
        }
    }

    fn cancel(&mut self) {
        self.run_actors.cancel();
    }
}

pub(super) async fn run(
    mut input: TeamRunCoordinatorInput,
    mut requests: mpsc::Receiver<TeamRunCoordinatorRequest>,
    cancellation: CancellationToken,
) {
    let mut requests_open = true;
    let mut team_trigger_cron = TeamTriggerCron::default();
    let mut supervisor = TeamRunSupervisor::new(&input);
    reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
    loop {
        match next(
            &mut requests,
            &mut requests_open,
            &mut input.admission_changes,
            &cancellation,
        )
        .await
        {
            Next::Shutdown => {
                supervisor.cancel();
                return;
            }
            Next::Tick | Next::AdmissionChanged => {
                reconcile(&input, &mut team_trigger_cron, &mut supervisor).await;
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
        _ = tokio::time::sleep(Duration::from_secs(30)) => Next::Tick,
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
    supervisor.wake_active_runs(input, now).await;
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
