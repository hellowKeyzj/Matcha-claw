use foundation::execution::OwnerRuntimeHandle;
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::oneshot;

use crate::{
    application::commands::{WorkspaceCommand, WorkspaceQuery},
    domain::model::{
        ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
        WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
        WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
        WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
        WorkspaceWriteFailure, WorkspaceWriteReceipt,
    },
};

#[derive(Clone)]
pub struct WorkspaceHandle {
    owner: OwnerRuntimeHandle<WorkspaceCommand, WorkspaceQuery>,
}

impl WorkspaceHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<WorkspaceCommand, WorkspaceQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn read_text(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        limit: usize,
    ) -> Result<Result<WorkspaceTextReceipt, WorkspaceReadFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ReadText {
            endpoint,
            session_key,
            relative_path,
            limit,
            reply,
        })
        .await
    }

    pub(crate) async fn read_binary(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        limit: usize,
    ) -> Result<Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ReadBinary {
            endpoint,
            session_key,
            relative_path,
            limit,
            reply,
        })
        .await
    }

    pub(crate) async fn stat_file(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
    ) -> Result<Result<WorkspaceStatReceipt, WorkspaceStatFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::StatFile {
            endpoint,
            session_key,
            relative_path,
            reply,
        })
        .await
    }

    pub(crate) async fn list_directory(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        include_hidden: bool,
    ) -> Result<Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ListDirectory {
            endpoint,
            session_key,
            relative_path,
            include_hidden,
            reply,
        })
        .await
    }

    pub(crate) async fn write_text(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        content: String,
    ) -> Result<Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::WriteText {
            endpoint,
            session_key,
            relative_path,
            content,
            reply,
        })
        .await
    }

    pub(crate) async fn prepare_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        mime_type: String,
    ) -> Result<Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::PrepareMedia {
            endpoint,
            session_key,
            relative_path,
            mime_type,
            reply,
        })
        .await
    }

    pub(crate) async fn resolve_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        reference: String,
    ) -> Result<Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ResolveMedia {
            endpoint,
            session_key,
            reference,
            reply,
        })
        .await
    }

    pub(crate) async fn thumbnail_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        mime_type: String,
    ) -> Result<Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ThumbnailMedia {
            endpoint,
            session_key,
            relative_path,
            mime_type,
            reply,
        })
        .await
    }

    pub(crate) async fn thumbnail_media_gateway(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    ) -> Result<Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ThumbnailMediaGateway {
            endpoint,
            session_key,
            gateway_url,
            mime_type,
            agent_id,
            reply,
        })
        .await
    }

    pub(crate) async fn thumbnails_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
    ) -> Result<Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::ThumbnailsMedia {
            endpoint,
            session_key,
            paths,
            reply,
        })
        .await
    }

    pub(crate) async fn stage_paths_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
    ) -> Result<Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::StagePathsMedia {
            endpoint,
            session_key,
            paths,
            reply,
        })
        .await
    }

    pub(crate) async fn stage_buffer_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        base64: String,
        file_name: String,
        mime_type: String,
    ) -> Result<Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>, ()> {
        self.request_command(|reply| WorkspaceCommand::StageBufferMedia {
            endpoint,
            session_key,
            base64,
            file_name,
            mime_type,
            reply,
        })
        .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> WorkspaceCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
