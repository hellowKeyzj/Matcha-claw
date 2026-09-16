use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use foundation::execution::{ObservationSink, OperationHandle, TraceContext};
use tokio::sync::{Mutex, mpsc};

use crate::{
    RuntimeSessionError,
    composition::{HostAdmission, RequestAdmissionClosed},
    runtime::directory::RuntimeDriverDirectory,
    sessions::SessionHandle,
};

use super::driver_lookup::RuntimeDrivers;

const CRON_EXECUTION_CAPACITY: usize = 32;
const CRON_EXECUTION_TRACE_NAME: &str = "cron.execution";

static NEXT_CRON_EXECUTION_TRACE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct CronHandle {
    admission: Arc<HostAdmission>,
    runtimes: RuntimeDrivers,
    session: SessionHandle,
    events: Option<mpsc::Sender<(String, String, crate::cron::CronExecutionTerminalStatus)>>,
    observation: ObservationSink,
    active_executions: Arc<Mutex<Vec<CronExecution>>>,
}

struct CronExecution {
    job_id: String,
    run_id: String,
    handle: OperationHandle<crate::cron::CronExecutionTerminalStatus>,
}

impl CronHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
        session: SessionHandle,
        events: Option<mpsc::Sender<(String, String, openclaw::port::CronExecutionStatus)>>,
        observation: ObservationSink,
    ) -> Self {
        Self {
            admission,
            runtimes: RuntimeDrivers::new(runtime_directory),
            session,
            events: events.map(project_execution_events),
            observation,
            active_executions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(crate) async fn list(&self) -> crate::cron::CronListOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronListOutcome::Unavailable;
        }
        let Some(driver) = self.running_cron_driver() else {
            return crate::cron::CronListOutcome::Unavailable;
        };
        let Some(ops) = driver.cron_ops() else {
            return crate::cron::CronListOutcome::Unavailable;
        };
        ops.list_cron_jobs().await
    }

    pub(crate) async fn load_history(
        &self,
        command: crate::cron::CronHistoryCommand,
    ) -> crate::cron::CronHistoryOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronHistoryOutcome::Unavailable;
        }
        let Some(driver) = self.running_cron_driver() else {
            return crate::cron::CronHistoryOutcome::Unavailable;
        };
        let Some(ops) = driver.cron_ops() else {
            return crate::cron::CronHistoryOutcome::Unavailable;
        };
        let receipts = match ops
            .cron_run_history(command.job_id().to_owned(), command.limit())
            .await
        {
            Ok(receipts) => receipts.into_iter(),
            Err(crate::cron::CronRunHistoryFailure::Rejected) => {
                return crate::cron::CronHistoryOutcome::Rejected;
            }
            Err(crate::cron::CronRunHistoryFailure::Protocol) => {
                return crate::cron::CronHistoryOutcome::Protocol;
            }
            Err(crate::cron::CronRunHistoryFailure::Deadline) => {
                return crate::cron::CronHistoryOutcome::Deadline;
            }
            Err(crate::cron::CronRunHistoryFailure::Unavailable) => {
                return crate::cron::CronHistoryOutcome::Unavailable;
            }
        };
        let session_key = match command.canonical_session_key(receipts) {
            Some(session_key) => session_key,
            None => return crate::cron::CronHistoryOutcome::Rejected,
        };
        let session_key = match openclaw::session::protocol::SessionKey::try_new(session_key) {
            Ok(session_key) => session_key,
            Err(_) => return crate::cron::CronHistoryOutcome::Protocol,
        };
        let params = match openclaw::session::protocol::ChatHistoryParams::new(session_key)
            .try_with_limit(command.limit())
        {
            Ok(params) => params,
            Err(_) => return crate::cron::CronHistoryOutcome::Protocol,
        };
        match self.session.openclaw_history(params).await {
            Ok(Ok(history)) => {
                crate::cron::CronHistoryOutcome::Loaded(project_history_view(history))
            }
            Ok(Err(
                RuntimeSessionError::AdmissionClosed(_) | RuntimeSessionError::RuntimeUnavailable,
            ))
            | Err(()) => crate::cron::CronHistoryOutcome::Unavailable,
            Ok(Err(RuntimeSessionError::Client(
                openclaw::port::OpenClawSessionError::TargetRejected,
            ))) => crate::cron::CronHistoryOutcome::Rejected,
            Ok(Err(RuntimeSessionError::Client(
                openclaw::port::OpenClawSessionError::RequestDeadline,
            ))) => crate::cron::CronHistoryOutcome::Deadline,
            Ok(Err(RuntimeSessionError::Client(
                openclaw::port::OpenClawSessionError::Protocol(_)
                | openclaw::port::OpenClawSessionError::UnknownResponse,
            ))) => crate::cron::CronHistoryOutcome::Protocol,
            Ok(Err(RuntimeSessionError::Client(_))) => crate::cron::CronHistoryOutcome::Unavailable,
        }
    }

    pub(crate) async fn create(
        &self,
        command: crate::cron::CronCreateCommand,
    ) -> crate::cron::CronJobMutationOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        }
        let Some(driver) = self.running_cron_driver() else {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        };
        match driver.cron_ops() {
            Some(ops) => ops.add_cron_job(command).await,
            None => crate::cron::CronJobMutationOutcome::Unavailable,
        }
    }

    pub(crate) async fn update(
        &self,
        command: crate::cron::CronUpdateCommand,
    ) -> crate::cron::CronJobMutationOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        }
        let Some(driver) = self.running_cron_driver() else {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        };
        match driver.cron_ops() {
            Some(ops) => ops.update_cron_job(command).await,
            None => crate::cron::CronJobMutationOutcome::Unavailable,
        }
    }

    pub(crate) async fn delete(
        &self,
        command: crate::cron::CronDeleteCommand,
    ) -> crate::cron::CronDeleteOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronDeleteOutcome::Unavailable;
        }
        let Some(driver) = self.running_cron_driver() else {
            return crate::cron::CronDeleteOutcome::Unavailable;
        };
        match driver.cron_ops() {
            Some(ops) => ops.delete_cron_job(command).await,
            None => crate::cron::CronDeleteOutcome::Unavailable,
        }
    }

    pub(crate) async fn trigger(
        &self,
        job_id: String,
    ) -> Result<crate::cron::CronTriggerResult, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        let Some(driver) = self.running_cron_driver() else {
            return Ok(crate::cron::CronTriggerResult::OutcomeUnknown);
        };
        let Some(ops) = driver.cron_ops() else {
            return Ok(crate::cron::CronTriggerResult::OutcomeUnknown);
        };
        self.reap_active_executions().await;
        let mut active_executions = self.active_executions.lock().await;
        if active_executions.len() >= CRON_EXECUTION_CAPACITY {
            return Ok(crate::cron::CronTriggerResult::OutcomeUnknown);
        }
        let Some(events) = self.events.clone() else {
            return Ok(crate::cron::CronTriggerResult::OutcomeUnknown);
        };
        let admission = match ops.admit_cron_execution(job_id.clone()).await {
            Ok(Ok(admission)) => admission,
            Ok(Err(status)) => return Ok(status),
            Err(_) => return Ok(crate::cron::CronTriggerResult::OutcomeUnknown),
        };
        let run_id = admission.run_id().to_owned();
        let event_job_id = job_id.clone();
        let event_run_id = run_id.clone();
        let operation = if self.observation.is_enabled() {
            OperationHandle::spawn_observed(
                self.observation.clone(),
                next_cron_execution_trace(),
                CRON_EXECUTION_TRACE_NAME,
                move |cancellation| async move {
                    let status = admission.await_terminal(cancellation).await;
                    let _ = events.try_send((event_job_id, event_run_id, status));
                    status
                },
            )
            .0
        } else {
            OperationHandle::spawn(move |cancellation| async move {
                let status = admission.await_terminal(cancellation).await;
                let _ = events.try_send((event_job_id, event_run_id, status));
                status
            })
            .0
        };
        active_executions.push(CronExecution {
            job_id,
            run_id,
            handle: operation,
        });
        Ok(crate::cron::CronTriggerResult::Accepted)
    }

    pub(crate) async fn cancel_operations(&self) {
        let mut active_executions = self.active_executions.lock().await;
        let events = self.events.clone();
        for execution in active_executions.iter() {
            execution.handle.cancel();
        }
        for mut execution in active_executions.drain(..) {
            if execution.handle.join().await.is_err() {
                if let Some(events) = &events {
                    let _ = events.try_send((
                        execution.job_id,
                        execution.run_id,
                        crate::cron::CronExecutionTerminalStatus::OutcomeUnknown,
                    ));
                }
            }
        }
    }

    async fn reap_active_executions(&self) {
        let mut active_executions = self.active_executions.lock().await;
        let events = self.events.clone();
        let mut pending = Vec::with_capacity(active_executions.len());
        for mut execution in active_executions.drain(..) {
            if execution.handle.is_finished() {
                if execution.handle.join().await.is_err() {
                    if let Some(events) = &events {
                        let _ = events.try_send((
                            execution.job_id,
                            execution.run_id,
                            crate::cron::CronExecutionTerminalStatus::OutcomeUnknown,
                        ));
                    }
                }
            } else {
                pending.push(execution);
            }
        }
        *active_executions = pending;
    }

    fn running_cron_driver(&self) -> Option<Arc<dyn crate::runtime::driver::RuntimeDriver>> {
        self.runtimes.ready_openclaw_driver()
    }
}

fn project_execution_events(
    events: mpsc::Sender<(String, String, openclaw::port::CronExecutionStatus)>,
) -> mpsc::Sender<(String, String, crate::cron::CronExecutionTerminalStatus)> {
    let (sender, mut receiver) = mpsc::channel(CRON_EXECUTION_CAPACITY);
    tokio::spawn(async move {
        while let Some((job_id, run_id, status)) = receiver.recv().await {
            let _ = events
                .send((job_id, run_id, project_native_execution_status(status)))
                .await;
        }
    });
    sender
}

fn project_history_view(
    history: openclaw::session::protocol::ChatHistoryResult,
) -> crate::cron::CronHistoryView {
    crate::cron::CronHistoryView {
        messages: history
            .messages
            .into_iter()
            .map(project_history_message_view)
            .collect(),
    }
}

fn project_history_message_view(
    message: openclaw::session::protocol::HistoryMessage,
) -> crate::cron::CronHistoryMessageView {
    crate::cron::CronHistoryMessageView {
        role: match message.role {
            openclaw::session::protocol::HistoryRole::User => crate::cron::CronHistoryRole::User,
            openclaw::session::protocol::HistoryRole::Assistant => {
                crate::cron::CronHistoryRole::Assistant
            }
        },
        text: message.text,
    }
}

fn project_native_execution_status(
    status: crate::cron::CronExecutionTerminalStatus,
) -> openclaw::port::CronExecutionStatus {
    match status {
        crate::cron::CronExecutionTerminalStatus::Succeeded => {
            openclaw::port::CronExecutionStatus::Succeeded
        }
        crate::cron::CronExecutionTerminalStatus::Failed => {
            openclaw::port::CronExecutionStatus::Failed
        }
        crate::cron::CronExecutionTerminalStatus::Skipped => {
            openclaw::port::CronExecutionStatus::Skipped
        }
        crate::cron::CronExecutionTerminalStatus::Cancelled => {
            openclaw::port::CronExecutionStatus::Cancelled
        }
        crate::cron::CronExecutionTerminalStatus::OutcomeUnknown => {
            openclaw::port::CronExecutionStatus::OutcomeUnknown
        }
    }
}

fn next_cron_execution_trace() -> TraceContext {
    TraceContext::root(NEXT_CRON_EXECUTION_TRACE.fetch_add(1, Ordering::Relaxed))
}
