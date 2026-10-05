use super::WikiHandle;
use crate::{
    WikiFailure, WikiProjectSelector,
    application::commands::{WikiCommand, WikiQuery},
    insights::{WikiGraphInsightInput, WikiGraphInsightsReceipt},
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
}
