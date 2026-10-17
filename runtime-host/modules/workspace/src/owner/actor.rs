use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::{
    sync::{Mutex, oneshot},
    task::JoinSet,
};

use crate::{
    application::commands::{
        WorkspaceCommand, WorkspaceOperation, WorkspaceOwnerKey, WorkspaceQuery, WorkspaceSelection,
    },
    call::{Outcome, RecordedCall},
    domain::model::{
        WorkspaceBinaryFailure, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceReadFailure,
        WorkspaceStatFailure, WorkspaceWriteFailure,
    },
    ports::{WorkspaceBinding, WorkspaceRequestAdmission, WorkspaceRuntimeDirectory},
};

pub struct WorkspaceOwnerInput {
    pub admission: Arc<dyn WorkspaceRequestAdmission>,
    pub runtime_directory: Arc<dyn WorkspaceRuntimeDirectory>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceShared {
    admission: Arc<dyn WorkspaceRequestAdmission>,
    runtime_directory: Arc<dyn WorkspaceRuntimeDirectory>,
    pub(crate) ingress: Arc<Mutex<()>>,
    effects: Arc<Mutex<Effects>>,
}

struct Effects {
    tasks: Option<JoinSet<()>>,
    panic: Option<Box<dyn std::any::Any + Send>>,
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
                ingress: Arc::new(Mutex::new(())),
                effects: Arc::new(Mutex::new(Effects {
                    tasks: Some(JoinSet::new()),
                    panic: None,
                })),
            },
        }
    }

    pub(crate) fn shared(&self) -> WorkspaceShared {
        self.shared.clone()
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
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        Self::handle_global_command(shared, &mut WorkspaceGlobalState, command).await;
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        let WorkspaceCommand {
            binding,
            operation,
            call,
            ..
        } = command;
        match operation {
            WorkspaceOperation::ReadText {
                endpoint,
                relative_path,
                limit,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceReadFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceReadFailure::Unavailable)?
                                    .read_text(&relative_path, limit)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ReadBinary {
                endpoint,
                relative_path,
                limit,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceBinaryFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceBinaryFailure::Unavailable)?
                                    .read_binary(&relative_path, limit)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::StatFile {
                endpoint,
                relative_path,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceStatFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceStatFailure::Unavailable)?
                                    .stat_file(&relative_path)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ListDirectory {
                endpoint,
                relative_path,
                include_hidden,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceListFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceListFailure::Unavailable)?
                                    .list_directory(&relative_path, include_hidden)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::WriteText {
                endpoint,
                relative_path,
                content,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceWriteFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceWriteFailure::Unavailable)?
                                    .write_text(&relative_path, &content)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::PrepareMedia {
                endpoint,
                session_key,
                relative_path,
                mime_type,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceMediaFailure::Unavailable)?
                                    .prepare_media(&session_key, &relative_path, &mime_type)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ResolveMedia {
                endpoint,
                session_key,
                reference,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |ops| {
                            Box::pin(
                                async move { ops.resolve_media(&session_key, &reference).await },
                            )
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ThumbnailMedia {
                endpoint,
                relative_path,
                mime_type,
                reply,
                ..
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceMediaFailure::Unavailable)?
                                    .thumbnail_media(&relative_path, &mime_type)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ThumbnailMediaGateway {
                endpoint,
                session_key,
                gateway_url,
                mime_type,
                agent_id,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |ops| {
                            Box::pin(async move {
                                ops.thumbnail_media_gateway(
                                    &session_key,
                                    &gateway_url,
                                    &mime_type,
                                    &agent_id,
                                )
                                .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::ThumbnailsMedia {
                endpoint,
                session_key,
                paths,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceMediaFailure::Unavailable)?
                                    .thumbnails_media(&session_key, &paths)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::StagePathsMedia {
                endpoint,
                session_key,
                paths,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |_| {
                            Box::pin(async move {
                                binding
                                    .ok_or(WorkspaceMediaFailure::Unavailable)?
                                    .stage_paths_media(&session_key, &paths)
                                    .await
                            })
                        },
                    )
                    .await;
                let _ = reply.send(result);
            }
            WorkspaceOperation::StageBufferMedia {
                endpoint,
                session_key,
                base64,
                file_name,
                mime_type,
                reply,
            } => {
                let result = shared
                    .execute(
                        call,
                        endpoint,
                        WorkspaceMediaFailure::Unavailable,
                        move |ops| {
                            Box::pin(async move {
                                ops.stage_buffer_media(
                                    &session_key,
                                    &base64,
                                    &file_name,
                                    &mime_type,
                                )
                                .await
                            })
                        },
                    )
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

    async fn shutdown(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        let (mut effects, mut panic) = {
            let mut custody = shared.effects.lock().await;
            let Some(tasks) = custody.tasks.take() else {
                return;
            };
            (tasks, custody.panic.take())
        };
        while let Some(result) = effects.join_next().await {
            if let Err(error) = result {
                if error.is_panic() && panic.is_none() {
                    panic = Some(error.into_panic());
                }
            }
        }
        if let Some(panic) = panic {
            std::panic::resume_unwind(panic);
        }
    }
}

impl WorkspaceShared {
    pub(crate) async fn bind(
        &self,
        endpoint: &RuntimeEndpoint,
        selection: WorkspaceSelection<'_>,
    ) -> Option<Arc<dyn WorkspaceBinding>> {
        if self.admission.admit_workspace_request().is_err() {
            return None;
        }
        let ops = self.runtime_directory.workspace_ops(endpoint)?;
        if !ops.workspace_runtime_ready() {
            return None;
        }
        match selection {
            WorkspaceSelection::Agent(agent_id) => ops.bind_agent_workspace(agent_id).await.ok(),
            WorkspaceSelection::Session(session_key) => ops.bind_workspace(session_key).await.ok(),
        }
    }

    pub(crate) async fn effect<T: Send + 'static>(
        &self,
        effect: impl std::future::Future<Output = T> + Send + 'static,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        {
            let mut custody = self.effects.lock().await;
            let Effects { tasks, panic } = &mut *custody;
            let tasks = tasks.as_mut().ok_or(())?;
            while let Some(result) = tasks.try_join_next() {
                if let Err(error) = result {
                    if error.is_panic() && panic.is_none() {
                        *panic = Some(error.into_panic());
                    }
                }
            }
            // Registration closes before shutdown joins, including ingress bindings.
            tasks.spawn(async move {
                let _ = reply.send(effect.await);
            });
        }
        response.await.map_err(|_| ())
    }

    async fn execute<T, E>(
        &self,
        call: RecordedCall,
        endpoint: RuntimeEndpoint,
        unavailable: E,
        effect: impl for<'a> FnOnce(
            &'a dyn crate::ports::WorkspaceOps,
        ) -> crate::ports::WorkspaceFuture<'a, T, E>
        + Send
        + 'static,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: Copy + Into<Outcome> + Send + 'static,
    {
        let shared = self.clone();
        self.effect(async move {
            call.execute(unavailable, shared.with_ops(&endpoint, unavailable, effect))
                .await
        })
        .await
        .unwrap_or(Err(unavailable))
    }

    async fn with_ops<T, E: Copy>(
        &self,
        endpoint: &RuntimeEndpoint,
        unavailable: E,
        effect: impl for<'a> FnOnce(
            &'a dyn crate::ports::WorkspaceOps,
        ) -> crate::ports::WorkspaceFuture<'a, T, E>,
    ) -> Result<T, E> {
        if self.admission.admit_workspace_request().is_err() {
            return Err(unavailable);
        }
        let Some(ops) = self.runtime_directory.workspace_ops(endpoint) else {
            return Err(unavailable);
        };
        if !ops.workspace_runtime_ready() {
            return Err(unavailable);
        }
        effect(ops).await
    }
}
