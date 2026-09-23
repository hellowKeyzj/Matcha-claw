use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use super::WorkspaceProjectionError;

pub(super) fn absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
}

pub(super) fn ensure_workspace(path: &Path) -> Result<PathBuf, WorkspaceProjectionError> {
    fs::create_dir_all(path).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
    directory(path)
}

pub(super) fn directory(path: &Path) -> Result<PathBuf, WorkspaceProjectionError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(WorkspaceProjectionError::WorkspaceUnavailable);
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
    Ok(external_path(canonical))
}

pub(super) fn external_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy();
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(r"\\").join(path);
        }
        if let Some(path) = path.strip_prefix(r"\\?\") {
            return PathBuf::from(path);
        }
    }
    path
}

pub(super) fn read_regular(path: &Path) -> Result<Option<String>, WorkspaceProjectionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(WorkspaceProjectionError::WorkspaceUnavailable)
        }
        Ok(_) => fs::read_to_string(path)
            .map(Some)
            .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(WorkspaceProjectionError::WorkspaceUnavailable),
    }
}

pub(super) fn write_if_missing(
    path: &Path,
    content: &str,
) -> Result<bool, WorkspaceProjectionError> {
    let mut output = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_regular(path)?;
            return Ok(false);
        }
        Err(_) => return Err(WorkspaceProjectionError::WorkspaceUnavailable),
    };
    output
        .write_all(content.as_bytes())
        .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
    Ok(true)
}

pub(super) fn remove_regular(path: &Path) -> Result<(), WorkspaceProjectionError> {
    if read_regular(path)?.is_none() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)
}
