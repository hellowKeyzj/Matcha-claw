use std::{fs, path::Path};

use super::{WorkspaceProjectionError, identity};
use crate::workspace::replace_regular_file;

const SNIPPET_SUFFIX: &str = ".matchaclaw.md";
const RETIRED_CONTEXT_TARGETS: &[&str] = &["TOOLS.md"];
const MARKER_BEGIN: &str = "<!-- matchaclaw:begin -->";
const MARKER_END: &str = "<!-- matchaclaw:end -->";

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ContextMerge {
    merged_files: Vec<String>,
    skipped_missing: usize,
}

impl ContextMerge {
    pub fn merged_files(&self) -> &[String] {
        &self.merged_files
    }

    pub const fn skipped_missing(&self) -> usize {
        self.skipped_missing
    }
}

pub(super) fn merge(
    context: &Path,
    workspace: &Path,
) -> Result<ContextMerge, WorkspaceProjectionError> {
    let context = identity::directory(context)?;
    let workspace = identity::directory(workspace)?;
    let mut result = ContextMerge::default();

    for entry in
        fs::read_dir(context).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?
    {
        let entry = entry.map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
        let metadata = entry
            .file_type()
            .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
        if metadata.is_symlink() || !metadata.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or(WorkspaceProjectionError::WorkspaceUnavailable)?;
        let Some(target) = name.strip_suffix(SNIPPET_SUFFIX) else {
            continue;
        };
        if target.is_empty() || target.contains(['/', '\\']) {
            return Err(WorkspaceProjectionError::WorkspaceUnavailable);
        }
        let target = format!("{target}.md");
        if RETIRED_CONTEXT_TARGETS.contains(&target.as_str()) {
            continue;
        }
        let target_path = workspace.join(&target);
        let Some(original) = identity::read_regular(&target_path)? else {
            result.skipped_missing += 1;
            continue;
        };
        let snippet = identity::read_regular(&entry.path())?
            .ok_or(WorkspaceProjectionError::WorkspaceUnavailable)?;
        let merged = merge_section(&original, &snippet);
        if merged != original {
            replace_regular_file(&workspace, &target, merged.as_bytes())
                .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
            result.merged_files.push(target);
        }
    }
    Ok(result)
}

fn merge_section(existing: &str, section: &str) -> String {
    let section = section.trim();
    if existing.contains(section) {
        return existing.to_owned();
    }
    let wrapped = format!("{MARKER_BEGIN}\n{section}\n{MARKER_END}");
    let begin = existing.find(MARKER_BEGIN);
    let end = existing.find(MARKER_END);
    match (begin, end) {
        (Some(begin), Some(end)) if end >= begin => format!(
            "{}{}{}",
            &existing[..begin],
            wrapped,
            &existing[end + MARKER_END.len()..]
        ),
        _ => format!("{}\n\n{wrapped}\n", existing.trim_end()),
    }
}
