use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use workspace_module::session_images::{
    SessionImage, SessionImageData, SessionImageFailure, SessionImagePage,
};

use super::{SessionOperation, next_request_id, protocol::AgentScopedSessionKey, request};
use crate::gateway::wire::GatewayResponse;

pub(crate) const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const PAGE_SIZE: usize = 4;
const TRANSCRIPT_PREFIX: &str = "artifact_";
const MANAGED_PREFIX: &str = "artifact_managed_image_";

#[derive(Deserialize, Serialize)]
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

#[derive(Deserialize, Serialize)]
struct DownloadMode {
    mode: Mode,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
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
        let cursor = cursor.map(decode_cursor).transpose()?;
        let mut page: Page = serde_json::from_value(
            self.artifact_query(
                "artifacts.list",
                json!({"sessionKey":session_key,"agentId":agent_id}),
            )
            .await?,
        )
        .map_err(|_| SessionImageFailure::Unavailable)?;
        page.artifacts.retain(|artifact| artifact.kind == "image");
        for artifact in &page.artifacts {
            artifact.validate(session_key)?;
        }
        // Native lists all artifacts; bind local pages to this scope and ordered image metadata.
        let fingerprint: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&(agent_id, session_key, &page.artifacts))
                .map_err(|_| SessionImageFailure::Unavailable)?,
        )
        .into();
        let image_count = page.artifacts.len();
        page.artifacts.retain(|artifact| {
            artifact
                .size_bytes
                .is_none_or(|size| size <= MAX_IMAGE_BYTES as u64)
        });
        let omitted_oversized = page.artifacts.len() != image_count;
        let offset = match cursor {
            Some((expected, offset))
                if expected == fingerprint && offset < page.artifacts.len() =>
            {
                offset
            }
            Some(_) => return Err(SessionImageFailure::CursorInvalid),
            None => 0,
        };
        let next_cursor = (page.artifacts.len() - offset > PAGE_SIZE)
            .then(|| encode_cursor(&fingerprint, offset + PAGE_SIZE));
        let items = page
            .artifacts
            .into_iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .map(|artifact| {
                let readable = artifact.readable();
                SessionImage {
                    name: image_name(&artifact.title),
                    reference: artifact.id,
                    mime_type: artifact.mime_type,
                    readable,
                }
            })
            .collect();
        Ok(SessionImagePage {
            items,
            next_cursor,
            omitted_oversized,
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
        let download: Download = serde_json::from_value(
            self.artifact_query(
                "artifacts.download",
                json!({
                    "sessionKey":session_key,"agentId":agent_id,"artifactId":reference,
                }),
            )
            .await?,
        )
        .map_err(|_| SessionImageFailure::Unavailable)?;
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
            Mode::Url
                if managed_attachment(reference).is_some()
                    && download.data.is_none()
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
        let response = self
            .gateway
            .query_artifact(query)
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

fn encode_cursor(fingerprint: &[u8; 32], offset: usize) -> String {
    let mut bytes = [0_u8; 41];
    bytes[0] = 1;
    bytes[1..33].copy_from_slice(fingerprint);
    bytes[33..].copy_from_slice(&(offset as u64).to_be_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_cursor(value: &str) -> Result<([u8; 32], usize), SessionImageFailure> {
    if !bounded_text(value, 256) {
        return Err(SessionImageFailure::CursorInvalid);
    }
    let bytes: [u8; 41] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SessionImageFailure::CursorInvalid)?
        .try_into()
        .map_err(|_| SessionImageFailure::CursorInvalid)?;
    if bytes[0] != 1 || URL_SAFE_NO_PAD.encode(bytes) != value {
        return Err(SessionImageFailure::CursorInvalid);
    }
    let fingerprint = bytes[1..33]
        .try_into()
        .map_err(|_| SessionImageFailure::CursorInvalid)?;
    let offset = usize::try_from(u64::from_be_bytes(
        bytes[33..]
            .try_into()
            .map_err(|_| SessionImageFailure::CursorInvalid)?,
    ))
    .map_err(|_| SessionImageFailure::CursorInvalid)?;
    if offset == 0 || offset % PAGE_SIZE != 0 {
        return Err(SessionImageFailure::CursorInvalid);
    }
    Ok((fingerprint, offset))
}

fn transcript_reference(value: &str) -> bool {
    value.strip_prefix(TRANSCRIPT_PREFIX).is_some_and(|id| {
        id.len() == 18
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

pub(crate) fn managed_attachment(reference: &str) -> Option<&str> {
    let id = reference.strip_prefix(MANAGED_PREFIX).or_else(|| reference.strip_prefix("artifact_managed_media_"))?;
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
