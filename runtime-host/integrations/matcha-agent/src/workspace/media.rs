use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use workspace_module::{WorkspaceMediaFailure, WorkspaceMediaReceipt, WorkspaceMediaThumbnail};

use crate::client::{Client, Error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    reference: String,
    name: String,
    mime_type: String,
    size: u64,
}

pub(super) async fn stage(
    client: &Client,
    agent_id: &str,
    session_id: &str,
    bytes: Vec<u8>,
    file_name: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
    let file_name = file_name.to_owned();
    let mime_type = mime_type.to_owned();
    let (bytes, file_name, mime_type, preview) =
        tokio::task::spawn_blocking(move || -> Result<_, WorkspaceMediaFailure> {
            let mime_type =
                workspace_module::media::normalized_mime_type(&mime_type, &file_name, &bytes)?;
            let preview = workspace_module::media::image_preview(&bytes, &mime_type);
            Ok((bytes, file_name, mime_type, preview))
        })
        .await
        .map_err(|_| WorkspaceMediaFailure::Unavailable)??;
    let value = client
        .upload_media(agent_id, session_id, &file_name, &mime_type, &bytes)
        .await
        .map_err(failure)?;
    let receipt: Receipt =
        serde_json::from_value(value).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
    if receipt.size != bytes.len() as u64
        || receipt.name != file_name
        || receipt.mime_type != mime_type
        || receipt.reference.len() != 38
        || !receipt.reference.starts_with("media_")
        || !receipt.reference.as_bytes()[6..]
            .iter()
            .all(u8::is_ascii_hexdigit)
    {
        return Err(WorkspaceMediaFailure::Unavailable);
    }
    Ok(WorkspaceMediaReceipt::new(
        receipt.reference,
        receipt.name,
        receipt.mime_type,
        receipt.size,
        preview,
    ))
}

pub(super) async fn stage_buffer(
    client: &Client,
    agent_id: &str,
    session_id: &str,
    base64: &str,
    file_name: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
    let base64 = base64.to_owned();
    let bytes = tokio::task::spawn_blocking(move || STANDARD.decode(base64))
        .await
        .map_err(|_| WorkspaceMediaFailure::Unavailable)?
        .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
    stage(client, agent_id, session_id, bytes, file_name, mime_type).await
}

pub(super) async fn thumbnail(
    bytes: Vec<u8>,
    path: &str,
    mime_type: &str,
) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
    let path = path.to_owned();
    let mime_type = mime_type.to_owned();
    tokio::task::spawn_blocking(move || {
        let mime_type = workspace_module::media::normalized_mime_type(&mime_type, &path, &bytes)?;
        let preview = workspace_module::media::image_preview(&bytes, &mime_type);
        Ok(WorkspaceMediaThumbnail::new(preview, bytes.len() as u64))
    })
    .await
    .map_err(|_| WorkspaceMediaFailure::Unavailable)?
}

pub(super) fn failure(error: Error) -> WorkspaceMediaFailure {
    match error.kind() {
        "invalid_params" | "workspace_link_forbidden" | "workspace_hardlink_forbidden" => {
            WorkspaceMediaFailure::InvalidPath
        }
        "workspace_not_file" => WorkspaceMediaFailure::NotFile,
        _ => WorkspaceMediaFailure::Unavailable,
    }
}
