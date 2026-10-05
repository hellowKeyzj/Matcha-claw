pub(crate) mod prompts;
pub(crate) mod workflow;

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use crate::{
    WikiFailure,
    domain::{WikiSelectionInput, WikiSelectionReference, WikiSelectionStatus, WikiSelectionTask},
    ports::WikiIngestLlm,
};

pub(crate) const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const REQUEST_FAILED: &str =
    "Selection generation failed. Check the Wiki model and retry with a new taskId.";

pub(crate) struct SelectionPlan {
    pub(crate) input: WikiSelectionInput,
    pub(crate) llm: Arc<dyn WikiIngestLlm>,
    pub(crate) run: SelectionRun,
}

#[derive(Default)]
pub(crate) struct SelectionRuns {
    state: Mutex<SelectionState>,
}

#[derive(Default)]
struct SelectionState {
    closed: bool,
    entries: Vec<SelectionEntry>,
}

struct SelectionEntry {
    task: WikiSelectionTask,
    cancellation: Option<CancellationToken>,
    published_len: usize,
    published_at: Instant,
}

impl SelectionEntry {
    fn snapshot(&self) -> WikiSelectionTask {
        WikiSelectionTask {
            project_id: self.task.project_id.clone(),
            task_id: self.task.task_id.clone(),
            relative_path: self.task.relative_path.clone(),
            intent: self.task.intent,
            status: self.task.status,
            content: self.task.content[..self.published_len].to_owned(),
            references: self.task.references.clone(),
            error: self.task.error.clone(),
        }
    }
}

impl SelectionRuns {
    pub(crate) fn begin(
        self: &Arc<Self>,
        task: WikiSelectionTask,
    ) -> Result<SelectionRun, WikiFailure> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        if state.closed {
            return Err(WikiFailure::OwnerUnavailable);
        }
        if state.entries.iter().any(|entry| {
            entry.task.project_id == task.project_id && entry.task.task_id == task.task_id
        }) {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "Selection task already exists; use a new taskId",
            ));
        }
        if state.entries.len() == 32 {
            let index = state
                .entries
                .iter()
                .position(|entry| entry.cancellation.is_none())
                .ok_or_else(|| {
                    WikiFailure::state("Too many active selection tasks; retry after one completes")
                })?;
            state.entries.remove(index);
        }
        let cancellation = CancellationToken::new();
        let key = (task.project_id.clone(), task.task_id.clone());
        state.entries.push(SelectionEntry {
            task,
            cancellation: Some(cancellation.clone()),
            published_len: 0,
            published_at: Instant::now(),
        });
        Ok(SelectionRun {
            runs: self.clone(),
            key,
            cancellation,
        })
    }

    pub(crate) fn task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiSelectionTask, WikiFailure> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let entry = find_entry(&mut state, project_id, task_id)?;
        if entry.published_at.elapsed() >= Duration::from_millis(200) {
            entry.published_len = entry.task.content.len();
            entry.published_at = Instant::now();
        }
        Ok(entry.snapshot())
    }

    pub(crate) fn cancel(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiSelectionTask, WikiFailure> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let entry = find_entry(&mut state, project_id, task_id)?;
        cancel_entry(entry);
        Ok(entry.snapshot())
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            for entry in &mut state.entries {
                cancel_entry(entry);
            }
        }
    }
}

pub(crate) struct SelectionRun {
    runs: Arc<SelectionRuns>,
    key: (String, String),
    pub(crate) cancellation: CancellationToken,
}

impl SelectionRun {
    pub(crate) fn update(
        &self,
        status: WikiSelectionStatus,
        references: Vec<WikiSelectionReference>,
    ) -> Result<(), WikiFailure> {
        let mut state = self
            .runs
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let entry = find_entry(&mut state, &self.key.0, &self.key.1)?;
        self.ensure_active()?;
        entry.task.status = status;
        entry.task.references = references;
        Ok(())
    }

    pub(crate) fn append(&self, delta: &str) -> Result<(), WikiFailure> {
        let mut state = self
            .runs
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let entry = find_entry(&mut state, &self.key.0, &self.key.1)?;
        self.ensure_active()?;
        if entry.task.content.len().saturating_add(delta.len()) > MAX_CONTENT_BYTES {
            return Err(WikiFailure::state(
                "Selection output exceeds the 2 MiB limit",
            ));
        }
        entry.task.content.push_str(delta);
        Ok(())
    }

    pub(crate) fn ensure_active(&self) -> Result<(), WikiFailure> {
        if self.cancellation.is_cancelled() {
            Err(WikiFailure::cancelled())
        } else {
            Ok(())
        }
    }

    pub(crate) fn finish(&self, result: &Result<(), WikiFailure>) -> Result<(), WikiFailure> {
        let mut state = self
            .runs
            .state
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let entry = find_entry(&mut state, &self.key.0, &self.key.1)?;
        if self.cancellation.is_cancelled()
            || result.as_ref().err().is_some_and(WikiFailure::is_cancelled)
        {
            cancel_entry(entry);
            return Err(WikiFailure::cancelled());
        }
        entry.task.status = if result.is_ok() {
            WikiSelectionStatus::Done
        } else {
            WikiSelectionStatus::Failed
        };
        entry.task.error = result.as_ref().err().map(|_| REQUEST_FAILED.to_owned());
        entry.published_len = entry.task.content.len();
        Ok(())
    }
}

impl Drop for SelectionRun {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Ok(mut state) = self.runs.state.lock() {
            if let Ok(entry) = find_entry(&mut state, &self.key.0, &self.key.1) {
                cancel_entry(entry);
                entry.cancellation = None;
            }
        }
    }
}

fn find_entry<'a>(
    state: &'a mut SelectionState,
    project_id: &str,
    task_id: &str,
) -> Result<&'a mut SelectionEntry, WikiFailure> {
    state
        .entries
        .iter_mut()
        .find(|entry| entry.task.project_id == project_id && entry.task.task_id == task_id)
        .ok_or_else(|| WikiFailure::not_found("Wiki selection task"))
}

fn cancel_entry(entry: &mut SelectionEntry) {
    if matches!(
        entry.task.status,
        WikiSelectionStatus::Done | WikiSelectionStatus::Failed | WikiSelectionStatus::Cancelled
    ) {
        return;
    }
    if let Some(cancellation) = &entry.cancellation {
        cancellation.cancel();
    }
    entry.task.status = WikiSelectionStatus::Cancelled;
    entry.task.error = None;
    entry.published_len = entry.task.content.len();
}
