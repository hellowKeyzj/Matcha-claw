mod detection;
mod merge;
mod prompts;
mod queue;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{WikiDuplicateGroup, WikiFailure},
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest,
        WikiIngestLlmRole,
    },
};

pub(crate) use detection::detect;
pub(crate) use merge::compute_merge;
pub(crate) use queue::ProjectQueue;
pub(crate) use queue::{DedupRuns, group_key};

#[derive(Clone)]
pub(crate) struct Page {
    pub path: String,
    pub content: String,
}

pub(crate) struct DedupDetectionPlan {
    pub(crate) project_id: String,
    pub(crate) input: crate::domain::WikiDedupDetectInput,
    pub(crate) cancellation: CancellationToken,
    pub(crate) runs: Arc<DedupRuns>,
}

impl Drop for DedupDetectionPlan {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.runs
            .detections
            .lock()
            .expect("dedup detection lock")
            .remove(&(self.project_id.clone(), self.input.task_id.clone()));
    }
}

pub(crate) struct DedupMergePlan {
    pub(crate) project_id: String,
    pub(crate) task_id: String,
    pub(crate) root: PathBuf,
    pub(crate) canonical: Page,
    pub(crate) rewrites: Vec<Page>,
    pub(crate) deleted: Vec<String>,
    pub(crate) backup: Vec<Page>,
    pub(crate) cancellation: CancellationToken,
    // Keep the serial merge ownership through Commit, not just through the LLM call.
    pub(crate) _serial: OwnedMutexGuard<()>,
}

pub(crate) fn load_pages(root: &Path) -> Result<Vec<Page>, WikiFailure> {
    let mut pages = Vec::new();
    for path in crate::owner::source_lifecycle::wiki_markdown_files(root)? {
        let relative = crate::domain::normalize_relative_path(
            path.strip_prefix(root)
                .expect("wiki traversal remains under project"),
        );
        if let Ok(content) = std::fs::read_to_string(&path) {
            pages.push(Page {
                path: relative,
                content,
            });
        }
    }
    pages.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(pages)
}

pub(crate) fn validate_group(
    group: &WikiDuplicateGroup,
    canonical: &str,
) -> Result<(), WikiFailure> {
    if group.slugs.len() < 2 || !group.slugs.iter().any(|slug| slug == canonical) {
        return Err(WikiFailure::invalid_input(
            "group",
            "merge requires at least two pages and a canonical slug in the group",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for slug in &group.slugs {
        if slug.is_empty()
            || slug.contains(['/', '\\'])
            || !crate::ingest::parser::is_safe_ingest_path(&format!("wiki/entities/{slug}.md"))
            || !seen.insert(slug.to_lowercase())
        {
            return Err(WikiFailure::invalid_input(
                "group.slugs",
                "slugs must be distinct wiki page names",
            ));
        }
    }
    Ok(())
}

pub(super) async fn call_llm(
    llm: &Arc<dyn WikiIngestLlm>,
    model_ref: Option<String>,
    system: &str,
    user: String,
    max_tokens: u32,
    cancellation: &CancellationToken,
) -> Result<String, WikiFailure> {
    check_cancelled(cancellation)?;
    llm.generate_cancellable(
        WikiIngestLlmRequest {
            model_ref,
            messages: vec![
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::System,
                    content: system.to_owned(),
                },
                WikiIngestLlmMessage {
                    role: WikiIngestLlmRole::User,
                    content: user,
                },
            ],
            options: WikiIngestLlmOptions {
                max_output_tokens: Some(max_tokens),
                temperature: Some(0.1),
            },
        },
        cancellation.clone(),
    )
    .await
    .map(|response| response.text)
}

pub(crate) fn check_cancelled(cancellation: &CancellationToken) -> Result<(), WikiFailure> {
    if cancellation.is_cancelled() {
        Err(WikiFailure::cancelled())
    } else {
        Ok(())
    }
}
