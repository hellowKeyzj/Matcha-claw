use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use foundation::execution::{
    EventObservation, EventReason, EventStage, ObservationRecord, ObservationSink,
    OperationObservation, OperationReason, OperationStage, TraceContext,
};
use sha2::{Digest, Sha256};
use tokio::{sync::mpsc, task::JoinError};

use crate::{
    runtime::driver::NativeRunSettled,
    sessions::{
        SessionHandle, SessionRunTerminalSnapshot, SessionTerminalHook,
        command::role_session_route_key,
        send::{NativeEndpoint, SessionSendCommand, SessionSendOutcome},
        state::{RunPhase, SessionProvider, SessionSourceBinding},
    },
};

use super::{OrganizationHandle, start_gate_control, start_gate_send_hook::StartGateRegistry};

const SESSION_TERMINAL_CAPACITY: usize = 256;

/// Consumes sessions run-terminal snapshots for the organization owner.
///
/// `run_terminal` is synchronous on the sessions lane, so it only enqueues; every settlement call
/// happens on the task started by [`OrganizationSessionTerminal::start`].
pub(crate) struct OrganizationSessionTerminal {
    start_gate: Arc<StartGateRegistry>,
    repair_session: Arc<Mutex<Option<SessionHandle>>>,
    snapshots: Mutex<Option<mpsc::Sender<SessionRunTerminalSnapshot>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    observation: ObservationSink,
}

#[derive(Clone)]
struct TeamMessageRepairSession {
    provider: SessionProvider,
    session_key: String,
    route_key: Option<String>,
    source_binding: SessionSourceBinding,
    endpoint_session_id: organization::EndpointSessionId,
}

struct TeamMessageRepair {
    delivery_id: organization::DeliveryId,
    run_id: organization::GraphRunId,
    status: organization::NativeTerminalStatus,
    settled_at: u64,
    attempt: usize,
    session: TeamMessageRepairSession,
    last_invalid_output: String,
}

impl OrganizationSessionTerminal {
    pub(crate) fn start(organization: OrganizationHandle, observation: ObservationSink) -> Self {
        let start_gate = Arc::new(StartGateRegistry::new());
        let repairs = Arc::new(Mutex::new(BTreeMap::new()));
        let repair_session = Arc::new(Mutex::new(None));
        let (snapshots, receiver) = mpsc::channel(SESSION_TERMINAL_CAPACITY);
        let task = tokio::spawn(consume(
            organization,
            Arc::clone(&start_gate),
            Arc::clone(&repairs),
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

    pub(crate) fn start_gate_registry(&self) -> Arc<StartGateRegistry> {
        Arc::clone(&self.start_gate)
    }

    pub(crate) fn bind_session(&self, session: SessionHandle) {
        *self
            .repair_session
            .lock()
            .expect("session repair handle mutex poisoned") = Some(session);
    }

    pub(crate) async fn close_and_join(&self) -> Result<(), JoinError> {
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

impl SessionTerminalHook for OrganizationSessionTerminal {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot) {
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
}

async fn consume(
    organization: OrganizationHandle,
    start_gate: Arc<StartGateRegistry>,
    repairs: Arc<Mutex<BTreeMap<String, TeamMessageRepair>>>,
    repair_session: Arc<Mutex<Option<SessionHandle>>>,
    mut snapshots: mpsc::Receiver<SessionRunTerminalSnapshot>,
    observation: ObservationSink,
) {
    observe_operation(&observation, OperationStage::Start, None);
    while let Some(snapshot) = snapshots.recv().await {
        settle(
            &organization,
            &start_gate,
            &repairs,
            &repair_session,
            snapshot,
            settlement_timestamp_seconds(),
            &observation,
        )
        .await;
    }
}

async fn settle(
    organization: &OrganizationHandle,
    start_gate: &StartGateRegistry,
    repairs: &Arc<Mutex<BTreeMap<String, TeamMessageRepair>>>,
    repair_session: &Arc<Mutex<Option<SessionHandle>>>,
    snapshot: SessionRunTerminalSnapshot,
    settled_at: u64,
    observation: &ObservationSink,
) {
    let SessionRunTerminalSnapshot {
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
    if let Some(repair) = take_repair(repairs, &native_run_id) {
        settle_or_repair(
            organization,
            repairs,
            repair_session,
            repair,
            final_assistant_text,
            observation,
        )
        .await;
        return;
    }
    let delivery_id = match organization.native_delivery_by_run(native_run_id).await {
        Ok(Some(delivery_id)) => delivery_id,
        Ok(None) => return,
        Err(_) => {
            observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
            return;
        }
    };
    let target = match organization
        .native_terminal_target(delivery_id.clone())
        .await
    {
        Ok(Some(target)) => target,
        Ok(None) => return,
        Err(_) => {
            observe_event(observation, EventStage::Drop, Some(EventReason::SinkClosed));
            return;
        }
    };
    let repair = TeamMessageRepair {
        delivery_id,
        run_id: target.graph_run_id().clone(),
        status,
        settled_at,
        attempt: 0,
        session: TeamMessageRepairSession {
            provider,
            session_key,
            route_key,
            source_binding,
            endpoint_session_id: target.correlation().endpoint_session_id().clone(),
        },
        last_invalid_output: String::new(),
    };
    settle_or_repair(
        organization,
        repairs,
        repair_session,
        repair,
        final_assistant_text,
        observation,
    )
    .await;
}

async fn settle_or_repair(
    organization: &OrganizationHandle,
    repairs: &Arc<Mutex<BTreeMap<String, TeamMessageRepair>>>,
    repair_session: &Arc<Mutex<Option<SessionHandle>>>,
    repair: TeamMessageRepair,
    final_assistant_text: Option<String>,
    observation: &ObservationSink,
) {
    let Some(text) = final_assistant_text else {
        settle_team_delivery(organization, repair, None, observation).await;
        return;
    };
    match super::team_message::parse_or_normalize_team_message_text(&text) {
        Ok(normalized) => {
            settle_team_delivery(organization, repair, Some(normalized), observation).await
        }
        Err(error) => {
            let mut repair = repair;
            repair.last_invalid_output = text;
            match schedule_repair(repairs, repair_session, repair, error).await {
                Ok(()) => {}
                Err(repair) => {
                    let final_assistant_text = Some(repair.last_invalid_output.clone());
                    settle_team_delivery(organization, repair, final_assistant_text, observation)
                        .await;
                }
            }
        }
    }
}

async fn settle_team_delivery(
    organization: &OrganizationHandle,
    repair: TeamMessageRepair,
    final_assistant_text: Option<String>,
    observation: &ObservationSink,
) {
    match organization
        .native_run_settled(
            repair.run_id,
            repair.delivery_id,
            NativeRunSettled {
                status: repair.status,
                final_assistant_text,
            },
            repair.settled_at,
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

async fn schedule_repair(
    repairs: &Arc<Mutex<BTreeMap<String, TeamMessageRepair>>>,
    repair_session: &Arc<Mutex<Option<SessionHandle>>>,
    mut repair: TeamMessageRepair,
    error: super::team_message::TeamMessageError,
) -> Result<(), TeamMessageRepair> {
    if repair.attempt >= super::team_message::MAX_REPAIR_ATTEMPTS {
        return Err(repair);
    }
    let next_attempt = repair.attempt + 1;
    let prompt = super::team_message::build_team_message_repair_prompt(
        next_attempt,
        &repair.last_invalid_output,
        &error,
    );
    let requested_run_id = team_message_repair_run_id(&repair.delivery_id, next_attempt);
    let Some(command) = repair_send_command(&repair.session, requested_run_id, prompt.as_str())
    else {
        return Err(repair);
    };
    let session = repair_session
        .lock()
        .expect("session repair handle mutex poisoned")
        .clone();
    let Some(session) = session else {
        return Err(repair);
    };
    let native_run_id = match session.send_session(command).await {
        Ok(SessionSendOutcome::Queued { run_id })
        | Ok(SessionSendOutcome::Succeeded { run_id, .. }) => run_id,
        Ok(SessionSendOutcome::Rejected)
        | Ok(SessionSendOutcome::Unknown)
        | Ok(SessionSendOutcome::Unsupported)
        | Ok(SessionSendOutcome::Unavailable)
        | Err(_) => return Err(repair),
    };
    repair.attempt = next_attempt;
    repairs
        .lock()
        .expect("team message repair registry lock is never poisoned")
        .insert(native_run_id, repair);
    Ok(())
}

fn repair_send_command(
    session: &TeamMessageRepairSession,
    run_id: String,
    prompt: &str,
) -> Option<SessionSendCommand> {
    let route_key = session
        .route_key
        .clone()
        .unwrap_or_else(|| role_session_route_key(&session.session_key));
    SessionSendCommand::try_new(
        native_endpoint(session.provider),
        session.session_key.clone(),
        Some(session.endpoint_session_id.as_str().to_owned()),
        route_key,
        prompt.to_owned(),
        Some(run_id),
        None,
        Some(true),
        Vec::new(),
        None,
    )
    .ok()
    .map(|command| command.with_source_binding(session.source_binding.clone()))
}

fn native_endpoint(provider: SessionProvider) -> NativeEndpoint {
    match provider {
        SessionProvider::OpenClaw => NativeEndpoint::OpenClawLocal,
        SessionProvider::MatchaAgent => NativeEndpoint::MatchaAgentLocal,
    }
}

fn team_message_repair_run_id(delivery_id: &organization::DeliveryId, attempt: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(delivery_id.as_str().as_bytes());
    digest.update([0]);
    digest.update(attempt.to_le_bytes());
    format!("tmr-{:x}", digest.finalize())
}

fn take_repair(
    repairs: &Arc<Mutex<BTreeMap<String, TeamMessageRepair>>>,
    native_run_id: &str,
) -> Option<TeamMessageRepair> {
    repairs
        .lock()
        .expect("team message repair registry lock is never poisoned")
        .remove(native_run_id)
}

async fn settle_start_gate_proposal(
    organization: &OrganizationHandle,
    start_gate: &StartGateRegistry,
    native_run_id: &str,
    phase: RunPhase,
    final_assistant_text: Option<&str>,
    observation: &ObservationSink,
) {
    let Some((run_id, proposal_id)) = start_gate.take(native_run_id) else {
        return;
    };
    if phase != RunPhase::Completed {
        return;
    }
    let Some(text) = final_assistant_text else {
        return;
    };
    if let start_gate_control::TeamControl::ProposeRun(summary) =
        start_gate_control::parse_control(text)
    {
        match organization
            .run_start_proposal_set(run_id, proposal_id, summary, native_run_id.to_owned())
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
}

fn native_terminal_status(phase: RunPhase) -> Option<organization::NativeTerminalStatus> {
    match phase {
        RunPhase::Completed => Some(organization::NativeTerminalStatus::Completed),
        RunPhase::Failed => Some(organization::NativeTerminalStatus::Failed),
        RunPhase::Cancelled => Some(organization::NativeTerminalStatus::Cancelled),
        RunPhase::Interrupted => Some(organization::NativeTerminalStatus::Interrupted),
        RunPhase::Queued
        | RunPhase::Started
        | RunPhase::WaitingForApproval
        | RunPhase::CancellationRequested => None,
    }
}

fn observe_enqueue_failure(
    observation: &ObservationSink,
    error: &mpsc::error::TrySendError<SessionRunTerminalSnapshot>,
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
