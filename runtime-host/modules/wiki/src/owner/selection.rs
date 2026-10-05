use super::actor::{
    WikiShared, WikiState, project_root, read_source_watch_config, selected_project,
};
use crate::{
    WikiFailure,
    domain::{
        WikiSelectionInput, WikiSelectionIntent, WikiSelectionStatus, WikiSelectionTask,
        WikiSelectionTaskInput, normalize_relative_path, safe_relative_path,
    },
    selection::SelectionPlan,
};

pub(crate) fn stage(
    shared: &WikiShared,
    state: &WikiState,
    mut input: WikiSelectionInput,
) -> Result<SelectionPlan, WikiFailure> {
    input.task_id = input.task_id.trim().to_owned();
    if input.task_id.is_empty() || input.task_id.chars().count() > 200 {
        return Err(WikiFailure::invalid_input(
            "taskId",
            "A unique taskId of 1 to 200 characters is required",
        ));
    }
    input.instruction = input.instruction.trim().to_owned();
    if input.instruction.is_empty() {
        return Err(WikiFailure::invalid_input(
            "instruction",
            "Selection instruction must not be empty",
        ));
    }
    if input.selection.selected_text.trim().is_empty() {
        return Err(WikiFailure::invalid_input(
            "selection",
            "Selected text must not be empty",
        ));
    }
    if input.intent == WikiSelectionIntent::Edit && !input.selection.source_mapped {
        return Err(WikiFailure::invalid_input(
            "selection",
            "Only a source-mapped selection can be edited",
        ));
    }
    let path = safe_relative_path(&input.relative_path)?;
    if path.as_os_str().is_empty() {
        return Err(WikiFailure::invalid_input(
            "relativePath",
            "A project-relative file path is required",
        ));
    }
    input.relative_path = normalize_relative_path(&path);
    let project = selected_project(state, input.project_id.as_deref())?;
    input.project_id = Some(project.project_id().to_owned());
    if input.model_ref.is_none() {
        input.model_ref = read_source_watch_config(project_root(project))
            .map_err(|_| WikiFailure::state("Wiki generation model configuration is unavailable"))?
            .generation_model_ref()
            .map(str::to_owned);
    }
    let model = input
        .model_ref
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty() && *model != "auto")
        .ok_or_else(|| {
            WikiFailure::invalid_input(
                "modelRef",
                "Choose a Wiki generation model before using the selection assistant",
            )
        })?;
    input.model_ref = Some(model.to_owned());
    let llm = shared.ingest_llm.clone().ok_or_else(|| {
        WikiFailure::state("Wiki selection generation is unavailable. Configure a model and retry.")
    })?;
    let history_start = input.history.len().saturating_sub(6);
    input.history = input.history.drain(history_start..).collect();
    let run = shared.selection.begin(WikiSelectionTask {
        project_id: project.project_id().to_owned(),
        task_id: input.task_id.clone(),
        relative_path: input.relative_path.clone(),
        intent: input.intent,
        status: WikiSelectionStatus::Queued,
        content: String::new(),
        references: Vec::new(),
        error: None,
    })?;
    Ok(SelectionPlan { input, llm, run })
}

pub(crate) fn task(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiSelectionTaskInput,
) -> Result<WikiSelectionTask, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    shared.selection.task(project.project_id(), &input.task_id)
}

pub(crate) fn cancel(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiSelectionTaskInput,
) -> Result<WikiSelectionTask, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    shared
        .selection
        .cancel(project.project_id(), &input.task_id)
}
