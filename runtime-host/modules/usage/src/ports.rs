use std::{future::Future, pin::Pin};

use crate::domain::model::{UsageEntry, UsageReadError};

pub type UsageFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait UsageRequestAdmission: Send + Sync {
    fn admit_usage_request(&self) -> Result<(), UsageRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageRequestAdmissionClosed;

pub trait UsageRuntimeDirectory: Send + Sync {
    fn usage_ops(&self) -> Option<&dyn UsageOps>;
}

pub trait UsageOps: Send + Sync {
    fn usage_recent<'a>(
        &'a self,
        limit: usize,
    ) -> UsageFuture<'a, Result<Vec<UsageEntry>, UsageReadError>>;

    fn session_usage_timeseries<'a>(
        &'a self,
        agent_id: &'a str,
        session_id: &'a str,
    ) -> UsageFuture<'a, Result<Vec<UsageEntry>, UsageReadError>>;

    fn default_usage_limit(&self) -> usize;

    fn max_usage_limit(&self) -> usize;
}
