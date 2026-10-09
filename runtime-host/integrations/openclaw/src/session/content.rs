use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sessions_module::{state::SessionIdentity, timeline::{ContentChunk, ContentCommand, ContentOutcome, UnavailableReason}};

use super::{SessionOperation, OperationError, next_request_id, payload, request};
use crate::session::{protocol::{SessionDescribeParams, SessionKey}, window::{self, LargeTextFacts, MessageRole, SessionWindow}};

const REF_PREFIX: &str = "oc-text:1:";
const REF_HEADER_BYTES: usize = 104;
const PREFIX_BYTES: usize = 32 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageGetParams<'a> {
    session_key: &'a str,
    agent_id: &'a str,
    message_id: &'a str,
    max_chars: u32,
}

struct CompleteText {
    text: String,
    sequence: u64,
}

impl SessionOperation {
    async fn message_text(&self, identity: &SessionIdentity, message_id: &str) -> Result<CompleteText, OperationError> {
        let id = next_request_id("chat-message-get")?;
        let request = request(&id, "chat.message.get", MessageGetParams {
            session_key: &identity.session_key, agent_id: &identity.agent_id, message_id, max_chars: 2_000_000,
        })?;
        let result = payload(&id, self.gateway.rpc_query(request).await?)?;
        if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) { return Err(OperationError::Rejected); }
        let message = result.get("message").ok_or(OperationError::Protocol)?;
        if message.pointer("/__openclaw/id").and_then(serde_json::Value::as_str) != Some(message_id) { return Err(OperationError::Protocol); }
        let sequence = message.pointer("/__openclaw/seq").and_then(serde_json::Value::as_u64).filter(|seq| *seq > 0).ok_or(OperationError::Protocol)?;
        let text = window::decode_complete_text(message).map_err(|_| OperationError::Protocol)?;
        Ok(CompleteText { text, sequence })
    }

    pub(crate) async fn hydrate_history(&self, identity: &SessionIdentity, window: &mut SessionWindow) -> Result<(), OperationError> {
        let Some(native_session) = window.native_session_id().map(str::to_owned) else { return Ok(()); };
        let mut queried = false;
        for message in window.messages_mut() {
            if !message.truncated() || message.large_text().is_some() || message.hidden_control_reply() || message.display_item_id().is_some()
                || !matches!(message.role(), MessageRole::User | MessageRole::Assistant) { continue; }
            let Some(message_id) = message.identity_message_id() else { continue; };
            queried = true;
            let Ok(full) = self.message_text(identity, message_id).await else { continue; };
            if Some(full.sequence) != message.identity_sequence() { continue; }
            let Some(content_ref) = content_ref(identity, &native_session, message_id, &full) else { continue; };
            let end = byte_end(&full.text, PREFIX_BYTES);
            let facts = LargeTextFacts { text: full.text[..end].to_owned(), content_ref, total_bytes: full.text.len() as u64, loaded_bytes: end as u64 };
            *message = message.clone().with_large_text(facts);
        }
        if queried {
            let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| OperationError::Rejected)?;
            let row = self.describe_session(SessionDescribeParams::new(key, Some(&identity.agent_id))).await?.ok_or(OperationError::Rejected)?;
            if row.key.as_deref() != Some(identity.session_key.as_str()) || row.agent_id.as_ref().map(|id| id.as_str()) != Some(identity.agent_id.as_str())
                || row.session_id.as_deref() != Some(native_session.as_str()) { return Err(OperationError::Rejected); }
        }
        Ok(())
    }

    pub(crate) async fn load_content(&self, command: ContentCommand) -> ContentOutcome {
        use crate::port::validate_observation_identity;
        if validate_observation_identity(command.identity()).is_err() { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); }
        let Some(reference) = ContentReference::decode(command.content_ref()) else { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); };
        if reference.identity != digest_identity(command.identity()) { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); }
        let Ok(key) = SessionKey::try_new(command.session_key().to_owned()) else { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); };
        let full = match self.message_text(command.identity(), &reference.message_id).await {
            Ok(full) => full,
            Err(_) => return ContentOutcome::unavailable(UnavailableReason::RuntimeUnavailable),
        };
        if full.sequence != reference.sequence || digest(&full.text) != reference.text {
            return ContentOutcome::unavailable(UnavailableReason::RuntimeUnavailable);
        }
        let row = match self.describe_session(SessionDescribeParams::new(key, command.agent_id())).await {
            Ok(Some(row)) => row,
            _ => return ContentOutcome::unavailable(UnavailableReason::RuntimeUnavailable),
        };
        if row.key.as_deref() != Some(command.session_key()) || row.agent_id.as_ref().map(|id| id.as_str()) != command.agent_id()
            || row.session_id.as_deref().map(digest) != Some(reference.native_session)
            || command.endpoint_session_id().is_some_and(|id| row.session_id.as_deref() != Some(id)) {
            return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected);
        }
        let Ok(offset) = usize::try_from(command.offset()) else { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); };
        if offset > full.text.len() || !full.text.is_char_boundary(offset) { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); }
        let end = byte_end(&full.text, offset.saturating_add(command.limit()));
        if end == offset && offset < full.text.len() { return ContentOutcome::unavailable(UnavailableReason::RuntimeTargetRejected); }
        ContentOutcome::Complete(ContentChunk { content_ref: command.content_ref().to_owned(), offset: command.offset(), text: full.text[offset..end].to_owned(), next_offset: end as u64, total_bytes: full.text.len() as u64, complete: end == full.text.len() })
    }
}

fn byte_end(text: &str, limit: usize) -> usize {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) { end -= 1; }
    end
}

fn digest(text: &str) -> [u8; 32] { Sha256::digest(text.as_bytes()).into() }

fn digest_identity(identity: &SessionIdentity) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(identity).expect("session identity serializes")).into()
}

fn content_ref(identity: &SessionIdentity, native_session: &str, message_id: &str, full: &CompleteText) -> Option<String> {
    if message_id.is_empty() || message_id.len() > 256 || message_id.chars().any(char::is_control) { return None; }
    let mut bytes = Vec::with_capacity(REF_HEADER_BYTES + message_id.len());
    bytes.extend_from_slice(&digest_identity(identity));
    bytes.extend_from_slice(&digest(native_session));
    bytes.extend_from_slice(&digest(&full.text));
    bytes.extend_from_slice(&full.sequence.to_be_bytes());
    bytes.extend_from_slice(message_id.as_bytes());
    Some(format!("{REF_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

struct ContentReference {
    identity: [u8; 32],
    native_session: [u8; 32],
    text: [u8; 32],
    sequence: u64,
    message_id: String,
}

impl ContentReference {
    fn decode(value: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(value.strip_prefix(REF_PREFIX)?).ok()?;
        if bytes.len() <= REF_HEADER_BYTES || bytes.len() > REF_HEADER_BYTES + 256 { return None; }
        let message_id = String::from_utf8(bytes[REF_HEADER_BYTES..].to_vec()).ok()?;
        if message_id.chars().any(char::is_control) { return None; }
        Some(Self { identity: bytes[..32].try_into().ok()?, native_session: bytes[32..64].try_into().ok()?, text: bytes[64..96].try_into().ok()?, sequence: u64::from_be_bytes(bytes[96..104].try_into().ok()?), message_id })
    }
}
