use std::{path::PathBuf, sync::Arc};

use workspace_module::ports::WorkspaceFuture;

use crate::{driver::OpenClawDriver, surfaces::workspace::OpenClawWorkspaceBinding};

use super::projection::{
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
    pub(crate) fn workspace(&self) -> &crate::surfaces::workspace::OpenClawWorkspaceAccess {
        &self.workspace
    }

    pub fn preseed_matcha_workspace_identity(
        &self,
    ) -> Result<(), crate::native_config::workspace::WorkspaceProjectionError> {
        crate::native_config::workspace::MatchaWorkspaceOverlay::preseed_identity(
            self.main_workspace_directory()?,
            self.matcha_workspace_templates.clone(),
        )
    }

    pub fn merge_matcha_workspace_context(
        &self,
    ) -> Result<
        Option<crate::native_config::workspace::ContextMerge>,
        crate::native_config::workspace::WorkspaceProjectionError,
    > {
        let Some(context) = self.workspace_context.clone() else {
            return Ok(None);
        };
        crate::native_config::workspace::MatchaWorkspaceOverlay::merge_context(
            self.main_workspace_directory()?,
            context,
        )
        .map(Some)
    }

    fn main_workspace_directory(
        &self,
    ) -> Result<
        crate::native_config::workspace::AgentWorkspaceDirectory,
        crate::native_config::workspace::WorkspaceProjectionError,
    > {
        let workspace = self
            .workspace
            .trusted_workspace_directory("agent:main:runtime-host")
            .map_err(|_| {
                crate::native_config::workspace::WorkspaceProjectionError::WorkspaceUnavailable
            })?;
        crate::native_config::workspace::AgentWorkspaceDirectory::try_new(PathBuf::from(
            workspace.as_str(),
        ))
    }
}

impl workspace_module::WorkspaceOps for OpenClawDriver {
    fn bind_agent_workspace<'a>(
        &'a self,
        agent_id: &'a str,
    ) -> WorkspaceFuture<
        'a,
        Arc<dyn workspace_module::WorkspaceBinding>,
        DriverWorkspaceDirectoryFailure,
    > {
        let workspace = self.workspace.clone();
        let agent_id = agent_id.to_owned();
        blocking(DriverWorkspaceDirectoryFailure::Unavailable, move || {
            let workspace = workspace
                .bind_agent_workspace(&agent_id)
                .map_err(workspace_directory_failure)?;
            Ok(Arc::new(WorkspaceBinding {
                workspace: Arc::new(workspace),
            }) as Arc<dyn workspace_module::WorkspaceBinding>)
        })
    }

    fn trusted_workspace_directory<'a>(
        &'a self,
        session_key: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryRoot, DriverWorkspaceDirectoryFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        blocking(DriverWorkspaceDirectoryFailure::Unavailable, move || {
            workspace
                .trusted_workspace_directory(&session_key)
                .map(workspace_directory_root)
                .map_err(workspace_directory_failure)
        })
    }

    fn bind_workspace<'a>(
        &'a self,
        session_key: &'a str,
    ) -> WorkspaceFuture<
        'a,
        Arc<dyn workspace_module::WorkspaceBinding>,
        DriverWorkspaceDirectoryFailure,
    > {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        blocking(DriverWorkspaceDirectoryFailure::Unavailable, move || {
            let workspace = workspace
                .bind_workspace(&session_key)
                .map_err(workspace_directory_failure)?;
            Ok(Arc::new(WorkspaceBinding {
                workspace: Arc::new(workspace),
            })
                as Arc<dyn workspace_module::WorkspaceBinding>)
        })
    }

    fn resolve_media<'a>(
        &'a self,
        session_key: &'a str,
        reference: &'a str,
    ) -> WorkspaceFuture<'a, ResolvedWorkspaceMedia, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let reference = reference.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            workspace
                .resolve_media(&session_key, &reference)
                .map(resolved_workspace_media)
                .map_err(workspace_media_failure)
        })
    }

    fn thumbnail_media_gateway<'a>(
        &'a self,
        session_key: &'a str,
        gateway_url: &'a str,
        mime_type: &'a str,
        agent_id: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let gateway_url = gateway_url.to_owned();
        let mime_type = mime_type.to_owned();
        let agent_id = agent_id.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            workspace
                .thumbnail_media_gateway(&session_key, &gateway_url, &mime_type, &agent_id)
                .map(workspace_media_thumbnail)
                .map_err(workspace_media_failure)
        })
    }

    fn stage_buffer_media<'a>(
        &'a self,
        session_key: &'a str,
        base64: &'a str,
        file_name: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let base64 = base64.to_owned();
        let file_name = file_name.to_owned();
        let mime_type = mime_type.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            workspace
                .stage_buffer_media(&session_key, &base64, &file_name, &mime_type)
                .map(workspace_media_receipt)
                .map_err(workspace_media_failure)
        })
    }

    fn workspace_runtime_ready(&self) -> bool {
        self.owner().snapshot().phase()
            == foundation::process::supervision::SupervisorPhase::Running
    }
}

struct WorkspaceBinding {
    workspace: Arc<OpenClawWorkspaceBinding>,
}

impl workspace_module::WorkspaceBinding for WorkspaceBinding {
    fn resource_key(&self) -> Option<&str> {
        self.workspace.resource_key()
    }

    fn read_text<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceTextReceipt, DriverWorkspaceReadFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        blocking(DriverWorkspaceReadFailure::Unavailable, move || {
            workspace
                .read_text(&relative_path, limit)
                .map(workspace_text_receipt)
                .map_err(workspace_read_failure)
        })
    }

    fn read_binary<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceBinaryReceipt, DriverWorkspaceBinaryFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        blocking(DriverWorkspaceBinaryFailure::Unavailable, move || {
            workspace
                .read_binary(&relative_path, limit)
                .map(workspace_binary_receipt)
                .map_err(workspace_binary_failure)
        })
    }

    fn stat_file<'a>(
        &'a self,
        relative_path: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceStatReceipt, DriverWorkspaceStatFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        blocking(DriverWorkspaceStatFailure::Unavailable, move || {
            workspace
                .stat(&relative_path)
                .map(workspace_stat_receipt)
                .map_err(workspace_stat_failure)
        })
    }

    fn list_directory<'a>(
        &'a self,
        relative_path: &'a str,
        include_hidden: bool,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryReceipt, DriverWorkspaceListFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        blocking(DriverWorkspaceListFailure::Unavailable, move || {
            workspace
                .list_dir_with_options(&relative_path, include_hidden)
                .map(workspace_directory_receipt)
                .map_err(workspace_list_failure)
        })
    }

    fn write_text<'a>(
        &'a self,
        relative_path: &'a str,
        content: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceWriteReceipt, DriverWorkspaceWriteFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        let content = content.to_owned();
        blocking(DriverWorkspaceWriteFailure::Unavailable, move || {
            workspace
                .write_text(&relative_path, &content)
                .map(workspace_write_receipt)
                .map_err(workspace_write_failure)
        })
    }

    fn prepare_media<'a>(
        &'a self,
        session_key: &'a str,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let relative_path = relative_path.to_owned();
        let mime_type = mime_type.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            workspace
                .prepare_media(&session_key, &relative_path, &mime_type)
                .map(workspace_media_receipt)
                .map_err(workspace_media_failure)
        })
    }

    fn thumbnail_media<'a>(
        &'a self,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let relative_path = relative_path.to_owned();
        let mime_type = mime_type.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            workspace
                .thumbnail_media(&relative_path, &mime_type)
                .map(workspace_media_thumbnail)
                .map_err(workspace_media_failure)
        })
    }

    fn thumbnails_media<'a>(
        &'a self,
        session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaThumbnailEntry>, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let paths = paths.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            let native_paths = paths
                .iter()
                .map(native_workspace_media_path)
                .collect::<Vec<_>>();
            workspace
                .thumbnails_media(&session_key, &native_paths)
                .map(|entries| {
                    entries
                        .into_iter()
                        .map(workspace_media_thumbnail_entry)
                        .collect()
                })
                .map_err(workspace_media_failure)
        })
    }

    fn stage_paths_media<'a>(
        &'a self,
        session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaReceipt>, DriverWorkspaceMediaFailure> {
        let workspace = self.workspace.clone();
        let session_key = session_key.to_owned();
        let paths = paths.to_owned();
        blocking(DriverWorkspaceMediaFailure::Unavailable, move || {
            let native_paths = paths
                .iter()
                .map(native_workspace_media_path)
                .collect::<Vec<_>>();
            workspace
                .stage_paths_media(&session_key, &native_paths)
                .map(|receipts| receipts.into_iter().map(workspace_media_receipt).collect())
                .map_err(workspace_media_failure)
        })
    }
}

fn blocking<T: Send + 'static, E: Send + Copy + 'static>(
    unavailable: E,
    effect: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> WorkspaceFuture<'static, T, E> {
    Box::pin(async move {
        tokio::task::spawn_blocking(effect)
            .await
            .unwrap_or(Err(unavailable))
    })
}
