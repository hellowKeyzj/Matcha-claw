use std::sync::Arc;

use super::actor::{
    WikiShared, WikiState, project_root, read_source_watch_config, selected_project,
};
use crate::{
    WikiFailure, WikiProjectSelector,
    domain::build_graph,
    insights::{
        self, WikiGraphInsightInput, WikiGraphInsightResearchInput, WikiGraphInsightsReceipt,
        WikiKnowledgeGap,
    },
    ports::{WikiIngestLlm, WikiIngestLlmRequest},
};

pub(crate) struct InsightResearchPlan {
    pub project_id: String,
    pub gap: WikiKnowledgeGap,
    pub llm: Arc<dyn WikiIngestLlm>,
    pub request: WikiIngestLlmRequest,
}

pub(crate) fn read(
    state: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiGraphInsightsReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let mut receipt = insights::analyze(&build_graph(root)?, project.project_id());
    receipt.dismissed_keys = insights::read_dismissed(root)?;
    Ok(receipt)
}

pub(crate) fn dismiss(
    state: &WikiState,
    input: WikiGraphInsightInput,
) -> Result<WikiGraphInsightsReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let mut receipt = insights::analyze(&build_graph(root)?, project.project_id());
    receipt.dismissed_keys = insights::read_dismissed(root)?;
    // A research admission can change the graph before this previously issued key is dismissed.
    if input.insight_key.trim().is_empty()
        || input.insight_key.len() > 1_048_576
        || (!input.insight_key.starts_with("gap:") && !input.insight_key.contains(":::"))
    {
        return Err(WikiFailure::invalid_input(
            "insightKey",
            "Graph insight key is invalid",
        ));
    }
    insights::dismiss(root, &input.insight_key)?;
    receipt.dismissed_keys.insert(input.insight_key);
    Ok(receipt)
}

pub(crate) fn stage_research(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiGraphInsightResearchInput,
) -> Result<InsightResearchPlan, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let receipt = insights::analyze(&build_graph(root)?, project.project_id());
    let gap = receipt
        .knowledge_gaps
        .into_iter()
        .find(|gap| gap.key == input.insight_key)
        .ok_or_else(|| WikiFailure::invalid_input("insightKey", "Knowledge gap was not found"))?;
    let config = read_source_watch_config(root)?;
    let model_ref = input
        .model_ref
        .or_else(|| config.generation_model_ref().map(str::to_owned))
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty() && model != "auto")
        .ok_or_else(|| {
            WikiFailure::invalid_input(
                "modelRef",
                "Wiki research generation model is not configured",
            )
        })?;
    let llm = shared.ingest_llm.clone().ok_or_else(|| {
        WikiFailure::state(
            "Research generation model is unavailable. Configure a Wiki model and rerun.",
        )
    })?;
    let request =
        insights::research_request(root, &gap, Some(model_ref), config.output_language())?;
    Ok(InsightResearchPlan {
        project_id: project.project_id().to_owned(),
        gap,
        llm,
        request,
    })
}
