mod binding;
mod media;

use std::sync::Arc;

use foundation::process::supervision::SupervisorPhase;
use serde_json::json;
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
            Ok(Arc::new(Binding::new(
                self.native_client(),
                agent_id.to_owned(),
                None,
            )) as Arc<dyn WorkspaceBinding>)
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
            let (agent_id, session_id) = selection(&client, session_key)
                .await
                .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
            client
                .call("workspace.stat", json!({ "agentId": agent_id, "path": "" }))
                .await
                .map_err(|_| WorkspaceDirectoryFailure::Unavailable)?;
            Ok(Arc::new(Binding::new(client, agent_id, Some(session_id))) as Arc<dyn WorkspaceBinding>)
        })
    }

    fn resolve_media<'a>(
        &'a self,
        session_key: &'a str,
        reference: &'a str,
    ) -> WorkspaceFuture<'a, ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        Box::pin(async move {
            if reference.len() != 38
                || !reference.starts_with("media_")
                || !reference.as_bytes()[6..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err(WorkspaceMediaFailure::InvalidReference);
            }
            let client = self.native_client();
            let (agent_id, session_id) = selection(&client, session_key).await?;
            let bytes = client
                .take_media(&agent_id, &session_id, reference)
                .await
                .map_err(media::failure)?;
            Ok(ResolvedWorkspaceMedia::new(bytes))
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
            let (agent_id, session_id) = selection(&client, session_key).await?;
            media::stage_buffer(
                &client,
                &agent_id,
                &session_id,
                base64,
                file_name,
                mime_type,
            )
            .await
        })
    }

    fn workspace_runtime_ready(&self) -> bool {
        self.lifecycle_handle().snapshot().phase() == SupervisorPhase::Running
    }
}

async fn selection(
    client: &Client,
    session_key: &str,
) -> Result<(String, String), WorkspaceMediaFailure> {
    let (requested_agent, session_id) = crate::session::projection::parse_session_key(session_key)
        .ok_or(WorkspaceMediaFailure::Unavailable)?;
    let record = client
        .call("sessions.get", json!({ "sessionId": session_id }))
        .await
        .map_err(media::failure)?;
    let agent_id = record
        .get("agentId")
        .and_then(serde_json::Value::as_str)
        .filter(|agent_id| *agent_id == requested_agent)
        .ok_or(WorkspaceMediaFailure::Unavailable)?;
    Ok((agent_id.to_owned(), session_id.to_owned()))
}
