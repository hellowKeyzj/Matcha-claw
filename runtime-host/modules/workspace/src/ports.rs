use std::{future::Future, pin::Pin, sync::Arc};

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

pub type WorkspaceFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

pub trait WorkspaceOps: Send + Sync {
    fn bind_agent_workspace<'a>(
        &'a self,
        agent_id: &'a str,
    ) -> WorkspaceFuture<'a, Arc<dyn WorkspaceBinding>, WorkspaceDirectoryFailure>;

    fn trusted_workspace_directory<'a>(
        &'a self,
        session_key: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryRoot, WorkspaceDirectoryFailure>;

    fn bind_workspace<'a>(
        &'a self,
        session_key: &'a str,
    ) -> WorkspaceFuture<'a, Arc<dyn WorkspaceBinding>, WorkspaceDirectoryFailure>;

    fn resolve_media<'a>(
        &'a self,
        session_key: &'a str,
        reference: &'a str,
    ) -> WorkspaceFuture<'a, ResolvedWorkspaceMedia, WorkspaceMediaFailure>;

    fn thumbnail_media_gateway<'a>(
        &'a self,
        session_key: &'a str,
        gateway_url: &'a str,
        mime_type: &'a str,
        agent_id: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn stage_buffer_media<'a>(
        &'a self,
        session_key: &'a str,
        base64: &'a str,
        file_name: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, WorkspaceMediaFailure>;

    fn workspace_runtime_ready(&self) -> bool;
}

/// Native-selected resource identity and effects share one bound directory.
pub trait WorkspaceBinding: Send + Sync {
    fn resource_key(&self) -> Option<&str>;

    fn read_text<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceTextReceipt, WorkspaceReadFailure>;

    fn read_binary<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceBinaryReceipt, WorkspaceBinaryFailure>;

    fn stat_file<'a>(
        &'a self,
        relative_path: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceStatReceipt, WorkspaceStatFailure>;

    fn list_directory<'a>(
        &'a self,
        relative_path: &'a str,
        include_hidden: bool,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryReceipt, WorkspaceListFailure>;

    fn write_text<'a>(
        &'a self,
        relative_path: &'a str,
        content: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceWriteReceipt, WorkspaceWriteFailure>;

    fn prepare_media<'a>(
        &'a self,
        session_key: &'a str,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, WorkspaceMediaFailure>;

    fn thumbnail_media<'a>(
        &'a self,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn thumbnails_media<'a>(
        &'a self,
        session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>;

    fn stage_paths_media<'a>(
        &'a self,
        session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>;
}
