use std::{future::Future, pin::Pin};

use crate::model::{
    CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronExecutionAdmission,
    CronHistoryView, CronJobMutationOutcome, CronListOutcome, CronRunHistoryFailure,
    CronRunHistoryReceipt, CronTriggerResult, CronUpdateCommand,
};

pub type CronFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait CronRequestAdmission: Send + Sync {
    fn admit_cron_request(&self) -> Result<(), CronRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CronRequestAdmissionClosed;

pub trait CronRuntimeDirectory: Send + Sync {
    fn cron_ops(&self) -> Option<&dyn CronOps>;
}

pub trait CronSessionHistoryPort: Send + Sync {
    fn load_cron_session_history<'a>(
        &'a self,
        session_key: String,
        limit: u64,
    ) -> CronFuture<'a, Result<CronHistoryView, CronSessionHistoryFailure>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronSessionHistoryFailure {
    Rejected,
    Protocol,
    Unavailable,
    Deadline,
}

pub trait CronOps: Send + Sync {
    fn list_cron_jobs<'a>(&'a self) -> CronFuture<'a, CronListOutcome>;

    fn cron_run_history<'a>(
        &'a self,
        job_id: String,
        limit: u64,
    ) -> CronFuture<'a, Result<Vec<CronRunHistoryReceipt>, CronRunHistoryFailure>>;

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> CronFuture<'a, Result<Result<CronExecutionAdmission, CronTriggerResult>, ()>>;

    fn add_cron_job<'a>(
        &'a self,
        command: CronCreateCommand,
    ) -> CronFuture<'a, CronJobMutationOutcome>;

    fn update_cron_job<'a>(
        &'a self,
        command: CronUpdateCommand,
    ) -> CronFuture<'a, CronJobMutationOutcome>;

    fn delete_cron_job<'a>(
        &'a self,
        command: CronDeleteCommand,
    ) -> CronFuture<'a, CronDeleteOutcome>;
}
