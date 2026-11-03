use base64::{Engine as _, engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use workspace_module::{ResolvedWorkspaceMedia, WorkspaceMediaFailure, WorkspaceMediaThumbnail};

use super::{SessionOperation, next_request_id, payload, request};
use crate::{
    gateway::media::{MAX_NATIVE_MEDIA_BYTES, MediaRendition, NativeMedia, NativeMediaError, outgoing_media_path, readable_media_source},
    session::protocol::{AgentScopedSessionKey, SessionDescribeParams, SessionKey},
};

const REF_PREFIX: &str = "oc-media:1:";
const REF_HEADER_BYTES: usize = 76;
const MAX_MESSAGE_ID_BYTES: usize = 256;
const MAX_REFERENCE_BYTES: usize = 512;
const CONTENT_SLOT_TAG: u32 = 1 << 31;

#[derive(Clone, Copy)]
pub(crate) enum SourceSlot {
    Fact(usize),
    Content(usize),
}

impl SourceSlot {
    fn encode(self) -> Option<u32> {
        let (index, tag) = match self { Self::Fact(index) => (index, 0), Self::Content(index) => (index, CONTENT_SLOT_TAG) };
        let index = u32::try_from(index).ok().filter(|index| *index < CONTENT_SLOT_TAG)?;
        Some(index | tag)
    }

    fn decode(value: u32) -> Self {
        let index = (value & !CONTENT_SLOT_TAG) as usize;
        if value & CONTENT_SLOT_TAG == 0 { Self::Fact(index) } else { Self::Content(index) }
    }
}

pub(crate) fn fact_source(fact: &Map<String, Value>) -> Option<&str> {
    fact.get("path").and_then(Value::as_str).or_else(|| fact.get("url").and_then(Value::as_str))
        .filter(|source| !source.is_empty())
}

pub(crate) fn content_source(block: &Map<String, Value>) -> Option<&str> {
    let media = block.get("attachment").and_then(Value::as_object).unwrap_or(block);
    let fields = ["url", "openUrl", "image_url", "audio_url", "video_url"];
    [Some(media), media.get("source").and_then(Value::as_object)].into_iter().flatten()
        .flat_map(|record| fields.into_iter().filter_map(move |field| record.get(field)))
        .filter_map(|value| value.as_str().or_else(|| value.get("url").and_then(Value::as_str)))
        .chain(media.get("source").and_then(Value::as_str))
        .find(|source| !source.is_empty() && (!source.starts_with("data:")
            || matches!(block.get("type").and_then(Value::as_str), Some("image_url" | "input_image"))
                && inline_image_parts(source).is_some()))
}

pub(crate) fn inline_image_type(source: &str) -> Option<&str> {
    inline_image_parts(source).map(|(mime_type, _)| mime_type)
}

fn inline_image_parts(source: &str) -> Option<(&str, &str)> {
    let (metadata, data) = source.strip_prefix("data:")?.split_once(',')?;
    let mime_type = metadata.strip_suffix(";base64")?;
    (matches!(mime_type, "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp" | "image/heic" | "image/heif")
        && !data.is_empty()).then_some((mime_type, data))
}

pub(crate) fn media_reference(
    native_session: Option<&str>,
    message_id: Option<&str>,
    sequence: Option<u64>,
    slot: SourceSlot,
    source: &str,
) -> Option<String> {
    let native_session = native_session.filter(|value| !value.is_empty())?;
    let message_id = message_id.filter(|value| valid_message_id(value))?;
    let sequence = sequence.filter(|sequence| *sequence > 0)?;
    if !readable_media_source(source)
        && !(matches!(slot, SourceSlot::Content(_)) && inline_image_parts(source).is_some()) { return None; }
    let slot = slot.encode()?;
    let mut bytes = Vec::with_capacity(REF_HEADER_BYTES + message_id.len());
    bytes.extend_from_slice(&digest(native_session));
    bytes.extend_from_slice(&sequence.to_be_bytes());
    bytes.extend_from_slice(&slot.to_be_bytes());
    bytes.extend_from_slice(&digest(source));
    bytes.extend_from_slice(message_id.as_bytes());
    let reference = format!("{REF_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    (reference.len() <= MAX_REFERENCE_BYTES).then_some(reference)
}

struct MediaReference {
    native_session: [u8; 32],
    sequence: u64,
    slot: SourceSlot,
    source: [u8; 32],
    message_id: String,
}

impl MediaReference {
    fn decode(value: &str) -> Option<Self> {
        if value.len() > MAX_REFERENCE_BYTES { return None; }
        let bytes = URL_SAFE_NO_PAD.decode(value.strip_prefix(REF_PREFIX)?).ok()?;
        if bytes.len() <= REF_HEADER_BYTES || bytes.len() > REF_HEADER_BYTES + MAX_MESSAGE_ID_BYTES { return None; }
        let message_id = String::from_utf8(bytes[REF_HEADER_BYTES..].to_vec()).ok()?;
        if !valid_message_id(&message_id) { return None; }
        let sequence = u64::from_be_bytes(bytes[32..40].try_into().ok()?);
        if sequence == 0 { return None; }
        Some(Self {
            native_session: bytes[..32].try_into().ok()?, sequence,
            slot: SourceSlot::decode(u32::from_be_bytes(bytes[40..44].try_into().ok()?)),
            source: bytes[44..76].try_into().ok()?, message_id,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageGetParams<'a> {
    session_key: &'a str,
    agent_id: &'a str,
    message_id: &'a str,
    max_chars: u32,
}

impl SessionOperation {
    pub(crate) async fn resolve_media_reference(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        let media = self.read_media_reference(session_key, reference, MediaRendition::Original).await?;
        Ok(ResolvedWorkspaceMedia::new(media.bytes))
    }

    pub(crate) async fn playback_media_reference(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        let media = self.read_media_reference(session_key, reference, MediaRendition::Playback).await?;
        Ok(ResolvedWorkspaceMedia::playback(media.bytes, media.mime_type))
    }

    pub(crate) async fn thumbnail_media_reference(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        let media = self.read_media_reference(session_key, reference, MediaRendition::Thumbnail).await?;
        let file_size = media.size_bytes;
        let preview = tokio::task::spawn_blocking(move || {
            workspace_module::media::image_preview(&media.bytes, &media.mime_type)
        }).await.map_err(|_| WorkspaceMediaFailure::Unavailable)?
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        Ok(WorkspaceMediaThumbnail::new(Some(preview), file_size))
    }

    async fn read_media_reference(
        &self,
        session_key: &str,
        reference: &str,
        rendition: MediaRendition,
    ) -> Result<NativeMedia, WorkspaceMediaFailure> {
        let key = AgentScopedSessionKey::try_parse(session_key).map_err(|_| WorkspaceMediaFailure::InvalidReference)?;
        let reference = MediaReference::decode(reference).ok_or(WorkspaceMediaFailure::InvalidReference)?;
        self.verify_media_session(&key, &reference).await?;
        let id = next_request_id("chat-media-message-get").map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let query = request(&id, "chat.message.get", MessageGetParams {
            session_key: key.as_str(), agent_id: key.agent_id(), message_id: &reference.message_id, max_chars: 1024,
        }).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let response = self.gateway.rpc_query(query).await.map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let result = payload(&id, response).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) { return Err(WorkspaceMediaFailure::Unavailable); }
        let message = result.get("message").ok_or(WorkspaceMediaFailure::Unavailable)?;
        if message.pointer("/__openclaw/id").and_then(Value::as_str) != Some(reference.message_id.as_str())
            || message.pointer("/__openclaw/seq").and_then(Value::as_u64) != Some(reference.sequence) {
            return Err(WorkspaceMediaFailure::InvalidReference);
        }
        let media_metadata = match reference.slot {
            SourceSlot::Fact(index) => message.pointer("/__openclaw/media").and_then(Value::as_array)
                .and_then(|facts| facts.get(index)),
            SourceSlot::Content(index) => message.get("content").and_then(Value::as_array)
                .and_then(|blocks| blocks.get(index)).map(|block| block.get("attachment").unwrap_or(block)),
        };
        let original_size = media_metadata.and_then(|media| media.get("sizeBytes")).and_then(Value::as_u64);
        let image = media_metadata.is_some_and(|media| {
            matches!(media.get("kind").or_else(|| media.get("type")).and_then(Value::as_str), Some("image" | "image_url" | "input_image"))
                || ["contentType", "mimeType", "mediaType"].into_iter().any(|field|
                    media.get(field).and_then(Value::as_str).is_some_and(|mime| mime.starts_with("image/")))
        });
        let source = match reference.slot {
            SourceSlot::Fact(index) => {
                let fact = message.pointer("/__openclaw/media").and_then(Value::as_array)
                    .and_then(|facts| facts.get(index)).and_then(Value::as_object)
                    .filter(|fact| fact.get("hydrationSuppressed").and_then(Value::as_bool) != Some(true))
                    .ok_or(WorkspaceMediaFailure::InvalidReference)?;
                fact_source(fact)
            }
            SourceSlot::Content(index) => {
                let block = message.get("content").and_then(Value::as_array)
                    .and_then(|blocks| blocks.get(index)).and_then(Value::as_object)
                    .filter(|block| matches!(block.get("type").and_then(Value::as_str),
                        Some("image" | "image_url" | "input_image" | "audio" | "video" | "media" | "attachment" | "document")))
                    .ok_or(WorkspaceMediaFailure::InvalidReference)?;
                let source = content_source(block);
                if source.is_some_and(|source| message.pointer("/__openclaw/media").and_then(Value::as_array)
                    .is_some_and(|facts| facts.iter().filter_map(Value::as_object).any(|fact|
                        ["path", "url"].into_iter().any(|field| fact.get(field).and_then(Value::as_str) == Some(source))
                            && fact.get("hydrationSuppressed").and_then(Value::as_bool) == Some(true)))) {
                    return Err(WorkspaceMediaFailure::InvalidReference);
                }
                source
            }
        }.filter(|source| digest(source) == reference.source)
            .ok_or(WorkspaceMediaFailure::InvalidReference)?;
        let mut media = if let Some((mime_type, data)) = inline_image_parts(source) {
            if rendition == MediaRendition::Playback { return Err(WorkspaceMediaFailure::Unavailable); }
            if !matches!(reference.slot, SourceSlot::Content(_)) { return Err(WorkspaceMediaFailure::InvalidReference); }
            if data.len() > MAX_NATIVE_MEDIA_BYTES.div_ceil(3) * 4 { return Err(WorkspaceMediaFailure::TooLarge); }
            let bytes = STANDARD.decode(data).map_err(|_| WorkspaceMediaFailure::InvalidReference)?;
            if bytes.len() > MAX_NATIVE_MEDIA_BYTES { return Err(WorkspaceMediaFailure::TooLarge); }
            NativeMedia { size_bytes: bytes.len() as u64, bytes, mime_type: mime_type.to_owned() }
        } else {
            self.gateway.read_session_media(key.as_str(), key.agent_id(), source, image, rendition).await
                .map_err(|error| match error {
                    NativeMediaError::Invalid => WorkspaceMediaFailure::InvalidReference,
                    NativeMediaError::Unavailable => WorkspaceMediaFailure::Unavailable,
                    NativeMediaError::TooLarge => WorkspaceMediaFailure::TooLarge,
                })?
        };
        if rendition == MediaRendition::Thumbnail && outgoing_media_path(source, rendition).is_some() {
            media.size_bytes = original_size.unwrap_or(0);
        }
        self.verify_media_session(&key, &reference).await?;
        Ok(media)
    }

    async fn verify_media_session(
        &self,
        key: &AgentScopedSessionKey,
        reference: &MediaReference,
    ) -> Result<(), WorkspaceMediaFailure> {
        let session_key = SessionKey::try_new(key.as_str()).map_err(|_| WorkspaceMediaFailure::InvalidReference)?;
        let row = self.describe_session(SessionDescribeParams::new(session_key, Some(key.agent_id())))
            .await.map_err(|_| WorkspaceMediaFailure::Unavailable)?.ok_or(WorkspaceMediaFailure::Unavailable)?;
        if row.key.as_deref() != Some(key.as_str())
            || row.agent_id.as_ref().map(|agent| agent.as_str()) != Some(key.agent_id())
            || row.session_id.as_deref().map(digest) != Some(reference.native_session) {
            return Err(WorkspaceMediaFailure::InvalidReference);
        }
        Ok(())
    }
}

fn valid_message_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_MESSAGE_ID_BYTES && !value.chars().any(char::is_control)
}

pub(crate) fn resource_id(source: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(source.as_bytes()))
}

pub(crate) fn media_file_name(media: &Map<String, Value>) -> Option<String> {
    ["fileName", "label"].into_iter().filter_map(|field| media.get(field).and_then(Value::as_str))
        .find(|name| sessions_module::state::valid_media_file_name(name)).map(str::to_owned)
}

pub(crate) fn media_size_bytes(media: &Map<String, Value>) -> Option<u64> {
    media.get("sizeBytes").and_then(Value::as_u64)
        .filter(|size| *size <= sessions_module::state::MAX_SAFE_INTEGER)
}

fn digest(value: &str) -> [u8; 32] { Sha256::digest(value.as_bytes()).into() }
