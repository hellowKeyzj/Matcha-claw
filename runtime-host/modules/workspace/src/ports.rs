use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::domain::model::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryFailure, WorkspaceDirectoryReceipt, WorkspaceDirectoryRoot,
    WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath, WorkspaceMediaReceipt,
    WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry, WorkspaceReadFailure,
    WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt, WorkspaceWriteFailure,
    WorkspaceWriteReceipt,
};

pub trait WorkspaceRequestAdmission: Send + Sync {
    fn admit_workspace_request(&self) -> Result<(), WorkspaceRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkspaceRequestAdmissionClosed;

pub trait WorkspaceRuntimeDirectory: Send + Sync {
    fn workspace_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn WorkspaceOps>;
}

pub trait WorkspaceOps: Send + Sync {
    fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<WorkspaceDirectoryRoot, WorkspaceDirectoryFailure>;

    fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure>;

    fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>;

    fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure>;

    fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>;

    fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>;

    fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>;

    fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure>;

    fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>;

    fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>;

    fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>;

    fn workspace_runtime_ready(&self) -> bool;
}
