use std::{fmt, path::Path};

use super::{
    directory::{DirectoryHandle, open},
    selection::WorkspaceSelection,
};

#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use posix as platform;
#[cfg(windows)]
use windows as platform;

pub(super) const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_BINARY_BYTES: usize = 50 * 1024 * 1024;
pub(super) const MAX_WRITE_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES: usize = 4096;
const MAX_PATH_COMPONENT_BYTES: usize = 255;

pub(super) struct WorkspaceFiles {
    selection: WorkspaceSelection,
}

pub(crate) fn replace_regular_file(
    workspace: &std::path::Path,
    name: &str,
    content: &[u8],
) -> Result<(), WorkspaceFileError> {
    let path = RelativePath::try_new(name)?;
    if path.components().len() != 1 {
        return Err(WorkspaceFileError::InvalidRelative);
    }
    let workspace = open(workspace).map_err(|_| WorkspaceFileError::Unavailable)?;
    platform::write_file(&workspace.into_handle(), path.components(), content)
}

impl WorkspaceFiles {
    pub(super) fn read_external_file(
        path: &Path,
        limit: usize,
    ) -> Result<(Vec<u8>, u64), WorkspaceFileError> {
        platform::read_external_file(path, limit)
    }

    pub(super) fn new(selection: WorkspaceSelection) -> Self {
        Self { selection }
    }

    pub(super) fn read_text_with_limit(
        &self,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceText, WorkspaceFileError> {
        let path = RelativePath::try_new(relative_path)?;
        let workspace = self.resolve()?;
        let (content, size) =
            platform::read_file(&workspace, path.components(), limit.min(MAX_TEXT_BYTES))?;
        if content.contains(&0) {
            return Err(WorkspaceFileError::Binary);
        }
        let content = String::from_utf8(content).map_err(|_| WorkspaceFileError::Binary)?;
        Ok(WorkspaceText {
            name: path.into_string(),
            content,
            size,
        })
    }

    pub(super) fn read_binary(
        &self,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinary, WorkspaceFileError> {
        let path = RelativePath::try_new(relative_path)?;
        let workspace = self.resolve()?;
        let (content, size) =
            platform::read_file(&workspace, path.components(), limit.min(MAX_BINARY_BYTES))?;
        Ok(WorkspaceBinary {
            name: path.into_string(),
            content,
            size,
        })
    }

    pub(super) fn stat(&self, relative_path: &str) -> Result<WorkspaceEntry, WorkspaceFileError> {
        let path = RelativePath::try_new(relative_path)?;
        let workspace = self.resolve()?;
        let entry = platform::stat(&workspace, path.components())?;
        Ok(WorkspaceEntry {
            name: path.into_string(),
            kind: entry.kind,
            size: entry.size,
            mtime_ms: entry.mtime_ms,
        })
    }

    pub(super) fn list_dir_with_options(
        &self,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<Vec<WorkspaceEntry>, WorkspaceFileError> {
        let path = RelativePath::try_new(relative_path)?;
        self.list_directory(path.components(), include_hidden)
    }

    pub(super) fn list_root_dir_with_options(
        &self,
        include_hidden: bool,
    ) -> Result<Vec<WorkspaceEntry>, WorkspaceFileError> {
        self.list_directory(&[], include_hidden)
    }

    fn list_directory(
        &self,
        components: &[String],
        include_hidden: bool,
    ) -> Result<Vec<WorkspaceEntry>, WorkspaceFileError> {
        let workspace = self.resolve()?;
        platform::list_dir(&workspace, components, include_hidden)
    }

    pub(super) fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceText, WorkspaceFileError> {
        if content.len() > MAX_WRITE_TEXT_BYTES {
            return Err(WorkspaceFileError::TooLarge);
        }
        let path = RelativePath::try_new(relative_path)?;
        let workspace = self.resolve()?;
        platform::write_file(&workspace, path.components(), content.as_bytes())?;
        Ok(WorkspaceText {
            name: path.into_string(),
            content: content.to_owned(),
            size: content.len() as u64,
        })
    }

    fn resolve(&self) -> Result<DirectoryHandle, WorkspaceFileError> {
        open(self.selection.as_path())
            .map(|workspace| workspace.into_handle())
            .map_err(|_| WorkspaceFileError::Unavailable)
    }
}

impl fmt::Debug for WorkspaceFiles {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WorkspaceFiles")
    }
}

pub(super) struct WorkspaceText {
    pub(super) name: String,
    pub(super) content: String,
    pub(super) size: u64,
}

impl fmt::Debug for WorkspaceText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceText")
            .field("name", &self.name)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

pub(super) struct WorkspaceBinary {
    pub(super) name: String,
    pub(super) content: Vec<u8>,
    pub(super) size: u64,
}

impl fmt::Debug for WorkspaceBinary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceBinary")
            .field("name", &self.name)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct WorkspaceEntry {
    pub(super) name: String,
    pub(super) kind: WorkspaceEntryKind,
    pub(super) size: u64,
    pub(super) mtime_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum WorkspaceEntryKind {
    File,
    Directory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceFileError {
    InvalidRelative,
    Unavailable,
    NotFile,
    NotDirectory,
    TooLarge,
    Binary,
    OutcomeUnknown,
}

impl fmt::Display for WorkspaceFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRelative => "invalid relative workspace path",
            Self::Unavailable => "workspace file is unavailable",
            Self::NotFile => "workspace entry is not a file",
            Self::NotDirectory => "workspace entry is not a directory",
            Self::TooLarge => "workspace file exceeds the operation limit",
            Self::Binary => "workspace text file is binary",
            Self::OutcomeUnknown => "workspace write outcome is unknown",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WorkspaceFileError {}

pub(super) struct RelativePath {
    value: String,
    components: Vec<String>,
}

impl RelativePath {
    pub(super) fn try_new(value: &str) -> Result<Self, WorkspaceFileError> {
        if value.is_empty()
            || value.len() > MAX_RELATIVE_PATH_BYTES
            || value.as_bytes().contains(&0)
            || value
                .as_bytes()
                .first()
                .is_some_and(|byte| matches!(byte, b'/' | b'\\'))
            || value.contains(':')
        {
            return Err(WorkspaceFileError::InvalidRelative);
        }
        let components = value
            .split(['/', '\\'])
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if components.is_empty()
            || components
                .iter()
                .any(|component| !valid_component(component))
        {
            return Err(WorkspaceFileError::InvalidRelative);
        }
        Ok(Self {
            value: components.join("/"),
            components,
        })
    }

    fn components(&self) -> &[String] {
        &self.components
    }

    fn into_string(self) -> String {
        self.value
    }
}

fn valid_component(component: &str) -> bool {
    !component.is_empty()
        && component.len() <= MAX_PATH_COMPONENT_BYTES
        && component != "."
        && component != ".."
        && !component.contains(['/', '\\', ':'])
        && !component.as_bytes().contains(&0)
}
