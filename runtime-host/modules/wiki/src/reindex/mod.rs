use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    WikiFailure, WikiRevision,
    domain::{chunk_markdown_with_overlap, extract_search_title, normalize_relative_path},
    index::{PreparedPageEmbedding, WikiVectorIndex},
    search_config::{EmbeddingConfig, EmbeddingCredentials},
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiReindexInput {
    pub project_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiReindexStatus {
    Idle,
    Running,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiReindexPhase {
    Preparing,
    Writing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReindexState {
    pub project_id: String,
    pub task_id: Option<String>,
    pub status: WikiReindexStatus,
    pub phase: Option<WikiReindexPhase>,
    pub done: usize,
    pub total: usize,
    pub count: usize,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReindexReceipt {
    pub project_id: String,
    pub count: usize,
}

#[derive(Default)]
pub(crate) struct ReindexProgress {
    states: Mutex<BTreeMap<String, WikiReindexState>>,
}

impl ReindexProgress {
    pub(crate) fn state(&self, project_id: &str) -> WikiReindexState {
        self.states
            .lock()
            .expect("Wiki reindex progress lock")
            .get(project_id)
            .cloned()
            .unwrap_or_else(|| WikiReindexState {
                project_id: project_id.to_owned(),
                task_id: None,
                status: WikiReindexStatus::Idle,
                phase: None,
                done: 0,
                total: 0,
                count: 0,
                message: None,
            })
    }

    pub(crate) fn reserve(
        self: &Arc<Self>,
        project_id: &str,
        task_id: Option<String>,
    ) -> Result<ReindexRun, WikiFailure> {
        let mut states = self.states.lock().expect("Wiki reindex progress lock");
        if states
            .get(project_id)
            .is_some_and(|state| state.status == WikiReindexStatus::Running)
        {
            return Err(WikiFailure::invalid_input(
                "projectId",
                "An embedding rebuild is already running for this project",
            ));
        }
        states.insert(
            project_id.to_owned(),
            WikiReindexState {
                project_id: project_id.to_owned(),
                task_id,
                status: WikiReindexStatus::Running,
                phase: Some(WikiReindexPhase::Preparing),
                done: 0,
                total: 0,
                count: 0,
                message: None,
            },
        );
        Ok(ReindexRun {
            progress: self.clone(),
            project_id: project_id.to_owned(),
            finished: false,
        })
    }
}

pub(crate) struct ReindexRun {
    progress: Arc<ReindexProgress>,
    project_id: String,
    finished: bool,
}

impl ReindexRun {
    fn update(&self, update: impl FnOnce(&mut WikiReindexState)) {
        let mut states = self
            .progress
            .states
            .lock()
            .expect("Wiki reindex progress lock");
        update(
            states
                .get_mut(&self.project_id)
                .expect("reserved Wiki reindex progress"),
        );
    }

    fn finish(&mut self, error: Option<&WikiFailure>) {
        self.update(|state| {
            state.status = if error.is_some() {
                WikiReindexStatus::Error
            } else {
                WikiReindexStatus::Done
            };
            state.phase = None;
            state.message = error.map(failure_message);
        });
        self.finished = true;
    }
}

impl Drop for ReindexRun {
    fn drop(&mut self) {
        if !self.finished {
            self.update(|state| {
                state.status = WikiReindexStatus::Error;
                state.phase = None;
                state.message = Some(
                    "Embedding rebuild was interrupted; retry explicitly. It will not be replayed."
                        .to_owned(),
                );
            });
        }
    }
}

pub(crate) struct ReindexPlan {
    pub project_root: PathBuf,
    pub index: Arc<dyn WikiVectorIndex>,
    pub config: EmbeddingConfig,
    pub credentials: EmbeddingCredentials,
    pub progress: ReindexRun,
}

pub(crate) async fn run(
    mut plan: ReindexPlan,
    cancellation: CancellationToken,
) -> Result<WikiReindexReceipt, WikiFailure> {
    let result = execute(&plan, &cancellation).await;
    plan.progress.finish(result.as_ref().err());
    result
}

async fn execute(
    plan: &ReindexPlan,
    cancellation: &CancellationToken,
) -> Result<WikiReindexReceipt, WikiFailure> {
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    let root = plan.project_root.clone();
    let paths = tokio::task::spawn_blocking(move || content_paths(&root))
        .await
        .map_err(|_| {
            WikiFailure::state("Could not read the Wiki tree; existing index was left unchanged")
        })??;
    plan.progress.update(|state| state.total = paths.len());
    let http_slots = tokio::sync::Semaphore::new(plan.config.concurrency.clamp(1, 32));
    let mut pending = stream::iter(paths)
        .map(|path| {
            let slots = &http_slots;
            async move { prepare_page(plan, &path, slots, cancellation).await }
        })
        .buffer_unordered(plan.config.concurrency.clamp(1, 32));
    let mut pages = Vec::new();
    let mut failed = 0;
    while let Some(result) = pending.next().await {
        match result {
            Ok(Some(page)) => pages.push(page),
            Ok(None) => {}
            Err(error) if error.is_cancelled() => return Err(error),
            Err(_) => failed += 1,
        }
        plan.progress.update(|state| state.done += 1);
    }
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    plan.progress
        .update(|state| state.phase = Some(WikiReindexPhase::Writing));
    // Cancellation stops preparation, never abandons a Lance commit. OwnedTask shutdown joins this section.
    if failed > 0 {
        let on_written = |count| plan.progress.update(|state| state.count = count);
        let (count, write_failure) = plan
            .index
            .update_pages(&plan.project_root, pages, &on_written)
            .await;
        plan.progress.update(|state| state.count = count);
        if count > 0 && crate::vector::optimize(&plan.project_root).await.is_err() {
            eprintln!("[WikiEmbedding] partial_index_optimization_failed");
        }
        return Err(WikiFailure::state(if write_failure.is_some() {
            format!(
                "{failed} pages could not be prepared; {count} pages were updated. Some prepared pages could not be written; failed pages retained their previous vectors. Retry explicitly."
            )
        } else {
            format!(
                "{failed} pages could not be prepared; {count} pages were updated. Failed pages retained their previous vectors. Retry explicitly."
            )
        }));
    }
    let count = plan
        .index
        .replace_pages(&plan.project_root, pages)
        .await
        .map_err(|_| {
            WikiFailure::state(
                "Embedding rebuild could not confirm index replacement; retry explicitly. It will not be replayed.",
            )
        })?;
    plan.progress.update(|state| state.count = count);
    if count > 0 && crate::vector::optimize(&plan.project_root).await.is_err() {
        eprintln!("[WikiEmbedding] rebuilt_index_optimization_failed");
    }
    Ok(WikiReindexReceipt {
        project_id: plan.progress.project_id.clone(),
        count,
    })
}

async fn prepare_page(
    plan: &ReindexPlan,
    relative_path: &str,
    http_slots: &tokio::sync::Semaphore,
    cancellation: &CancellationToken,
) -> Result<Option<PreparedPageEmbedding>, WikiFailure> {
    let content = tokio::select! {
        _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
        content = tokio::fs::read_to_string(plan.project_root.join(relative_path)) => content.map_err(|_| WikiFailure::state("Wiki content could not be read"))?,
    };
    let title = extract_search_title(
        &content,
        Path::new(relative_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(relative_path),
    );
    let revision = WikiRevision::for_bytes(content.as_bytes(), 0);
    let chunks = chunk_markdown_with_overlap(
        relative_path,
        &content,
        plan.config.max_chunk_chars,
        plan.config.overlap_chunk_chars,
    );
    if chunks.is_empty() {
        return Ok(None);
    }
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::select! {
                _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
                _ = tokio::time::sleep(std::time::Duration::from_millis(attempt * 250)) => {},
            }
        }
        let result = tokio::select! {
            _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
            result = plan.index.prepare_page(relative_path, &title, &revision, &chunks, &plan.config, &plan.credentials, http_slots) => result,
        };
        if let Ok(page) = result {
            return Ok(Some(page));
        }
    }
    Err(WikiFailure::state("Wiki page could not be fully embedded"))
}

fn content_paths(root: &Path) -> Result<Vec<String>, WikiFailure> {
    let wiki = root.join("wiki");
    let mut directories = vec![wiki];
    let mut paths = Vec::new();
    while let Some(directory) = directories.pop() {
        let metadata = std::fs::symlink_metadata(&directory).map_err(|_| tree_failure())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(tree_failure());
        }
        for entry in std::fs::read_dir(directory).map_err(|_| tree_failure())? {
            let entry = entry.map_err(|_| tree_failure())?;
            let file_type = entry.file_type().map_err(|_| tree_failure())?;
            if file_type.is_symlink() {
                return Err(tree_failure());
            }
            if file_type.is_dir() {
                directories.push(entry.path());
                continue;
            }
            let path = entry.path();
            if !file_type.is_file() || path.extension().is_none_or(|extension| extension != "md") {
                continue;
            }
            if path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| {
                    matches!(stem, "index" | "log" | "overview" | "purpose" | "schema")
                })
            {
                continue;
            }
            paths.push(normalize_relative_path(
                path.strip_prefix(root).map_err(|_| tree_failure())?,
            ));
            if paths.len() > 10_000 {
                return Err(WikiFailure::state(
                    "Wiki rebuild exceeds the 10000 content page limit; existing index was left unchanged",
                ));
            }
        }
    }
    paths.sort_unstable();
    Ok(paths)
}

fn tree_failure() -> WikiFailure {
    WikiFailure::state("Could not read the complete Wiki tree; existing index was left unchanged")
}

fn failure_message(error: &WikiFailure) -> String {
    match error {
        WikiFailure::Cancelled => "Embedding rebuild was cancelled before writing; existing index was left unchanged. Retry explicitly.".to_owned(),
        WikiFailure::StateUnavailable { message } => message.clone(),
        _ => "Embedding rebuild failed; retry explicitly.".to_owned(),
    }
}
