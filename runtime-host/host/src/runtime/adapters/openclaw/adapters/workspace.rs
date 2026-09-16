use crate::runtime::driver::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure as DriverWorkspaceBinaryFailure,
    WorkspaceBinaryReceipt, WorkspaceDirectoryEntry,
    WorkspaceDirectoryFailure as DriverWorkspaceDirectoryFailure, WorkspaceDirectoryReceipt,
    WorkspaceDirectoryRoot, WorkspaceListFailure as DriverWorkspaceListFailure,
    WorkspaceMediaFailure as DriverWorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure as DriverWorkspaceReadFailure,
    WorkspaceStatFailure as DriverWorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure as DriverWorkspaceWriteFailure, WorkspaceWriteReceipt,
};

pub(crate) fn workspace_directory_root(
    value: openclaw::workspace::TrustedWorkspaceDirectory,
) -> WorkspaceDirectoryRoot {
    WorkspaceDirectoryRoot::new(value.as_str().to_owned())
}

pub(crate) fn workspace_text_receipt(
    value: openclaw::workspace::WorkspaceTextReceipt,
) -> WorkspaceTextReceipt {
    WorkspaceTextReceipt::new(
        value.name().to_owned(),
        value.content().to_owned(),
        value.size(),
    )
}

pub(crate) fn workspace_write_receipt(
    value: openclaw::workspace::WorkspaceTextReceipt,
) -> WorkspaceWriteReceipt {
    WorkspaceWriteReceipt::new(value.name().to_owned(), value.size())
}

pub(crate) fn workspace_binary_receipt(
    value: openclaw::workspace::WorkspaceBinaryReceipt,
) -> WorkspaceBinaryReceipt {
    WorkspaceBinaryReceipt::new(
        value.name().to_owned(),
        value.content().to_vec(),
        value.size(),
    )
}

pub(crate) fn workspace_stat_receipt(
    value: openclaw::workspace::WorkspaceStatReceipt,
) -> WorkspaceStatReceipt {
    WorkspaceStatReceipt::new(
        value.name().to_owned(),
        value.is_directory(),
        value.size(),
        value.mtime_ms(),
    )
}

pub(crate) fn workspace_directory_receipt(
    value: openclaw::workspace::WorkspaceDirectoryReceipt,
) -> WorkspaceDirectoryReceipt {
    WorkspaceDirectoryReceipt::new(
        value
            .entries()
            .iter()
            .map(|entry| {
                WorkspaceDirectoryEntry::new(
                    entry.relative_path().to_owned(),
                    entry.display().to_owned(),
                    entry.is_directory(),
                    entry.size(),
                )
            })
            .collect(),
    )
}

pub(crate) fn workspace_media_receipt(
    value: openclaw::workspace::media::WorkspaceMediaReceipt,
) -> WorkspaceMediaReceipt {
    WorkspaceMediaReceipt::new(
        value.handle().as_str().to_owned(),
        value.name().to_owned(),
        value.mime_type().to_owned(),
        value.size(),
        value.preview().map(str::to_owned),
    )
}

pub(crate) fn resolved_workspace_media(
    value: openclaw::workspace::media::ResolvedWorkspaceMedia,
) -> ResolvedWorkspaceMedia {
    ResolvedWorkspaceMedia::new(value.content().to_vec())
}

pub(crate) fn workspace_media_thumbnail(
    value: openclaw::workspace::media::WorkspaceMediaThumbnail,
) -> WorkspaceMediaThumbnail {
    WorkspaceMediaThumbnail::new(value.preview().map(str::to_owned), value.file_size())
}

pub(crate) fn workspace_media_thumbnail_entry(
    value: openclaw::workspace::media::WorkspaceMediaThumbnailEntry,
) -> WorkspaceMediaThumbnailEntry {
    WorkspaceMediaThumbnailEntry::new(
        value.key().to_owned(),
        workspace_media_thumbnail(value.thumbnail().clone()),
    )
}

pub(crate) fn native_workspace_media_path(
    value: &WorkspaceMediaPath,
) -> openclaw::workspace::media::WorkspaceMediaPath {
    match value {
        WorkspaceMediaPath::Relative {
            key,
            relative_path,
            mime_type,
        } => openclaw::workspace::media::WorkspaceMediaPath::new(
            key.clone(),
            relative_path.clone(),
            mime_type.clone(),
        ),
        WorkspaceMediaPath::Gateway {
            key,
            gateway_url,
            mime_type,
            agent_id,
        } => openclaw::workspace::media::WorkspaceMediaPath::new_gateway(
            key.clone(),
            gateway_url.clone(),
            mime_type.clone(),
            agent_id.clone(),
        ),
    }
}

impl From<openclaw::workspace::WorkspaceDirectoryFailure> for DriverWorkspaceDirectoryFailure {
    fn from(value: openclaw::workspace::WorkspaceDirectoryFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceDirectoryFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl From<openclaw::workspace::WorkspaceReadFailure> for DriverWorkspaceReadFailure {
    fn from(value: openclaw::workspace::WorkspaceReadFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceReadFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceReadFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceReadFailure::TooLarge => Self::TooLarge,
            openclaw::workspace::WorkspaceReadFailure::Binary => Self::Binary,
        }
    }
}

impl From<openclaw::workspace::WorkspaceBinaryFailure> for DriverWorkspaceBinaryFailure {
    fn from(value: openclaw::workspace::WorkspaceBinaryFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceBinaryFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceBinaryFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceBinaryFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceBinaryFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl From<openclaw::workspace::WorkspaceStatFailure> for DriverWorkspaceStatFailure {
    fn from(value: openclaw::workspace::WorkspaceStatFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceStatFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceStatFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl From<openclaw::workspace::WorkspaceListFailure> for DriverWorkspaceListFailure {
    fn from(value: openclaw::workspace::WorkspaceListFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceListFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceListFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceListFailure::NotDirectory => Self::NotDirectory,
        }
    }
}

impl From<openclaw::workspace::WorkspaceWriteFailure> for DriverWorkspaceWriteFailure {
    fn from(value: openclaw::workspace::WorkspaceWriteFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceWriteFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceWriteFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceWriteFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceWriteFailure::TooLarge => Self::TooLarge,
            openclaw::workspace::WorkspaceWriteFailure::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

impl From<openclaw::workspace::media::WorkspaceMediaFailure> for DriverWorkspaceMediaFailure {
    fn from(value: openclaw::workspace::media::WorkspaceMediaFailure) -> Self {
        match value {
            openclaw::workspace::media::WorkspaceMediaFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::media::WorkspaceMediaFailure::InvalidReference => {
                Self::InvalidReference
            }
            openclaw::workspace::media::WorkspaceMediaFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::media::WorkspaceMediaFailure::NotFile => Self::NotFile,
            openclaw::workspace::media::WorkspaceMediaFailure::TooLarge => Self::TooLarge,
        }
    }
}
