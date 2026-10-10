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
use tokio::{sync::mpsc, task::JoinError};

use crate::{OrganizationHandle, TeamMessageRepairDispatch, TeamMessageTerminalObservation};

const SESSION_TERMINAL_CAPACITY: usize = 256;

pub type TeamMessageRepairSessionFuture<'a> =
    Pin<Box<dyn Future<Output = TeamMessageRepairSessionOutcome> + Send + 'a>>;

pub trait TeamMessageRepairSessionPort<SourceBinding>: Send + Sync {
    fn send_repair<'a>(
        &'a self,
        request: TeamMessageRepairSessionRequest<SourceBinding>,
    ) -> TeamMessageRepairSessionFuture<'a>;
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
    Rejected,
    Unknown,
}

/// Consumes sessions run-terminal snapshots for the organization owner.
///
/// `run_terminal` is synchronous on the sessions lane, so it only enqueues; every settlement call
/// happens on the task started by [`OrganizationSessionTerminal::start`].
pub struct OrganizationSessionTerminal<SourceBinding> {
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    snapshots: Mutex<Option<mpsc::Sender<OrganizationRunTerminalSnapshot<SourceBinding>>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    SourceBinding: Clone + Send + 'static,
{
    pub fn start(organization: OrganizationHandle, observation: ObservationSink) -> Self {
        let repair_session = Arc::new(Mutex::new(None));
        let (snapshots, receiver) = mpsc::channel(SESSION_TERMINAL_CAPACITY);
        let task = tokio::spawn(consume(
            organization,
            Arc::clone(&repair_session),
            receiver,
            observation.clone(),
        ));
        Self {
            repair_session,
            snapshots: Mutex::new(Some(snapshots)),
            task: Mutex::new(Some(task)),
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

    pub fn run_terminal(&self, snapshot: OrganizationRunTerminalSnapshot<SourceBinding>) {
        let trace = platform::trace::enabled().then(|| (
            identifier_hash(&snapshot.native_run_id),
            snapshot.delivery_context.as_ref().map(|(delivery, _)| identifier_hash(delivery.as_str())),
            snapshot.phase,
            snapshot.assistant_texts.len(),
        ));
        let snapshots = self
            .snapshots
            .lock()
            .expect("session terminal sender mutex poisoned")
            .clone();
        let outcome = match snapshots {
            Some(sender) => match sender.try_send(snapshot) {
                Ok(()) => "accepted",
                Err(error) => {
                    observe_enqueue_failure(&self.observation, &error);
                    match error {
                        mpsc::error::TrySendError::Full(_) => "full",
                        mpsc::error::TrySendError::Closed(_) => "closed",
                    }
                }
            },
            None => {
                observe_event(
                    &self.observation,
                    EventStage::Drop,
                    Some(EventReason::SinkClosed),
                );
                "closed"
            }
        };
        runtime_trace("runtime.team_run.terminal.enqueue", || {
            let (native_run_hash, delivery_hash, phase, candidate_count) = trace.as_ref().expect("trace enabled");
            json!({
                "nativeRunHash": native_run_hash, "deliveryHash": delivery_hash,
                "phase": format!("{phase:?}"), "candidateCount": candidate_count,
                "hasDeliveryContext": delivery_hash.is_some(), "outcome": outcome,
            })
        });
    }

    pub async fn close_and_join(&self) -> Result<(), JoinError> {
        observe_operation(
            &self.observation,
            OperationStage::Cancel,
            Some(OperationReason::Cancelled),
        );
        {
            let mut snapshots = self
                .snapshots
                .lock()
                .expect("session terminal sender mutex poisoned");
            drop(snapshots.take());
        }
        let task = {
            let mut task = self
                .task
                .lock()
                .expect("session terminal task mutex poisoned");
            task.take()
        };
        let Some(mut task) = task else {
            observe_operation(
                &self.observation,
                OperationStage::Settle,
                Some(OperationReason::Completed),
            );
            return Ok(());
        };
        observe_operation(&self.observation, OperationStage::Join, None);
        let result = (&mut task).await;
        observe_operation(
            &self.observation,
            OperationStage::Settle,
            Some(if result.is_ok() {
                OperationReason::Completed
            } else {
                OperationReason::JoinFailed
            }),
        );
        result
    }
}

async fn consume<SourceBinding>(
    organization: OrganizationHandle,
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    mut snapshots: mpsc::Receiver<OrganizationRunTerminalSnapshot<SourceBinding>>,
    observation: ObservationSink,
) where
    SourceBinding: Clone + Send + 'static,
{
    observe_operation(&observation, OperationStage::Start, None);
    while let Some(snapshot) = snapshots.recv().await {
        runtime_trace("runtime.team_run.terminal.dequeue", || json!({
            "nativeRunHash": identifier_hash(&snapshot.native_run_id),
            "deliveryHash": snapshot.delivery_context.as_ref().map(|(delivery, _)| identifier_hash(delivery.as_str())),
            "phase": format!("{:?}", snapshot.phase),
            "candidateCount": snapshot.assistant_texts.len(),
            "hasDeliveryContext": snapshot.delivery_context.is_some(),
        }));
        settle(
            &organization,
            &repair_session,
            snapshot,
            settlement_timestamp_millis(),
            &observation,
        )
        .await;
    }
}

async fn settle<SourceBinding>(
    organization: &OrganizationHandle,
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    snapshot: OrganizationRunTerminalSnapshot<SourceBinding>,
    settled_at: u64,
    observation: &ObservationSink,
) where
    SourceBinding: Clone + Send + 'static,
{
    let OrganizationRunTerminalSnapshot {
        identity,
        source_binding,
        native_run_id,
        delivery_context,
        phase,
        assistant_texts,
    } = snapshot;
    let Some(status) = native_terminal_status(phase) else {
        runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
            "nativeRunHash": identifier_hash(&native_run_id), "outcome": "non_terminal_phase",
            "phase": format!("{phase:?}"),
        }));
        return;
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
            return;
        }
        Err(_) => {
            runtime_trace("runtime.team_run.terminal.owner.reply", || json!({
                "nativeRunHash": native_run_hash, "outcome": "admission_or_reply_closed",
                "elapsedMs": started.map(|start| start.elapsed().as_millis()),
            }));
            observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
            return;
        }
    };
    if let TeamMessageTerminalObservation::Repair(dispatch) = observation_outcome {
        let session = TeamMessageRepairSession {
            identity,
            source_binding,
            endpoint_session_id: dispatch.endpoint_session_id().clone(),
        };
        schedule_repair(organization, repair_session, session, dispatch, observation).await;
    }
}

async fn schedule_repair<SourceBinding>(
    organization: &OrganizationHandle,
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    repair: TeamMessageRepairSession<SourceBinding>,
    dispatch: TeamMessageRepairDispatch,
    observation: &ObservationSink,
) where
    SourceBinding: Clone + Send + 'static,
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
        settle_rejected_repair(organization, dispatch, observation).await;
        return;
    };
    runtime_trace("runtime.team_run.repair.dispatch", || json!({
        "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
        "attempt": dispatch.attempt(), "outcome": "sending",
    }));
    let native_run_id = match session
        .send_repair(TeamMessageRepairSessionRequest {
            identity: repair.identity,
            source_binding: repair.source_binding,
            endpoint_session_id: dispatch.endpoint_session_id().clone(),
            requested_run_id: dispatch.requested_run_id().to_owned(),
            prompt: dispatch.prompt().to_owned(),
        })
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
        TeamMessageRepairSessionOutcome::Rejected => {
            runtime_trace("runtime.team_run.repair.dispatch", || json!({
                "nativeRunHash": identifier_hash(dispatch.requested_run_id()),
                "attempt": dispatch.attempt(), "outcome": "rejected",
            }));
            settle_rejected_repair(organization, dispatch, observation).await;
            return;
        }
        TeamMessageRepairSessionOutcome::Unknown => {
            runtime_trace("runtime.team_run.repair.dispatch", || json!({
                "nativeRunHash": identifier_hash(dispatch.requested_run_id()), "attempt": dispatch.attempt(),
                "outcome": "unknown", "pendingRetained": true,
            }));
            return;
        }
    };
    let native_run_hash = platform::trace::enabled().then(|| identifier_hash(&native_run_id));
    let result = organization.team_message_repair_queued(native_run_id, dispatch).await;
    runtime_trace("runtime.team_run.repair.queued.reply", || json!({
        "nativeRunHash": native_run_hash,
        "outcome": if result.is_ok() { "accepted" } else { "admission_or_reply_closed" },
    }));
    if result.is_err() {
        observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
    }
}

async fn settle_rejected_repair(
    organization: &OrganizationHandle,
    dispatch: TeamMessageRepairDispatch,
    observation: &ObservationSink,
) {
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
        Ok(Ok(())) => {}
        Ok(Err(_)) => observe_event(
            observation,
            EventStage::Drop,
            Some(EventReason::ValidationRejected),
        ),
        Err(_) => observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed)),
    }
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

fn observe_enqueue_failure<SourceBinding>(
    observation: &ObservationSink,
    error: &mpsc::error::TrySendError<OrganizationRunTerminalSnapshot<SourceBinding>>,
) {
    let reason = match error {
        mpsc::error::TrySendError::Full(_) => EventReason::SinkFull,
        mpsc::error::TrySendError::Closed(_) => EventReason::SinkClosed,
    };
    observe_event(observation, EventStage::Drop, Some(reason));
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
