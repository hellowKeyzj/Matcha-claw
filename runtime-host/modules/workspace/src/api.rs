use foundation::execution::OwnerRuntimeHandle;
use platform::{
    call::{CallRecorder, CallStatus},
    endpoint::runtime_address::RuntimeEndpoint,
};
use tokio::sync::oneshot;

use crate::{
    application::commands::{WorkspaceCommand, WorkspaceQuery},
    call::{self, Detail, Operation, Outcome, RecordedCall},
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
    recorder: Option<CallRecorder>,
}

impl WorkspaceHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<WorkspaceCommand, WorkspaceQuery>) -> Self {
        Self {
            owner,
            recorder: None,
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub(crate) async fn read_text(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        limit: usize,
    ) -> Result<Result<WorkspaceTextReceipt, WorkspaceReadFailure>, ()> {
        self.request_command(Operation::ReadText, 1, |call, reply| {
            WorkspaceCommand::ReadText {
                call,
                endpoint,
                session_key,
                relative_path,
                limit,
                reply,
            }
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
        self.request_command(Operation::ReadBinary, 1, |call, reply| {
            WorkspaceCommand::ReadBinary {
                call,
                endpoint,
                session_key,
                relative_path,
                limit,
                reply,
            }
        })
        .await
    }

    pub(crate) async fn stat_file(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
    ) -> Result<Result<WorkspaceStatReceipt, WorkspaceStatFailure>, ()> {
        self.request_command(Operation::StatFile, 1, |call, reply| {
            WorkspaceCommand::StatFile {
                call,
                endpoint,
                session_key,
                relative_path,
                reply,
            }
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
        self.request_command(Operation::ListDirectory, 1, |call, reply| {
            WorkspaceCommand::ListDirectory {
                call,
                endpoint,
                session_key,
                relative_path,
                include_hidden,
                reply,
            }
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
        self.request_command(Operation::WriteText, 1, |call, reply| {
            WorkspaceCommand::WriteText {
                call,
                endpoint,
                session_key,
                relative_path,
                content,
                reply,
            }
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
        self.request_command(Operation::PrepareMedia, 1, |call, reply| {
            WorkspaceCommand::PrepareMedia {
                call,
                endpoint,
                session_key,
                relative_path,
                mime_type,
                reply,
            }
        })
        .await
    }

    pub(crate) async fn resolve_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        reference: String,
    ) -> Result<Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure>, ()> {
        self.request_command(Operation::ResolveMedia, 1, |call, reply| {
            WorkspaceCommand::ResolveMedia {
                call,
                endpoint,
                session_key,
                reference,
                reply,
            }
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
        self.request_command(Operation::ThumbnailMedia, 1, |call, reply| {
            WorkspaceCommand::ThumbnailMedia {
                call,
                endpoint,
                session_key,
                relative_path,
                mime_type,
                reply,
            }
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
        self.request_command(Operation::ThumbnailMedia, 1, |call, reply| {
            WorkspaceCommand::ThumbnailMediaGateway {
                call,
                endpoint,
                session_key,
                gateway_url,
                mime_type,
                agent_id,
                reply,
            }
        })
        .await
    }

    pub(crate) async fn thumbnails_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
    ) -> Result<Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>, ()> {
        self.request_command(Operation::ThumbnailsMedia, paths.len(), |call, reply| {
            WorkspaceCommand::ThumbnailsMedia {
                call,
                endpoint,
                session_key,
                paths,
                reply,
            }
        })
        .await
    }

    pub(crate) async fn stage_paths_media(
        &self,
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
    ) -> Result<Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>, ()> {
        self.request_command(Operation::StagePathsMedia, paths.len(), |call, reply| {
            WorkspaceCommand::StagePathsMedia {
                call,
                endpoint,
                session_key,
                paths,
                reply,
            }
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
        self.request_command(Operation::StageBufferMedia, 1, |call, reply| {
            WorkspaceCommand::StageBufferMedia {
                call,
                endpoint,
                session_key,
                base64,
                file_name,
                mime_type,
                reply,
            }
        })
        .await
    }

    async fn request_command<T>(
        &self,
        operation: Operation,
        item_count: usize,
        command: impl FnOnce(RecordedCall, oneshot::Sender<T>) -> WorkspaceCommand,
    ) -> Result<T, ()> {
        let detail = Detail {
            operation,
            item_count,
            outcome: None,
        };
        let recorder = self.recorder.as_ref().ok_or(())?;
        let context = recorder
            .begin(operation.command(), &detail)
            .await
            .map_err(|error| {
                call::diagnose("begin", error);
            })?;
        let mut call = RecordedCall {
            context: context.clone(),
            detail: detail.clone(),
        };
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_command(command(RecordedCall { context, detail }, reply))
            .await
            .is_err()
        {
            call.finish(CallStatus::Rejected, Outcome::Unavailable)
                .await;
            return Err(());
        }
        response.await.map_err(|_| ())
    }
}
