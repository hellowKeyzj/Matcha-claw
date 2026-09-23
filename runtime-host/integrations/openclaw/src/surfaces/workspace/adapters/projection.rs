use workspace_module::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryEntry, WorkspaceDirectoryFailure, WorkspaceDirectoryReceipt,
    WorkspaceDirectoryRoot, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure, WorkspaceWriteReceipt,
};

pub(crate) fn workspace_directory_root(
    value: crate::surfaces::workspace::TrustedWorkspaceDirectory,
) -> WorkspaceDirectoryRoot {
    WorkspaceDirectoryRoot::new(value.as_str().to_owned())
}

pub(crate) fn workspace_text_receipt(
    value: crate::surfaces::workspace::WorkspaceTextReceipt,
) -> WorkspaceTextReceipt {
    WorkspaceTextReceipt::new(
        value.name().to_owned(),
        value.content().to_owned(),
        value.size(),
    )
}

pub(crate) fn workspace_write_receipt(
    value: crate::surfaces::workspace::WorkspaceTextReceipt,
) -> WorkspaceWriteReceipt {
    WorkspaceWriteReceipt::new(value.name().to_owned(), value.size())
}

pub(crate) fn workspace_binary_receipt(
    value: crate::surfaces::workspace::WorkspaceBinaryReceipt,
) -> WorkspaceBinaryReceipt {
    WorkspaceBinaryReceipt::new(
        value.name().to_owned(),
        value.content().to_vec(),
        value.size(),
    )
}

pub(crate) fn workspace_stat_receipt(
    value: crate::surfaces::workspace::WorkspaceStatReceipt,
) -> WorkspaceStatReceipt {
    WorkspaceStatReceipt::new(
        value.name().to_owned(),
        value.is_directory(),
        value.size(),
        value.mtime_ms(),
    )
}

pub(crate) fn workspace_directory_receipt(
    value: crate::surfaces::workspace::WorkspaceDirectoryReceipt,
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
    value: crate::surfaces::workspace::media::WorkspaceMediaReceipt,
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
    value: crate::surfaces::workspace::media::ResolvedWorkspaceMedia,
) -> ResolvedWorkspaceMedia {
    ResolvedWorkspaceMedia::new(value.content().to_vec())
}

pub(crate) fn workspace_media_thumbnail(
    value: crate::surfaces::workspace::media::WorkspaceMediaThumbnail,
) -> WorkspaceMediaThumbnail {
    WorkspaceMediaThumbnail::new(value.preview().map(str::to_owned), value.file_size())
}

pub(crate) fn workspace_media_thumbnail_entry(
    value: crate::surfaces::workspace::media::WorkspaceMediaThumbnailEntry,
) -> WorkspaceMediaThumbnailEntry {
    WorkspaceMediaThumbnailEntry::new(
        value.key().to_owned(),
        workspace_media_thumbnail(value.thumbnail().clone()),
    )
}

pub(crate) fn native_workspace_media_path(
    value: &WorkspaceMediaPath,
) -> crate::surfaces::workspace::media::WorkspaceMediaPath {
    match value {
        WorkspaceMediaPath::Relative {
            key,
            relative_path,
            mime_type,
        } => crate::surfaces::workspace::media::WorkspaceMediaPath::new(
            key.clone(),
            relative_path.clone(),
            mime_type.clone(),
        ),
        WorkspaceMediaPath::Gateway {
            key,
            gateway_url,
            mime_type,
            agent_id,
        } => crate::surfaces::workspace::media::WorkspaceMediaPath::new_gateway(
            key.clone(),
            gateway_url.clone(),
            mime_type.clone(),
            agent_id.clone(),
        ),
    }
}

pub(crate) fn workspace_directory_failure(
    value: crate::surfaces::workspace::WorkspaceDirectoryFailure,
) -> WorkspaceDirectoryFailure {
    match value {
        crate::surfaces::workspace::WorkspaceDirectoryFailure::Unavailable => {
            WorkspaceDirectoryFailure::Unavailable
        }
    }
}

pub(crate) fn workspace_read_failure(
    value: crate::surfaces::workspace::WorkspaceReadFailure,
) -> WorkspaceReadFailure {
    match value {
        crate::surfaces::workspace::WorkspaceReadFailure::InvalidPath => {
            WorkspaceReadFailure::InvalidPath
        }
        crate::surfaces::workspace::WorkspaceReadFailure::Unavailable => {
            WorkspaceReadFailure::Unavailable
        }
        crate::surfaces::workspace::WorkspaceReadFailure::NotFile => WorkspaceReadFailure::NotFile,
        crate::surfaces::workspace::WorkspaceReadFailure::TooLarge => {
            WorkspaceReadFailure::TooLarge
        }
        crate::surfaces::workspace::WorkspaceReadFailure::Binary => WorkspaceReadFailure::Binary,
    }
}

pub(crate) fn workspace_binary_failure(
    value: crate::surfaces::workspace::WorkspaceBinaryFailure,
) -> WorkspaceBinaryFailure {
    match value {
        crate::surfaces::workspace::WorkspaceBinaryFailure::InvalidPath => {
            WorkspaceBinaryFailure::InvalidPath
        }
        crate::surfaces::workspace::WorkspaceBinaryFailure::Unavailable => {
            WorkspaceBinaryFailure::Unavailable
        }
        crate::surfaces::workspace::WorkspaceBinaryFailure::NotFile => {
            WorkspaceBinaryFailure::NotFile
        }
        crate::surfaces::workspace::WorkspaceBinaryFailure::TooLarge => {
            WorkspaceBinaryFailure::TooLarge
        }
    }
}

pub(crate) fn workspace_stat_failure(
    value: crate::surfaces::workspace::WorkspaceStatFailure,
) -> WorkspaceStatFailure {
    match value {
        crate::surfaces::workspace::WorkspaceStatFailure::InvalidPath => {
            WorkspaceStatFailure::InvalidPath
        }
        crate::surfaces::workspace::WorkspaceStatFailure::Unavailable => {
            WorkspaceStatFailure::Unavailable
        }
    }
}

pub(crate) fn workspace_list_failure(
    value: crate::surfaces::workspace::WorkspaceListFailure,
) -> WorkspaceListFailure {
    match value {
        crate::surfaces::workspace::WorkspaceListFailure::InvalidPath => {
            WorkspaceListFailure::InvalidPath
        }
        crate::surfaces::workspace::WorkspaceListFailure::Unavailable => {
            WorkspaceListFailure::Unavailable
        }
        crate::surfaces::workspace::WorkspaceListFailure::NotDirectory => {
            WorkspaceListFailure::NotDirectory
        }
    }
}

pub(crate) fn workspace_write_failure(
    value: crate::surfaces::workspace::WorkspaceWriteFailure,
) -> WorkspaceWriteFailure {
    match value {
        crate::surfaces::workspace::WorkspaceWriteFailure::InvalidPath => {
            WorkspaceWriteFailure::InvalidPath
        }
        crate::surfaces::workspace::WorkspaceWriteFailure::Unavailable => {
            WorkspaceWriteFailure::Unavailable
        }
        crate::surfaces::workspace::WorkspaceWriteFailure::NotFile => {
            WorkspaceWriteFailure::NotFile
        }
        crate::surfaces::workspace::WorkspaceWriteFailure::TooLarge => {
            WorkspaceWriteFailure::TooLarge
        }
        crate::surfaces::workspace::WorkspaceWriteFailure::OutcomeUnknown => {
            WorkspaceWriteFailure::OutcomeUnknown
        }
    }
}

pub(crate) fn workspace_media_failure(
    value: crate::surfaces::workspace::media::WorkspaceMediaFailure,
) -> WorkspaceMediaFailure {
    match value {
        crate::surfaces::workspace::media::WorkspaceMediaFailure::InvalidPath => {
            WorkspaceMediaFailure::InvalidPath
        }
        crate::surfaces::workspace::media::WorkspaceMediaFailure::InvalidReference => {
            WorkspaceMediaFailure::InvalidReference
        }
        crate::surfaces::workspace::media::WorkspaceMediaFailure::Unavailable => {
            WorkspaceMediaFailure::Unavailable
        }
        crate::surfaces::workspace::media::WorkspaceMediaFailure::NotFile => {
            WorkspaceMediaFailure::NotFile
        }
        crate::surfaces::workspace::media::WorkspaceMediaFailure::TooLarge => {
            WorkspaceMediaFailure::TooLarge
        }
    }
}
