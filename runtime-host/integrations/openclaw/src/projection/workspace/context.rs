use std::{fs, path::Path};

use super::{WorkspaceProjectionError, identity};
use crate::workspace::replace_regular_file;

const SNIPPET_SUFFIX: &str = ".matchaclaw.md";
const MARKER_BEGIN: &str = "<!-- matchaclaw:begin -->";
const MARKER_END: &str = "<!-- matchaclaw:end -->";

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ContextMerge {
    merged_files: Vec<String>,
    skipped_missing: usize,
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
        let target_path = workspace.join(&target);
        let Some(original) = identity::read_regular(&target_path)? else {
            result.skipped_missing += 1;
            continue;
        };
        let snippet = identity::read_regular(&entry.path())?
            .ok_or(WorkspaceProjectionError::WorkspaceUnavailable)?;
        let source = if target == "AGENTS.md" {
            strip_first_run_section(&original)
        } else {
            original.clone()
        };
        let merged = merge_section(&source, &snippet);
        if merged != original {
            replace_regular_file(&workspace, &target, merged.as_bytes())
                .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
            result.merged_files.push(target);
        }
    }
    Ok(result)
}

fn merge_section(existing: &str, section: &str) -> String {
    let wrapped = format!("{MARKER_BEGIN}\n{}\n{MARKER_END}", section.trim());
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

fn strip_first_run_section(content: &str) -> String {
    let mut result = Vec::new();
    let mut skipping = false;
    let mut consumed_first_paragraph = false;
    let mut seen_blank_after_paragraph = false;

    for line in content.split('\n') {
        let trimmed = line.trim();
        let heading_hashes = line.bytes().take_while(|byte| *byte == b'#').count();
        let is_heading = (1..=6).contains(&heading_hashes)
            && line
                .as_bytes()
                .get(heading_hashes)
                .is_some_and(|byte| byte.is_ascii_whitespace());

        if trimmed == "## First Run" {
            skipping = true;
            consumed_first_paragraph = false;
            seen_blank_after_paragraph = false;
            continue;
        }

        if skipping {
            if is_heading {
                skipping = false;
            } else if !consumed_first_paragraph {
                if trimmed.is_empty() {
                    continue;
                }
                consumed_first_paragraph = true;
                continue;
            } else if !seen_blank_after_paragraph {
                if trimmed.is_empty() {
                    seen_blank_after_paragraph = true;
                }
                continue;
            } else if trimmed.is_empty() {
                continue;
            } else {
                skipping = false;
            }
        }

        if !skipping {
            result.push(line);
        }
    }

    let mut normalized = result.join("\n");
    while normalized.contains("\n\n\n") {
        normalized = normalized.replace("\n\n\n", "\n\n");
    }
    normalized
}
