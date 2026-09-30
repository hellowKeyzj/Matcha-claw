use platform::call::CallReceipt;

use super::*;
use crate::domain::{WikiQuestionInput, WikiQuestionTaskReceipt, WikiQuestionTaskSelector};

impl WikiHandle {
    pub async fn ask_question(
        &self,
        mut input: WikiQuestionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::QaAsk;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let owner = self.unrecorded();
        let cancellation = self.workflows.cancellation.child_token();
        let (staged, stage_result) = oneshot::channel();
        let receipt = self
            .workflows
            .admit(
                call,
                operation,
                async move {
                    let plan = owner
                        .request_command(None, |reply| WikiCommand::StageQuestion {
                            input,
                            cancellation,
                            reply,
                        })
                        .await
                        .unwrap_or(Err(WikiFailure::OwnerUnavailable));
                    let _ = staged.send(plan.as_ref().map(|_| ()).map_err(Clone::clone));
                    crate::qa::workflow::run(owner, plan?).await
                },
                |_| WikiWorkflowSummary::Question,
            )
            .await?;
        stage_result
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        Ok(receipt)
    }

    pub async fn question_task(
        &self,
        input: WikiQuestionTaskSelector,
    ) -> Result<WikiQuestionTaskReceipt, WikiFailure> {
        self.request_query(Some("qa.task"), |reply| WikiQuery::QuestionTask {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_question(
        &self,
        input: WikiQuestionTaskSelector,
    ) -> Result<WikiQuestionTaskReceipt, WikiFailure> {
        self.request_command(Some("qa.cancel"), |reply| WikiCommand::CancelQuestion {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_save_question(
        &self,
        mut input: WikiQuestionTaskSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::QaSave;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, true, |reply| WikiCommand::SaveQuestion {
            input,
            reply,
        })
        .await
    }

    pub async fn save_question(
        &self,
        input: WikiQuestionTaskSelector,
    ) -> Result<crate::domain::WikiQuestionSaveReceipt, WikiFailure> {
        self.request_command(Some("qa.save"), |reply| WikiCommand::SaveQuestion {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
