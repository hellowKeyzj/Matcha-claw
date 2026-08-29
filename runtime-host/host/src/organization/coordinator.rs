use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::execution::{ObservationSink, OperationHandle, ServiceHandle, TraceContext};
use matcha_agent::session::receipt::TerminalRunStatus;
use organization::{DeliveryClaim, DeliveryId, GraphRunId, PromptDeliveryRequest};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{
    composition::{
        HostAdmission, TeamRunDeliveryTarget,
        team_trigger_cron::{CronReconciliation, TeamTriggerCron},
    },
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::{OwnedRuntimeFuture, RuntimeDriverIdentity},
};

use super::OrganizationHandle;

const TEAM_RUN_MAINTENANCE_CAPACITY: usize = 8;
const DELIVERY_RETRY_DELAY: Duration = Duration::from_secs(30);
const DELIVERY_RECONCILIATION_CONCURRENCY: usize = 8;
const READY_NODES_OPERATION: &str = "teamRun.readyNodes";
const DELIVERY_OBSERVATION_OPERATION: &str = "teamRun.deliveryObservation";
const OPENCLAW_DELIVERY_OPERATION: &str = "teamRun.openClawDelivery";
const MATCHA_DELIVERY_OPERATION: &str = "teamRun.matchaDelivery";

static NEXT_TEAM_RUN_OPERATION_TRACE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct TeamRunCoordinatorInput {
    pub(crate) admission: Arc<HostAdmission>,
    pub(crate) organization: OrganizationHandle,
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
    pub(crate) admission_changes: tokio::sync::watch::Receiver<crate::composition::AdmissionState>,
    pub(crate) observation: ObservationSink,
}

#[derive(Clone)]
pub(crate) struct TeamRunCoordinatorHandle {
    requests: mpsc::Sender<TeamRunCoordinatorRequest>,
}

pub(crate) struct TeamRunCoordinator {
    service: ServiceHandle<()>,
}

enum TeamRunCoordinatorRequest {
    CancelMatchaTerminalWatches { reply: oneshot::Sender<()> },
    RecoverMaterializationReceipts,
}

impl TeamRunCoordinatorHandle {
    pub(crate) async fn cancel_matcha_terminal_watches(&self) {
        let (reply, reply_rx) = oneshot::channel();
        if self
            .requests
            .send(TeamRunCoordinatorRequest::CancelMatchaTerminalWatches { reply })
            .await
            .is_ok()
        {
            let _ = reply_rx.await;
        }
    }

    pub(crate) async fn recover_materialization_receipts(&self) {
        let _ = self
            .requests
            .send(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)
            .await;
    }
}

impl TeamRunCoordinator {
    pub(crate) fn spawn(input: TeamRunCoordinatorInput) -> (Self, TeamRunCoordinatorHandle) {
        let (requests, receiver) = mpsc::channel(TEAM_RUN_MAINTENANCE_CAPACITY);
        let handle = TeamRunCoordinatorHandle { requests };
        let (service, _) = ServiceHandle::spawn(move |cancellation| async move {
            run(input, receiver, cancellation).await;
        });
        (Self { service }, handle)
    }

    pub(crate) fn cancel(&self) {
        self.service.cancel();
    }

    pub(crate) async fn join(&mut self) -> Result<(), tokio::task::JoinError> {
        self.service.join().await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalWatchCompletion {
    Terminal(TerminalRunStatus),
    OutcomeUnknown,
}

struct TerminalWatches {
    watched_delivery_ids: BTreeSet<DeliveryId>,
    tasks: JoinSet<(GraphRunId, DeliveryId, TerminalWatchCompletion)>,
}

#[derive(Debug, Eq, PartialEq)]
struct TerminalWatchObservation {
    run_id: GraphRunId,
    delivery_id: DeliveryId,
    status: TerminalRunStatus,
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
            self.start(input, delivery_id).await;
        }
    }

    async fn start(&mut self, input: &TeamRunCoordinatorInput, delivery_id: DeliveryId) {
        let Ok(Some(target)) = input
            .organization
            .matcha_terminal_target(delivery_id.clone())
            .await
        else {
            return;
        };
        let run_id = target.graph_run_id().clone();
        let watch = watch_matcha_terminal(input, target);
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
            TerminalWatchCompletion::Terminal(status) => Some(TerminalWatchObservation {
                run_id,
                delivery_id,
                status,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeliveryReconciliationStatus {
    Delivered,
    AlreadyClaimed,
    AwaitingRetry,
    Terminal,
    OutcomeUnknown,
    TargetUnavailable,
    StoreFault,
    DeliveryError,
    ResponseUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DeliveryReconciliationObservation {
    delivery_id: DeliveryId,
    status: DeliveryReconciliationStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum DeliveryReconciliationKey {
    Delivery(DeliveryId),
    Run(GraphRunId),
}

enum DeliveryReconciliationCompletion {
    Run,
    Observation(DeliveryReconciliationObservation),
    OpenClaw {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        claim: DeliveryClaim,
        outcome: organization::PromptDeliveryOutcome,
    },
    Matcha {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
        outcome: organization::PromptDeliveryOutcome,
    },
}

struct DeliveryReconciliationWork {
    operation: OperationHandle<DeliveryReconciliationCompletion>,
}

#[derive(Default)]
struct DeliveryReconciliationState {
    last: Option<DeliveryReconciliationObservation>,
    last_failure: Option<DeliveryReconciliationObservation>,
    dirty: BTreeSet<DeliveryReconciliationKey>,
    processing: BTreeMap<DeliveryReconciliationKey, DeliveryReconciliationWork>,
}

impl DeliveryReconciliationState {
    fn dirty(&mut self, key: DeliveryReconciliationKey) {
        if !self.processing.contains_key(&key) {
            self.dirty.insert(key);
        }
    }

    fn start(
        &mut self,
        key: DeliveryReconciliationKey,
        operation: OperationHandle<DeliveryReconciliationCompletion>,
    ) {
        self.dirty.remove(&key);
        self.processing
            .insert(key, DeliveryReconciliationWork { operation });
    }

    fn capacity(&self) -> usize {
        DELIVERY_RECONCILIATION_CONCURRENCY.saturating_sub(self.processing.len())
    }

    fn dirty_run(&mut self, run_id: GraphRunId) {
        self.dirty(DeliveryReconciliationKey::Run(run_id));
    }

    fn dirty_delivery(&mut self, delivery_id: DeliveryId) {
        self.dirty(DeliveryReconciliationKey::Delivery(delivery_id));
    }

    fn record(&mut self, observation: DeliveryReconciliationObservation) {
        if !matches!(
            observation.status,
            DeliveryReconciliationStatus::Delivered
                | DeliveryReconciliationStatus::AlreadyClaimed
                | DeliveryReconciliationStatus::AwaitingRetry
                | DeliveryReconciliationStatus::Terminal
        ) {
            self.last_failure = Some(observation.clone());
        }
        self.last = Some(observation);
    }

    async fn poll_completed(&mut self) -> Vec<DeliveryReconciliationCompletion> {
        let mut completed = Vec::new();
        let mut pending = BTreeMap::new();
        for (key, mut work) in std::mem::take(&mut self.processing) {
            if work.operation.is_finished() {
                match work.operation.join().await {
                    Ok(completion) => completed.push(completion),
                    Err(_) => {
                        if let DeliveryReconciliationKey::Delivery(delivery_id) = key {
                            completed.push(DeliveryReconciliationCompletion::Observation(
                                DeliveryReconciliationObservation {
                                    delivery_id,
                                    status: DeliveryReconciliationStatus::ResponseUnavailable,
                                },
                            ));
                        }
                    }
                }
            } else {
                pending.insert(key, work);
            }
        }
        self.processing = pending;
        completed
    }

    fn cancel(&mut self) {
        for (_, work) in std::mem::take(&mut self.processing) {
            work.operation.cancel();
        }
        self.dirty.clear();
    }

    #[cfg(test)]
    fn last(&self) -> Option<&DeliveryReconciliationObservation> {
        self.last.as_ref()
    }

    #[cfg(test)]
    fn last_failure(&self) -> Option<&DeliveryReconciliationObservation> {
        self.last_failure.as_ref()
    }

    #[cfg(test)]
    fn record_target_unavailable(&mut self, delivery_id: DeliveryId) {
        self.record(DeliveryReconciliationObservation {
            delivery_id,
            status: DeliveryReconciliationStatus::TargetUnavailable,
        });
    }
}

enum Next {
    Shutdown,
    Tick,
    AdmissionChanged,
    Request(Option<TeamRunCoordinatorRequest>),
    TerminalWatch(Option<TerminalWatchObservation>),
}

async fn run(
    mut input: TeamRunCoordinatorInput,
    mut requests: mpsc::Receiver<TeamRunCoordinatorRequest>,
    cancellation: CancellationToken,
) {
    let mut requests_open = true;
    let mut terminal_watches = TerminalWatches::new();
    let mut team_trigger_cron = TeamTriggerCron::default();
    let mut delivery_reconciliation = DeliveryReconciliationState::default();
    reconcile(
        &input,
        &mut terminal_watches,
        &mut team_trigger_cron,
        &mut delivery_reconciliation,
    )
    .await;
    loop {
        match next(
            &mut requests,
            &mut requests_open,
            &mut input.admission_changes,
            &mut terminal_watches,
            &cancellation,
        )
        .await
        {
            Next::Shutdown => {
                terminal_watches.cancel().await;
                delivery_reconciliation.cancel();
                return;
            }
            Next::Tick | Next::AdmissionChanged => {
                reconcile(
                    &input,
                    &mut terminal_watches,
                    &mut team_trigger_cron,
                    &mut delivery_reconciliation,
                )
                .await;
            }
            Next::Request(Some(TeamRunCoordinatorRequest::CancelMatchaTerminalWatches {
                reply,
            })) => {
                terminal_watches.cancel().await;
                let _ = reply.send(());
            }
            Next::Request(Some(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)) => {
                if input.admission.admit_request().is_ok() {
                    let _ = input.organization.recover_materialization_receipts().await;
                }
            }
            Next::Request(None) => requests_open = false,
            Next::TerminalWatch(Some(observation)) => {
                if input.admission.admit_request().is_ok() {
                    let _ = input
                        .organization
                        .observe_matcha_terminal(
                            observation.run_id,
                            observation.delivery_id,
                            observation.status,
                            now_seconds(),
                        )
                        .await;
                }
            }
            Next::TerminalWatch(None) => {}
        }
    }
}

async fn next(
    requests: &mut mpsc::Receiver<TeamRunCoordinatorRequest>,
    requests_open: &mut bool,
    admission_changes: &mut tokio::sync::watch::Receiver<crate::composition::AdmissionState>,
    terminal_watches: &mut TerminalWatches,
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
        delivery_id = terminal_watches.join_next(), if !terminal_watches.is_empty() => Next::TerminalWatch(delivery_id),
        _ = tokio::time::sleep(Duration::from_secs(30)) => Next::Tick,
    }
}

async fn reconcile(
    input: &TeamRunCoordinatorInput,
    terminal_watches: &mut TerminalWatches,
    team_trigger_cron: &mut TeamTriggerCron,
    delivery_reconciliation: &mut DeliveryReconciliationState,
) {
    if input.admission.admit_request().is_err() {
        return;
    }
    terminal_watches.start_recovery(input).await;
    reconcile_team_trigger_cron(input, team_trigger_cron).await;
    reconcile_team_run_deliveries(input, terminal_watches, delivery_reconciliation).await;
}

async fn reconcile_team_run_deliveries(
    input: &TeamRunCoordinatorInput,
    terminal_watches: &mut TerminalWatches,
    reconciliation: &mut DeliveryReconciliationState,
) {
    let now = now_seconds();
    let retry_at = now.saturating_add(DELIVERY_RETRY_DELAY.as_secs());
    for completion in reconciliation.poll_completed().await {
        complete_delivery_reconciliation(
            input,
            terminal_watches,
            reconciliation,
            completion,
            retry_at,
        )
        .await;
    }
    if let Ok(run_ids) = input.organization.active_run_ids().await {
        for run_id in run_ids {
            reconciliation.dirty_run(run_id);
        }
    }
    if let Ok(delivery_ids) = input.organization.pending_delivery_ids(now).await {
        for delivery_id in delivery_ids {
            reconciliation.dirty_delivery(delivery_id);
        }
    }
    let keys = reconciliation
        .dirty
        .iter()
        .take(reconciliation.capacity())
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        let Some(work) = start_delivery_reconciliation(input, &key, now).await else {
            reconciliation.dirty.remove(&key);
            continue;
        };
        reconciliation.start(key, work);
    }
}

async fn start_delivery_reconciliation(
    input: &TeamRunCoordinatorInput,
    key: &DeliveryReconciliationKey,
    now: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    match key {
        DeliveryReconciliationKey::Run(run_id) => {
            let _ = input
                .organization
                .schedule_ready_nodes(run_id.clone(), now)
                .await;
            Some(spawn_reconciliation_operation(
                input,
                READY_NODES_OPERATION,
                |_| async { DeliveryReconciliationCompletion::Run },
            ))
        }
        DeliveryReconciliationKey::Delivery(delivery_id) => {
            let Ok(Some(target)) = input
                .organization
                .delivery_target(delivery_id.clone())
                .await
            else {
                return Some(observed_delivery_reconciliation(
                    input,
                    delivery_id.clone(),
                    DeliveryReconciliationStatus::TargetUnavailable,
                ));
            };
            match target {
                TeamRunDeliveryTarget::OpenClaw { run_id } => {
                    start_openclaw_delivery_reconciliation(input, run_id, delivery_id.clone(), now)
                        .await
                }
                TeamRunDeliveryTarget::Matcha { run_id } => {
                    start_matcha_delivery_reconciliation(input, run_id, delivery_id.clone(), now)
                        .await
                }
            }
        }
    }
}

fn observed_delivery_reconciliation(
    input: &TeamRunCoordinatorInput,
    delivery_id: DeliveryId,
    status: DeliveryReconciliationStatus,
) -> OperationHandle<DeliveryReconciliationCompletion> {
    spawn_reconciliation_operation(input, DELIVERY_OBSERVATION_OPERATION, move |_| async move {
        DeliveryReconciliationCompletion::Observation(DeliveryReconciliationObservation {
            delivery_id,
            status,
        })
    })
}

fn spawn_reconciliation_operation<F, U>(
    input: &TeamRunCoordinatorInput,
    operation_kind: &'static str,
    future: F,
) -> OperationHandle<DeliveryReconciliationCompletion>
where
    F: FnOnce(CancellationToken) -> U + Send + 'static,
    U: Future<Output = DeliveryReconciliationCompletion> + Send + 'static,
{
    if input.observation.is_enabled() {
        OperationHandle::spawn_observed(
            input.observation.clone(),
            next_team_run_operation_trace(),
            operation_kind,
            future,
        )
        .0
    } else {
        OperationHandle::spawn(future).0
    }
}

fn next_team_run_operation_trace() -> TraceContext {
    TraceContext::root(NEXT_TEAM_RUN_OPERATION_TRACE.fetch_add(1, Ordering::Relaxed))
}

async fn start_openclaw_delivery_reconciliation(
    input: &TeamRunCoordinatorInput,
    run_id: GraphRunId,
    delivery_id: DeliveryId,
    claimed_at: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    if open_claw_delivery_unavailable(input) {
        return Some(observed_delivery_reconciliation(
            input,
            delivery_id,
            DeliveryReconciliationStatus::DeliveryError,
        ));
    }
    let start = match input
        .organization
        .claim_openclaw_delivery(run_id.clone(), delivery_id.clone(), claimed_at)
        .await
    {
        Ok(Ok(start)) => start,
        Ok(Err(crate::composition::OpenClawDeliveryError::Store(_))) => {
            return Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::StoreFault,
            ));
        }
        Ok(Err(_)) | Err(_) => {
            return Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::DeliveryError,
            ));
        }
    };
    match start {
        crate::composition::OpenClawDeliveryStart::Claimed { claim, delivery } => {
            let operation = deliver_team_prompt(input, delivery);
            Some(spawn_reconciliation_operation(
                input,
                OPENCLAW_DELIVERY_OPERATION,
                move |_| async move {
                    let outcome = operation.await;
                    DeliveryReconciliationCompletion::OpenClaw {
                        run_id,
                        delivery_id,
                        claim,
                        outcome,
                    }
                },
            ))
        }
        crate::composition::OpenClawDeliveryStart::Immediate(outcome) => {
            Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                openclaw_delivery_status(&outcome),
            ))
        }
    }
}

async fn start_matcha_delivery_reconciliation(
    input: &TeamRunCoordinatorInput,
    run_id: GraphRunId,
    delivery_id: DeliveryId,
    claimed_at: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    let start = match input
        .organization
        .claim_matcha_delivery(run_id.clone(), delivery_id.clone(), claimed_at)
        .await
    {
        Ok(Ok(start)) => start,
        Ok(Err(crate::composition::MatchaDeliveryError::Store(_))) => {
            return Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::StoreFault,
            ));
        }
        Ok(Err(_)) | Err(_) => {
            return Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::DeliveryError,
            ));
        }
    };
    match start {
        crate::composition::MatchaDeliveryStartOutcome::Claimed { claim, delivery } => {
            let operation = deliver_team_prompt(input, delivery.clone());
            Some(spawn_reconciliation_operation(
                input,
                MATCHA_DELIVERY_OPERATION,
                move |_| async move {
                    let outcome = operation.await;
                    DeliveryReconciliationCompletion::Matcha {
                        run_id,
                        delivery_id,
                        claim,
                        delivery,
                        outcome,
                    }
                },
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::AlreadyClaimed(_) => {
            Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::AlreadyClaimed,
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::AwaitingRetry(_) => {
            Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::AwaitingRetry,
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::Terminal(_) => {
            Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::Terminal,
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::OutcomeUnknown(_) => {
            Some(observed_delivery_reconciliation(
                input,
                delivery_id,
                DeliveryReconciliationStatus::OutcomeUnknown,
            ))
        }
    }
}

async fn complete_delivery_reconciliation(
    input: &TeamRunCoordinatorInput,
    terminal_watches: &mut TerminalWatches,
    reconciliation: &mut DeliveryReconciliationState,
    completion: DeliveryReconciliationCompletion,
    retry_at: u64,
) {
    match completion {
        DeliveryReconciliationCompletion::Run => {}
        DeliveryReconciliationCompletion::Observation(observation) => {
            reconciliation.record(observation)
        }
        DeliveryReconciliationCompletion::OpenClaw {
            run_id,
            delivery_id,
            claim,
            outcome,
        } => {
            let status = match input
                .organization
                .settle_openclaw_delivery(run_id, claim, outcome, retry_at)
                .await
            {
                Ok(Ok(outcome)) => openclaw_delivery_status(&outcome),
                Ok(Err(crate::composition::OpenClawDeliveryError::Store(_))) => {
                    DeliveryReconciliationStatus::StoreFault
                }
                Ok(Err(_)) | Err(_) => DeliveryReconciliationStatus::DeliveryError,
            };
            reconciliation.record(DeliveryReconciliationObservation {
                delivery_id,
                status,
            });
        }
        DeliveryReconciliationCompletion::Matcha {
            run_id,
            delivery_id,
            claim,
            delivery,
            outcome,
        } => {
            let status = match input
                .organization
                .settle_matcha_delivery(run_id, claim, delivery, outcome, retry_at)
                .await
            {
                Ok(Ok(outcome)) => matcha_delivery_status(&outcome),
                Ok(Err(crate::composition::MatchaDeliveryError::Store(_))) => {
                    DeliveryReconciliationStatus::StoreFault
                }
                Ok(Err(_)) | Err(_) => DeliveryReconciliationStatus::DeliveryError,
            };
            if matches!(status, DeliveryReconciliationStatus::Delivered) {
                terminal_watches.start(input, delivery_id.clone()).await;
            }
            reconciliation.record(DeliveryReconciliationObservation {
                delivery_id,
                status,
            });
        }
    }
}

fn openclaw_delivery_status(
    outcome: &crate::composition::OpenClawDeliveryOutcome,
) -> DeliveryReconciliationStatus {
    match outcome {
        crate::composition::OpenClawDeliveryOutcome::Delivered(_) => {
            DeliveryReconciliationStatus::Delivered
        }
        crate::composition::OpenClawDeliveryOutcome::AlreadyClaimed(_) => {
            DeliveryReconciliationStatus::AlreadyClaimed
        }
        crate::composition::OpenClawDeliveryOutcome::AwaitingRetry(_) => {
            DeliveryReconciliationStatus::AwaitingRetry
        }
        crate::composition::OpenClawDeliveryOutcome::Terminal(_) => {
            DeliveryReconciliationStatus::Terminal
        }
        crate::composition::OpenClawDeliveryOutcome::OutcomeUnknown(_) => {
            DeliveryReconciliationStatus::OutcomeUnknown
        }
    }
}

fn matcha_delivery_status(
    outcome: &crate::composition::MatchaDeliveryOutcome,
) -> DeliveryReconciliationStatus {
    match outcome {
        crate::composition::MatchaDeliveryOutcome::Delivered(_) => {
            DeliveryReconciliationStatus::Delivered
        }
        crate::composition::MatchaDeliveryOutcome::AlreadyClaimed(_) => {
            DeliveryReconciliationStatus::AlreadyClaimed
        }
        crate::composition::MatchaDeliveryOutcome::AwaitingRetry(_) => {
            DeliveryReconciliationStatus::AwaitingRetry
        }
        crate::composition::MatchaDeliveryOutcome::Terminal(_) => {
            DeliveryReconciliationStatus::Terminal
        }
        crate::composition::MatchaDeliveryOutcome::OutcomeUnknown(_) => {
            DeliveryReconciliationStatus::OutcomeUnknown
        }
    }
}

async fn reconcile_team_trigger_cron(input: &TeamRunCoordinatorInput, cron: &mut TeamTriggerCron) {
    let now = now_seconds();
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

fn open_claw_delivery_unavailable(input: &TeamRunCoordinatorInput) -> bool {
    if input.admission.admit_request().is_err() {
        return true;
    }
    let Some(driver) = input
        .runtime_directory
        .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return true;
    };
    !driver.lifecycle_ops().is_some_and(|ops| ops.readiness())
}

fn deliver_team_prompt(
    input: &TeamRunCoordinatorInput,
    request: PromptDeliveryRequest,
) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
    let Some(driver) = input.runtime_directory.all_drivers().find(|driver| {
        driver.identity().runtime_endpoint_reference() == request.binding().endpoint().as_str()
    }) else {
        return Box::pin(async {
            organization::PromptDeliveryOutcome::Rejected {
                rejection: organization::DeliveryRejection::Permanent,
            }
        });
    };
    match driver.team_ops() {
        Some(ops) => ops.deliver_prompt(request),
        None => Box::pin(async {
            organization::PromptDeliveryOutcome::Rejected {
                rejection: organization::DeliveryRejection::Permanent,
            }
        }),
    }
}

fn watch_matcha_terminal(
    input: &TeamRunCoordinatorInput,
    target: organization::MatchaTerminalReceiptTarget,
) -> OwnedRuntimeFuture<Option<TerminalRunStatus>> {
    let Some(driver) = input
        .runtime_directory
        .lookup(&RuntimeDriverIdentity::matcha_agent().endpoint())
    else {
        return Box::pin(async { None });
    };
    match driver.team_terminal_ops() {
        Some(ops) => ops.watch_terminal(target),
        None => Box::pin(async { None }),
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
    use tokio::sync::oneshot;

    use super::*;

    #[test]
    fn team_run_coordinator_retains_unknown_target_as_observable_failure() {
        let delivery_id = DeliveryId::new("delivery-target-unknown").unwrap();
        let mut state = DeliveryReconciliationState::default();

        state.record_target_unavailable(delivery_id.clone());

        assert_eq!(
            state.last(),
            Some(&DeliveryReconciliationObservation {
                delivery_id: delivery_id.clone(),
                status: DeliveryReconciliationStatus::TargetUnavailable,
            })
        );
        assert_eq!(state.last_failure(), state.last());
    }

    #[tokio::test]
    async fn team_run_coordinator_merges_wakeups_for_a_processing_key() {
        let key =
            DeliveryReconciliationKey::Delivery(DeliveryId::new("delivery-single-flight").unwrap());
        let mut state = DeliveryReconciliationState::default();

        state.dirty(key.clone());
        state.start(key.clone(), completed_delivery_reconciliation());
        state.dirty(key.clone());

        assert!(!state.dirty.contains(&key));
        assert_eq!(state.processing.len(), 1);
    }

    #[tokio::test]
    async fn team_run_coordinator_runs_distinct_keys_up_to_capacity() {
        let first = DeliveryReconciliationKey::Delivery(
            DeliveryId::new("delivery-concurrent-one").unwrap(),
        );
        let second = DeliveryReconciliationKey::Delivery(
            DeliveryId::new("delivery-concurrent-two").unwrap(),
        );
        let mut state = DeliveryReconciliationState::default();

        state.dirty(first.clone());
        state.dirty(second.clone());
        for key in state
            .dirty
            .iter()
            .take(state.capacity())
            .cloned()
            .collect::<Vec<_>>()
        {
            state.start(key, completed_delivery_reconciliation());
        }

        assert!(state.processing.contains_key(&first));
        assert!(state.processing.contains_key(&second));
    }

    #[tokio::test]
    async fn team_run_coordinator_capacity_is_finite() {
        let mut state = DeliveryReconciliationState::default();
        for index in 0..DELIVERY_RECONCILIATION_CONCURRENCY {
            state.start(
                DeliveryReconciliationKey::Delivery(
                    DeliveryId::new(format!("delivery-capacity-{index}")).unwrap(),
                ),
                completed_delivery_reconciliation(),
            );
        }

        assert_eq!(state.capacity(), 0);
    }

    #[test]
    fn team_run_coordinator_completion_uses_claim_settlement_as_the_stale_fence() {
        let completion = include_str!("coordinator.rs")
            .split_once("async fn complete_delivery_reconciliation")
            .and_then(|(_, source)| source.split_once("\nfn openclaw_delivery_status"))
            .map(|(completion, _)| completion)
            .expect("coordinator must retain delivery completion");

        assert!(completion.contains(".settle_openclaw_delivery(run_id, claim, outcome, retry_at)"));
        assert!(
            completion
                .contains(".settle_matcha_delivery(run_id, claim, delivery, outcome, retry_at)")
        );
    }

    fn completed_delivery_reconciliation() -> OperationHandle<DeliveryReconciliationCompletion> {
        OperationHandle::spawn(|_| async { DeliveryReconciliationCompletion::Run }).0
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
    async fn terminal_watch_completion_remains_deduplicated_for_the_coordinator_lifetime() {
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
                    TerminalWatchCompletion::Terminal(TerminalRunStatus::Completed),
                )
            }
        });

        assert_eq!(
            watches.join_next().await,
            Some(TerminalWatchObservation {
                run_id,
                delivery_id: delivery_id.clone(),
                status: TerminalRunStatus::Completed,
            })
        );
        assert!(watches.watched_delivery_ids.contains(&delivery_id));
        assert!(watches.tasks.is_empty());
    }

    #[tokio::test]
    async fn coordinator_shutdown_cancels_and_forgets_terminal_watches() {
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

    #[test]
    fn coordinator_startup_scans_durable_delivery_ids_once() {
        let source = include_str!("coordinator.rs");
        let planner = concat!("terminal_observation_", "deliveries()");
        let startup = concat!("terminal_watches.", "start_", "recovery(input).await;");
        let recovery = source
            .split("async fn start_recovery(&mut self, input: &TeamRunCoordinatorInput) {")
            .nth(1)
            .and_then(|source| source.split("\n    async fn start(&mut self").next())
            .expect("coordinator must define terminal-watch recovery before its start operation");

        assert!(recovery.contains(planner));
        assert!(recovery.contains("self.start(input, delivery_id).await;"));
        assert_eq!(source.matches(planner).count(), 1);
        assert_eq!(source.matches(startup).count(), 1);
    }
}
