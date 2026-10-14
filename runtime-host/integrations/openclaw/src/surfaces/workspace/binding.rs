use std::sync::Arc;

use platform::state_dir::CanonicalStateDir;

use super::{
    WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryEntry, WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceReadFailure,
    WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt, WorkspaceWriteFailure,
    access::{WorkspaceEntryKind, WorkspaceFiles},
    media,
};

pub struct OpenClawWorkspaceBinding {
    pub(super) files: WorkspaceFiles,
    pub(super) media: Arc<media::WorkspaceMedia>,
    pub(super) state_dir: CanonicalStateDir,
}

impl OpenClawWorkspaceBinding {
    pub fn resource_key(&self) -> Option<&str> {
        self.files.resource_key()
    }

    pub fn read_text(
        &self,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure> {
        let text = self.files
            .read_text_with_limit(relative_path, limit)
            .map_err(WorkspaceReadFailure::from)?;
        Ok(WorkspaceTextReceipt { name: text.name, content: text.content, size: text.size })
    }

    pub fn read_binary(
        &self,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure> {
        let binary = self.files
            .read_binary(relative_path, limit)
            .map_err(WorkspaceBinaryFailure::from)?;
        Ok(WorkspaceBinaryReceipt { name: binary.name, content: binary.content, size: binary.size })
    }

    pub fn stat(&self, relative_path: &str) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure> {
        let entry = self.files.stat(relative_path).map_err(WorkspaceStatFailure::from)?;
        Ok(WorkspaceStatReceipt {
            name: entry.name,
            is_directory: entry.kind == WorkspaceEntryKind::Directory,
            size: entry.size,
            mtime_ms: entry.mtime_ms,
        })
    }

    pub fn list_dir_with_options(
        &self,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure> {
        let relative_path = relative_path.replace('\\', "/");
        let entries = if relative_path.is_empty() {
            self.files.list_root_dir_with_options(include_hidden)
        } else {
            self.files.list_dir_with_options(&relative_path, include_hidden)
        }.map_err(WorkspaceListFailure::from)?;
        Ok(WorkspaceDirectoryReceipt {
            entries: entries.into_iter().map(|entry| WorkspaceDirectoryEntry {
                relative_path: if relative_path.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{relative_path}/{}", entry.name)
                },
                display: entry.name,
                is_directory: entry.kind == WorkspaceEntryKind::Directory,
                size: entry.size,
            }).collect(),
        })
    }

    pub fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceTextReceipt, WorkspaceWriteFailure> {
        let text = self.files.write_text(relative_path, content).map_err(WorkspaceWriteFailure::from)?;
        Ok(WorkspaceTextReceipt { name: text.name, content: text.content, size: text.size })
    }

    pub fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<media::WorkspaceMediaReceipt, media::WorkspaceMediaFailure> {
        self.media.prepare(session_key, &self.files, relative_path, mime_type)
    }

    pub fn thumbnail_media(
        &self,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<media::WorkspaceMediaThumbnail, media::WorkspaceMediaFailure> {
        self.media.thumbnail(&self.files, relative_path, mime_type)
    }

    pub fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[media::WorkspaceMediaPath],
    ) -> Result<Vec<media::WorkspaceMediaThumbnailEntry>, media::WorkspaceMediaFailure> {
        Ok(self.media.thumbnails_with_gateway_context(&self.state_dir, session_key, &self.files, paths))
    }

    pub fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[media::WorkspaceMediaPath],
    ) -> Result<Vec<media::WorkspaceMediaReceipt>, media::WorkspaceMediaFailure> {
        self.media.stage_paths(session_key, &self.files, paths)
    }
}
