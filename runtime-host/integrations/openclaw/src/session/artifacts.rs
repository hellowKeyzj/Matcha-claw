use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::Deserialize;
use serde_json::{Value, json};
use workspace_module::session_images::{
    SessionImage, SessionImageData, SessionImageFailure, SessionImagePage,
};

use super::{SessionOperation, next_request_id, protocol::AgentScopedSessionKey, request};
use crate::gateway::wire::GatewayResponse;

pub(crate) const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const TRANSCRIPT_PREFIX: &str = "artifact_transcript_image_";
const MANAGED_PREFIX: &str = "artifact_managed_image_";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    title: String,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    session_key: Option<String>,
    source: Option<String>,
    download: DownloadMode,
}

#[derive(Deserialize)]
struct DownloadMode {
    mode: Mode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Bytes,
    Url,
    Unsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    artifacts: Vec<Artifact>,
    next_cursor: Option<String>,
    #[serde(default)]
    omitted_oversized: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    artifact: Artifact,
    encoding: Option<String>,
    data: Option<String>,
    url: Option<String>,
    expires_at: Option<String>,
}

impl Artifact {
    fn validate(&self, session_key: &str) -> Result<(), SessionImageFailure> {
        if self.kind != "image"
            || self.session_key.as_deref() != Some(session_key)
            || !bounded_text(&self.id, 8192)
            || self
                .mime_type
                .as_deref()
                .is_some_and(|mime| !bounded_text(mime, 255))
        {
            return Err(SessionImageFailure::Unavailable);
        }
        Ok(())
    }

    fn readable(&self) -> bool {
        self.source.as_deref() == Some("session-transcript")
            && match self.download.mode {
                Mode::Bytes => transcript_reference(&self.id),
                Mode::Url => managed_attachment(&self.id).is_some(),
                Mode::Unsupported => false,
            }
    }
}

impl SessionOperation {
    pub(crate) async fn list_session_images(
        &self,
        session_key: &str,
        agent_id: &str,
        cursor: Option<&str>,
    ) -> Result<SessionImagePage, SessionImageFailure> {
        validate_identity(session_key, agent_id)?;
        if cursor.is_some_and(|cursor| !bounded_text(cursor, 256)) {
            return Err(SessionImageFailure::CursorInvalid);
        }
        let mut params =
            json!({"sessionKey":session_key,"agentId":agent_id,"type":"image","limit":4});
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        let page: Page =
            serde_json::from_value(self.artifact_query("artifacts.list", params).await?)
                .map_err(|_| SessionImageFailure::Unavailable)?;
        if page.artifacts.len() > 4
            || page
                .next_cursor
                .as_deref()
                .is_some_and(|cursor| !bounded_text(cursor, 256))
        {
            return Err(SessionImageFailure::Unavailable);
        }
        let mut items = Vec::with_capacity(page.artifacts.len());
        for artifact in page.artifacts {
            artifact.validate(session_key)?;
            let readable = artifact.readable();
            items.push(SessionImage {
                name: image_name(&artifact.title),
                reference: artifact.id,
                mime_type: artifact.mime_type,
                readable,
            });
        }
        Ok(SessionImagePage {
            items,
            next_cursor: page.next_cursor,
            omitted_oversized: page.omitted_oversized,
        })
    }

    pub(crate) async fn read_session_image(
        &self,
        session_key: &str,
        agent_id: &str,
        reference: &str,
    ) -> Result<SessionImageData, SessionImageFailure> {
        validate_identity(session_key, agent_id)?;
        if !transcript_reference(reference) && managed_attachment(reference).is_none() {
            return Err(SessionImageFailure::InvalidReference);
        }
        let download: Download = serde_json::from_value(self.artifact_query("artifacts.download", json!({
            "sessionKey":session_key,"agentId":agent_id,"artifactId":reference,"transport":"http",
        })).await?).map_err(|_| SessionImageFailure::Unavailable)?;
        download.artifact.validate(session_key)?;
        if download.artifact.id != reference {
            return Err(SessionImageFailure::InvalidReference);
        }
        if download
            .artifact
            .size_bytes
            .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
        {
            return Err(SessionImageFailure::TooLarge);
        }
        let (bytes, mime_type) = match download.artifact.download.mode {
            Mode::Bytes
                if transcript_reference(reference)
                    && download.url.is_none()
                    && download.encoding.as_deref() == Some("base64") =>
            {
                let data = download.data.ok_or(SessionImageFailure::Unavailable)?;
                if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
                    return Err(SessionImageFailure::TooLarge);
                }
                let bytes = STANDARD
                    .decode(&data)
                    .map_err(|_| SessionImageFailure::Unavailable)?;
                if STANDARD.encode(&bytes) != data {
                    return Err(SessionImageFailure::Unavailable);
                }
                if bytes.len() > MAX_IMAGE_BYTES {
                    return Err(SessionImageFailure::TooLarge);
                }
                let mime = image_mime(&bytes, download.artifact.mime_type.as_deref())?;
                (bytes, mime)
            }
            // Native HTTP grants rewrite transcript byte artifacts to mode=url too.
            Mode::Url
                if download.data.is_none()
                    && download.encoding.is_none()
                    && download
                        .expires_at
                        .as_deref()
                        .is_some_and(|value| bounded_text(value, 128)) =>
            {
                self.gateway
                    .read_artifact_image(
                        session_key,
                        reference,
                        download
                            .url
                            .as_deref()
                            .ok_or(SessionImageFailure::Unavailable)?,
                    )
                    .await?
            }
            Mode::Unsupported => return Err(SessionImageFailure::Unsupported),
            _ => return Err(SessionImageFailure::Unavailable),
        };
        Ok(SessionImageData {
            name: image_name(&download.artifact.title),
            mime_type,
            bytes,
        })
    }

    async fn artifact_query(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, SessionImageFailure> {
        let id = next_request_id(method).map_err(|_| SessionImageFailure::Unavailable)?;
        let query = request(&id, method, params).map_err(|_| SessionImageFailure::Unavailable)?;
        // Native cursors belong to this shared control connection, not a new socket per page.
        let response = self
            .gateway
            .rpc_query(query)
            .await
            .map_err(|_| SessionImageFailure::Unavailable)?;
        if response.request_id() != id {
            return Err(SessionImageFailure::Unavailable);
        }
        match response {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => Ok(payload),
            GatewayResponse::Failure { error, .. } => Err(match error.artifact_error_type {
                Some("artifact_cursor_invalid") => SessionImageFailure::CursorInvalid,
                Some("artifact_not_found") => SessionImageFailure::InvalidReference,
                Some("artifact_download_unsupported") => SessionImageFailure::Unsupported,
                _ => SessionImageFailure::Unavailable,
            }),
            _ => Err(SessionImageFailure::Unavailable),
        }
    }
}

fn validate_identity(session_key: &str, agent_id: &str) -> Result<(), SessionImageFailure> {
    let key = AgentScopedSessionKey::try_parse(session_key)
        .map_err(|_| SessionImageFailure::InvalidReference)?;
    if key.agent_id() != agent_id {
        return Err(SessionImageFailure::InvalidReference);
    }
    Ok(())
}

fn image_name(title: &str) -> String {
    let mut name = String::new();
    for character in title.chars() {
        let character = if character.is_control() || matches!(character, '/' | '\\' | ':') {
            '_'
        } else {
            character
        };
        if name.len() + character.len_utf8() > 4096 {
            break;
        }
        name.push(character);
    }
    if name.trim().is_empty() || matches!(name.as_str(), "." | "..") {
        "image".to_owned()
    } else {
        name
    }
}

fn bounded_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptReference {
    source: String,
    raw_seq: u64,
    message_id: String,
    message_seq: u64,
    content_index: u64,
}

fn transcript_reference(value: &str) -> bool {
    let Some(encoded) = value
        .strip_prefix(TRANSCRIPT_PREFIX)
        .filter(|_| value.len() <= 8192)
    else {
        return false;
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) else {
        return false;
    };
    let Ok(reference) = serde_json::from_slice::<TranscriptReference>(&bytes) else {
        return false;
    };
    URL_SAFE_NO_PAD.encode(&bytes) == encoded
        && bounded_text(&reference.source, 128)
        && bounded_text(&reference.message_id, 1024)
        && reference.message_seq > 0
        && reference.message_seq < 9_007_199_254_740_991
        && reference.raw_seq <= 9_007_199_254_740_991
        && reference.content_index <= 9_007_199_254_740_991
}

pub(crate) fn managed_attachment(reference: &str) -> Option<&str> {
    let id = reference.strip_prefix(MANAGED_PREFIX)?;
    (id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        }))
    .then_some(id)
}

pub(crate) fn image_mime(
    bytes: &[u8],
    declared: Option<&str>,
) -> Result<String, SessionImageFailure> {
    if bytes.is_empty() {
        return Err(SessionImageFailure::Unavailable);
    }
    let declared = declared.map(|value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
    });
    let actual = image::guess_format(bytes)
        .ok()
        .map(|format| format.to_mime_type().to_owned())
        .or_else(|| workspace_module::media::normalized_mime_type("image/svg+xml", "", bytes).ok())
        .ok_or(SessionImageFailure::Unavailable)?;
    if !actual.starts_with("image/") || declared.as_deref().is_some_and(|mime| mime != actual) {
        return Err(SessionImageFailure::Unavailable);
    }
    Ok(actual)
}
