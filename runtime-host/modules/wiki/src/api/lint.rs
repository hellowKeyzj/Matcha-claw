use platform::call::CallReceipt;

use super::WikiHandle;
use crate::{
    application::commands::{WikiCommand, WikiQuery},
    call::{self, WikiCallOperation, WikiWorkflowSummary},
    domain::{WikiFailure, WikiProjectSelector},
    lint::{
        LintAction, WikiLintActionInput, WikiLintCancelInput, WikiLintConfig, WikiLintConfigInput,
        WikiLintRunInput, WikiLintState,
    },
};

impl WikiHandle {
    pub async fn lint_config(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiLintConfig, WikiFailure> {
        self.request_query(Some("lint.config.read"), |reply| WikiQuery::LintConfig {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn update_lint_config(
        &self,
        input: WikiLintConfigInput,
    ) -> Result<WikiLintConfig, WikiFailure> {
        self.request_command(Some("lint.config.update"), |reply| {
            WikiCommand::UpdateLintConfig { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn lint_state(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiLintState, WikiFailure> {
        self.request_query(None, |reply| WikiQuery::LintState { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn cancel_lint(
        &self,
        input: WikiLintCancelInput,
    ) -> Result<WikiLintState, WikiFailure> {
        self.request_query(Some("lint.cancel"), |reply| WikiQuery::CancelLint {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn dismiss_lint(
        &self,
        input: WikiLintActionInput,
    ) -> Result<WikiLintState, WikiFailure> {
        self.request_command(Some("lint.dismiss"), |reply| WikiCommand::DismissLint {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_lint_run(
        &self,
        mut input: WikiLintRunInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RunLint;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let task_id = call.id().as_str().to_owned();
        let plan = match self
            .unrecorded()
            .request_command(None, |reply| WikiCommand::StageLint {
                input,
                task_id,
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
        let owner = self.unrecorded();
        let failure_owner = owner.clone();
        let failure_plan = plan.clone();
        let shutdown = self.workflows.cancellation.clone();
        let guard = crate::lint::LintRunGuard {
            project_id: plan.project_id.clone(),
            task_id: plan.task_id.clone(),
            runs: plan.runs.clone(),
        };
        let admitted=self.workflows.admit(call,operation,async move {
            let _guard = guard;
            let begin_plan=plan.clone();
            let started=owner.request_command(None,|reply|WikiCommand::BeginLint{plan:begin_plan,reply}).await.unwrap_or(Err(WikiFailure::OwnerUnavailable));
            let result=match started {
                Ok(())=>tokio::select! {
                    _=shutdown.cancelled()=>{plan.cancellation.cancel();Err(WikiFailure::cancelled())},
                    result=crate::lint::run(&plan,plan.llm.as_deref(),&plan.runs)=>result,
                },
                Err(failure)=>Err(failure),
            };
            let failure=result.as_ref().err().cloned();
            let state=owner.request_command(None,|reply|WikiCommand::CompleteLint{plan,result,reply}).await.unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
            if let Some(failure)=failure{return Err(failure);}
            if state.phase==crate::lint::WikiLintPhase::Cancelled{return Err(WikiFailure::cancelled());}
            Ok(state)
        },|_|WikiWorkflowSummary::Lint).await;
        if admitted.is_err() {
            let _ = failure_owner
                .request_command(None, |reply| WikiCommand::CompleteLint {
                    plan: failure_plan,
                    result: Err(WikiFailure::OwnerUnavailable),
                    reply,
                })
                .await;
        }
        admitted
    }

    pub(crate) async fn admit_lint_fix(
        &self,
        input: WikiLintActionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        self.admit_lint_action(input, LintAction::Fix).await
    }
    pub(crate) async fn admit_lint_review(
        &self,
        input: WikiLintActionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        self.admit_lint_action(input, LintAction::Review).await
    }
    pub(crate) async fn admit_lint_delete(
        &self,
        input: WikiLintActionInput,
    ) -> Result<CallReceipt, WikiFailure> {
        self.admit_lint_action(input, LintAction::Delete).await
    }

    async fn admit_lint_action(
        &self,
        mut input: WikiLintActionInput,
        action: LintAction,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = match action {
            LintAction::Fix => WikiCallOperation::FixLint,
            LintAction::Review => WikiCallOperation::ReviewLint,
            LintAction::Delete => WikiCallOperation::DeleteLint,
        };
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, true, |reply| WikiCommand::LintAction {
            input,
            action,
            reply,
        })
        .await
    }
}
