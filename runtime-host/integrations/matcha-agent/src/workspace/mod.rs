mod binding;
mod media;

use std::sync::Arc;

use foundation::process::supervision::SupervisorPhase;
use workspace_module::{
    ResolvedWorkspaceMedia, WorkspaceBinding, WorkspaceDirectoryFailure, WorkspaceDirectoryRoot,
    WorkspaceMediaFailure, WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceOps,
    ports::WorkspaceFuture,
};

use crate::{client::Client, driver::MatchaRuntimeDriver};
use binding::Binding;

impl WorkspaceOps for MatchaRuntimeDriver {
    fn bind_agent_workspace<'a>(
        &'a self,
        agent_id: &'a str,
    ) -> WorkspaceFuture<'a, Arc<dyn WorkspaceBinding>, WorkspaceDirectoryFailure> {
        Box::pin(async move {
            Ok(Arc::new(Binding::bind(
                self.native_client(),
                agent_id.to_owned(),
                None,
                None,
            ).await?) as Arc<dyn WorkspaceBinding>)
        })
    }

    fn trusted_workspace_directory<'a>(
        &'a self,
        _session_key: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryRoot, WorkspaceDirectoryFailure> {
        // A Matcha workspace is Server-owned; exposing its native path would bypass that custody.
        Box::pin(async { Err(WorkspaceDirectoryFailure::Unavailable) })
    }

    fn bind_workspace<'a>(
        &'a self,
        session_key: &'a str,
    ) -> WorkspaceFuture<'a, Arc<dyn WorkspaceBinding>, WorkspaceDirectoryFailure> {
        Box::pin(async move {
            let client = self.native_client();
            let record = selection(&client, session_key)
                .await
                .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
            Ok(Arc::new(Binding::bind(
                client, record.agent_id, Some(record.session_id.as_str().to_owned()),
                Some(std::path::Path::new(&record.cwd)),
            ).await?) as Arc<dyn WorkspaceBinding>)
        })
    }

    fn resolve_media<'a>(
        &'a self,
        session_key: &'a str,
        reference: &'a str,
    ) -> WorkspaceFuture<'a, ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        Box::pin(async move {
            let historical = crate::session::media::is_reference(reference);
            if !historical
                && (reference.len() != 38
                    || !reference.starts_with("media_")
                    || !reference.as_bytes()[6..].iter().all(u8::is_ascii_hexdigit))
            {
                return Err(WorkspaceMediaFailure::InvalidReference);
            }
            let client = self.native_client();
            let record = selection(&client, session_key).await?;
            let agent_id = &record.agent_id;
            let session_id = record.session_id.as_str();
            let bytes = if historical {
                media::historical(&client, agent_id, session_id, reference, 50 * 1024 * 1024)
                    .await?
                    .0
            } else {
                client
                    .take_media(agent_id, session_id, reference)
                    .await
                    .map_err(media::failure)?
            };
            Ok(ResolvedWorkspaceMedia::new(bytes))
        })
    }

    fn playback_media<'a>(
        &'a self,
        _session_key: &'a str,
        _reference: &'a str,
    ) -> WorkspaceFuture<'a, ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        Box::pin(async { Err(WorkspaceMediaFailure::Unavailable) })
    }

    fn thumbnail_media_reference<'a>(
        &'a self,
        session_key: &'a str,
        reference: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        Box::pin(async move {
            if !crate::session::media::is_reference(reference) {
                return Err(WorkspaceMediaFailure::InvalidReference);
            }
            let client = self.native_client();
            let record = selection(&client, session_key).await?;
            let agent_id = &record.agent_id;
            let session_id = record.session_id.as_str();
            media::historical_thumbnail(&client, agent_id, session_id, reference).await
        })
    }

    fn thumbnail_media_gateway<'a>(
        &'a self,
        _session_key: &'a str,
        _gateway_url: &'a str,
        _mime_type: &'a str,
        _agent_id: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        Box::pin(async { Err(WorkspaceMediaFailure::InvalidPath) })
    }

    fn stage_buffer_media<'a>(
        &'a self,
        session_key: &'a str,
        base64: &'a str,
        file_name: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        Box::pin(async move {
            let client = self.native_client();
            let record = selection(&client, session_key).await?;
            let agent_id = &record.agent_id;
            let session_id = record.session_id.as_str();
            media::stage_buffer(
                &client,
                agent_id,
                session_id,
                base64,
                file_name,
                mime_type,
            )
            .await
        })
    }

    fn list_session_images<'a>(
        &'a self,
        _session_key: &'a str,
        _agent_id: &'a str,
        _cursor: Option<&'a str>,
    ) -> WorkspaceFuture<'a, workspace_module::session_images::SessionImagePage, workspace_module::session_images::SessionImageFailure> {
        Box::pin(async { Err(workspace_module::session_images::SessionImageFailure::Unsupported) })
    }

    fn read_session_image<'a>(
        &'a self,
        _session_key: &'a str,
        _agent_id: &'a str,
        _reference: &'a str,
    ) -> WorkspaceFuture<'a, workspace_module::session_images::SessionImageData, workspace_module::session_images::SessionImageFailure> {
        Box::pin(async { Err(workspace_module::session_images::SessionImageFailure::Unsupported) })
    }

    fn workspace_runtime_ready(&self) -> bool {
        self.lifecycle_handle().snapshot().phase() == SupervisorPhase::Running
    }
}

async fn selection(
    client: &Client,
    session_key: &str,
) -> Result<crate::session::model::SessionRecord, WorkspaceMediaFailure> {
    let (requested_agent, session_id) = crate::session::projection::parse_session_key(session_key)
        .ok_or(WorkspaceMediaFailure::Unavailable)?;
    let record = crate::session::rpc::get(client, session_id, Some(requested_agent))
        .await
        .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
    if record.status == "deleting" {
        return Err(WorkspaceMediaFailure::Unavailable);
    }
    Ok(record)
}
