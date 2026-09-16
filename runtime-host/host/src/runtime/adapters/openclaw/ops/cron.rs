use super::super::adapters::cron::*;
use super::*;

impl CronOps for OpenClawInstance {
    fn list_cron_jobs<'a>(&'a self) -> SessionFuture<'a, crate::cron::CronListOutcome> {
        Box::pin(async move {
            match self.gateway.lock().await.list_cron_jobs().await {
                Ok(jobs) => crate::cron::CronListOutcome::Listed(project_cron_list(jobs)),
                Err(openclaw::port::CronReadFailure::Unavailable) => {
                    crate::cron::CronListOutcome::Unavailable
                }
                Err(openclaw::port::CronReadFailure::Rejected) => {
                    crate::cron::CronListOutcome::Rejected
                }
                Err(openclaw::port::CronReadFailure::Protocol) => {
                    crate::cron::CronListOutcome::Protocol
                }
            }
        })
    }

    fn cron_run_history<'a>(
        &'a self,
        job_id: String,
        limit: u64,
    ) -> SessionFuture<
        'a,
        Result<Vec<crate::cron::CronRunHistoryReceipt>, crate::cron::CronRunHistoryFailure>,
    > {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .cron_run_history(job_id, limit)
                .await
                .map(|receipts| {
                    receipts
                        .into_iter()
                        .map(project_cron_history_receipt)
                        .collect()
                })
                .map_err(project_cron_history_failure)
        })
    }

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> SessionFuture<
        'a,
        Result<Result<crate::cron::CronExecutionAdmission, crate::cron::CronTriggerResult>, ()>,
    > {
        Box::pin(async move {
            match self.gateway.lock().await.admit_cron_execution(job_id).await {
                Ok(Ok(admission)) => project_cron_execution_admission(admission).map(Ok),
                Ok(Err(outcome)) => Ok(Err(project_cron_trigger_result(outcome))),
                Err(_) => Err(()),
            }
        })
    }

    fn add_cron_job<'a>(
        &'a self,
        command: crate::cron::CronCreateCommand,
    ) -> SessionFuture<'a, crate::cron::CronJobMutationOutcome> {
        Box::pin(async move {
            let job = match cron_create_into_gateway(command) {
                Ok(job) => job,
                Err(_) => return crate::cron::CronJobMutationOutcome::Rejected,
            };
            project_cron_mutation(self.gateway.lock().await.add_cron_job(job).await)
        })
    }

    fn update_cron_job<'a>(
        &'a self,
        command: crate::cron::CronUpdateCommand,
    ) -> SessionFuture<'a, crate::cron::CronJobMutationOutcome> {
        Box::pin(async move {
            let (job_id, patch, expected_config_revision) = match cron_update_into_gateway(command)
            {
                Ok(parts) => parts,
                Err(_) => return crate::cron::CronJobMutationOutcome::Rejected,
            };
            project_cron_mutation(
                self.gateway
                    .lock()
                    .await
                    .update_cron_job(job_id, patch, expected_config_revision)
                    .await,
            )
        })
    }

    fn delete_cron_job<'a>(
        &'a self,
        command: crate::cron::CronDeleteCommand,
    ) -> SessionFuture<'a, crate::cron::CronDeleteOutcome> {
        Box::pin(async move {
            project_cron_delete(
                self.gateway
                    .lock()
                    .await
                    .remove_cron_job(command.job_id)
                    .await,
            )
        })
    }
}
