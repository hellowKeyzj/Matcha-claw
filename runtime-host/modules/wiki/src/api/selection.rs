use super::*;
use crate::domain::{WikiSelectionInput, WikiSelectionTask, WikiSelectionTaskInput};

impl WikiHandle {
    pub(crate) async fn admit_selection_generate(
        &self,
        mut input: WikiSelectionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::SelectionGenerate;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let plan = self
            .request_query(None, |reply| WikiQuery::StageSelection { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable));
        let plan = match plan {
            Ok(plan) => plan,
            Err(error) => {
                call::finish_detail(Some(&call), Some(&error), Some(operation)).await;
                return Err(error);
            }
        };
        let owner = self.unrecorded();
        self.workflows
            .admit(
                call,
                operation,
                async move { crate::selection::workflow::run(owner, plan).await },
                |_| WikiWorkflowSummary::Selection,
            )
            .await
    }

    pub async fn selection_task(
        &self,
        input: WikiSelectionTaskInput,
    ) -> Result<WikiSelectionTask, WikiFailure> {
        self.request_query(Some("selection.task"), |reply| WikiQuery::SelectionTask {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_selection(
        &self,
        input: WikiSelectionTaskInput,
    ) -> Result<WikiSelectionTask, WikiFailure> {
        self.request_query(Some("selection.cancel"), |reply| {
            WikiQuery::CancelSelection { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
