use std::{
    fs::{File, OpenOptions, TryLockError},
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio_util::sync::CancellationToken;

use crate::domain::{WikiFailure, stable_content_hash};

use super::source_lifecycle;

#[derive(Debug)]
pub(crate) struct SourceExecution {
    _lock: File,
    root: PathBuf,
    task_id: String,
    cancellation: CancellationToken,
}

impl SourceExecution {
    pub(super) fn new(lock: File, root: &Path, task_id: String) -> Arc<Self> {
        Arc::new(Self {
            _lock: lock,
            root: root.to_path_buf(),
            task_id,
            cancellation: CancellationToken::new(),
        })
    }

    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }

    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn check_cancelled(&self) -> Result<(), WikiFailure> {
        if source_lifecycle::source_task_cancel_requested(&self.root, &self.task_id)? {
            self.cancellation.cancel();
        }
        if self.cancellation.is_cancelled() {
            return Err(WikiFailure::cancelled());
        }
        Ok(())
    }

    pub(crate) async fn observe<F, T>(&self, future: F) -> Result<T, WikiFailure>
    where
        F: Future<Output = Result<T, WikiFailure>>,
    {
        tokio::pin!(future);
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                result = &mut future => return result,
                _ = interval.tick() => {
                    if let Err(error) = self.check_cancelled() {
                        self.cancellation.cancel();
                        let result = future.await;
                        return if error.is_cancelled() { result.and(Err(error)) } else { Err(error) };
                    }
                }
            }
        }
    }

    pub(crate) fn finish<T>(&self, result: &Result<T, WikiFailure>) -> Result<(), WikiFailure> {
        source_lifecycle::finish_source_execution(&self.root, &self.task_id, result.as_ref().err())
    }
}

// Always take the short tasks lock before probing this lock; never wait for an execution.
pub(super) fn try_source_execution_lock(
    root: &Path,
    source_path: &str,
) -> Result<Option<File>, WikiFailure> {
    let directory = root.join(".llm-wiki/source-executions");
    std::fs::create_dir_all(&directory)
        .map_err(|error| WikiFailure::io(directory.to_string_lossy(), error))?;
    let path = directory.join(format!(
        "{}.lock",
        stable_content_hash(source_path.as_bytes())
    ));
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| WikiFailure::io(path.to_string_lossy(), error))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(WikiFailure::io(path.to_string_lossy(), error)),
    }
}
