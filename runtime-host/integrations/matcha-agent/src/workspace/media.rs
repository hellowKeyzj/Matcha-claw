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

pub(super) async fn historical(
    client: &Client,
    agent_id: &str,
    session_id: &str,
    reference: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, String), WorkspaceMediaFailure> {
    use crate::session::media::{self, Body, Source};
    let block = media::read(client, agent_id, session_id, reference).await?;
    let source = Source::parse(&block).ok_or(WorkspaceMediaFailure::InvalidReference)?;
    if let Body::Url(url) = source.body {
        let (agent, path) =
            media::workspace_source(url).ok_or(WorkspaceMediaFailure::InvalidReference)?;
        if agent != agent_id {
            return Err(WorkspaceMediaFailure::InvalidReference);
        }
        let stat = client
            .call(
                "workspace.stat",
                serde_json::json!({"agentId":agent_id,"path":path}),
            )
            .await
            .map_err(failure)?;
        if stat.get("kind").and_then(serde_json::Value::as_str) != Some("file") {
            return Err(WorkspaceMediaFailure::NotFile);
        }
        let size = stat
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        if size > max_bytes as u64 {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        let bytes = client.read_file(agent_id, &path).await.map_err(failure)?;
        if bytes.len() > max_bytes {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        let requested = source.mime_type();
        let mime_type = if requested == "image/*" {
            workspace_module::media::normalized_mime_type("", &path, &bytes)?
        } else {
            requested.to_owned()
        };
        return Ok((bytes, mime_type));
    }
    tokio::task::spawn_blocking(move || {
        let source = Source::parse(&block).ok_or(WorkspaceMediaFailure::InvalidReference)?;
        let bytes = match source.body {
            Body::Base64(encoded) => {
                if encoded.len() > ((max_bytes + 2) / 3) * 4 {
                    return Err(WorkspaceMediaFailure::TooLarge);
                }
                STANDARD
                    .decode(encoded)
                    .map_err(|_| WorkspaceMediaFailure::Unavailable)?
            }
            Body::Text(text) => {
                if text.len() > max_bytes {
                    return Err(WorkspaceMediaFailure::TooLarge);
                }
                text.as_bytes().to_vec()
            }
            Body::Url(_) => return Err(WorkspaceMediaFailure::InvalidReference),
        };
        if bytes.len() > max_bytes {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        Ok((bytes, source.mime_type().to_owned()))
    })
    .await
    .map_err(|_| WorkspaceMediaFailure::Unavailable)?
}

pub(super) async fn historical_thumbnail(
    client: &Client,
    agent_id: &str,
    session_id: &str,
    reference: &str,
) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
    let (bytes, mime_type) = historical(
        client, agent_id, session_id, reference, workspace_module::media::MAX_PREVIEW_INPUT_BYTES,
    ).await?;
    tokio::task::spawn_blocking(move || {
        let preview = workspace_module::media::image_preview(&bytes, &mime_type);
        WorkspaceMediaThumbnail::new(preview, bytes.len() as u64)
    })
    .await
    .map_err(|_| WorkspaceMediaFailure::Unavailable)
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
