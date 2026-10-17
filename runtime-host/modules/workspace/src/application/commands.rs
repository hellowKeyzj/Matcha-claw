use std::sync::Arc;

use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::oneshot;

use crate::{
    call::RecordedCall,
    domain::model::{
        ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
        WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
        WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
        WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
        WorkspaceWriteFailure, WorkspaceWriteReceipt,
    },
    ports::WorkspaceBinding,
};

pub(crate) struct WorkspaceCommand {
    pub(crate) key: WorkspaceOwnerKey,
    pub(crate) binding: Option<Arc<dyn WorkspaceBinding>>,
    pub(crate) operation: WorkspaceOperation,
    pub(crate) call: RecordedCall,
}

pub(crate) enum WorkspaceOperation {
    ReadText {
        endpoint: RuntimeEndpoint,
        agent_id: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceTextReceipt, WorkspaceReadFailure>>,
    },
    ReadBinary {
        endpoint: RuntimeEndpoint,
        agent_id: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>>,
    },
    StatFile {
        endpoint: RuntimeEndpoint,
        agent_id: String,
        relative_path: String,
        reply: oneshot::Sender<Result<WorkspaceStatReceipt, WorkspaceStatFailure>>,
    },
    ListDirectory {
        endpoint: RuntimeEndpoint,
        agent_id: String,
        relative_path: String,
        include_hidden: bool,
        reply: oneshot::Sender<Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>>,
    },
    WriteText {
        endpoint: RuntimeEndpoint,
        agent_id: String,
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

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) enum WorkspaceOwnerKey {
    Directory(RuntimeEndpoint, String),
    Agent(RuntimeEndpoint, String),
    Session(RuntimeEndpoint, String),
}

#[derive(Clone, Copy)]
pub(crate) enum WorkspaceSelection<'a> {
    Agent(&'a str),
    Session(&'a str),
}

impl WorkspaceSelection<'_> {
    pub(crate) fn owner_key(self, endpoint: RuntimeEndpoint) -> WorkspaceOwnerKey {
        match self {
            Self::Agent(agent_id) => WorkspaceOwnerKey::Agent(endpoint, agent_id.to_owned()),
            Self::Session(session_key) => WorkspaceOwnerKey::Session(endpoint, session_key.to_owned()),
        }
    }
}

impl WorkspaceOperation {
    pub(crate) fn scope(&self) -> (&RuntimeEndpoint, WorkspaceSelection<'_>) {
        match self {
            Self::ReadText { endpoint, agent_id, .. }
            | Self::ReadBinary { endpoint, agent_id, .. }
            | Self::StatFile { endpoint, agent_id, .. }
            | Self::ListDirectory { endpoint, agent_id, .. }
            | Self::WriteText { endpoint, agent_id, .. } => (endpoint, WorkspaceSelection::Agent(agent_id)),
            Self::PrepareMedia { endpoint, session_key, .. }
            | Self::ResolveMedia { endpoint, session_key, .. }
            | Self::ThumbnailMedia { endpoint, session_key, .. }
            | Self::ThumbnailMediaGateway { endpoint, session_key, .. }
            | Self::ThumbnailsMedia { endpoint, session_key, .. }
            | Self::StagePathsMedia { endpoint, session_key, .. }
            | Self::StageBufferMedia { endpoint, session_key, .. } => (endpoint, WorkspaceSelection::Session(session_key)),
        }
    }

    pub(crate) fn needs_workspace(&self) -> bool {
        !matches!(self, Self::ResolveMedia { .. }
            | Self::ThumbnailMediaGateway { .. }
            | Self::StageBufferMedia { .. })
    }
}

impl WorkspaceCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<WorkspaceOwnerKey> {
        foundation::execution::CommandRoute::Keyed(self.key.clone())
    }
}

impl WorkspaceQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<WorkspaceOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
