use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use foundation::execution::{ObservationSink, OperationHandle, TraceContext};
use tokio::sync::{Mutex, mpsc};

use crate::{
    RuntimeSessionError,
    composition::{HostAdmission, RequestAdmissionClosed},
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::RuntimeDriverIdentity,
    sessions::SessionHandle,
};

const CRON_OPERATION_CAPACITY: usize = 32;
const CRON_EXECUTION_OPERATION: &str = "cron.execution";

static NEXT_CRON_OPERATION_TRACE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct CronHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    session: SessionHandle,
    events: Option<mpsc::Sender<(String, String, openclaw::port::CronExecutionStatus)>>,
    observation: ObservationSink,
    operations: Arc<Mutex<Vec<CronOperation>>>,
}

struct CronOperation {
    job_id: String,
    run_id: String,
    operation: OperationHandle<openclaw::port::CronExecutionStatus>,
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
            runtime_directory,
            session,
            events,
            observation,
            operations: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(crate) async fn list(
        &self,
    ) -> Result<openclaw::gateway::wire::CronJobs, openclaw::port::CronReadFailure> {
        if self.admission.admit_request().is_err() {
            return Err(openclaw::port::CronReadFailure::Unavailable);
        }
        let Some(driver) = self.running_cron_driver() else {
            return Err(openclaw::port::CronReadFailure::Unavailable);
        };
        let Some(ops) = driver.cron_ops() else {
            return Err(openclaw::port::CronReadFailure::Unavailable);
        };
        match ops.list_cron_jobs().await {
            crate::cron::CronListOutcome::Listed(jobs) => Ok(jobs),
            crate::cron::CronListOutcome::Unavailable => {
                Err(openclaw::port::CronReadFailure::Unavailable)
            }
            crate::cron::CronListOutcome::Rejected => {
                Err(openclaw::port::CronReadFailure::Rejected)
            }
            crate::cron::CronListOutcome::Protocol => {
                Err(openclaw::port::CronReadFailure::Protocol)
            }
        }
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
            Ok(receipts) => receipts,
            Err(openclaw::port::CronHistoryReadFailure::Rejected) => {
                return crate::cron::CronHistoryOutcome::Rejected;
            }
            Err(openclaw::port::CronHistoryReadFailure::Protocol) => {
                return crate::cron::CronHistoryOutcome::Protocol;
            }
            Err(openclaw::port::CronHistoryReadFailure::Deadline) => {
                return crate::cron::CronHistoryOutcome::Deadline;
            }
            Err(openclaw::port::CronHistoryReadFailure::Unavailable) => {
                return crate::cron::CronHistoryOutcome::Unavailable;
            }
        };
        let session_key = match canonical_cron_session_key(&command, receipts) {
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
            Ok(Ok(history)) => crate::cron::CronHistoryOutcome::Loaded(history),
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
    ) -> Result<openclaw::port::CronTriggerOutcome, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        let Some(driver) = self.running_cron_driver() else {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        };
        let Some(ops) = driver.cron_ops() else {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        };
        self.reap_operations().await;
        let mut operations = self.operations.lock().await;
        if operations.len() >= CRON_OPERATION_CAPACITY {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        }
        let Some(events) = self.events.clone() else {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        };
        let admission = match ops.admit_cron_execution(job_id.clone()).await {
            Ok(Ok(admission)) => admission,
            Ok(Err(status)) => return Ok(status),
            Err(_) => return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown),
        };
        let run_id = admission.run_id().to_owned();
        let event_job_id = job_id.clone();
        let event_run_id = run_id.clone();
        let operation = if self.observation.is_enabled() {
            OperationHandle::spawn_observed(
                self.observation.clone(),
                next_cron_operation_trace(),
                CRON_EXECUTION_OPERATION,
                move |cancellation| async move {
                    let status =
                        openclaw::port::await_cron_execution(admission, cancellation).await;
                    let _ = events.try_send((event_job_id, event_run_id, status));
                    status
                },
            )
            .0
        } else {
            OperationHandle::spawn(move |cancellation| async move {
                let status = openclaw::port::await_cron_execution(admission, cancellation).await;
                let _ = events.try_send((event_job_id, event_run_id, status));
                status
            })
            .0
        };
        operations.push(CronOperation {
            job_id,
            run_id,
            operation,
        });
        Ok(openclaw::port::CronTriggerOutcome::Accepted)
    }

    pub(crate) async fn cancel_operations(&self) {
        let mut operations = self.operations.lock().await;
        let events = self.events.clone();
        for operation in operations.iter() {
            operation.operation.cancel();
        }
        for mut operation in operations.drain(..) {
            if operation.operation.join().await.is_err() {
                if let Some(events) = &events {
                    let _ = events.try_send((
                        operation.job_id,
                        operation.run_id,
                        openclaw::port::CronExecutionStatus::OutcomeUnknown,
                    ));
                }
            }
        }
    }

    async fn reap_operations(&self) {
        let mut operations = self.operations.lock().await;
        let events = self.events.clone();
        let mut pending = Vec::with_capacity(operations.len());
        for mut operation in operations.drain(..) {
            if operation.operation.is_finished() {
                if operation.operation.join().await.is_err() {
                    if let Some(events) = &events {
                        let _ = events.try_send((
                            operation.job_id,
                            operation.run_id,
                            openclaw::port::CronExecutionStatus::OutcomeUnknown,
                        ));
                    }
                }
            } else {
                pending.push(operation);
            }
        }
        *operations = pending;
    }

    fn running_cron_driver(&self) -> Option<Arc<dyn crate::runtime_driver::RuntimeDriver>> {
        let driver = self
            .runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())?;
        driver
            .lifecycle_ops()
            .is_some_and(|ops| ops.readiness())
            .then_some(driver)
    }
}

fn next_cron_operation_trace() -> TraceContext {
    TraceContext::root(NEXT_CRON_OPERATION_TRACE.fetch_add(1, Ordering::Relaxed))
}

fn canonical_cron_session_key(
    command: &crate::cron::CronHistoryCommand,
    receipts: Vec<openclaw::gateway::wire::CronRunHistoryEntry>,
) -> Option<String> {
    let keys: BTreeSet<_> = receipts
        .into_iter()
        .filter(|receipt| {
            receipt.job_id == command.job_id()
                && command.matches_run_session(receipt.session_id.as_deref())
        })
        .filter_map(|receipt| receipt.session_key)
        .collect();
    (keys.len() == 1).then(|| keys.into_iter().next()).flatten()
}
