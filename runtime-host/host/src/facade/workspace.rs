use std::sync::Arc;

use crate::{
    composition::HostAdmission,
    runtime::{
        directory::RuntimeDriverDirectory,
        driver::{
            ResolvedWorkspaceMedia, RuntimeDriverIdentity, WorkspaceBinaryFailure,
            WorkspaceBinaryReceipt, WorkspaceDirectoryFailure, WorkspaceDirectoryReceipt,
            WorkspaceDirectoryRoot, WorkspaceListFailure, WorkspaceMediaFailure,
            WorkspaceMediaPath, WorkspaceMediaReceipt, WorkspaceMediaThumbnail,
            WorkspaceMediaThumbnailEntry, WorkspaceReadFailure, WorkspaceStatFailure,
            WorkspaceStatReceipt, WorkspaceTextReceipt, WorkspaceWriteFailure,
            WorkspaceWriteReceipt,
        },
    },
};

#[derive(Clone)]
pub(crate) struct WorkspaceHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl WorkspaceHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
        }
    }

    pub(crate) fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<WorkspaceDirectoryRoot, WorkspaceDirectoryFailure> {
        self.with_workspace_ops(WorkspaceDirectoryFailure::Unavailable, |ops| {
            ops.trusted_workspace_directory(session_key)
        })
    }

    pub(crate) fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure> {
        self.with_workspace_ops(WorkspaceReadFailure::Unavailable, |ops| {
            ops.read_text(session_key, relative_path, limit)
        })
    }

    pub(crate) fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure> {
        self.with_workspace_ops(WorkspaceBinaryFailure::Unavailable, |ops| {
            ops.read_binary(session_key, relative_path, limit)
        })
    }

    pub(crate) fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure> {
        self.with_workspace_ops(WorkspaceStatFailure::Unavailable, |ops| {
            ops.stat_file(session_key, relative_path)
        })
    }

    pub(crate) fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure> {
        self.with_workspace_ops(WorkspaceListFailure::Unavailable, |ops| {
            ops.list_directory(session_key, relative_path, include_hidden)
        })
    }

    pub(crate) fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceWriteReceipt, WorkspaceWriteFailure> {
        self.with_workspace_ops(WorkspaceWriteFailure::Unavailable, |ops| {
            ops.write_text(session_key, relative_path, content)
        })
    }

    pub(crate) fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.prepare_media(session_key, relative_path, mime_type)
        })
    }

    pub(crate) fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.resolve_media(session_key, reference)
        })
    }

    pub(crate) fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.thumbnail_media(session_key, relative_path, mime_type)
        })
    }

    pub(crate) fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.thumbnail_media_gateway(session_key, gateway_url, mime_type, agent_id)
        })
    }

    pub(crate) fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.thumbnails_media(session_key, paths)
        })
    }

    pub(crate) fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.stage_paths_media(session_key, paths)
        })
    }

    pub(crate) fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        self.with_workspace_ops(WorkspaceMediaFailure::Unavailable, |ops| {
            ops.stage_buffer_media(session_key, base64, file_name, mime_type)
        })
    }

    fn with_workspace_ops<T, E: Copy>(
        &self,
        unavailable: E,
        read: impl FnOnce(&dyn crate::runtime::driver::WorkspaceOps) -> Result<T, E>,
    ) -> Result<T, E> {
        if self.admission.admit_request().is_err() {
            return Err(unavailable);
        }
        let Some(driver) = self
            .runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
        else {
            return Err(unavailable);
        };
        let Some(ops) = driver.workspace_ops() else {
            return Err(unavailable);
        };
        read(ops)
    }
}
