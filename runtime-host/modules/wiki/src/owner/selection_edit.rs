use crate::domain::{
    WikiFailure, WikiSelectionApplyInput, WikiSelectionApplyReceipt, WikiWriteInput,
    normalize_relative_path, resolve_project_path,
};

use super::actor::{
    WikiShared, WikiState, project_root, selected_project, write_file_with_history,
};

pub(crate) fn apply(
    _shared: &WikiShared,
    state: &WikiState,
    input: WikiSelectionApplyInput,
) -> Result<WikiSelectionApplyReceipt, WikiFailure> {
    if !input.selection.source_mapped {
        return Err(WikiFailure::invalid_input(
            "selection.sourceMapped",
            "Selection edit requires a mapped source range",
        ));
    }
    if input.selection.selected_text.is_empty() {
        return Err(WikiFailure::invalid_input(
            "selection.selectedText",
            "Selection edit requires non-empty selected text",
        ));
    }
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let path = resolve_project_path(root, &input.relative_path)?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return Err(WikiFailure::invalid_path(input.relative_path));
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WikiFailure::not_found(&input.relative_path)
        } else {
            WikiFailure::state("Failed to inspect selection edit target")
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(WikiFailure::invalid_path(input.relative_path));
    }
    if !metadata.is_file() {
        return Err(WikiFailure::IsDirectory {
            path: input.relative_path,
        });
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| WikiFailure::state("Failed to resolve selection edit project"))?;
    let canonical = path
        .canonicalize()
        .map_err(|_| WikiFailure::state("Failed to resolve selection edit target"))?;
    if !canonical.starts_with(&canonical_root)
        || canonical.starts_with(canonical_root.join(".llm-wiki"))
    {
        return Err(WikiFailure::PathOutsideProject {
            path: input.relative_path,
        });
    }
    let current = std::fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidData {
            WikiFailure::NotText {
                path: input.relative_path.clone(),
            }
        } else {
            WikiFailure::state("Failed to read selection edit target")
        }
    })?;
    let selection = input.selection;
    if current
        != format!(
            "{}{}{}",
            selection.prefix, selection.selected_text, selection.suffix
        )
    {
        return Err(WikiFailure::invalid_input(
            "selection",
            "The file changed after the selection was captured. Re-select the text before applying the Agent suggestion.",
        ));
    }
    let replacement = crate::page_links::normalize_draft(&input.replacement);
    let content = format!("{}{replacement}{}", selection.prefix, selection.suffix);
    let project_id = project.project_id().to_owned();
    let relative_path =
        normalize_relative_path(path.strip_prefix(root).expect("Wiki project file"));
    write_file_with_history(
        state,
        WikiWriteInput {
            project_id: Some(project_id.clone()),
            relative_path: relative_path.clone(),
            content: content.clone(),
        },
        "agent",
        "agent.selection_edit",
    )?;
    Ok(WikiSelectionApplyReceipt {
        project_id,
        relative_path,
        content,
    })
}
