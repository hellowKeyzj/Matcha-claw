use std::sync::Arc;

use crate::composition::{HostAdmission, OpenClawInstance};

#[derive(Clone)]
pub(crate) struct UsageHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
}

impl UsageHandle {
    pub(crate) fn new(admission: Arc<HostAdmission>, open_claw: Arc<OpenClawInstance>) -> Self {
        Self {
            admission,
            open_claw,
        }
    }

    pub(crate) async fn recent(
        &self,
        limit: usize,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageReadError> {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::usage::UsageReadError::Unavailable)?;
        self.open_claw.usage_recent(limit).await
    }

    pub(crate) async fn session_timeseries(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageReadError> {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::usage::UsageReadError::Unavailable)?;
        self.open_claw
            .session_usage_timeseries(agent_id, session_id)
            .await
    }
}
