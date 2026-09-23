use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::{
    sync::mpsc,
    time::{Duration, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    delivery::{DispatcherError, MutationDelivery},
    dispatcher::Dispatcher,
    wire::{self, GatewayEvent, RpcRequest},
};

use super::provider::CronProvider;

const CRON_EVENT_DEADLINE: Duration = Duration::from_secs(15 * 60);
const EARLY_EVENT_CAPACITY: usize = 16;
static NEXT_CRON_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn next_request_id() -> String {
    let sequence = NEXT_CRON_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cron-run-{timestamp}-{sequence}")
}

pub struct CronExecutionAdmission {
    pub(crate) client: Arc<GatewayClient>,
    pub(crate) job_id: String,
    pub(crate) run_id: String,
    pub(crate) dispatcher: Dispatcher,
    pub(crate) events: mpsc::Receiver<GatewayEvent>,
    pub(crate) terminal: Option<CronExecutionStatus>,
}

impl CronExecutionAdmission {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronExecutionStatus {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronTriggerOutcome {
    Accepted,
    Skipped(CronRunDisposition),
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronRunDisposition {
    AlreadyRunning,
    NotDue,
    InvalidSpec,
    Disabled,
    Stopped,
}

fn map_run_disposition(disposition: wire::cron::CronRunDisposition) -> CronRunDisposition {
    match disposition {
        wire::cron::CronRunDisposition::AlreadyRunning => CronRunDisposition::AlreadyRunning,
        wire::cron::CronRunDisposition::NotDue => CronRunDisposition::NotDue,
        wire::cron::CronRunDisposition::InvalidSpec => CronRunDisposition::InvalidSpec,
        wire::cron::CronRunDisposition::Disabled => CronRunDisposition::Disabled,
        wire::cron::CronRunDisposition::Stopped => CronRunDisposition::Stopped,
    }
}

pub async fn admit(
    client: Arc<GatewayClient>,
    job_id: String,
) -> Result<Result<CronExecutionAdmission, CronTriggerOutcome>, GatewayClientError> {
    let request = wire::cron::run_force_request(next_request_id(), job_id.clone())
        .map_err(|_| GatewayClientError::Protocol)?;
    let socket = client.connect_cron_execution().await?;
    let (dispatcher, mut events) = Dispatcher::new(socket);
    let response = match receive_run_receipt(&dispatcher, request).await? {
        Ok(response) => response,
        Err(outcome) => {
            dispatcher.close().await;
            return Ok(Err(outcome));
        }
    };
    let receipt = match wire::cron::decode_run(response) {
        Ok(receipt) => receipt,
        Err(_) => {
            dispatcher.close().await;
            return Ok(Err(CronTriggerOutcome::OutcomeUnknown));
        }
    };
    match receipt.into_outcome() {
        wire::cron::CronRunReceiptOutcome::Enqueued { run_id } => {
            let terminal = drain_early_terminal(&mut events, &job_id, &run_id);
            Ok(Ok(CronExecutionAdmission {
                client,
                job_id,
                run_id,
                dispatcher,
                events,
                terminal,
            }))
        }
        wire::cron::CronRunReceiptOutcome::Ran => {
            dispatcher.close().await;
            Ok(Err(CronTriggerOutcome::Accepted))
        }
        wire::cron::CronRunReceiptOutcome::Skipped(disposition) => {
            dispatcher.close().await;
            Ok(Err(CronTriggerOutcome::Skipped(map_run_disposition(
                disposition,
            ))))
        }
        wire::cron::CronRunReceiptOutcome::OutcomeUnknown => {
            dispatcher.close().await;
            Ok(Err(CronTriggerOutcome::OutcomeUnknown))
        }
    }
}

pub async fn await_terminal(
    mut admission: CronExecutionAdmission,
    cancellation: CancellationToken,
) -> CronExecutionStatus {
    if let Some(status) = admission.terminal {
        admission.dispatcher.close().await;
        return status;
    }
    let result = timeout(
        CRON_EVENT_DEADLINE,
        receive_terminal(
            &mut admission.events,
            &admission.job_id,
            &admission.run_id,
            cancellation.clone(),
        ),
    )
    .await;
    admission.dispatcher.close().await;
    match result {
        Ok(Some(status)) => status,
        Ok(None) | Err(_) => {
            read_terminal_from_native_history(
                admission.client,
                admission.job_id,
                admission.run_id,
                cancellation,
            )
            .await
        }
    }
}

async fn receive_run_receipt(
    dispatcher: &Dispatcher,
    request: RpcRequest,
) -> Result<Result<wire::GatewayResponse, CronTriggerOutcome>, GatewayClientError> {
    match dispatcher.mutate(request).await {
        MutationDelivery::Response(wire::GatewayResponse::Failure { .. }) => {
            Ok(Err(CronTriggerOutcome::OutcomeUnknown))
        }
        MutationDelivery::Response(response) => Ok(Ok(response)),
        MutationDelivery::NotWritten(error) => Err(map_dispatcher_error(error)),
        MutationDelivery::MayHaveReached(_) => Ok(Err(CronTriggerOutcome::OutcomeUnknown)),
    }
}

fn drain_early_terminal(
    events: &mut mpsc::Receiver<GatewayEvent>,
    job_id: &str,
    run_id: &str,
) -> Option<CronExecutionStatus> {
    let mut buffered = Vec::with_capacity(EARLY_EVENT_CAPACITY);
    while let Ok(event) = events.try_recv() {
        if buffered.len() == EARLY_EVENT_CAPACITY {
            buffered.remove(0);
        }
        buffered.push(event);
    }
    buffered
        .into_iter()
        .find_map(|event| terminal_status(event, job_id, run_id))
}

fn terminal_status(event: GatewayEvent, job_id: &str, run_id: &str) -> Option<CronExecutionStatus> {
    wire::cron::decode_run_finished_event(event, job_id, run_id)
        .ok()
        .flatten()
        .map(|status| match status {
            wire::cron::CronRunStatus::Ok => CronExecutionStatus::Succeeded,
            wire::cron::CronRunStatus::Error => CronExecutionStatus::Failed,
            wire::cron::CronRunStatus::Skipped => CronExecutionStatus::Skipped,
        })
}

async fn read_terminal_from_native_history(
    client: Arc<GatewayClient>,
    job_id: String,
    run_id: String,
    cancellation: CancellationToken,
) -> CronExecutionStatus {
    let provider = CronProvider::new(client);
    let result = tokio::select! {
        _ = cancellation.cancelled() => return CronExecutionStatus::Cancelled,
        result = provider.run_status(job_id, run_id) => result,
    };
    match result {
        Ok(Some(wire::cron::CronRunStatus::Ok)) => CronExecutionStatus::Succeeded,
        Ok(Some(wire::cron::CronRunStatus::Error)) => CronExecutionStatus::Failed,
        Ok(Some(wire::cron::CronRunStatus::Skipped)) => CronExecutionStatus::Skipped,
        Ok(None) | Err(_) => CronExecutionStatus::OutcomeUnknown,
    }
}

async fn receive_terminal(
    events: &mut mpsc::Receiver<GatewayEvent>,
    job_id: &str,
    run_id: &str,
    cancellation: CancellationToken,
) -> Option<CronExecutionStatus> {
    loop {
        let event = tokio::select! {
            _ = cancellation.cancelled() => return Some(CronExecutionStatus::Cancelled),
            event = events.recv() => event,
        }?;
        if let Some(status) = terminal_status(event, job_id, run_id) {
            return Some(status);
        }
    }
}

fn map_dispatcher_error(error: DispatcherError) -> GatewayClientError {
    match error {
        DispatcherError::Deadline => GatewayClientError::RpcDeadline,
        DispatcherError::ConnectionClosed => GatewayClientError::ConnectionClosed,
        DispatcherError::Transport => GatewayClientError::Transport,
        DispatcherError::Protocol
        | DispatcherError::EventBackpressure
        | DispatcherError::Saturated => GatewayClientError::Protocol,
    }
}
