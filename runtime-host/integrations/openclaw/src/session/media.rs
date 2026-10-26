use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use workspace_module::{WorkspaceMediaFailure, WorkspaceMediaThumbnail};

use super::{SessionOperation, next_request_id, payload, request};
use crate::{
    gateway::media::NativeMediaError,
    session::protocol::{AgentScopedSessionKey, SessionDescribeParams, SessionKey},
};

const REF_PREFIX: &str = "oc-media:1:";
const REF_HEADER_BYTES: usize = 76;
const MAX_MESSAGE_ID_BYTES: usize = 256;
const MAX_REFERENCE_BYTES: usize = 512;

pub(crate) fn inbound_source(source: &str) -> bool {
    source.starts_with("media://inbound/")
        && source.len() > "media://inbound/".len()
        && source.len() <= 8 * 1024
        && !source.chars().any(char::is_control)
}

pub(crate) fn media_reference(
    native_session: Option<&str>,
    message_id: Option<&str>,
    sequence: Option<u64>,
    fact_index: usize,
    source: &str,
) -> Option<String> {
    let native_session = native_session.filter(|value| !value.is_empty())?;
    let message_id = message_id.filter(|value| valid_message_id(value))?;
    let sequence = sequence.filter(|sequence| *sequence > 0)?;
    let fact_index = u32::try_from(fact_index).ok()?;
    if !inbound_source(source) { return None; }
    let mut bytes = Vec::with_capacity(REF_HEADER_BYTES + message_id.len());
    bytes.extend_from_slice(&digest(native_session));
    bytes.extend_from_slice(&sequence.to_be_bytes());
    bytes.extend_from_slice(&fact_index.to_be_bytes());
    bytes.extend_from_slice(&digest(source));
    bytes.extend_from_slice(message_id.as_bytes());
    Some(format!("{REF_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

struct MediaReference {
    native_session: [u8; 32],
    sequence: u64,
    fact_index: u32,
    source: [u8; 32],
    message_id: String,
}

impl MediaReference {
    fn decode(value: &str) -> Option<Self> {
        if value.len() > MAX_REFERENCE_BYTES { return None; }
        let bytes = URL_SAFE_NO_PAD.decode(value.strip_prefix(REF_PREFIX)?).ok()?;
        if bytes.len() <= REF_HEADER_BYTES || bytes.len() > REF_HEADER_BYTES + MAX_MESSAGE_ID_BYTES {
            return None;
        }
        let message_id = String::from_utf8(bytes[REF_HEADER_BYTES..].to_vec()).ok()?;
        if !valid_message_id(&message_id) { return None; }
        let sequence = u64::from_be_bytes(bytes[32..40].try_into().ok()?);
        if sequence == 0 { return None; }
        Some(Self {
            native_session: bytes[..32].try_into().ok()?,
            sequence,
            fact_index: u32::from_be_bytes(bytes[40..44].try_into().ok()?),
            source: bytes[44..76].try_into().ok()?,
            message_id,
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
    pub(crate) async fn thumbnail_media_reference(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        let key = AgentScopedSessionKey::try_parse(session_key)
            .map_err(|_| WorkspaceMediaFailure::InvalidReference)?;
        let reference = MediaReference::decode(reference)
            .ok_or(WorkspaceMediaFailure::InvalidReference)?;
        self.verify_media_session(&key, &reference).await?;
        let id = next_request_id("chat-media-message-get")
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let query = request(&id, "chat.message.get", MessageGetParams {
            session_key: key.as_str(),
            agent_id: key.agent_id(),
            message_id: &reference.message_id,
            max_chars: 1024,
        }).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let response = self.gateway.rpc_query(query).await
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let result = payload(&id, response).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(WorkspaceMediaFailure::Unavailable);
        }
        let message = result.get("message").ok_or(WorkspaceMediaFailure::Unavailable)?;
        if message.pointer("/__openclaw/id").and_then(Value::as_str) != Some(reference.message_id.as_str())
            || message.pointer("/__openclaw/seq").and_then(Value::as_u64) != Some(reference.sequence) {
            return Err(WorkspaceMediaFailure::InvalidReference);
        }
        let fact = message.pointer("/__openclaw/media").and_then(Value::as_array)
            .and_then(|facts| facts.get(reference.fact_index as usize))
            .ok_or(WorkspaceMediaFailure::InvalidReference)?;
        let source = fact.get("url").and_then(Value::as_str)
            .filter(|source| inbound_source(source) && digest(source) == reference.source)
            .ok_or(WorkspaceMediaFailure::InvalidReference)?;
        if fact.get("hydrationSuppressed").and_then(Value::as_bool) == Some(true) {
            return Err(WorkspaceMediaFailure::InvalidReference);
        }
        let media = self.gateway.read_session_media(key.as_str(), key.agent_id(), source).await
            .map_err(|error| match error {
                NativeMediaError::Invalid => WorkspaceMediaFailure::InvalidReference,
                NativeMediaError::Unavailable => WorkspaceMediaFailure::Unavailable,
                NativeMediaError::TooLarge => WorkspaceMediaFailure::TooLarge,
            })?;
        let file_size = media.size_bytes;
        let preview = tokio::task::spawn_blocking(move || {
            workspace_module::media::image_preview(&media.bytes, &media.mime_type)
        }).await.map_err(|_| WorkspaceMediaFailure::Unavailable)?
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        self.verify_media_session(&key, &reference).await?;
        Ok(WorkspaceMediaThumbnail::new(Some(preview), file_size))
    }

    async fn verify_media_session(
        &self,
        key: &AgentScopedSessionKey,
        reference: &MediaReference,
    ) -> Result<(), WorkspaceMediaFailure> {
        let session_key = SessionKey::try_new(key.as_str())
            .map_err(|_| WorkspaceMediaFailure::InvalidReference)?;
        let row = self.describe_session(SessionDescribeParams::new(session_key, Some(key.agent_id())))
            .await.map_err(|_| WorkspaceMediaFailure::Unavailable)?
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
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

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
