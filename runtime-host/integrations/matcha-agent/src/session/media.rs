use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use sessions_module::state::{
    MAX_SEGMENTS, OmissionReason, SessionContent, public_media_reference,
};
use sha2::{Digest, Sha256};
use workspace_module::WorkspaceMediaFailure;

use super::{history, model::valid_uuid, normalization, rpc::Failure};
use crate::client::Client;

const PREFIX: &str = "ma-media:1:";
const HEADER_BYTES: usize = 72;
const MAX_REFERENCE_BYTES: usize = 512;

#[derive(Clone, Copy)]
pub(crate) enum Body<'a> {
    Base64(&'a str),
    Text(&'a str),
    Url(&'a str),
}

pub(crate) struct Source<'a> {
    pub body: Body<'a>,
    pub mime_type: Option<&'a str>,
    kind: &'a str,
}

impl<'a> Source<'a> {
    pub fn parse(block: &'a Value) -> Option<Self> {
        let kind = block.get("type")?.as_str()?;
        if !matches!(kind, "image" | "document") {
            return None;
        }
        let source = block.get("source")?;
        let mime_type = source.get("media_type").and_then(Value::as_str);
        if mime_type.is_some_and(|mime| {
            mime.is_empty()
                || mime.len() > 128
                || !mime.is_ascii()
                || mime.chars().any(char::is_control)
                || !mime.contains('/')
        }) {
            return None;
        }
        let body = match source.get("type")?.as_str()? {
            "base64" if mime_type.is_some() => Body::Base64(source.get("data")?.as_str()?),
            "text" if kind == "document" => Body::Text(source.get("data")?.as_str()?),
            "url" => Body::Url(source.get("url")?.as_str()?),
            _ => return None,
        };
        Some(Self {
            body,
            mime_type,
            kind,
        })
    }

    pub fn mime_type(&self) -> &str {
        self.mime_type.unwrap_or(match self.body {
            Body::Text(_) => "text/plain",
            _ if self.kind == "image" => "image/*",
            _ => "application/pdf",
        })
    }

    fn digest(&self) -> [u8; 32] {
        let (encoding, value) = match self.body {
            Body::Base64(value) => ("base64", value),
            Body::Text(value) => ("text", value),
            Body::Url(value) => ("url", value),
        };
        let mut digest = Sha256::new();
        for field in [self.kind, self.mime_type(), encoding, value] {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field.as_bytes());
        }
        digest.finalize().into()
    }
}

pub(crate) fn project(
    session_id: &str,
    uuid: &str,
    index: usize,
    nested_index: Option<usize>,
    block: &Value,
) -> SessionContent {
    let omitted = || SessionContent::Omitted {
        reason: OmissionReason::Unknown,
    };
    let Some(source) = Source::parse(block) else {
        return omitted();
    };
    let reference = if let Body::Url(url) = source.body {
        if url.starts_with("http://") || url.starts_with("https://") {
            let Ok(parsed) = reqwest::Url::parse(url) else {
                return omitted();
            };
            if parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return omitted();
            }
            let Some(reference) = public_media_reference(url) else {
                return omitted();
            };
            reference
        } else {
            if workspace_source(url).is_none() {
                return omitted();
            }
            let Some(reference) = reference(session_id, uuid, index, nested_index, &source) else {
                return omitted();
            };
            reference
        }
    } else {
        let Some(reference) = reference(session_id, uuid, index, nested_index, &source) else {
            return omitted();
        };
        reference
    };
    SessionContent::Media {
        media_type: Some(source.mime_type().to_owned()),
        reference,
        file_name: None,
        size_bytes: None,
        resource_id: None,
    }
}

fn reference(
    session_id: &str,
    uuid: &str,
    index: usize,
    nested_index: Option<usize>,
    source: &Source<'_>,
) -> Option<String> {
    if !valid_uuid(session_id)
        || !valid_uuid(uuid)
        || index >= MAX_SEGMENTS
        || nested_index.is_some_and(|index| index >= MAX_SEGMENTS)
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(HEADER_BYTES + uuid.len());
    bytes.extend_from_slice(&Sha256::digest(session_id.as_bytes()));
    bytes.extend_from_slice(&(index as u32).to_be_bytes());
    bytes.extend_from_slice(
        &nested_index
            .map_or(u32::MAX, |index| index as u32)
            .to_be_bytes(),
    );
    bytes.extend_from_slice(&source.digest());
    bytes.extend_from_slice(uuid.as_bytes());
    Some(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

struct Reference {
    session: [u8; 32],
    index: usize,
    nested_index: Option<usize>,
    source: [u8; 32],
    uuid: String,
}

impl Reference {
    fn parse(reference: &str) -> Option<Self> {
        if reference.len() > MAX_REFERENCE_BYTES {
            return None;
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(reference.strip_prefix(PREFIX)?)
            .ok()?;
        if bytes.len() != HEADER_BYTES + 36 {
            return None;
        }
        let uuid = String::from_utf8(bytes[HEADER_BYTES..].to_vec()).ok()?;
        if !valid_uuid(&uuid) {
            return None;
        }
        let index = u32::from_be_bytes(bytes[32..36].try_into().ok()?) as usize;
        let nested = u32::from_be_bytes(bytes[36..40].try_into().ok()?);
        let nested_index = (nested != u32::MAX).then_some(nested as usize);
        if index >= MAX_SEGMENTS || nested_index.is_some_and(|index| index >= MAX_SEGMENTS) {
            return None;
        }
        Some(Self {
            session: bytes[..32].try_into().ok()?,
            index,
            nested_index,
            source: bytes[40..72].try_into().ok()?,
            uuid,
        })
    }
}

pub(crate) fn is_reference(reference: &str) -> bool {
    reference.starts_with(PREFIX)
}

pub(crate) async fn read(
    client: &Client,
    agent_id: &str,
    session_id: &str,
    reference: &str,
) -> Result<Value, WorkspaceMediaFailure> {
    let reference = Reference::parse(reference).ok_or(WorkspaceMediaFailure::InvalidReference)?;
    let session: [u8; 32] = Sha256::digest(session_id.as_bytes()).into();
    if reference.session != session {
        return Err(WorkspaceMediaFailure::InvalidReference);
    }
    let total = history::page(client, session_id, agent_id, 0, 0, None)
        .await
        .map_err(history_failure)?
        .total;
    // Native history pages include every inline source. A batch could exceed the
    // content budget because of unrelated rows and make a valid media ref unreadable.
    for offset in (0..total).rev() {
        let page = history::page(client, session_id, agent_id, offset, 1, None)
            .await
            .map_err(history_failure)?;
        for raw in &page.messages {
            let managed = raw.get("uuid").and_then(Value::as_str).is_some_and(|uuid| {
                page.managed_input_message_ids
                    .iter()
                    .any(|input| input == uuid)
            });
            for mut message in normalization::messages(raw, managed).map_err(history_failure)? {
                if message.row.get("uuid").and_then(Value::as_str) != Some(reference.uuid.as_str())
                {
                    continue;
                }
                let original = message
                    .source
                    .block(reference.index)
                    .map_err(history_failure)?;
                if message.row["type"] == "user"
                    && !matches!(
                        normalization::user_presentation(&message.row, original),
                        normalization::UserPresentation::Content
                    )
                {
                    return Err(WorkspaceMediaFailure::InvalidReference);
                }
                let block = match reference.nested_index {
                    Some(index) if original["type"] == "tool_result" => original
                        .get("content")
                        .and_then(Value::as_array)
                        .and_then(|blocks| blocks.get(index))
                        .ok_or(WorkspaceMediaFailure::InvalidReference)?,
                    Some(_) => return Err(WorkspaceMediaFailure::InvalidReference),
                    None => original,
                };
                let source = Source::parse(block).ok_or(WorkspaceMediaFailure::InvalidReference)?;
                if source.digest() != reference.source {
                    return Err(WorkspaceMediaFailure::InvalidReference);
                }
                let root = if message.row.pointer("/message/content").is_some() {
                    "/message/content"
                } else {
                    "/content"
                };
                let mut pointer = format!("{root}/{}", reference.index);
                if let Some(index) = reference.nested_index {
                    pointer.push_str(&format!("/content/{index}"));
                }
                return message
                    .row
                    .pointer_mut(&pointer)
                    .map(Value::take)
                    .ok_or(WorkspaceMediaFailure::InvalidReference);
            }
        }
    }
    Err(WorkspaceMediaFailure::Unavailable)
}

// Only the existing native file route can turn a URL source into workspace I/O.
pub(crate) fn workspace_source(url: &str) -> Option<(String, String)> {
    if url.contains(['?', '#']) {
        return None;
    }
    let (agent, path) = url.strip_prefix("/files/")?.split_once('/')?;
    let agent = decode_segment(agent)?;
    if !super::model::valid_agent_id(&agent) {
        return None;
    }
    let path = path
        .split('/')
        .map(decode_segment)
        .collect::<Option<Vec<_>>>()?
        .join("/");
    Some((agent, path))
}

fn decode_segment(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(if byte == b'%' {
            (input.next()? as char).to_digit(16)? as u8 * 16
                + (input.next()? as char).to_digit(16)? as u8
        } else {
            byte
        });
    }
    let value = String::from_utf8(bytes).ok()?;
    (!value.is_empty()
        && !matches!(value.as_str(), "." | "..")
        && !value
            .chars()
            .any(|ch| ch.is_control() || "/\\:".contains(ch)))
    .then_some(value)
}

fn history_failure(failure: Failure) -> WorkspaceMediaFailure {
    match failure {
        Failure::InvalidInput => WorkspaceMediaFailure::InvalidReference,
        _ => WorkspaceMediaFailure::Unavailable,
    }
}
