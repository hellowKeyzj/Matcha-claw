use std::{io, path::Path};

use serde_json::json;

use crate::rpc;

#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

/// Replaces a regular file in an existing, caller-authorized parent directory.
/// Existing permissions are retained; a final symlink is rejected, not followed.
/// Dropping this future does not cancel an already queued write or its cleanup.
pub async fn atomic_write(path: &Path, bytes: &[u8]) -> rpc::Result<()> {
    let path = path.to_owned();
    let bytes = bytes.to_owned();
    tokio::task::spawn_blocking(move || {
        platform::write_path(&path, &bytes).map_err(Failure::project)
    })
    .await
    .map_err(worker_error)?
}

/// Commits relative to the held directory, including on systems without /proc.
#[cfg(unix)]
pub async fn atomic_write_at(
    directory: &std::fs::File,
    name: &std::ffi::OsStr,
    bytes: &[u8],
) -> rpc::Result<()> {
    let directory = directory
        .try_clone()
        .map_err(|error| Failure::io("directory_clone", error).project())?;
    let name = name.to_owned();
    let bytes = bytes.to_owned();
    tokio::task::spawn_blocking(move || {
        platform::write_at(&directory, &name, &bytes).map_err(Failure::project)
    })
    .await
    .map_err(worker_error)?
}

fn worker_error(source: tokio::task::JoinError) -> rpc::Error {
    if source.is_cancelled() {
        rpc::Error::new(
            -32005,
            "file_worker_cancelled",
            "File write was cancelled before its worker started",
        )
        .with_source(source)
    } else {
        rpc::Error::new(
            -32006,
            "file_worker_outcome_unknown",
            "File worker stopped without a result; inspect the file before retrying",
        )
        .with_source(source)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("atomic file write failed during {stage}")]
struct Failure {
    stage: &'static str,
    outcome_unknown: bool,
    #[source]
    source: io::Error,
    cleanup: Vec<CleanupFailure>,
}

#[derive(Debug)]
struct CleanupFailure {
    stage: &'static str,
    source: io::Error,
}

impl Failure {
    fn io(stage: &'static str, source: io::Error) -> Self {
        Self {
            stage,
            outcome_unknown: false,
            source,
            cleanup: Vec::new(),
        }
    }

    fn commit(stage: &'static str, source: io::Error) -> Self {
        Self {
            outcome_unknown: true,
            ..Self::io(stage, source)
        }
    }

    fn project(self) -> rpc::Error {
        let kind = match self.stage {
            "target_symlink" => "file_target_symlink",
            "target_type" => "file_target_not_regular",
            "commit" => "file_commit_outcome_unknown",
            "commit_sync" => "file_sync_outcome_unknown",
            "directory_sync" => "file_directory_sync_outcome_unknown",
            _ if self.outcome_unknown => "file_commit_outcome_unknown",
            _ => match self.source.kind() {
                io::ErrorKind::PermissionDenied => "file_permission_denied",
                io::ErrorKind::NotFound => "file_not_found",
                io::ErrorKind::AlreadyExists => "file_already_exists",
                io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename => "file_invalid_path",
                io::ErrorKind::StorageFull => "file_disk_full",
                io::ErrorKind::ReadOnlyFilesystem => "file_read_only",
                io::ErrorKind::QuotaExceeded => "file_quota_exceeded",
                _ => match self.stage {
                    "directory_open" | "directory_clone" | "directory_stat" => "file_directory",
                    "target_stat" | "target_open" => "file_target_read",
                    "temporary_create" => "file_temporary_create",
                    "permissions" => "file_permissions",
                    "write" => "file_write",
                    "flush" => "file_flush",
                    "sync" => "file_sync",
                    "close" | "target_close" => "file_close",
                    _ => "file_storage",
                },
            },
        };
        let message = if self.outcome_unknown {
            "File commit could not be confirmed; inspect the file before retrying"
        } else {
            "File was not committed; inspect the storage reason before retrying"
        };
        rpc::Error::new(
            if self.outcome_unknown { -32006 } else { -32005 },
            kind,
            message,
        )
        .with_data(json!({
            "stage": self.stage,
            "ioKind": format!("{:?}", self.source.kind()),
            "osCode": self.source.raw_os_error(),
            "cleanup": self.cleanup.iter().map(|failure| json!({
                "kind": "file_cleanup",
                "stage": failure.stage,
                "ioKind": format!("{:?}", failure.source.kind()),
                "osCode": failure.source.raw_os_error(),
            })).collect::<Vec<_>>(),
        }))
        .with_source(self)
    }

    fn with_cleanup(mut self, stage: &'static str, result: io::Result<()>) -> Self {
        if let Err(source) = result {
            self.cleanup.push(CleanupFailure { stage, source });
        }
        self
    }
}
