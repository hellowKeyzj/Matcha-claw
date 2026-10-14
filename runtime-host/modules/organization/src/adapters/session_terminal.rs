use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use foundation::execution::{
    EventObservation, EventReason, EventStage, ObservationRecord, ObservationSink,
    OperationObservation, OperationReason, OperationStage, TraceContext,
};
use platform::endpoint::runtime_address::SessionIdentity;
use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;
use tokio::{sync::{mpsc, OwnedSemaphorePermit, Semaphore}, task::JoinError};
use tokio_util::sync::CancellationToken;

use crate::{OrganizationHandle, TeamMessageRepairDispatch, TeamMessageTerminalObservation};

const SESSION_TERMINAL_CAPACITY: usize = 256;

pub type TeamMessageRepairSessionFuture<'a> =
    Pin<Box<dyn Future<Output = TeamMessageRepairSessionOutcome> + Send + 'a>>;

pub trait TeamMessageRepairSessionPort<SourceBinding>: Send + Sync {
    fn send_repair<'a>(
        &'a self,
        request: TeamMessageRepairSessionRequest<SourceBinding>,
    ) -> TeamMessageRepairSessionFuture<'a>;

    fn send_repair_cancellable<'a>(
        &'a self,
        request: TeamMessageRepairSessionRequest<SourceBinding>,
        _cancellation: CancellationToken,
    ) -> TeamMessageRepairSessionFuture<'a> {
        self.send_repair(request)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrganizationRunPhase {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone)]
pub struct OrganizationRunTerminalSnapshot<SourceBinding> {
    pub identity: SessionIdentity,
    pub source_binding: SourceBinding,
    pub native_run_id: String,
    pub delivery_context: Option<(crate::DeliveryId, crate::EndpointSessionId)>,
    pub phase: OrganizationRunPhase,
    pub assistant_texts: Vec<String>,
}

pub struct TeamMessageRepairSessionRequest<SourceBinding> {
    pub identity: SessionIdentity,
    pub source_binding: SourceBinding,
    pub endpoint_session_id: crate::EndpointSessionId,
    pub requested_run_id: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageRepairSessionOutcome {
    Queued { native_run_id: String },
    NotDelivered,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrganizationTerminalCloseError {
    Join,
    Unsettled,
}

impl std::fmt::Display for OrganizationTerminalCloseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Join => "organization terminal consumer join failed",
            Self::Unsettled => "organization terminal deliveries remain unsettled",
        })
    }
}

impl std::error::Error for OrganizationTerminalCloseError {}

struct TerminalDelivery<SourceBinding> {
    snapshot: OrganizationRunTerminalSnapshot<SourceBinding>,
    settled_at: u64,
    repair: Option<(TeamMessageRepairDispatch, TeamMessageRepairSessionOutcome)>,
    repair_flight: Arc<Mutex<RepairInFlight<SourceBinding>>>,
    ignored: bool,
    awaiting_repair: Option<Arc<Mutex<RepairInFlight<SourceBinding>>>>,
    _permit: OwnedSemaphorePermit,
}

impl<SourceBinding: Clone> TerminalDelivery<SourceBinding> {
    fn new(snapshot: OrganizationRunTerminalSnapshot<SourceBinding>, permit: OwnedSemaphorePermit) -> Self {
        let repair_flight = Arc::new(Mutex::new(RepairInFlight {
            identity: snapshot.identity.clone(),
            source_binding: snapshot.source_binding.clone(),
            delivery_context: snapshot.delivery_context.clone(),
            active: false,
            associated: false,
        }));
        Self {
            snapshot, settled_at: settlement_timestamp_millis(), repair: None,
            repair_flight, ignored: false, awaiting_repair: None, _permit: permit,
        }
    }
}

/// Consumes sessions run-terminal snapshots for the organization owner.
///
/// `run_terminal_async` acknowledges consumer admission, not durable settlement. Every settlement
/// call happens on the task started by [`OrganizationSessionTerminal::start`].
pub struct OrganizationSessionTerminal<SourceBinding> {
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    snapshots: Mutex<Option<mpsc::Sender<TerminalDelivery<SourceBinding>>>>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<Vec<TerminalDelivery<SourceBinding>>>>>,
    close: tokio::sync::Mutex<()>,
    retained: tokio::sync::Mutex<Vec<TerminalWork<SourceBinding>>>,
    permits: Arc<Semaphore>,
    cancellation: CancellationToken,
    organization: OrganizationHandle,
    join_failed: std::sync::atomic::AtomicBool,
    closed_successfully: std::sync::atomic::AtomicBool,
    observation: ObservationSink,
}

#[derive(Clone)]
struct TeamMessageRepairSession<SourceBinding> {
    identity: SessionIdentity,
    source_binding: SourceBinding,
    endpoint_session_id: crate::EndpointSessionId,
}

impl<SourceBinding> OrganizationSessionTerminal<SourceBinding>
where
    SourceBinding: Clone + PartialEq + Send + 'static,
{
    pub fn start(organization: OrganizationHandle, observation: ObservationSink) -> Self {
        let repair_session = Arc::new(Mutex::new(None));
        let (snapshots, receiver) = mpsc::channel(SESSION_TERMINAL_CAPACITY);
        let terminal_recovery = organization.subscribe_terminal_recovery();
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(consume(
            organization.clone(),
            Arc::clone(&repair_session),
            receiver,
            terminal_recovery,
            cancellation.clone(),
            observation.clone(),
        ));
        Self {
            repair_session,
            snapshots: Mutex::new(Some(snapshots)),
            task: tokio::sync::Mutex::new(Some(task)),
            close: tokio::sync::Mutex::new(()),
            retained: tokio::sync::Mutex::new(Vec::new()),
            permits: Arc::new(Semaphore::new(SESSION_TERMINAL_CAPACITY)),
            cancellation,
            organization,
            join_failed: std::sync::atomic::AtomicBool::new(false),
            closed_successfully: std::sync::atomic::AtomicBool::new(false),
            observation,
        }
    }

    pub fn bind_repair_session(
        &self,
        session: Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>,
    ) {
        *self
            .repair_session
            .lock()
            .expect("session repair handle mutex poisoned") = Some(session);
    }

    pub async fn run_terminal_async(
        &self,
        snapshot: OrganizationRunTerminalSnapshot<SourceBinding>,
        cancellation: CancellationToken,
    ) -> Result<(), OrganizationRunTerminalSnapshot<SourceBinding>> {
        let sender = self.snapshots.lock().expect("session terminal sender mutex poisoned").clone();
        let Some(sender) = sender else { return Err(snapshot); };
        let permit = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(snapshot),
            _ = self.cancellation.cancelled() => return Err(snapshot),
            permit = Arc::clone(&self.permits).acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return Err(snapshot),
            },
        };
        let slot = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(snapshot),
            _ = self.cancellation.cancelled() => return Err(snapshot),
            slot = sender.reserve() => match slot {
                Ok(slot) => slot,
                Err(_) => return Err(snapshot),
            },
        };
        slot.send(TerminalDelivery::new(snapshot, permit));
        Ok(())
    }

    pub async fn close_and_join(&self) -> Result<(), JoinError> {
        self.close_consumer().await.map(|_| ())
    }

    async fn close_consumer(&self) -> Result<bool, JoinError> {
        let _close = self.close.lock().await;
        observe_operation(
            &self.observation,
            OperationStage::Cancel,
            Some(OperationReason::Cancelled),
        );
        self.cancellation.cancel();
        {
            let mut snapshots = self
                .snapshots
                .lock()
                .expect("session terminal sender mutex poisoned");
            drop(snapshots.take());
        }
        let mut retained = self.retained.lock().await;
        let mut task = self.task.lock().await;
        let Some(join) = task.as_mut() else { return Ok(false); };
        observe_operation(&self.observation, OperationStage::Join, None);
        let result = join.await;
        *task = None;
        match result {
            Ok(deliveries) => retained.extend(deliveries.into_iter().map(TerminalWork::Pending)),
            Err(error) => {
                self.join_failed.store(true, std::sync::atomic::Ordering::Release);
                return Err(error);
            }
        }
        Ok(true)
    }

    pub async fn close_and_join_checked(&self) -> Result<(), OrganizationTerminalCloseError> {
        if self.closed_successfully.load(std::sync::atomic::Ordering::Acquire) { return Ok(()); }
        let joined = self.close_consumer().await.map_err(|_| OrganizationTerminalCloseError::Join)?;
        if self.join_failed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(OrganizationTerminalCloseError::Join);
        }
        let mut retained = self.retained.lock().await;
        if joined {
            return self.check_settled(retained.is_empty()).await;
        }
        resume_pending(&mut retained, &self.organization, &self.repair_session, &self.cancellation, &self.observation, true);
        while retained.iter().any(|slot| matches!(slot, TerminalWork::Running { .. })) {
            let (index, pending) = next_delivery(&mut retained).await;
            retain_completion(&mut retained, index, pending);
            resume_pending(&mut retained, &self.organization, &self.repair_session, &self.cancellation, &self.observation, false);
        }
        self.check_settled(retained.is_empty()).await
    }

    async fn check_settled(&self, deliveries_settled: bool) -> Result<(), OrganizationTerminalCloseError> {
        if deliveries_settled && matches!(self.organization.has_pending_team_message_repairs().await, Ok(false)) {
            self.closed_successfully.store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        } else {
            Err(OrganizationTerminalCloseError::Unsettled)
        }
    }
}

struct RepairInFlight<SourceBinding> {
    identity: SessionIdentity,
    source_binding: SourceBinding,
    delivery_context: Option<(crate::DeliveryId, crate::EndpointSessionId)>,
    active: bool,
    associated: bool,
}

enum TerminalWork<SourceBinding> {
    Running {
        future: Pin<Box<dyn Future<Output = Option<TerminalDelivery<SourceBinding>>> + Send>>,
        repair: Arc<Mutex<RepairInFlight<SourceBinding>>>,
    },
    Pending(TerminalDelivery<SourceBinding>),
    Vacant,
}

fn matching_repair<SourceBinding: PartialEq>(
    work: &[TerminalWork<SourceBinding>],
    snapshot: &OrganizationRunTerminalSnapshot<SourceBinding>,
) -> Option<Arc<Mutex<RepairInFlight<SourceBinding>>>> {
    work.iter().find_map(|slot| {
        let repair = match slot {
            TerminalWork::Running { repair, .. } => repair,
            TerminalWork::Pending(pending) => &pending.repair_flight,
            TerminalWork::Vacant => return None,
        };
        let flight = repair.lock().expect("repair flight mutex poisoned");
        (flight.active
            && flight.identity == snapshot.identity
            && flight.source_binding == snapshot.source_binding
            && (snapshot.delivery_context.is_none()
                || flight.delivery_context == snapshot.delivery_context))
            .then(|| Arc::clone(repair))
    })
}

fn retain_completion<SourceBinding: PartialEq>(
    work: &mut Vec<TerminalWork<SourceBinding>>,
    index: usize,
    pending: Option<TerminalDelivery<SourceBinding>>,
) {
    work.swap_remove(index);
    let Some(mut delivery) = pending else { return; };
    if delivery.ignored {
        if delivery.awaiting_repair.is_none() {
            delivery.awaiting_repair = matching_repair(work, &delivery.snapshot);
        }
        if delivery.awaiting_repair.is_none() { return; }
    }
    work.push(TerminalWork::Pending(delivery));
}

fn resume_pending<SourceBinding: Clone + PartialEq + Send + 'static>(
    work: &mut [TerminalWork<SourceBinding>],
    organization: &OrganizationHandle,
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    cancellation: &CancellationToken,
    observation: &ObservationSink,
    all: bool,
) {
    for slot in work {
        let TerminalWork::Pending(delivery) = slot else { continue; };
        if let Some(repair) = &delivery.awaiting_repair {
            let flight = repair.lock().expect("repair flight mutex poisoned");
            // An unknown repair retains the snapshot, not permission to retry an ignored terminal.
            if flight.active || (delivery.ignored && !flight.associated) { continue; }
        } else if !all { continue; }
        let TerminalWork::Pending(mut delivery) = std::mem::replace(slot, TerminalWork::Vacant) else { unreachable!() };
        delivery.ignored = false;
        *slot = delivery_work(organization.clone(), Arc::clone(repair_session), delivery, cancellation.clone(), observation.clone());
    }
}

async fn next_delivery<SourceBinding>(work: &mut [TerminalWork<SourceBinding>]) -> (usize, Option<TerminalDelivery<SourceBinding>>) {
    std::future::poll_fn(|context| {
        for (index, slot) in work.iter_mut().enumerate() {
            if let TerminalWork::Running { future, .. } = slot
                && let std::task::Poll::Ready(result) = future.as_mut().poll(context)
            {
                return std::task::Poll::Ready((index, result));
            }
        }
        std::task::Poll::Pending
    }).await
}

fn delivery_work<SourceBinding: Clone + PartialEq + Send + 'static>(
    organization: OrganizationHandle,
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    delivery: TerminalDelivery<SourceBinding>,
    cancellation: CancellationToken,
    observation: ObservationSink,
) -> TerminalWork<SourceBinding> {
    let repair = Arc::clone(&delivery.repair_flight);
    TerminalWork::Running {
        repair,
        future: Box::pin(async move {
            advance_delivery(&organization, &repair_session, delivery, &cancellation, &observation).await
        }),
    }
}

async fn consume<SourceBinding>(
    organization: OrganizationHandle,
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    mut snapshots: mpsc::Receiver<TerminalDelivery<SourceBinding>>,
    mut terminal_recovery: tokio::sync::watch::Receiver<()>,
    cancellation: CancellationToken,
    observation: ObservationSink,
) -> Vec<TerminalDelivery<SourceBinding>> where
    SourceBinding: Clone + PartialEq + Send + 'static,
{
    observe_operation(&observation, OperationStage::Start, None);
    let mut changes = organization.subscribe_schedule_changes();
    let mut work = Vec::new();
    let mut closed = false;
    let mut drained = false;
    loop {
        let mut retry_pending = false;
        tokio::select! {
            _ = cancellation.cancelled(), if !closed => { snapshots.close(); closed = true; }
            delivery = snapshots.recv(), if !drained => {
                if let Some(mut delivery) = delivery {
                    delivery.awaiting_repair = matching_repair(&work, &delivery.snapshot);
                    let snapshot = &delivery.snapshot;
                    runtime_trace("runtime.team_run.terminal.dequeue", || json!({
                        "nativeRunHash": identifier_hash(&snapshot.native_run_id),
                        "deliveryHash": snapshot.delivery_context.as_ref().map(|(delivery, _)| identifier_hash(delivery.as_str())),
                        "phase": format!("{:?}", snapshot.phase),
                        "candidateCount": snapshot.assistant_texts.len(),
                        "hasDeliveryContext": snapshot.delivery_context.is_some(),
                    }));
                    work.push(delivery_work(organization.clone(), Arc::clone(&repair_session), delivery, cancellation.clone(), observation.clone()));
                    retry_pending = true;
                } else { closed = true; drained = true; }
            }
            completed = next_delivery(&mut work) => {
                let (index, pending) = completed;
                retain_completion(&mut work, index, pending);
                resume_pending(&mut work, &organization, &repair_session, &cancellation, &observation, false);
            }
            changed = changes.changed(), if !closed => {
                if changed.is_err() { snapshots.close(); closed = true; }
                retry_pending = true;
            }
            changed = terminal_recovery.changed(), if !closed => {
                if changed.is_err() { snapshots.close(); closed = true; }
                retry_pending = true;
            }
        }
        if retry_pending && !closed {
            resume_pending(&mut work, &organization, &repair_session, &cancellation, &observation, true);
        }
        if drained && !work.iter().any(|slot| matches!(slot, TerminalWork::Running { .. })) {
            return work.into_iter().filter_map(|slot| match slot { TerminalWork::Pending(delivery) => Some(delivery), TerminalWork::Running { .. } | TerminalWork::Vacant => None }).collect();
        }
    }
}

async fn advance_delivery<SourceBinding>(
    organization: &OrganizationHandle,
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    mut delivery: TerminalDelivery<SourceBinding>,
    cancellation: &CancellationToken,
    observation: &ObservationSink,
) -> Option<TerminalDelivery<SourceBinding>> where SourceBinding: Clone + PartialEq + Send + 'static {
    if delivery.awaiting_repair.as_ref().is_some_and(|repair| repair.lock().expect("repair flight mutex poisoned").associated) {
        delivery.awaiting_repair = None;
    }
    if delivery.repair.is_none() {
        let mut outcome = None;
        for _ in 0..3 {
            outcome = settle(organization, delivery.snapshot.clone(), delivery.settled_at, observation).await;
            if outcome.is_some() { break; }
        }
        let Some(outcome) = outcome else { return Some(delivery); };
        if outcome != TeamMessageTerminalObservation::Ignored {
            delivery.awaiting_repair = None;
        }
        if outcome == TeamMessageTerminalObservation::Ignored {
            delivery.ignored = true;
            return Some(delivery);
        }
        let TeamMessageTerminalObservation::Repair(dispatch) = outcome else { return None; };
        delivery.repair = Some((dispatch, TeamMessageRepairSessionOutcome::NotDelivered));
    }
    if let Some((dispatch, TeamMessageRepairSessionOutcome::NotDelivered)) = &delivery.repair {
        let dispatch = dispatch.clone();
        delivery.repair_flight.lock().expect("repair flight mutex poisoned").active = true;
        let repair = TeamMessageRepairSession {
            identity: delivery.snapshot.identity.clone(), source_binding: delivery.snapshot.source_binding.clone(),
            endpoint_session_id: dispatch.endpoint_session_id().clone(),
        };
        let outcome = schedule_repair(repair_session, repair, dispatch.clone(), cancellation).await;
        match outcome {
            TeamMessageRepairSessionOutcome::NotDelivered => {
                delivery.repair_flight.lock().expect("repair flight mutex poisoned").active = false;
                return Some(delivery);
            }
            TeamMessageRepairSessionOutcome::Unknown => {
                delivery.repair_flight.lock().expect("repair flight mutex poisoned").active = false;
                return None;
            }
            outcome => delivery.repair = Some((dispatch, outcome)),
        }
    }
    for _ in 0..3 {
        let (dispatch, outcome) = delivery.repair.as_ref().expect("repair outcome retained");
        let settled = match outcome {
            TeamMessageRepairSessionOutcome::Queued { native_run_id } => {
                let native_run_hash = platform::trace::enabled().then(|| identifier_hash(native_run_id));
                let result = organization.team_message_repair_queued(native_run_id.clone(), dispatch.clone()).await;
                runtime_trace("runtime.team_run.repair.queued.reply", || json!({
                    "nativeRunHash": native_run_hash,
                    "outcome": if result.is_ok() { "accepted" } else { "admission_or_reply_closed" },
                }));
                if result.is_err() {
                    observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
                }
                result.is_ok()
            },
            TeamMessageRepairSessionOutcome::Rejected => settle_rejected_repair(organization, dispatch.clone(), observation).await,
            TeamMessageRepairSessionOutcome::NotDelivered | TeamMessageRepairSessionOutcome::Unknown => unreachable!(),
        };
        if settled {
            let mut flight = delivery.repair_flight.lock().expect("repair flight mutex poisoned");
            flight.active = false;
            flight.associated = matches!(outcome, TeamMessageRepairSessionOutcome::Queued { .. });
            return None;
        }
    }
    Some(delivery)
}

async fn settle<SourceBinding>(
    organization: &OrganizationHandle,
    snapshot: OrganizationRunTerminalSnapshot<SourceBinding>,
    settled_at: u64,
    observation: &ObservationSink,
) -> Option<TeamMessageTerminalObservation> where
    SourceBinding: Clone + PartialEq + Send + 'static,
{
    let OrganizationRunTerminalSnapshot {
        native_run_id,
        delivery_context,
        phase,
        assistant_texts,
        ..
    } = snapshot;
    let Some(status) = native_terminal_status(phase) else {
        runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
            "nativeRunHash": identifier_hash(&native_run_id), "outcome": "non_terminal_phase",
            "phase": format!("{phase:?}"),
        }));
        return Some(TeamMessageTerminalObservation::Ignored);
    };
    let started = platform::trace::enabled().then(std::time::Instant::now);
    let native_run_hash = platform::trace::enabled().then(|| identifier_hash(&native_run_id));
    let observation_outcome = match organization
        .team_message_terminal_observed(
            native_run_id,
            delivery_context,
            status,
            assistant_texts,
            settled_at,
        )
        .await
    {
        Ok(Ok(outcome)) => {
            runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
                "nativeRunHash": native_run_hash,
                "outcome": match &outcome {
                    TeamMessageTerminalObservation::Ignored => "ignored",
                    TeamMessageTerminalObservation::Repair(_) => "repair",
                    TeamMessageTerminalObservation::Settled => "settled",
                },
                "elapsedMs": started.map(|start| start.elapsed().as_millis()),
            }));
            outcome
        }
        Ok(Err(error)) => {
            runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
                "nativeRunHash": native_run_hash, "outcome": "store_error",
                "error": crate::trace::terminal_error(&error),
                "elapsedMs": started.map(|start| start.elapsed().as_millis()),
            }));
            observe_event(
                observation,
                EventStage::Drop,
                Some(EventReason::ValidationRejected),
            );
            return None;
        }
        Err(_) => {
            runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
                "nativeRunHash": native_run_hash, "outcome": "admission_or_reply_closed",
                "elapsedMs": started.map(|start| start.elapsed().as_millis()),
            }));
            observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
            return None;
        }
    };
    Some(observation_outcome)
}

async fn schedule_repair<SourceBinding>(
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    repair: TeamMessageRepairSession<SourceBinding>,
    dispatch: TeamMessageRepairDispatch,
    cancellation: &CancellationToken,
) -> TeamMessageRepairSessionOutcome where
    SourceBinding: Clone + PartialEq + Send + 'static,
{
    let session = repair_session
        .lock()
        .expect("session repair handle mutex poisoned")
        .clone();
    let Some(session) = session else {
        runtime_trace("runtime.team_run.repair.dispatch", || json!({
            "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
            "attempt": dispatch.attempt(), "outcome": "session_unbound",
        }));
        return TeamMessageRepairSessionOutcome::Rejected;
    };
    if cancellation.is_cancelled() {
        return TeamMessageRepairSessionOutcome::NotDelivered;
    }
    runtime_trace("runtime.team_run.repair.dispatch", || json!({
        "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
        "attempt": dispatch.attempt(), "outcome": "sending",
    }));
    let native_run_id = match session
        .send_repair_cancellable(TeamMessageRepairSessionRequest {
            identity: repair.identity,
            source_binding: repair.source_binding,
            endpoint_session_id: repair.endpoint_session_id,
            requested_run_id: dispatch.requested_run_id().to_owned(),
            prompt: dispatch.prompt().to_owned(),
        }, cancellation.clone())
        .await
    {
        TeamMessageRepairSessionOutcome::Queued { native_run_id } => {
            runtime_trace("runtime.team_run.repair.dispatch", || json!({
                "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
                "actualNativeRunHash": identifier_hash(&native_run_id),
                "attempt": dispatch.attempt(), "outcome": "queued",
            }));
            native_run_id
        }
        TeamMessageRepairSessionOutcome::NotDelivered => {
            return TeamMessageRepairSessionOutcome::NotDelivered;
        }
        TeamMessageRepairSessionOutcome::Rejected => {
            runtime_trace("runtime.team_run.repair.dispatch", || json!({
                "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
                "attempt": dispatch.attempt(), "outcome": "rejected",
            }));
            return TeamMessageRepairSessionOutcome::Rejected;
        }
        TeamMessageRepairSessionOutcome::Unknown => {
            runtime_trace("runtime.team_run.repair.dispatch", || json!({
                "nativeRunHash": identifier_hash(dispatch.requested_run_id()), "attempt": dispatch.attempt(),
                "outcome": "unknown", "pendingRetained": true,
            }));
            return TeamMessageRepairSessionOutcome::Unknown;
        }
    };
    TeamMessageRepairSessionOutcome::Queued { native_run_id }
}

async fn settle_rejected_repair(
    organization: &OrganizationHandle,
    dispatch: TeamMessageRepairDispatch,
    observation: &ObservationSink,
) -> bool {
    let native_run_hash = platform::trace::enabled().then(|| identifier_hash(dispatch.requested_run_id()));
    let result = organization.team_message_repair_rejected(dispatch).await;
    runtime_trace("runtime.team_run.repair.rejected.reply", || json!({
        "nativeRunHash": native_run_hash,
        "outcome": match &result {
            Ok(Ok(())) => "processed",
            Ok(Err(_)) => "store_error",
            Err(_) => "admission_or_reply_closed",
        },
        "error": result.as_ref().ok().and_then(|result| result.as_ref().err()).map(crate::trace::terminal_error),
    }));
    match result {
        Ok(Ok(())) => return true,
        Ok(Err(_)) => observe_event(
            observation,
            EventStage::Drop,
            Some(EventReason::ValidationRejected),
        ),
        Err(_) => observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed)),
    }
    false
}

const fn native_terminal_status(
    phase: OrganizationRunPhase,
) -> Option<crate::NativeTerminalStatus> {
    match phase {
        OrganizationRunPhase::Completed => Some(crate::NativeTerminalStatus::Completed),
        OrganizationRunPhase::Failed => Some(crate::NativeTerminalStatus::Failed),
        OrganizationRunPhase::Cancelled => Some(crate::NativeTerminalStatus::Cancelled),
        OrganizationRunPhase::Interrupted => Some(crate::NativeTerminalStatus::Interrupted),
        OrganizationRunPhase::Queued
        | OrganizationRunPhase::Started
        | OrganizationRunPhase::WaitingForApproval
        | OrganizationRunPhase::CancellationRequested => None,
    }
}

fn observe_event(observation: &ObservationSink, stage: EventStage, reason: Option<EventReason>) {
    observation.observe(ObservationRecord::Event(EventObservation {
        trace: TraceContext::absent(),
        event_kind: "organizationSessionTerminal",
        stage,
        reason,
    }));
}

fn observe_operation(
    observation: &ObservationSink,
    stage: OperationStage,
    reason: Option<OperationReason>,
) {
    observation.observe(ObservationRecord::Operation(OperationObservation {
        trace: TraceContext::absent(),
        operation_kind: "organizationSessionTerminal",
        stage,
        reason,
    }));
}

fn settlement_timestamp_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
