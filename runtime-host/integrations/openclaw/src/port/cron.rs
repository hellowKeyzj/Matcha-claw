use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::OpenClawGateway;
use crate::surfaces::cron::{
    CronExecutionAdmission, CronExecutionStatus, CronHistoryReadFailure, CronMutationOutcome,
    CronProvider, CronReadFailure, CronTriggerOutcome,
};

pub async fn await_cron_execution(
    admission: CronExecutionAdmission,
    cancellation: tokio_util::sync::CancellationToken,
) -> CronExecutionStatus {
    crate::surfaces::cron::await_terminal(admission, cancellation).await
}

impl OpenClawGateway {
    pub async fn admit_cron_execution(
        &self,
        job_id: String,
    ) -> Result<
        Result<CronExecutionAdmission, CronTriggerOutcome>,
        crate::gateway::client::GatewayClientError,
    > {
        crate::surfaces::cron::admit(Arc::clone(&self.client), job_id).await
    }

    pub async fn await_cron_execution(
        admission: CronExecutionAdmission,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> CronExecutionStatus {
        crate::surfaces::cron::await_terminal(admission, cancellation).await
    }

    pub async fn list_cron_jobs(&self) -> Result<crate::gateway::wire::CronJobs, CronReadFailure> {
        CronProvider::new(Arc::clone(&self.client)).list().await
    }

    pub async fn cron_run_history(
        &self,
        job_id: String,
        limit: u64,
    ) -> Result<Vec<crate::gateway::wire::CronRunHistoryEntry>, CronHistoryReadFailure> {
        CronProvider::new(Arc::clone(&self.client))
            .run_history(job_id, limit)
            .await
    }

    pub async fn add_cron_job(
        &self,
        job: crate::gateway::wire::CronJobCreate,
    ) -> CronMutationOutcome<crate::gateway::wire::CronJob> {
        CronProvider::new(Arc::clone(&self.client)).add(job).await
    }

    pub async fn update_cron_job(
        &self,
        job_id: String,
        patch: crate::gateway::wire::CronJobPatch,
        expected_config_revision: Option<String>,
    ) -> CronMutationOutcome<crate::gateway::wire::CronJob> {
        CronProvider::new(Arc::clone(&self.client))
            .update(job_id, patch, expected_config_revision)
            .await
    }

    pub async fn remove_cron_job(
        &self,
        job_id: String,
    ) -> CronMutationOutcome<crate::gateway::wire::CronRemoved> {
        CronProvider::new(Arc::clone(&self.client))
            .remove(job_id)
            .await
    }
}
