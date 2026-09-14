use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

use super::{WorkspaceProjectionError, identity};

#[derive(Clone, Eq, PartialEq)]
pub struct AgentWorkspaceDirectory(PathBuf);

impl AgentWorkspaceDirectory {
    pub fn from_state_dir(state_dir: &Path) -> Result<Self, WorkspaceProjectionError> {
        Self::try_new(state_dir.join("workspace"))
    }

    pub fn try_new(path: PathBuf) -> Result<Self, WorkspaceProjectionError> {
        identity::absolute_path(&path)
            .then_some(Self(path))
            .ok_or(WorkspaceProjectionError::InvalidPath)
    }

    pub(super) fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Debug for AgentWorkspaceDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentWorkspaceDirectory([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaWorkspaceTemplateDirectory(PathBuf);

impl MatchaWorkspaceTemplateDirectory {
    pub fn from_runtime_layout(
        working_directory: &Path,
        openclaw_dir: &Path,
    ) -> Result<Self, WorkspaceProjectionError> {
        let primary = working_directory
            .join("resources")
            .join("agent-workspace-templates")
            .join("main-agent");
        if primary.is_dir() {
            return Self::try_new(primary);
        }
        let resources = openclaw_dir
            .parent()
            .ok_or(WorkspaceProjectionError::InvalidPath)?;
        Self::try_new(
            resources
                .join("resources")
                .join("agent-workspace-templates")
                .join("main-agent"),
        )
    }

    pub fn try_new(path: PathBuf) -> Result<Self, WorkspaceProjectionError> {
        identity::absolute_path(&path)
            .then_some(Self(path))
            .ok_or(WorkspaceProjectionError::InvalidPath)
    }

    pub(super) fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Debug for MatchaWorkspaceTemplateDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatchaWorkspaceTemplateDirectory([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceContextDirectory(PathBuf);

impl WorkspaceContextDirectory {
    pub fn from_runtime_layout(
        working_directory: &Path,
        openclaw_dir: &Path,
    ) -> Result<Option<Self>, WorkspaceProjectionError> {
        let primary = working_directory.join("resources").join("context");
        if primary.is_dir() {
            return Ok(Some(Self::try_new(primary)?));
        }
        let resources = openclaw_dir
            .parent()
            .ok_or(WorkspaceProjectionError::InvalidPath)?;
        optional_directory(resources.join("resources").join("context"))
            .map(|directory| directory.map(Self))
    }

    pub fn try_new(path: PathBuf) -> Result<Self, WorkspaceProjectionError> {
        identity::absolute_path(&path)
            .then_some(Self(path))
            .ok_or(WorkspaceProjectionError::InvalidPath)
    }

    pub(super) fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Debug for WorkspaceContextDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WorkspaceContextDirectory([REDACTED])")
    }
}

fn optional_directory(path: PathBuf) -> Result<Option<PathBuf>, WorkspaceProjectionError> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(WorkspaceProjectionError::WorkspaceUnavailable)
        }
        Ok(_) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(WorkspaceProjectionError::WorkspaceUnavailable),
    }
}
