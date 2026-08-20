mod access;
mod directory;
pub mod media;
mod selection;

use std::fmt;

use self::{
    access::{WorkspaceFileError, WorkspaceFiles},
    selection::OpenClawWorkspaceSelector,
};

use crate::{
    lifecycle::state_dir::CanonicalStateDir, projection::config_store::OpenClawConfigStore,
};
pub(crate) use access::replace_regular_file;

pub struct OpenClawWorkspaceAccess {
    config: OpenClawConfigStore,
    media: media::WorkspaceMedia,
}

impl OpenClawWorkspaceAccess {
    pub fn new(state_dir: CanonicalStateDir) -> Self {
        Self {
            config: OpenClawConfigStore::new(state_dir),
            media: media::WorkspaceMedia::new(),
        }
    }

    pub fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<TrustedWorkspaceDirectory, WorkspaceDirectoryFailure> {
        let selection = self
            .selection(session_key)
            .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
        let directory = selection
            .as_path()
            .to_str()
            .ok_or(WorkspaceDirectoryFailure::Unavailable)?;
        Ok(TrustedWorkspaceDirectory(directory.to_owned()))
    }

    pub fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure> {
        let files = self.files(session_key)?;
        let text = files
            .read_text_with_limit(relative_path, limit)
            .map_err(WorkspaceReadFailure::from)?;
        Ok(WorkspaceTextReceipt {
            name: text.name,
            content: text.content,
            size: text.size,
        })
    }

    pub fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure> {
        let files = self
            .files(session_key)
            .map_err(WorkspaceBinaryFailure::from)?;
        let binary = files
            .read_binary(relative_path, limit)
            .map_err(WorkspaceBinaryFailure::from)?;
        Ok(WorkspaceBinaryReceipt {
            name: binary.name,
            content: binary.content,
            size: binary.size,
        })
    }

    pub fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<media::WorkspaceMediaReceipt, media::WorkspaceMediaFailure> {
        let files = self
            .files(session_key)
            .map_err(|_| media::WorkspaceMediaFailure::Unavailable)?;
        self.media
            .prepare(session_key, &files, relative_path, mime_type)
    }

    pub fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<media::ResolvedWorkspaceMedia, media::WorkspaceMediaFailure> {
        self.media.resolve(session_key, reference)
    }

    pub fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<media::WorkspaceMediaThumbnail, media::WorkspaceMediaFailure> {
        self.media.thumbnail_gateway(
            &self.config.state_dir(),
            session_key,
            gateway_url,
            agent_id,
            mime_type,
        )
    }

    pub fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<media::WorkspaceMediaThumbnail, media::WorkspaceMediaFailure> {
        let files = self
            .files(session_key)
            .map_err(|_| media::WorkspaceMediaFailure::Unavailable)?;
        self.media.thumbnail(&files, relative_path, mime_type)
    }

    pub fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[media::WorkspaceMediaPath],
    ) -> Result<Vec<media::WorkspaceMediaThumbnailEntry>, media::WorkspaceMediaFailure> {
        let files = self
            .files(session_key)
            .map_err(|_| media::WorkspaceMediaFailure::Unavailable)?;
        Ok(self.media.thumbnails_with_gateway_context(
            &self.config.state_dir(),
            session_key,
            &files,
            paths,
        ))
    }

    pub fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[media::WorkspaceMediaPath],
    ) -> Result<Vec<media::WorkspaceMediaReceipt>, media::WorkspaceMediaFailure> {
        let files = self
            .files(session_key)
            .map_err(|_| media::WorkspaceMediaFailure::Unavailable)?;
        self.media.stage_paths(session_key, &files, paths)
    }

    pub fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<media::WorkspaceMediaReceipt, media::WorkspaceMediaFailure> {
        self.media
            .stage_buffer(session_key, base64, file_name, mime_type)
    }

    pub fn stat(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure> {
        let files = self
            .files(session_key)
            .map_err(WorkspaceStatFailure::from)?;
        let entry = files
            .stat(relative_path)
            .map_err(WorkspaceStatFailure::from)?;
        Ok(WorkspaceStatReceipt {
            name: entry.name,
            is_directory: entry.kind == access::WorkspaceEntryKind::Directory,
            size: entry.size,
            mtime_ms: entry.mtime_ms,
        })
    }

    pub fn list_dir(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure> {
        self.list_dir_with_options(session_key, relative_path, false)
    }

    pub fn list_dir_with_options(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure> {
        let relative_path = relative_path.replace('\\', "/");
        let files = self
            .files(session_key)
            .map_err(WorkspaceListFailure::from)?;
        let entries = if relative_path.is_empty() {
            files.list_root_dir_with_options(include_hidden)
        } else {
            files.list_dir_with_options(&relative_path, include_hidden)
        }
        .map_err(WorkspaceListFailure::from)?;
        Ok(WorkspaceDirectoryReceipt {
            entries: entries
                .into_iter()
                .map(|entry| WorkspaceDirectoryEntry {
                    relative_path: if relative_path.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{relative_path}/{}", entry.name)
                    },
                    display: entry.name,
                    is_directory: entry.kind == access::WorkspaceEntryKind::Directory,
                    size: entry.size,
                })
                .collect(),
        })
    }

    pub fn maintenance_workspace_directories(
        &self,
    ) -> Result<Vec<TrustedWorkspaceDirectory>, WorkspaceDirectoryFailure> {
        let config = self
            .config
            .read_workspace_selection()
            .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
        let selector =
            OpenClawWorkspaceSelector::new(self.config.state_dir_path(), &config.as_value())
                .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
        selector
            .maintenance_roots()
            .iter()
            .map(|directory| {
                directory
                    .to_str()
                    .map(|directory| TrustedWorkspaceDirectory(directory.to_owned()))
                    .ok_or(WorkspaceDirectoryFailure::Unavailable)
            })
            .collect()
    }

    pub fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceTextReceipt, WorkspaceWriteFailure> {
        let files = self
            .files(session_key)
            .map_err(WorkspaceWriteFailure::from)?;
        let text = files
            .write_text(relative_path, content)
            .map_err(WorkspaceWriteFailure::from)?;
        Ok(WorkspaceTextReceipt {
            name: text.name,
            content: text.content,
            size: text.size,
        })
    }

    fn files(&self, session_key: &str) -> Result<WorkspaceFiles, WorkspaceReadFailure> {
        Ok(WorkspaceFiles::new(self.selection(session_key)?))
    }

    fn selection(
        &self,
        session_key: &str,
    ) -> Result<selection::WorkspaceSelection, WorkspaceReadFailure> {
        let config = self
            .config
            .read_workspace_selection()
            .map_err(|_| WorkspaceReadFailure::Unavailable)?;
        let selector =
            OpenClawWorkspaceSelector::new(self.config.state_dir_path(), &config.as_value())
                .map_err(|_| WorkspaceReadFailure::Unavailable)?;
        selector
            .select(session_key)
            .ok_or(WorkspaceReadFailure::Unavailable)
    }
}

impl fmt::Debug for OpenClawWorkspaceAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClawWorkspaceAccess")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TrustedWorkspaceDirectory(String);

impl TrustedWorkspaceDirectory {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TrustedWorkspaceDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TrustedWorkspaceDirectory([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceDirectoryFailure {
    Unavailable,
}

impl fmt::Display for WorkspaceDirectoryFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("workspace directory is unavailable")
    }
}

impl std::error::Error for WorkspaceDirectoryFailure {}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceBinaryReceipt {
    name: String,
    content: Vec<u8>,
    size: u64,
}

impl WorkspaceBinaryReceipt {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

impl fmt::Debug for WorkspaceBinaryReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceBinaryReceipt")
            .field("name", &self.name)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceStatReceipt {
    name: String,
    is_directory: bool,
    size: u64,
    mtime_ms: u64,
}

impl WorkspaceStatReceipt {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub const fn size(&self) -> u64 {
        self.size
    }

    pub const fn mtime_ms(&self) -> u64 {
        self.mtime_ms
    }
}

impl fmt::Debug for WorkspaceStatReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceStatReceipt")
            .field("name", &self.name)
            .field("is_directory", &self.is_directory)
            .field("size", &self.size)
            .field("mtime_ms", &self.mtime_ms)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceTextReceipt {
    name: String,
    content: String,
    size: u64,
}

impl WorkspaceTextReceipt {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

impl fmt::Debug for WorkspaceTextReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceTextReceipt")
            .field("name", &self.name)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceDirectoryReceipt {
    entries: Vec<WorkspaceDirectoryEntry>,
}

impl WorkspaceDirectoryReceipt {
    pub fn entries(&self) -> &[WorkspaceDirectoryEntry] {
        &self.entries
    }
}

impl fmt::Debug for WorkspaceDirectoryReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceDirectoryReceipt")
            .field("entries", &self.entries)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceDirectoryEntry {
    relative_path: String,
    display: String,
    is_directory: bool,
    size: u64,
}

impl WorkspaceDirectoryEntry {
    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    pub const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceReadFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    Binary,
}

impl From<WorkspaceFileError> for WorkspaceReadFailure {
    fn from(value: WorkspaceFileError) -> Self {
        match value {
            WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            WorkspaceFileError::NotFile => Self::NotFile,
            WorkspaceFileError::TooLarge => Self::TooLarge,
            WorkspaceFileError::Binary => Self::Binary,
            WorkspaceFileError::Unavailable
            | WorkspaceFileError::NotDirectory
            | WorkspaceFileError::OutcomeUnknown => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceReadFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace read path is invalid",
            Self::Unavailable => "workspace read is unavailable",
            Self::NotFile => "workspace read target is not a file",
            Self::TooLarge => "workspace read target exceeds the limit",
            Self::Binary => "workspace read target is binary",
        })
    }
}

impl std::error::Error for WorkspaceReadFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceBinaryFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<WorkspaceReadFailure> for WorkspaceBinaryFailure {
    fn from(value: WorkspaceReadFailure) -> Self {
        match value {
            WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            WorkspaceReadFailure::Unavailable | WorkspaceReadFailure::Binary => Self::Unavailable,
            WorkspaceReadFailure::NotFile => Self::NotFile,
            WorkspaceReadFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl From<WorkspaceFileError> for WorkspaceBinaryFailure {
    fn from(value: WorkspaceFileError) -> Self {
        match value {
            WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            WorkspaceFileError::NotFile => Self::NotFile,
            WorkspaceFileError::TooLarge => Self::TooLarge,
            WorkspaceFileError::Unavailable
            | WorkspaceFileError::NotDirectory
            | WorkspaceFileError::Binary
            | WorkspaceFileError::OutcomeUnknown => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceBinaryFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace binary path is invalid",
            Self::Unavailable => "workspace binary is unavailable",
            Self::NotFile => "workspace binary target is not a file",
            Self::TooLarge => "workspace binary target exceeds the limit",
        })
    }
}

impl std::error::Error for WorkspaceBinaryFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceStatFailure {
    InvalidPath,
    Unavailable,
}

impl From<WorkspaceReadFailure> for WorkspaceStatFailure {
    fn from(value: WorkspaceReadFailure) -> Self {
        match value {
            WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            WorkspaceReadFailure::Unavailable
            | WorkspaceReadFailure::NotFile
            | WorkspaceReadFailure::TooLarge
            | WorkspaceReadFailure::Binary => Self::Unavailable,
        }
    }
}

impl From<WorkspaceFileError> for WorkspaceStatFailure {
    fn from(value: WorkspaceFileError) -> Self {
        match value {
            WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            WorkspaceFileError::Unavailable
            | WorkspaceFileError::NotFile
            | WorkspaceFileError::NotDirectory
            | WorkspaceFileError::TooLarge
            | WorkspaceFileError::Binary
            | WorkspaceFileError::OutcomeUnknown => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceStatFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace stat path is invalid",
            Self::Unavailable => "workspace stat is unavailable",
        })
    }
}

impl std::error::Error for WorkspaceStatFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceListFailure {
    InvalidPath,
    Unavailable,
    NotDirectory,
}

impl From<WorkspaceReadFailure> for WorkspaceListFailure {
    fn from(value: WorkspaceReadFailure) -> Self {
        match value {
            WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            WorkspaceReadFailure::Unavailable
            | WorkspaceReadFailure::NotFile
            | WorkspaceReadFailure::TooLarge
            | WorkspaceReadFailure::Binary => Self::Unavailable,
        }
    }
}

impl From<WorkspaceFileError> for WorkspaceListFailure {
    fn from(value: WorkspaceFileError) -> Self {
        match value {
            WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            WorkspaceFileError::NotDirectory => Self::NotDirectory,
            WorkspaceFileError::Unavailable
            | WorkspaceFileError::NotFile
            | WorkspaceFileError::TooLarge
            | WorkspaceFileError::Binary
            | WorkspaceFileError::OutcomeUnknown => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceListFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace directory path is invalid",
            Self::Unavailable => "workspace directory is unavailable",
            Self::NotDirectory => "workspace directory target is not a directory",
        })
    }
}

impl std::error::Error for WorkspaceListFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceWriteFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    OutcomeUnknown,
}

impl From<WorkspaceReadFailure> for WorkspaceWriteFailure {
    fn from(value: WorkspaceReadFailure) -> Self {
        match value {
            WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            WorkspaceReadFailure::Unavailable | WorkspaceReadFailure::NotFile => Self::Unavailable,
            WorkspaceReadFailure::TooLarge => Self::TooLarge,
            WorkspaceReadFailure::Binary => Self::Unavailable,
        }
    }
}

impl From<WorkspaceFileError> for WorkspaceWriteFailure {
    fn from(value: WorkspaceFileError) -> Self {
        match value {
            WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            WorkspaceFileError::NotFile => Self::NotFile,
            WorkspaceFileError::TooLarge => Self::TooLarge,
            WorkspaceFileError::OutcomeUnknown => Self::OutcomeUnknown,
            WorkspaceFileError::Unavailable
            | WorkspaceFileError::NotDirectory
            | WorkspaceFileError::Binary => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceWriteFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace write path is invalid",
            Self::Unavailable => "workspace write is unavailable",
            Self::NotFile => "workspace write target is not a file",
            Self::TooLarge => "workspace write content exceeds the limit",
            Self::OutcomeUnknown => "workspace write outcome is unknown",
        })
    }
}

impl std::error::Error for WorkspaceWriteFailure {}

#[cfg(test)]
mod tests;
