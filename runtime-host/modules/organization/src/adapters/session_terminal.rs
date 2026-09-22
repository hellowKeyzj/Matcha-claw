use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use foundation::execution::{
    EventObservation, EventReason, EventStage, ObservationRecord, ObservationSink,
    OperationObservation, OperationReason, OperationStage, TraceContext,
};
use tokio::{sync::mpsc, task::JoinError};

use super::start_gate_send_hook::StartGateRegistry;
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
pub enum OrganizationSessionProvider {
    OpenClaw,
    MatchaAgent,
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
    pub provider: OrganizationSessionProvider,
    pub session_key: String,
    pub route_key: Option<String>,
    pub source_binding: SourceBinding,
    pub native_run_id: String,
    pub phase: OrganizationRunPhase,
    pub final_assistant_text: Option<String>,
}

pub struct TeamMessageRepairSessionRequest<SourceBinding> {
    pub provider: OrganizationSessionProvider,
    pub session_key: String,
    pub route_key: Option<String>,
    pub source_binding: SourceBinding,
    pub endpoint_session_id: crate::EndpointSessionId,
    pub requested_run_id: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageRepairSessionOutcome {
    Queued { native_run_id: String },
    Rejected,
}

/// Consumes sessions run-terminal snapshots for the organization owner.
///
/// `run_terminal` is synchronous on the sessions lane, so it only enqueues; every settlement call
/// happens on the task started by [`OrganizationSessionTerminal::start`].
pub struct OrganizationSessionTerminal<SourceBinding> {
    start_gate: Arc<StartGateRegistry>,
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    snapshots: Mutex<Option<mpsc::Sender<OrganizationRunTerminalSnapshot<SourceBinding>>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    observation: ObservationSink,
}

#[derive(Clone)]
struct TeamMessageRepairSession<SourceBinding> {
    provider: OrganizationSessionProvider,
    session_key: String,
    route_key: Option<String>,
    source_binding: SourceBinding,
    endpoint_session_id: crate::EndpointSessionId,
}

impl<SourceBinding> OrganizationSessionTerminal<SourceBinding>
where
    SourceBinding: Clone + Send + 'static,
{
    pub fn start(organization: OrganizationHandle, observation: ObservationSink) -> Self {
        let start_gate = Arc::new(StartGateRegistry::new());
        let repair_session = Arc::new(Mutex::new(None));
        let (snapshots, receiver) = mpsc::channel(SESSION_TERMINAL_CAPACITY);
        let task = tokio::spawn(consume(
            organization,
            Arc::clone(&start_gate),
            Arc::clone(&repair_session),
            receiver,
            observation.clone(),
        ));
        Self {
            start_gate,
            repair_session,
            snapshots: Mutex::new(Some(snapshots)),
            task: Mutex::new(Some(task)),
            observation,
        }
    }

    pub fn start_gate_registry(&self) -> Arc<StartGateRegistry> {
        Arc::clone(&self.start_gate)
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
        let snapshots = self
            .snapshots
            .lock()
            .expect("session terminal sender mutex poisoned")
            .clone();
        match snapshots {
            Some(sender) => {
                if let Err(error) = sender.try_send(snapshot) {
                    observe_enqueue_failure(&self.observation, &error);
                }
            }
            None => observe_event(
                &self.observation,
                EventStage::Drop,
                Some(EventReason::SinkClosed),
            ),
        }
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
    start_gate: Arc<StartGateRegistry>,
    repair_session: Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    mut snapshots: mpsc::Receiver<OrganizationRunTerminalSnapshot<SourceBinding>>,
    observation: ObservationSink,
) where
    SourceBinding: Clone + Send + 'static,
{
    observe_operation(&observation, OperationStage::Start, None);
    while let Some(snapshot) = snapshots.recv().await {
        settle(
            &organization,
            &start_gate,
            &repair_session,
            snapshot,
            settlement_timestamp_seconds(),
            &observation,
        )
        .await;
    }
}

async fn settle<SourceBinding>(
    organization: &OrganizationHandle,
    start_gate: &StartGateRegistry,
    repair_session: &Arc<Mutex<Option<Arc<dyn TeamMessageRepairSessionPort<SourceBinding>>>>>,
    snapshot: OrganizationRunTerminalSnapshot<SourceBinding>,
    settled_at: u64,
    observation: &ObservationSink,
) where
    SourceBinding: Clone + Send + 'static,
{
    let OrganizationRunTerminalSnapshot {
        provider,
        session_key,
        route_key,
        source_binding,
        native_run_id,
        phase,
        final_assistant_text,
    } = snapshot;
    settle_start_gate_proposal(
        organization,
        start_gate,
        &native_run_id,
        phase,
        final_assistant_text.as_deref(),
        observation,
    )
    .await;
    let Some(status) = native_terminal_status(phase) else {
        return;
    };
    let observation_outcome = match organization
        .team_message_terminal_observed(native_run_id, status, final_assistant_text, settled_at)
        .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => {
            observe_event(
                observation,
                EventStage::Drop,
                Some(EventReason::ValidationRejected),
            );
            return;
        }
        Err(_) => {
            observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
            return;
        }
    };
    if let TeamMessageTerminalObservation::Repair(dispatch) = observation_outcome {
        let session = TeamMessageRepairSession {
            provider,
            session_key,
            route_key,
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
        settle_rejected_repair(organization, dispatch, observation).await;
        return;
    };
    let native_run_id = match session
        .send_repair(TeamMessageRepairSessionRequest {
            provider: repair.provider,
            session_key: repair.session_key,
            route_key: repair.route_key,
            source_binding: repair.source_binding,
            endpoint_session_id: dispatch.endpoint_session_id().clone(),
            requested_run_id: dispatch.requested_run_id().to_owned(),
            prompt: dispatch.prompt().to_owned(),
        })
        .await
    {
        TeamMessageRepairSessionOutcome::Queued { native_run_id } => native_run_id,
        TeamMessageRepairSessionOutcome::Rejected => {
            settle_rejected_repair(organization, dispatch, observation).await;
            return;
        }
    };
    if organization
        .team_message_repair_queued(native_run_id, dispatch)
        .await
        .is_err()
    {
        observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
    }
}

async fn settle_rejected_repair(
    organization: &OrganizationHandle,
    dispatch: TeamMessageRepairDispatch,
    observation: &ObservationSink,
) {
    match organization.team_message_repair_rejected(dispatch).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => observe_event(
            observation,
            EventStage::Drop,
            Some(EventReason::ValidationRejected),
        ),
        Err(_) => observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed)),
    }
}

async fn settle_start_gate_proposal(
    organization: &OrganizationHandle,
    start_gate: &StartGateRegistry,
    native_run_id: &str,
    phase: OrganizationRunPhase,
    final_assistant_text: Option<&str>,
    observation: &ObservationSink,
) {
    let Some((run_id, proposal_id)) = start_gate.take(native_run_id) else {
        return;
    };
    if phase != OrganizationRunPhase::Completed {
        return;
    }
    let Some(text) = final_assistant_text else {
        return;
    };
    match organization
        .start_gate_terminal_proposal_set(
            run_id,
            proposal_id,
            native_run_id.to_owned(),
            text.to_owned(),
        )
        .await
    {
        Ok(Ok(_)) => {}
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

fn settlement_timestamp_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
