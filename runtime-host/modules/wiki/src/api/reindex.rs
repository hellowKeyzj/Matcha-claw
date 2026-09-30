use platform::call::CallReceipt;

use crate::{
    WikiFailure, WikiHandle, WikiProjectSelector,
    application::commands::{WikiCommand, WikiQuery},
    call::{self, WikiCallOperation, WikiWorkflowSummary},
    reindex::{self, ReindexPlan, WikiReindexInput, WikiReindexReceipt, WikiReindexState},
};

impl WikiHandle {
    pub(crate) async fn admit_reindex(
        &self,
        mut input: WikiReindexInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::Reindex;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        let plan = match owner
            .stage_reindex(input, Some(call.id().as_str().to_owned()))
            .await
        {
            Ok(plan) => plan,
            Err(error) => {
                call::finish_detail(Some(&call), Some(&error), Some(operation)).await;
                return Err(error);
            }
        };
        let cancellation = self.workflows.cancellation.child_token();
        self.workflows
            .admit(call, operation, reindex::run(plan, cancellation), |_| {
                WikiWorkflowSummary::Reindex
            })
            .await
    }

    pub async fn reindex(
        &self,
        mut input: WikiReindexInput,
    ) -> Result<WikiReindexReceipt, WikiFailure> {
        let operation = WikiCallOperation::Reindex;
        let call = call::begin(self.recorder(), operation.command()).await?;
        if let Err(error) = self.resolve_current_project(&mut input.project_id).await {
            call::finish_detail(call.as_ref(), Some(&error), Some(operation)).await;
            return Err(error);
        }
        let plan = match self
            .unrecorded()
            .stage_reindex(
                input,
                call.as_ref().map(|call| call.id().as_str().to_owned()),
            )
            .await
        {
            Ok(plan) => plan,
            Err(error) => {
                call::finish_detail(call.as_ref(), Some(&error), Some(operation)).await;
                return Err(error);
            }
        };
        let cancellation = self.workflows.cancellation.child_token();
        // MCP keeps its awaited payload while sharing the same bounded owned workflow and audit call.
        self.workflows
            .enqueue(
                call,
                Some(operation),
                None,
                reindex::run(plan, cancellation),
                |_| Some(WikiWorkflowSummary::Reindex),
            )
            .await?
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    async fn stage_reindex(
        &self,
        input: WikiReindexInput,
        task_id: Option<String>,
    ) -> Result<ReindexPlan, WikiFailure> {
        self.request_command(None, |reply| WikiCommand::StageReindex {
            input,
            task_id,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn reindex_state(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiReindexState, WikiFailure> {
        self.request_query(None, |reply| WikiQuery::ReindexState { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
