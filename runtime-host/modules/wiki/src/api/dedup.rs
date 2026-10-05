use std::sync::Arc;

use platform::call::CallReceipt;
use tokio::sync::OnceCell;

use super::WikiHandle;
use crate::{
    application::commands::{WikiCommand, WikiQuery},
    call::{self, WikiCallOperation},
    domain::{
        WikiDedupDetectInput, WikiDedupExcludeInput, WikiDedupMergeInput, WikiDedupState,
        WikiDedupTaskInput, WikiFailure, WikiProjectSelector,
    },
};

impl WikiHandle {
    pub async fn dedup_state(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiDedupState, WikiFailure> {
        self.request_query(None, |reply| WikiQuery::DedupState { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_dedup(
        &self,
        input: WikiDedupTaskInput,
    ) -> Result<WikiDedupState, WikiFailure> {
        self.request_query(Some("dedup.cancel"), |reply| WikiQuery::CancelDedup {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn exclude_duplicates(
        &self,
        input: WikiDedupExcludeInput,
    ) -> Result<WikiDedupState, WikiFailure> {
        self.request_command(Some("dedup.exclude"), |reply| {
            WikiCommand::ExcludeDuplicates { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_dedup_detect(
        &self,
        mut input: WikiDedupDetectInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::DedupDetect;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let plan = match self
            .unrecorded()
            .request_query(None, |reply| WikiQuery::StageDedupDetection {
                input,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
        {
            Ok(plan) => plan,
            Err(failure) => {
                call::finish_detail(Some(&call), Some(&failure), Some(operation)).await;
                return Err(failure);
            }
        };
        self.admit_command(call, operation, true, |reply| {
            WikiCommand::DetectDuplicates { plan, reply }
        })
        .await
    }

    pub(crate) async fn admit_dedup_merge(
        &self,
        mut input: WikiDedupMergeInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::DedupMerge;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let task_id = call.id().as_str().to_owned();
        let owner = self.unrecorded();
        let plan = owner
            .request_command(None, |reply| WikiCommand::EnqueueDedup {
                input,
                task_id,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable));
        self.admit_dedup_execution(call, operation, plan).await
    }

    pub(crate) async fn admit_dedup_retry(
        &self,
        mut input: WikiDedupTaskInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::DedupRetry;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let plan = self
            .unrecorded()
            .request_command(None, |reply| WikiCommand::RetryDedup { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable));
        self.admit_dedup_execution(call, operation, plan).await
    }

    pub(crate) async fn admit_dedup_resume(
        &self,
        mut input: WikiDedupTaskInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::DedupResume;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let plan = self
            .unrecorded()
            .request_command(None, |reply| WikiCommand::ResumeDedup { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable));
        self.admit_dedup_execution(call, operation, plan).await
    }

    async fn admit_dedup_execution(
        &self,
        call: platform::call::CallContext<crate::call::WikiCallDetail>,
        operation: WikiCallOperation,
        plan: Result<WikiDedupTaskInput, WikiFailure>,
    ) -> Result<CallReceipt, WikiFailure> {
        let input = match plan {
            Ok(input) => input,
            Err(failure) => {
                call::finish_detail(Some(&call), Some(&failure), Some(operation)).await;
                return Err(failure);
            }
        };
        let owner = self.unrecorded();
        let failure_owner = owner.clone();
        let failure_input = input.clone();
        let acceptance = Arc::new(OnceCell::new());
        let enqueued = self
            .workflows
            .enqueue(
                Some(call.clone()),
                Some(operation),
                Some(acceptance.clone()),
                async move { owner.execute_dedup(input).await },
                |_| None,
            )
            .await;
        if let Err(failure) = enqueued {
            let _ = failure_owner
                .request_command(None, |reply| WikiCommand::FailDedup {
                    input: failure_input,
                    error: failure.clone(),
                    reply,
                })
                .await;
            return Err(failure);
        }
        call::accepted(&call, &acceptance).await
    }

    async fn execute_dedup(
        &self,
        input: WikiDedupTaskInput,
    ) -> Result<WikiDedupState, WikiFailure> {
        for _ in 0..3 {
            let prepared = self
                .request_command(None, |reply| WikiCommand::PrepareDedup {
                    input: input.clone(),
                    reply,
                })
                .await
                .unwrap_or(Err(WikiFailure::OwnerUnavailable));
            let result = match prepared {
                Ok(plan) => self
                    .request_command(None, |reply| WikiCommand::CompleteDedup { plan, reply })
                    .await
                    .unwrap_or(Err(WikiFailure::OwnerUnavailable)),
                Err(failure) => Err(failure),
            };
            match result {
                Ok(state) => return Ok(state),
                Err(failure) => {
                    let state = self
                        .request_command(None, |reply| WikiCommand::FailDedup {
                            input: input.clone(),
                            error: failure.clone(),
                            reply,
                        })
                        .await
                        .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
                    let retry = state
                        .tasks
                        .iter()
                        .find(|task| task.id == input.task_id)
                        .is_some_and(|task| {
                            !task.paused
                                && task.status == crate::WikiDedupTaskStatus::Pending
                                && task.retry_count < 3
                        });
                    if !retry || failure.is_cancelled() {
                        return Err(failure);
                    }
                }
            }
        }
        Err(WikiFailure::state(
            "dedup merge exhausted its three attempts; retry from maintenance",
        ))
    }
}
