use platform::call::CallReceipt;

use super::WikiHandle;
use crate::{
    WikiFailure, WikiProjectSelector,
    application::commands::{WikiCommand, WikiQuery},
    call::{self, WikiCallOperation, WikiWorkflowSummary},
    call_result::WikiCallResult,
    insights::{WikiGraphInsightInput, WikiGraphInsightResearchInput, WikiGraphInsightsReceipt},
};

impl WikiHandle {
    pub async fn graph_insights(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiGraphInsightsReceipt, WikiFailure> {
        self.request_query(Some("graph.insights"), |reply| WikiQuery::GraphInsights {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn dismiss_graph_insight(
        &self,
        input: WikiGraphInsightInput,
    ) -> Result<WikiGraphInsightsReceipt, WikiFailure> {
        self.request_command(Some("graph.insights.dismiss"), |reply| {
            WikiCommand::DismissGraphInsight { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_graph_insight_research_input(
        &self,
        mut input: WikiGraphInsightResearchInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::GraphInsightResearchInput;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let reservation = match self.results.reserve(call.id()) {
            Ok(reservation) => reservation,
            Err(error) => {
                call::finish_detail(Some(&call), Some(&error), Some(operation)).await;
                return Err(error);
            }
        };
        let owner = self.unrecorded();
        let cancellation = self.workflows.cancellation.child_token();
        self.workflows
            .admit(
                call,
                operation,
                async move {
                    let plan = owner
                        .request_query(None, |reply| WikiQuery::StageGraphInsightResearch {
                            input,
                            reply,
                        })
                        .await
                        .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
                    let response = plan
                        .llm
                        .generate_cancellable(plan.request, cancellation)
                        .await?;
                    let receipt = crate::insights::parse_research_input(
                        &response.text,
                        &plan.project_id,
                        &plan.gap,
                    );
                    reservation.complete(WikiCallResult::GraphInsightResearchInput(receipt));
                    Ok(())
                },
                |_| WikiWorkflowSummary::GraphInsightResearchInput,
            )
            .await
    }
}
