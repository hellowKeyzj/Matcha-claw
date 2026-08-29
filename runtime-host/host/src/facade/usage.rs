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

    pub(crate) fn recent(
        &self,
        limit: usize,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError> {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::usage::UsageHistoryError::Unavailable)?;
        self.open_claw.usage_recent(limit)
    }
}
