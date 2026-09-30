use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::{
    application::commands::{WorkspaceCommand, WorkspaceOwnerKey, WorkspaceQuery},
    domain::model::{
        ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
        WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
        WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
        WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
        WorkspaceWriteFailure, WorkspaceWriteReceipt,
    },
    ports::{WorkspaceRequestAdmission, WorkspaceRuntimeDirectory},
};

pub struct WorkspaceOwnerInput {
    pub admission: Arc<dyn WorkspaceRequestAdmission>,
    pub runtime_directory: Arc<dyn WorkspaceRuntimeDirectory>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceShared {
    admission: Arc<dyn WorkspaceRequestAdmission>,
    runtime_directory: Arc<dyn WorkspaceRuntimeDirectory>,
}

pub(crate) struct WorkspaceGlobalState;
pub(crate) struct WorkspaceLaneState;

pub(crate) struct WorkspaceOwner {
    shared: WorkspaceShared,
}

impl WorkspaceOwner {
    pub fn new(input: WorkspaceOwnerInput) -> Self {
        Self {
            shared: WorkspaceShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for WorkspaceOwner {
    type Command = WorkspaceCommand;
    type Query = WorkspaceQuery;
    type Key = WorkspaceOwnerKey;
    type Shared = WorkspaceShared;
    type GlobalState = WorkspaceGlobalState;
    type LaneState = WorkspaceLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, WorkspaceGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        WorkspaceLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            WorkspaceCommand::ReadText {
                endpoint,
                session_key,
                relative_path,
                limit,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceReadFailure::Unavailable, || {
                        execute_read_text(&shared, &endpoint, &session_key, &relative_path, limit)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ReadBinary {
                endpoint,
                session_key,
                relative_path,
                limit,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceBinaryFailure::Unavailable, || {
                        execute_read_binary(&shared, &endpoint, &session_key, &relative_path, limit)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::StatFile {
                endpoint,
                session_key,
                relative_path,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceStatFailure::Unavailable, || {
                        execute_stat_file(&shared, &endpoint, &session_key, &relative_path)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ListDirectory {
                endpoint,
                session_key,
                relative_path,
                include_hidden,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceListFailure::Unavailable, || {
                        execute_list_directory(
                            &shared,
                            &endpoint,
                            &session_key,
                            &relative_path,
                            include_hidden,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::WriteText {
                endpoint,
                session_key,
                relative_path,
                content,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceWriteFailure::Unavailable, || {
                        execute_write_text(
                            &shared,
                            &endpoint,
                            &session_key,
                            &relative_path,
                            &content,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::PrepareMedia {
                endpoint,
                session_key,
                relative_path,
                mime_type,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_prepare_media(
                            &shared,
                            &endpoint,
                            &session_key,
                            &relative_path,
                            &mime_type,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ResolveMedia {
                endpoint,
                session_key,
                reference,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_resolve_media(&shared, &endpoint, &session_key, &reference)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ThumbnailMedia {
                endpoint,
                session_key,
                relative_path,
                mime_type,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_thumbnail_media(
                            &shared,
                            &endpoint,
                            &session_key,
                            &relative_path,
                            &mime_type,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ThumbnailMediaGateway {
                endpoint,
                session_key,
                gateway_url,
                mime_type,
                agent_id,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_thumbnail_media_gateway(
                            &shared,
                            &endpoint,
                            &session_key,
                            &gateway_url,
                            &mime_type,
                            &agent_id,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::ThumbnailsMedia {
                endpoint,
                session_key,
                paths,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_thumbnails_media(&shared, &endpoint, &session_key, &paths)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::StagePathsMedia {
                endpoint,
                session_key,
                paths,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_stage_paths_media(&shared, &endpoint, &session_key, &paths)
                    })
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceCommand::StageBufferMedia {
                endpoint,
                session_key,
                base64,
                file_name,
                mime_type,
                reply,
                call,
            } => {
                let result = call
                    .execute(WorkspaceMediaFailure::Unavailable, || {
                        execute_stage_buffer_media(
                            &shared,
                            &endpoint,
                            &session_key,
                            &base64,
                            &file_name,
                            &mime_type,
                        )
                    })
                    .await;
                let _ = reply.send(result);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

fn execute_read_text(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    limit: usize,
) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure> {
    with_workspace_ops(shared, endpoint, WorkspaceReadFailure::Unavailable, |ops| {
        ops.read_text(session_key, relative_path, limit)
    })
}

fn execute_read_binary(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    limit: usize,
) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceBinaryFailure::Unavailable,
        |ops| ops.read_binary(session_key, relative_path, limit),
    )
}

fn execute_stat_file(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure> {
    with_workspace_ops(shared, endpoint, WorkspaceStatFailure::Unavailable, |ops| {
        ops.stat_file(session_key, relative_path)
    })
}

fn execute_list_directory(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    include_hidden: bool,
) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure> {
    with_workspace_ops(shared, endpoint, WorkspaceListFailure::Unavailable, |ops| {
        ops.list_directory(session_key, relative_path, include_hidden)
    })
}

fn execute_write_text(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    content: &str,
) -> Result<WorkspaceWriteReceipt, WorkspaceWriteFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceWriteFailure::Unavailable,
        |ops| ops.write_text(session_key, relative_path, content),
    )
}

fn execute_prepare_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.prepare_media(session_key, relative_path, mime_type),
    )
}

fn execute_resolve_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    reference: &str,
) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.resolve_media(session_key, reference),
    )
}

fn execute_thumbnail_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    relative_path: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.thumbnail_media(session_key, relative_path, mime_type),
    )
}

fn execute_thumbnail_media_gateway(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    gateway_url: &str,
    mime_type: &str,
    agent_id: &str,
) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.thumbnail_media_gateway(session_key, gateway_url, mime_type, agent_id),
    )
}

fn execute_thumbnails_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    paths: &[WorkspaceMediaPath],
) -> Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.thumbnails_media(session_key, paths),
    )
}

fn execute_stage_paths_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    paths: &[WorkspaceMediaPath],
) -> Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.stage_paths_media(session_key, paths),
    )
}

fn execute_stage_buffer_media(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    base64: &str,
    file_name: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
    with_workspace_ops(
        shared,
        endpoint,
        WorkspaceMediaFailure::Unavailable,
        |ops| ops.stage_buffer_media(session_key, base64, file_name, mime_type),
    )
}

fn with_workspace_ops<T, E: Copy>(
    shared: &WorkspaceShared,
    endpoint: &RuntimeEndpoint,
    unavailable: E,
    read: impl FnOnce(&dyn crate::ports::WorkspaceOps) -> Result<T, E>,
) -> Result<T, E> {
    if shared.admission.admit_workspace_request().is_err() {
        return Err(unavailable);
    }
    let Some(ops) = shared.runtime_directory.workspace_ops(endpoint) else {
        return Err(unavailable);
    };
    if !ops.workspace_runtime_ready() {
        return Err(unavailable);
    }
    read(ops)
}
