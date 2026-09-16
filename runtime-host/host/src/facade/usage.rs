use std::sync::Arc;

use crate::{composition::HostAdmission, runtime::adapters::openclaw::OpenClawInstance};

#[derive(Clone)]
pub(crate) struct UsageHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsageEntry {
    pub(crate) session_id: String,
    pub(crate) agent_id: String,
    pub(crate) timestamp: String,
    pub(crate) model: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    pub(crate) cache_write_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) cost_usd: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UsageReadError {
    Unavailable,
}

impl UsageHandle {
    pub(crate) fn new(admission: Arc<HostAdmission>, open_claw: Arc<OpenClawInstance>) -> Self {
        Self {
            admission,
            open_claw,
        }
    }

    pub(crate) async fn recent(&self, limit: usize) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.admission
            .admit_request()
            .map_err(|_| UsageReadError::Unavailable)?;
        self.open_claw
            .usage_recent(limit)
            .await
            .map(project_usage_entries)
            .map_err(|_| UsageReadError::Unavailable)
    }

    pub(crate) async fn session_timeseries(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Vec<UsageEntry>, UsageReadError> {
        self.admission
            .admit_request()
            .map_err(|_| UsageReadError::Unavailable)?;
        self.open_claw
            .session_usage_timeseries(agent_id, session_id)
            .await
            .map(project_usage_entries)
            .map_err(|_| UsageReadError::Unavailable)
    }
}

pub(crate) const fn default_limit() -> usize {
    openclaw::usage::UsageProjection::default_limit()
}

pub(crate) const fn max_limit() -> usize {
    openclaw::usage::UsageProjection::max_limit()
}

fn project_usage_entries(entries: Vec<openclaw::usage::UsageEntry>) -> Vec<UsageEntry> {
    entries
        .into_iter()
        .map(|entry| UsageEntry {
            session_id: entry.session_id().to_owned(),
            agent_id: entry.agent_id().to_owned(),
            timestamp: entry.timestamp().to_owned(),
            model: entry.model().map(str::to_owned),
            provider: entry.provider().map(str::to_owned),
            input_tokens: entry.input_tokens(),
            output_tokens: entry.output_tokens(),
            cache_read_tokens: entry.cache_read_tokens(),
            cache_write_tokens: entry.cache_write_tokens(),
            total_tokens: entry.total_tokens(),
            cost_usd: entry.cost_usd(),
        })
        .collect()
}
