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
    ports::{WorkspaceBinding, WorkspaceFileAccess},
    session_images::{SessionImageData, SessionImageFailure, SessionImagePage},
};

pub(crate) struct WorkspaceCommand {
    pub(crate) key: WorkspaceOwnerKey,
    pub(crate) binding: Option<Arc<dyn WorkspaceBinding>>,
    pub(crate) operation: WorkspaceOperation,
    pub(crate) call: RecordedCall,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceFileSelection {
    Agent(String),
    TeamRun { team_id: String, run_id: String },
}

impl WorkspaceFileSelection {
    fn selection(&self, access: WorkspaceFileAccess) -> WorkspaceSelection<'_> {
        match self {
            Self::Agent(agent_id) => WorkspaceSelection::Agent(agent_id),
            Self::TeamRun { team_id, run_id } => WorkspaceSelection::TeamRun { team_id, run_id, access },
        }
    }
}

pub(crate) enum WorkspaceOperation {
    ReadText {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceTextReceipt, WorkspaceReadFailure>>,
    },
    ReadBinary {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>>,
    },
    StatFile {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        reply: oneshot::Sender<Result<WorkspaceStatReceipt, WorkspaceStatFailure>>,
    },
    ListDirectory {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        include_hidden: bool,
        reply: oneshot::Sender<Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>>,
    },
    WriteText {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        content: String,
        reply: oneshot::Sender<Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>>,
    },
    WriteBinary {
        endpoint: RuntimeEndpoint,
        selection: WorkspaceFileSelection,
        relative_path: String,
        content: Vec<u8>,
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
    PlaybackMedia {
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
    ThumbnailMediaReference {
        endpoint: RuntimeEndpoint,
        session_key: String,
        reference: String,
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
    ListSessionImages {
        endpoint: RuntimeEndpoint,
        session_key: String,
        agent_id: String,
        cursor: Option<String>,
        reply: oneshot::Sender<Result<SessionImagePage, SessionImageFailure>>,
    },
    ReadSessionImage {
        endpoint: RuntimeEndpoint,
        session_key: String,
        agent_id: String,
        reference: String,
        reply: oneshot::Sender<Result<SessionImageData, SessionImageFailure>>,
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
    TeamRun(RuntimeEndpoint, String, String),
    Session(RuntimeEndpoint, String),
}

#[derive(Clone, Copy)]
pub(crate) enum WorkspaceSelection<'a> {
    Agent(&'a str),
    TeamRun { team_id: &'a str, run_id: &'a str, access: WorkspaceFileAccess },
    Session(&'a str),
}

impl WorkspaceSelection<'_> {
    pub(crate) fn owner_key(self, endpoint: RuntimeEndpoint) -> WorkspaceOwnerKey {
        match self {
            Self::Agent(agent_id) => WorkspaceOwnerKey::Agent(endpoint, agent_id.to_owned()),
            Self::TeamRun { team_id, run_id, .. } => WorkspaceOwnerKey::TeamRun(endpoint, team_id.to_owned(), run_id.to_owned()),
            Self::Session(session_key) => WorkspaceOwnerKey::Session(endpoint, session_key.to_owned()),
        }
    }
}

impl WorkspaceOperation {
    pub(crate) fn scope(&self) -> (&RuntimeEndpoint, WorkspaceSelection<'_>) {
        match self {
            Self::ReadText { endpoint, selection, .. }
            | Self::ReadBinary { endpoint, selection, .. }
            | Self::StatFile { endpoint, selection, .. }
            | Self::ListDirectory { endpoint, selection, .. } => (endpoint, selection.selection(WorkspaceFileAccess::Read)),
            Self::WriteText { endpoint, selection, .. }
            | Self::WriteBinary { endpoint, selection, .. } => (endpoint, selection.selection(WorkspaceFileAccess::Write)),
            Self::PrepareMedia { endpoint, session_key, .. }
            | Self::ResolveMedia { endpoint, session_key, .. }
            | Self::PlaybackMedia { endpoint, session_key, .. }
            | Self::ThumbnailMedia { endpoint, session_key, .. }
            | Self::ThumbnailMediaReference { endpoint, session_key, .. }
            | Self::ThumbnailMediaGateway { endpoint, session_key, .. }
            | Self::ThumbnailsMedia { endpoint, session_key, .. }
            | Self::StagePathsMedia { endpoint, session_key, .. }
            | Self::ListSessionImages { endpoint, session_key, .. }
            | Self::ReadSessionImage { endpoint, session_key, .. }
            | Self::StageBufferMedia { endpoint, session_key, .. } => (endpoint, WorkspaceSelection::Session(session_key)),
        }
    }

    pub(crate) fn needs_workspace(&self) -> bool {
        !matches!(self, Self::ResolveMedia { .. }
            | Self::PlaybackMedia { .. }
            | Self::ThumbnailMediaReference { .. }
            | Self::ThumbnailMediaGateway { .. }
            | Self::StageBufferMedia { .. }
            | Self::ListSessionImages { .. }
            | Self::ReadSessionImage { .. })
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
