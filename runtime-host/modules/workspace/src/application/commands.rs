use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::oneshot;

use crate::domain::model::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure, WorkspaceWriteReceipt,
};

pub(crate) enum WorkspaceCommand {
    ReadText {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceTextReceipt, WorkspaceReadFailure>>,
    },
    ReadBinary {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>>,
    },
    StatFile {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        reply: oneshot::Sender<Result<WorkspaceStatReceipt, WorkspaceStatFailure>>,
    },
    ListDirectory {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        include_hidden: bool,
        reply: oneshot::Sender<Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>>,
    },
    WriteText {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        content: String,
        reply: oneshot::Sender<Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>>,
    },
    PrepareMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        mime_type: String,
        reply: oneshot::Sender<Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>>,
    },
    ResolveMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        reference: String,
        reply: oneshot::Sender<Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure>>,
    },
    ThumbnailMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        relative_path: String,
        mime_type: String,
        reply: oneshot::Sender<Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>>,
    },
    ThumbnailMediaGateway {
        endpoint: RuntimeEndpoint,
        session_key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
        reply: oneshot::Sender<Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>>,
    },
    ThumbnailsMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
        reply: oneshot::Sender<Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>>,
    },
    StagePathsMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        paths: Vec<WorkspaceMediaPath>,
        reply: oneshot::Sender<Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>>,
    },
    StageBufferMedia {
        endpoint: RuntimeEndpoint,
        session_key: String,
        base64: String,
        file_name: String,
        mime_type: String,
        reply: oneshot::Sender<Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>>,
    },
}

pub(crate) enum WorkspaceQuery {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum WorkspaceOwnerKey {}

impl WorkspaceCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<WorkspaceOwnerKey> {
        foundation::execution::CommandRoute::Global
    }
}

impl WorkspaceQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<WorkspaceOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
