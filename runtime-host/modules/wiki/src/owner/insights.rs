use super::actor::{WikiState, project_root, selected_project};
use crate::{
    WikiFailure, WikiProjectSelector,
    domain::build_graph,
    insights::{self, WikiGraphInsightInput, WikiGraphInsightsReceipt},
};

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
    // The graph can change before this previously issued key is dismissed.
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
