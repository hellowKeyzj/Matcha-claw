use workspace_module::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryEntry, WorkspaceDirectoryFailure, WorkspaceDirectoryReceipt,
    WorkspaceDirectoryRoot, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure, WorkspaceWriteReceipt,
};

pub(crate) fn workspace_directory_root(
    value: crate::workspace::TrustedWorkspaceDirectory,
) -> WorkspaceDirectoryRoot {
    WorkspaceDirectoryRoot::new(value.as_str().to_owned())
}

pub(crate) fn workspace_text_receipt(
    value: crate::workspace::WorkspaceTextReceipt,
) -> WorkspaceTextReceipt {
    WorkspaceTextReceipt::new(
        value.name().to_owned(),
        value.content().to_owned(),
        value.size(),
    )
}

pub(crate) fn workspace_write_receipt(
    value: crate::workspace::WorkspaceTextReceipt,
) -> WorkspaceWriteReceipt {
    WorkspaceWriteReceipt::new(value.name().to_owned(), value.size())
}

pub(crate) fn workspace_binary_receipt(
    value: crate::workspace::WorkspaceBinaryReceipt,
) -> WorkspaceBinaryReceipt {
    WorkspaceBinaryReceipt::new(
        value.name().to_owned(),
        value.content().to_vec(),
        value.size(),
    )
}

pub(crate) fn workspace_stat_receipt(
    value: crate::workspace::WorkspaceStatReceipt,
) -> WorkspaceStatReceipt {
    WorkspaceStatReceipt::new(
        value.name().to_owned(),
        value.is_directory(),
        value.size(),
        value.mtime_ms(),
    )
}

pub(crate) fn workspace_directory_receipt(
    value: crate::workspace::WorkspaceDirectoryReceipt,
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
    value: crate::workspace::media::WorkspaceMediaReceipt,
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
    value: crate::workspace::media::ResolvedWorkspaceMedia,
) -> ResolvedWorkspaceMedia {
    ResolvedWorkspaceMedia::new(value.content().to_vec())
}

pub(crate) fn workspace_media_thumbnail(
    value: crate::workspace::media::WorkspaceMediaThumbnail,
) -> WorkspaceMediaThumbnail {
    WorkspaceMediaThumbnail::new(value.preview().map(str::to_owned), value.file_size())
}

pub(crate) fn workspace_media_thumbnail_entry(
    value: crate::workspace::media::WorkspaceMediaThumbnailEntry,
) -> WorkspaceMediaThumbnailEntry {
    WorkspaceMediaThumbnailEntry::new(
        value.key().to_owned(),
        workspace_media_thumbnail(value.thumbnail().clone()),
    )
}

pub(crate) fn native_workspace_media_path(
    value: &WorkspaceMediaPath,
) -> crate::workspace::media::WorkspaceMediaPath {
    match value {
        WorkspaceMediaPath::Relative {
            key,
            relative_path,
            mime_type,
        } => crate::workspace::media::WorkspaceMediaPath::new(
            key.clone(),
            relative_path.clone(),
            mime_type.clone(),
        ),
        WorkspaceMediaPath::Gateway {
            key,
            gateway_url,
            mime_type,
            agent_id,
        } => crate::workspace::media::WorkspaceMediaPath::new_gateway(
            key.clone(),
            gateway_url.clone(),
            mime_type.clone(),
            agent_id.clone(),
        ),
    }
}

pub(crate) fn workspace_directory_failure(
    value: crate::workspace::WorkspaceDirectoryFailure,
) -> WorkspaceDirectoryFailure {
    match value {
        crate::workspace::WorkspaceDirectoryFailure::Unavailable => {
            WorkspaceDirectoryFailure::Unavailable
        }
    }
}

pub(crate) fn workspace_read_failure(
    value: crate::workspace::WorkspaceReadFailure,
) -> WorkspaceReadFailure {
    match value {
        crate::workspace::WorkspaceReadFailure::InvalidPath => WorkspaceReadFailure::InvalidPath,
        crate::workspace::WorkspaceReadFailure::Unavailable => WorkspaceReadFailure::Unavailable,
        crate::workspace::WorkspaceReadFailure::NotFile => WorkspaceReadFailure::NotFile,
        crate::workspace::WorkspaceReadFailure::TooLarge => WorkspaceReadFailure::TooLarge,
        crate::workspace::WorkspaceReadFailure::Binary => WorkspaceReadFailure::Binary,
    }
}

pub(crate) fn workspace_binary_failure(
    value: crate::workspace::WorkspaceBinaryFailure,
) -> WorkspaceBinaryFailure {
    match value {
        crate::workspace::WorkspaceBinaryFailure::InvalidPath => {
            WorkspaceBinaryFailure::InvalidPath
        }
        crate::workspace::WorkspaceBinaryFailure::Unavailable => {
            WorkspaceBinaryFailure::Unavailable
        }
        crate::workspace::WorkspaceBinaryFailure::NotFile => WorkspaceBinaryFailure::NotFile,
        crate::workspace::WorkspaceBinaryFailure::TooLarge => WorkspaceBinaryFailure::TooLarge,
    }
}

pub(crate) fn workspace_stat_failure(
    value: crate::workspace::WorkspaceStatFailure,
) -> WorkspaceStatFailure {
    match value {
        crate::workspace::WorkspaceStatFailure::InvalidPath => WorkspaceStatFailure::InvalidPath,
        crate::workspace::WorkspaceStatFailure::Unavailable => WorkspaceStatFailure::Unavailable,
    }
}

pub(crate) fn workspace_list_failure(
    value: crate::workspace::WorkspaceListFailure,
) -> WorkspaceListFailure {
    match value {
        crate::workspace::WorkspaceListFailure::InvalidPath => WorkspaceListFailure::InvalidPath,
        crate::workspace::WorkspaceListFailure::Unavailable => WorkspaceListFailure::Unavailable,
        crate::workspace::WorkspaceListFailure::NotDirectory => WorkspaceListFailure::NotDirectory,
    }
}

pub(crate) fn workspace_write_failure(
    value: crate::workspace::WorkspaceWriteFailure,
) -> WorkspaceWriteFailure {
    match value {
        crate::workspace::WorkspaceWriteFailure::InvalidPath => WorkspaceWriteFailure::InvalidPath,
        crate::workspace::WorkspaceWriteFailure::Unavailable => WorkspaceWriteFailure::Unavailable,
        crate::workspace::WorkspaceWriteFailure::NotFile => WorkspaceWriteFailure::NotFile,
        crate::workspace::WorkspaceWriteFailure::TooLarge => WorkspaceWriteFailure::TooLarge,
        crate::workspace::WorkspaceWriteFailure::OutcomeUnknown => {
            WorkspaceWriteFailure::OutcomeUnknown
        }
    }
}

pub(crate) fn workspace_media_failure(
    value: crate::workspace::media::WorkspaceMediaFailure,
) -> WorkspaceMediaFailure {
    match value {
        crate::workspace::media::WorkspaceMediaFailure::InvalidPath => {
            WorkspaceMediaFailure::InvalidPath
        }
        crate::workspace::media::WorkspaceMediaFailure::InvalidReference => {
            WorkspaceMediaFailure::InvalidReference
        }
        crate::workspace::media::WorkspaceMediaFailure::Unavailable => {
            WorkspaceMediaFailure::Unavailable
        }
        crate::workspace::media::WorkspaceMediaFailure::NotFile => WorkspaceMediaFailure::NotFile,
        crate::workspace::media::WorkspaceMediaFailure::TooLarge => WorkspaceMediaFailure::TooLarge,
    }
}
