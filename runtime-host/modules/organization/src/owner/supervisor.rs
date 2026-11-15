use std::{
    collections::BTreeMap,
    future::{Future, poll_fn},
    pin::Pin,
    task::Poll,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::execution::OwnedTask;
use organization::{DueCronTriggerPlan, GraphRunId};
use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::run::event::TeamRunWake;

use super::{
    coordinator::{TeamRunCoordinatorInput, TeamRunCoordinatorRequest},
    run_actor::{RunActorEvent, TeamRunActors},
    team_run::{ArmedTrigger, CronReconciliation, TeamTriggerCron},
};

const CRON_FIRE_CONCURRENCY: usize = 8;

type ActiveRunRead = OwnedTask<(Option<Vec<GraphRunId>>, bool)>;
type CronRead = OwnedTask<Option<Vec<ArmedTrigger>>>;

struct CronFire {
    plans: Vec<(DueCronTriggerPlan, String)>,
    task: OwnedTask<Vec<CronFireOutcome>>,
}

enum CronFireOutcome {
    Fired,
    Busy,
    Unknown,
}

enum ControlCompletion {
    ActiveRuns(Result<(Option<Vec<GraphRunId>>, bool), ()>),
    CronListed(Result<Option<Vec<ArmedTrigger>>, ()>),
    CronFired { run_id: GraphRunId, result: Result<Vec<CronFireOutcome>, ()> },
}

enum Next {
    Shutdown,
    Tick,
    CronDue,
    AdmissionChanged,
    ScheduleChanged(TeamRunWake),
    ActivityCompleted(RunActorEvent),
    ControlCompleted(ControlCompletion),
    RecoveryCompleted,
    Request(Option<TeamRunCoordinatorRequest>),
}

pub(super) struct TeamRunSupervisor {
    run_actors: TeamRunActors,
    active_runs: Option<ActiveRunRead>,
    active_runs_pending: bool,
    retry_deferred: bool,
    cron_read: Option<CronRead>,
    cron_pending: bool,
    cron_deadline: Option<tokio::time::Instant>,
    cron: TeamTriggerCron,
    cron_fires: BTreeMap<GraphRunId, CronFire>,
    join_failed: bool,
}

impl TeamRunSupervisor {
    fn new(_input: &TeamRunCoordinatorInput) -> Self {
        Self {
            run_actors: TeamRunActors::default(),
            active_runs: None,
            active_runs_pending: false,
            retry_deferred: false,
            cron_read: None,
            cron_pending: false,
            cron_deadline: None,
            cron: TeamTriggerCron::default(),
            cron_fires: BTreeMap::new(),
            join_failed: false,
        }
    }

    fn wake_active_runs(&mut self, input: &TeamRunCoordinatorInput, retry_deferred: bool) {
        self.active_runs_pending = true;
        self.retry_deferred |= retry_deferred;
        self.start_active_run_read(input);
    }

    fn start_active_run_read(&mut self, input: &TeamRunCoordinatorInput) {
        if !input.admission.is_admitted() || self.active_runs.is_some() || !self.active_runs_pending {
            return;
        }
        self.active_runs_pending = false;
        let retry_deferred = std::mem::take(&mut self.retry_deferred);
        let organization = input.organization.clone();
        self.active_runs = Some(OwnedTask::spawn(move |cancellation| async move {
            if cancellation.is_cancelled() { return (None, retry_deferred); }
            runtime_trace("runtime.team_run.active_runs.begin", || json!({
                "schedulerNow": now_millis(),
                "clockUnit": "milliseconds",
                "retryDeferred": retry_deferred,
            }));
            let run_ids = organization.with_cancellation(cancellation).active_run_ids().await.ok();
            runtime_trace("runtime.team_run.active_runs.result", || json!({
                "outcome": if run_ids.is_some() { "returned" } else { "owner_unavailable" },
                "runCount": run_ids.as_ref().map(Vec::len),
            }));
            (run_ids, retry_deferred)
        }).0);
    }

    fn wake_cron(&mut self, input: &TeamRunCoordinatorInput) {
        self.cron_pending = true;
        self.start_cron_read(input);
    }

    fn start_cron_read(&mut self, input: &TeamRunCoordinatorInput) {
        if !input.admission.is_admitted() || self.cron_read.is_some() || !self.cron_pending {
            return;
        }
        self.cron_pending = false;
        self.cron_deadline = None;
        let organization = input.organization.clone();
        self.cron_read = Some(OwnedTask::spawn(move |cancellation| async move {
            if cancellation.is_cancelled() { return None; }
            organization.with_cancellation(cancellation).trigger_list(None).await.ok()
        }).0);
    }

    fn reconcile_cron(&mut self, input: &TeamRunCoordinatorInput, triggers: Vec<ArmedTrigger>) {
        let now = now_millis();
        let unavailable_runs = self.cron_fires.keys().map(|run_id| run_id.as_str().to_owned()).collect();
        let capacity = CRON_FIRE_CONCURRENCY.saturating_sub(self.cron_fires.len());
        let mut plans = BTreeMap::<GraphRunId, Vec<(DueCronTriggerPlan, String)>>::new();
        // Cron slots and their idempotency keys use seconds; persisted run facts use milliseconds.
        for reconciliation in self.cron.reconcile(triggers, now / 1_000, unavailable_runs, capacity) {
            match reconciliation {
                CronReconciliation::Due { plan, expression } => {
                    plans.entry(GraphRunId::new(plan.fire.run_id.clone())).or_default().push((plan, expression));
                }
                CronReconciliation::InvalidSchedule { run_id, start_node_id } => {
                    runtime_trace("runtime.team_run.cron.invalid_schedule", || json!({
                        "runHash": identifier_hash(run_id.as_str()),
                        "nodeHash": identifier_hash(&start_node_id),
                    }));
                }
                CronReconciliation::AwaitingSlot | CronReconciliation::OutcomeUnknown => {}
            }
        }
        for (run_id, plans) in plans {
            let organization = input.organization.clone();
            let requests = plans.iter().map(|(plan, _)| plan.fire.clone()).collect::<Vec<_>>();
            let task = OwnedTask::spawn(move |cancellation| async move {
                let organization = organization.with_cancellation(cancellation.clone());
                let mut outcomes = Vec::with_capacity(requests.len());
                for request in requests {
                    if cancellation.is_cancelled() { break; }
                    let outcome = match organization.trigger_fire(request, now).await {
                        Ok(Ok(_)) => CronFireOutcome::Fired,
                        Ok(Err(crate::StoreFault::TriggerFire(crate::TriggerFireError::Busy))) => CronFireOutcome::Busy,
                        _ => CronFireOutcome::Unknown,
                    };
                    outcomes.push(outcome);
                }
                outcomes
            }).0;
            self.cron_fires.insert(run_id, CronFire { plans, task });
        }
        // Fire completion, not an overdue timer, wakes Runs waiting for capacity.
        self.cron_deadline = if self.cron_fires.len() < CRON_FIRE_CONCURRENCY {
            self.cron.next_slot_at(|run_id| !self.cron_fires.keys().any(|active| active.as_str() == run_id))
                .map(|slot| {
                    let delay = Duration::from_millis(slot.saturating_mul(1_000).saturating_sub(now_millis()));
                    tokio::time::Instant::now() + delay
                })
        } else {
            None
        };
    }

    async fn control_completed(&mut self, input: &TeamRunCoordinatorInput, completion: ControlCompletion, running: bool) {
        match completion {
            ControlCompletion::ActiveRuns(result) => {
                self.active_runs.take();
                match result {
                    Ok((Some(run_ids), retry_deferred)) if running && input.admission.is_admitted() => {
                        self.run_actors.wake_active_runs(input, run_ids, now_millis(), retry_deferred).await;
                    }
                    Err(()) => self.join_failed = true,
                    _ => {}
                }
                if running { self.start_active_run_read(input); }
            }
            ControlCompletion::CronListed(result) => {
                self.cron_read.take();
                match result {
                    Ok(Some(triggers)) if running && input.admission.is_admitted() => self.reconcile_cron(input, triggers),
                    Err(()) => self.join_failed = true,
                    _ => {}
                }
                if running { self.start_cron_read(input); }
            }
            ControlCompletion::CronFired { run_id, result } => {
                let fire = self.cron_fires.remove(&run_id).expect("cron completion belongs to an owned fire");
                match result {
                    Ok(outcomes) => {
                        for ((plan, expression), outcome) in fire.plans.iter().zip(outcomes) {
                            match outcome {
                                CronFireOutcome::Fired => {}
                                CronFireOutcome::Busy => runtime_trace("runtime.team_run.cron.skipped", || json!({
                                    "runHash": identifier_hash(&plan.fire.run_id),
                                    "nodeHash": identifier_hash(&plan.fire.start_node_id),
                                    "reason": "trigger_scope_busy",
                                })),
                                CronFireOutcome::Unknown => self.cron.unknown(plan, expression),
                            }
                        }
                    }
                    Err(()) => {
                        self.join_failed = true;
                        for (plan, expression) in &fire.plans { self.cron.unknown(plan, expression); }
                    }
                }
                if running { self.wake_cron(input); }
            }
        }
    }

    pub(super) async fn retry_settlements(&mut self, input: &TeamRunCoordinatorInput) {
        self.run_actors.join_settlements(input).await;
    }

    pub(super) fn has_pending_settlements(&self) -> bool {
        self.run_actors.has_pending_settlements()
    }

    pub(super) fn join_failed(&self) -> bool {
        self.join_failed
    }

    fn cancel(&mut self) {
        if let Some(task) = &self.active_runs { task.cancel(); }
        if let Some(task) = &self.cron_read { task.cancel(); }
        for fire in self.cron_fires.values() { fire.task.cancel(); }
        self.run_actors.cancel();
    }

    async fn cancel_and_join(&mut self, input: &TeamRunCoordinatorInput) {
        self.cancel();
        while self.active_runs.is_some() || self.cron_read.is_some() || !self.cron_fires.is_empty() {
            let completion = next_control_completion(&mut self.active_runs, &mut self.cron_read, &mut self.cron_fires).await;
            self.control_completed(input, completion, false).await;
        }
        self.run_actors.cancel_and_join(input).await;
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
    let mut supervisor = TeamRunSupervisor::new(&input);
    let mut recovery: Option<OwnedTask<()>> = None;
    runtime_trace("runtime.team_run.coordinator.started", || json!({
        "admitted": input.admission.is_admitted(),
    }));
    reconcile(&input, &mut supervisor).await;
    let mut maintenance = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let cron_deadline = supervisor.cron_deadline.filter(|_| input.admission.is_admitted());
        let event = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Next::Shutdown,
            event = async {
                tokio::select! {
                    completion = next_control_completion(&mut supervisor.active_runs, &mut supervisor.cron_read, &mut supervisor.cron_fires) => Next::ControlCompleted(completion),
                    _ = async { if let Some(deadline) = cron_deadline { tokio::time::sleep_until(deadline).await; } }, if cron_deadline.is_some() => Next::CronDue,
                    event = next(
                        &mut requests,
                        &mut requests_open,
                        &mut admission_changes,
                        &mut schedule_changes,
                        &mut supervisor.run_actors,
                        &mut maintenance,
                        &mut recovery,
                        &cancellation,
                    ) => event,
                }
            } => event,
        };
        match event {
            Next::Shutdown => {
                supervisor.cancel();
                if let Some(mut recovery) = recovery.take() {
                    if recovery.cancel_and_join().await.is_err() { supervisor.join_failed = true; }
                }
                supervisor.cancel_and_join(&input).await;
                runtime_trace("runtime.team_run.coordinator.stopped", || json!({}));
                return supervisor;
            }
            Next::Tick => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": "maintenance",
                    "admitted": input.admission.is_admitted(),
                }));
                reconcile(&input, &mut supervisor).await;
            }
            Next::CronDue => {
                supervisor.cron_deadline = None;
                supervisor.wake_cron(&input);
            }
            Next::AdmissionChanged => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": "admission_changed",
                    "admitted": input.admission.is_admitted(),
                }));
                reconcile(&input, &mut supervisor).await;
            }
            Next::ScheduleChanged(wake) => {
                runtime_trace("runtime.team_run.coordinator.wake", || json!({
                    "reason": format!("{:?}", wake.reason()),
                    "runHash": wake.run_id().map(|id| identifier_hash(id.as_str())),
                    "admitted": input.admission.is_admitted(),
                }));
                supervisor.run_actors.retry_settlements(&input).await;
                // Watch coalesces different runs; the payload cannot narrow this invalidation.
                supervisor.wake_active_runs(&input, false);
                supervisor.wake_cron(&input);
            }
            Next::ActivityCompleted(completion) => {
                let run_id = completion.run_id().clone();
                match completion {
                    RunActorEvent::Ready(completion) => supervisor.run_actors.route_ready_nodes(&input, completion, now_millis()).await,
                    RunActorEvent::Activity(completion) => {
                        supervisor.run_actors.route_completion(&input, completion).await;
                        supervisor.run_actors.wake_run(&run_id);
                    }
                    RunActorEvent::Settled { run_id, activity_id, status } => {
                        supervisor.run_actors.settlement_completed(run_id.clone(), activity_id, status);
                        supervisor.run_actors.wake_run(&run_id);
                    }
                }
                supervisor.run_actors.start_pending(&input, now_millis());
            }
            Next::ControlCompleted(completion) => supervisor.control_completed(&input, completion, true).await,
            Next::Request(Some(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)) => {
                supervisor.run_actors.retry_settlements(&input).await;
                if input.admission.is_admitted() && recovery.is_none() {
                    let organization = input.organization.clone();
                    recovery = Some(OwnedTask::spawn(move |cancellation| async move {
                        let _ = organization.with_cancellation(cancellation).recover_materialization_receipts().await;
                    }).0);
                }
            }
            Next::RecoveryCompleted => { recovery.take(); }
            Next::Request(None) => requests_open = false,
        }
    }
}

async fn next_control_completion(
    active_runs: &mut Option<ActiveRunRead>,
    cron_read: &mut Option<CronRead>,
    cron_fires: &mut BTreeMap<GraphRunId, CronFire>,
) -> ControlCompletion {
    let mut joins: Vec<Pin<Box<dyn Future<Output = ControlCompletion> + Send + '_>>> = Vec::new();
    if let Some(task) = active_runs {
        joins.push(Box::pin(async move { ControlCompletion::ActiveRuns(task.join().await.map_err(|_| ())) }));
    }
    if let Some(task) = cron_read {
        joins.push(Box::pin(async move { ControlCompletion::CronListed(task.join().await.map_err(|_| ())) }));
    }
    for (run_id, fire) in cron_fires {
        let run_id = run_id.clone();
        joins.push(Box::pin(async move {
            ControlCompletion::CronFired { run_id, result: fire.task.join().await.map_err(|_| ()) }
        }));
    }
    poll_fn(|context| {
        for join in &mut joins {
            if let Poll::Ready(completion) = join.as_mut().poll(context) { return Poll::Ready(completion); }
        }
        Poll::Pending
    }).await
}

async fn next<T>(
    requests: &mut mpsc::Receiver<TeamRunCoordinatorRequest>,
    requests_open: &mut bool,
    admission_changes: &mut tokio::sync::watch::Receiver<T>,
    schedule_changes: &mut tokio::sync::watch::Receiver<TeamRunWake>,
    run_actors: &mut TeamRunActors,
    maintenance: &mut tokio::time::Interval,
    recovery: &mut Option<OwnedTask<()>>,
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
        _ = async { if let Some(task) = recovery.as_mut() { let _ = task.join().await; } }, if recovery.is_some() => Next::RecoveryCompleted,
        completion = run_actors.next_event() => Next::ActivityCompleted(completion),
        changed = schedule_changes.changed() => match changed {
            Ok(()) => Next::ScheduleChanged(schedule_changes.borrow_and_update().clone()),
            Err(_) => {
                runtime_trace("runtime.team_run.coordinator.stopping", || json!({ "reason": "schedule_closed" }));
                Next::Shutdown
            },
        },
    }
}

async fn reconcile(input: &TeamRunCoordinatorInput, supervisor: &mut TeamRunSupervisor) {
    if !input.admission.is_admitted() {
        return;
    }
    input.organization.retry_terminal_deliveries();
    supervisor.run_actors.retry_settlements(input).await;
    supervisor.wake_active_runs(input, true);
    supervisor.wake_cron(input);
}

pub(super) fn now_millis() -> u64 {
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
                &mut None,
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
                &mut None,
                &cancellation
            )
            .await,
            Next::Shutdown
        ));
    }
}
