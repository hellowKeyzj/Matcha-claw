use std::path::PathBuf;

use super::super::OpenClawDriver;
use super::super::adapters::workspace::{
    native_workspace_media_path, resolved_workspace_media, workspace_binary_failure,
    workspace_binary_receipt, workspace_directory_failure, workspace_directory_receipt,
    workspace_directory_root, workspace_list_failure, workspace_media_failure,
    workspace_media_receipt, workspace_media_thumbnail, workspace_media_thumbnail_entry,
    workspace_read_failure, workspace_stat_failure, workspace_stat_receipt, workspace_text_receipt,
    workspace_write_failure, workspace_write_receipt,
};
use workspace_module::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure as DriverWorkspaceBinaryFailure,
    WorkspaceBinaryReceipt, WorkspaceDirectoryFailure as DriverWorkspaceDirectoryFailure,
    WorkspaceDirectoryReceipt, WorkspaceDirectoryRoot,
    WorkspaceListFailure as DriverWorkspaceListFailure,
    WorkspaceMediaFailure as DriverWorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure as DriverWorkspaceReadFailure,
    WorkspaceStatFailure as DriverWorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure as DriverWorkspaceWriteFailure, WorkspaceWriteReceipt,
};

impl OpenClawDriver {
    pub(crate) fn workspace(&self) -> &crate::workspace::OpenClawWorkspaceAccess {
        &self.workspace
    }

    pub fn preseed_matcha_workspace_identity(
        &self,
    ) -> Result<(), crate::projection::workspace::WorkspaceProjectionError> {
        crate::projection::workspace::MatchaWorkspaceOverlay::preseed_identity(
            self.main_workspace_directory()?,
            self.matcha_workspace_templates.clone(),
        )
    }

    pub fn merge_matcha_workspace_context(
        &self,
    ) -> Result<
        Option<crate::projection::workspace::ContextMerge>,
        crate::projection::workspace::WorkspaceProjectionError,
    > {
        let Some(context) = self.workspace_context.clone() else {
            return Ok(None);
        };
        crate::projection::workspace::MatchaWorkspaceOverlay::merge_context(
            self.main_workspace_directory()?,
            context,
        )
        .map(Some)
    }

    fn main_workspace_directory(
        &self,
    ) -> Result<
        crate::projection::workspace::AgentWorkspaceDirectory,
        crate::projection::workspace::WorkspaceProjectionError,
    > {
        let workspace = self
            .workspace
            .trusted_workspace_directory("agent:main:runtime-host")
            .map_err(|_| {
                crate::projection::workspace::WorkspaceProjectionError::WorkspaceUnavailable
            })?;
        crate::projection::workspace::AgentWorkspaceDirectory::try_new(PathBuf::from(
            workspace.as_str(),
        ))
    }
}

impl workspace_module::WorkspaceOps for OpenClawDriver {
    fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<WorkspaceDirectoryRoot, DriverWorkspaceDirectoryFailure> {
        self.workspace
            .trusted_workspace_directory(session_key)
            .map(workspace_directory_root)
            .map_err(workspace_directory_failure)
    }

    fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, DriverWorkspaceReadFailure> {
        self.workspace
            .read_text(session_key, relative_path, limit)
            .map(workspace_text_receipt)
            .map_err(workspace_read_failure)
    }

    fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, DriverWorkspaceBinaryFailure> {
        self.workspace
            .read_binary(session_key, relative_path, limit)
            .map(workspace_binary_receipt)
            .map_err(workspace_binary_failure)
    }

    fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceStatReceipt, DriverWorkspaceStatFailure> {
        self.workspace
            .stat(session_key, relative_path)
            .map(workspace_stat_receipt)
            .map_err(workspace_stat_failure)
    }

    fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, DriverWorkspaceListFailure> {
        self.workspace
            .list_dir_with_options(session_key, relative_path, include_hidden)
            .map(workspace_directory_receipt)
            .map_err(workspace_list_failure)
    }

    fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceWriteReceipt, DriverWorkspaceWriteFailure> {
        self.workspace
            .write_text(session_key, relative_path, content)
            .map(workspace_write_receipt)
            .map_err(workspace_write_failure)
    }

    fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, DriverWorkspaceMediaFailure> {
        self.workspace
            .prepare_media(session_key, relative_path, mime_type)
            .map(workspace_media_receipt)
            .map_err(workspace_media_failure)
    }

    fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, DriverWorkspaceMediaFailure> {
        self.workspace
            .resolve_media(session_key, reference)
            .map(resolved_workspace_media)
            .map_err(workspace_media_failure)
    }

    fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, DriverWorkspaceMediaFailure> {
        self.workspace
            .thumbnail_media(session_key, relative_path, mime_type)
            .map(workspace_media_thumbnail)
            .map_err(workspace_media_failure)
    }

    fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<WorkspaceMediaThumbnail, DriverWorkspaceMediaFailure> {
        self.workspace
            .thumbnail_media_gateway(session_key, gateway_url, mime_type, agent_id)
            .map(workspace_media_thumbnail)
            .map_err(workspace_media_failure)
    }

    fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaThumbnailEntry>, DriverWorkspaceMediaFailure> {
        let native_paths = paths
            .iter()
            .map(native_workspace_media_path)
            .collect::<Vec<_>>();
        self.workspace
            .thumbnails_media(session_key, &native_paths)
            .map(|entries| {
                entries
                    .into_iter()
                    .map(workspace_media_thumbnail_entry)
                    .collect()
            })
            .map_err(workspace_media_failure)
    }

    fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaReceipt>, DriverWorkspaceMediaFailure> {
        let native_paths = paths
            .iter()
            .map(native_workspace_media_path)
            .collect::<Vec<_>>();
        self.workspace
            .stage_paths_media(session_key, &native_paths)
            .map(|receipts| receipts.into_iter().map(workspace_media_receipt).collect())
            .map_err(workspace_media_failure)
    }

    fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, DriverWorkspaceMediaFailure> {
        self.workspace
            .stage_buffer_media(session_key, base64, file_name, mime_type)
            .map(workspace_media_receipt)
            .map_err(workspace_media_failure)
    }

    fn workspace_runtime_ready(&self) -> bool {
        self.owner().snapshot().phase()
            == foundation::process::supervision::SupervisorPhase::Running
    }
}
