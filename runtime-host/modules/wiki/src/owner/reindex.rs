use crate::{
    WikiFailure, WikiProjectSelector,
    reindex::{ReindexPlan, WikiReindexInput, WikiReindexState},
};

use super::actor::{WikiShared, WikiState, project_root, selected_project};

pub(crate) fn stage(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiReindexInput,
    task_id: Option<String>,
) -> Result<ReindexPlan, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let (config, credentials) = crate::search_config::embedding_execution_config(
        project_root(project),
        &state.state_root,
        project.project_id(),
    )?;
    if !config.is_ready() {
        return Err(WikiFailure::invalid_input(
            "embedding",
            "Wiki embedding is disabled or not configured",
        ));
    }
    let progress = shared
        .reindex_progress
        .reserve(project.project_id(), task_id)?;
    Ok(ReindexPlan {
        project_root: project_root(project).to_path_buf(),
        index: shared.vector_index.clone(),
        config,
        credentials,
        progress,
    })
}

pub(crate) fn state(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiReindexState, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    Ok(shared.reindex_progress.state(project.project_id()))
}
