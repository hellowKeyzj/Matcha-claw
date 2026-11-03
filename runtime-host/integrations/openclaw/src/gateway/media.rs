use std::time::Duration;

use reqwest::{StatusCode, header::CONTENT_TYPE, redirect::Policy};
use serde_json::{Value, json};

use super::{artifacts::artifact_url, client::GatewayClient, wire::{self, GatewayResponse}};

// Bounds buffered resource transport, not OpenClaw's native upload/download policy.
pub(crate) const MAX_NATIVE_MEDIA_BYTES: usize = 100 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 8 * 1024;
const MAX_METADATA_BYTES: usize = 128 * 1024;
const ASSISTANT_MEDIA_PATH: &str = "/__openclaw__/assistant-media";
const OUTGOING_MEDIA_PREFIX: &str = "api/chat/media/outgoing/";
const MEDIA_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum MediaRendition { Original, Thumbnail, Playback }

pub(crate) struct NativeMedia {
    pub(crate) bytes: Vec<u8>,
    pub(crate) size_bytes: u64,
    pub(crate) mime_type: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeMediaError {
    Invalid,
    Unavailable,
    TooLarge,
}

pub(crate) fn outgoing_media_path(source: &str, rendition: MediaRendition) -> Option<String> {
    let path = source.strip_prefix('/').unwrap_or(source);
    let mut parts = path.strip_prefix(OUTGOING_MEDIA_PREFIX)?.split('/');
    let owner = parts.next().filter(|owner| !owner.is_empty())?;
    let attachment = parts.next()?;
    let variant = parts.next()?;
    if parts.next().is_some() || !matches!(variant, "full" | "thumbnail")
        || owner.contains(['\\', '?', '#'])
        || attachment.len() != 36
        || !attachment.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        })
        || attachment.as_bytes()[14] != b'4'
        || !matches!(attachment.as_bytes()[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
    {
        return None;
    }
    let variant = match rendition { MediaRendition::Original | MediaRendition::Playback => "full", MediaRendition::Thumbnail => "thumbnail" };
    Some(format!("/{OUTGOING_MEDIA_PREFIX}{owner}/{attachment}/{variant}"))
}

pub(crate) fn readable_media_source(source: &str) -> bool {
    if source.is_empty() || source.len() > MAX_SOURCE_BYTES || source.trim() != source
        || source.chars().any(char::is_control) {
        return false;
    }
    if outgoing_media_path(source, MediaRendition::Original).is_some() { return true; }
    if source.starts_with("/api/chat/media/outgoing/") || source.starts_with(OUTGOING_MEDIA_PREFIX)
        || source.starts_with("/__openclaw__/") || source.starts_with("/media/") {
        return false;
    }
    if let Some(id) = source.strip_prefix("media://inbound/") {
        return !id.is_empty() && !matches!(id, "." | "..") && !id.contains(['/', '\\', '?', '#']);
    }
    if source.starts_with("file:") || source.starts_with('~') || source.starts_with('/') {
        return true;
    }
    let bytes = source.as_bytes();
    matches!(bytes, [drive, b':', b'/' | b'\\', ..] if drive.is_ascii_alphabetic())
        || !source.contains(':')
}

impl GatewayClient {
    // The caller binds this source to the current native session/message/source slot.
    pub(crate) async fn read_session_media(
        &self,
        session_key: &str,
        agent_id: &str,
        source: &str,
        image: bool,
        rendition: MediaRendition,
    ) -> Result<NativeMedia, NativeMediaError> {
        if session_key.trim().is_empty() || agent_id.trim().is_empty() || !readable_media_source(source) {
            return Err(NativeMediaError::Invalid);
        }
        // Tickets, native preparation, polling and byte transfer share one bounded budget.
        tokio::time::timeout(MEDIA_DEADLINE, async {
            let client = reqwest::Client::builder()
                .no_proxy().redirect(Policy::none()).timeout(MEDIA_DEADLINE)
                .build().map_err(|_| NativeMediaError::Unavailable)?;
            let mut url = if let Some(path) = outgoing_media_path(source, MediaRendition::Original) {
                let attachment = path.rsplit('/').nth(1).ok_or(NativeMediaError::Invalid)?;
                let family = if image { "image" } else { "media" };
                let reference = format!("artifact_managed_{family}_{attachment}");
                let id = "session-media-download";
                let request = wire::rpc_request(id.to_owned(), "artifacts.download", Some(json!({
                    "sessionKey": session_key, "agentId": agent_id, "artifactId": reference,
                }))).map_err(|_| NativeMediaError::Unavailable)?;
                let response = self.query_artifact(request).await.map_err(|_| NativeMediaError::Unavailable)?;
                if response.request_id() != id { return Err(NativeMediaError::Unavailable); }
                let GatewayResponse::Success { payload: Some(download), .. } = response else {
                    return Err(NativeMediaError::Unavailable);
                };
                if download.pointer("/artifact/id").and_then(Value::as_str) != Some(reference.as_str())
                    || download.pointer("/artifact/sessionKey").and_then(Value::as_str) != Some(session_key)
                    || download.pointer("/artifact/download/mode").and_then(Value::as_str) != Some("url")
                    || download.get("data").is_some() || download.get("encoding").is_some()
                    || !download.get("expiresAt").and_then(Value::as_str).is_some_and(valid_expiry) {
                    return Err(NativeMediaError::Unavailable);
                }
                let locator = download.get("url").and_then(Value::as_str).ok_or(NativeMediaError::Unavailable)?;
                let mut url = artifact_url(&self.http_origin(), session_key, &reference, locator)
                    .map_err(|_| NativeMediaError::Invalid)?;
                if url.path() != path { return Err(NativeMediaError::Invalid); }
                if rendition == MediaRendition::Thumbnail {
                    url.set_path(&outgoing_media_path(source, rendition).ok_or(NativeMediaError::Invalid)?);
                }
                url
            } else {
                let mut url = reqwest::Url::parse(&format!("{}{ASSISTANT_MEDIA_PATH}", self.http_origin()))
                    .map_err(|_| NativeMediaError::Unavailable)?;
                url.query_pairs_mut().extend_pairs([("source", source), ("sessionKey", session_key), ("agentId", agent_id)]);
                let mut metadata_url = url.clone();
                metadata_url.query_pairs_mut().append_pair("meta", "1");
                let response = self.authenticate_media_request(client.get(metadata_url))
                    .map_err(|_| NativeMediaError::Unavailable)?.send().await.map_err(|_| NativeMediaError::Unavailable)?;
                if response.status() != StatusCode::OK { return Err(NativeMediaError::Unavailable); }
                let metadata: Value = serde_json::from_slice(&read_bytes(response, MAX_METADATA_BYTES).await?)
                    .map_err(|_| NativeMediaError::Unavailable)?;
                if metadata.get("available").and_then(Value::as_bool) != Some(true)
                    || !metadata.get("mediaTicketExpiresAt").and_then(Value::as_str).is_some_and(valid_expiry) {
                    return Err(NativeMediaError::Unavailable);
                }
                let ticket = metadata.get("mediaTicket").and_then(Value::as_str)
                    .filter(|ticket| !ticket.is_empty() && ticket.len() <= 64 * 1024 && !ticket.chars().any(char::is_control))
                    .ok_or(NativeMediaError::Unavailable)?;
                // Native revalidates the ticket's exact source/session/agent and current read policy.
                url.query_pairs_mut().append_pair("mediaTicket", ticket);
                url
            };
            if rendition == MediaRendition::Playback { url.query_pairs_mut().append_pair("playback", "1"); }
            let mut attempt = 0;
            loop {
                // Resource URLs carry native tickets, never the Gateway bearer token.
                let response = client.get(url.clone()).send().await.map_err(|_| NativeMediaError::Unavailable)?;
                match response.status() {
                    StatusCode::OK => {}
                    StatusCode::ACCEPTED if rendition == MediaRendition::Playback => {
                        drop(response);
                        // Same native consumer backoff; the enclosing deadline stops at 30 seconds.
                        let seconds = [2, 4, 8, 16, 30][attempt.min(4)];
                        attempt += 1;
                        tokio::time::sleep(Duration::from_secs(seconds)).await;
                        continue;
                    }
                    StatusCode::PAYLOAD_TOO_LARGE => return Err(NativeMediaError::TooLarge),
                    _ => return Err(NativeMediaError::Unavailable),
                }
                let mime_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split(';').next()).map(str::trim)
                    .filter(|value| !value.is_empty()).unwrap_or("application/octet-stream").to_ascii_lowercase();
                if rendition == MediaRendition::Playback && !mime_type.starts_with("audio/") && !mime_type.starts_with("video/") {
                    return Err(NativeMediaError::Unavailable);
                }
                let bytes = read_bytes(response, MAX_NATIVE_MEDIA_BYTES).await?;
                return Ok(NativeMedia { size_bytes: bytes.len() as u64, bytes, mime_type });
            }
        }).await.map_err(|_| NativeMediaError::Unavailable)?
    }
}

fn valid_expiry(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

async fn read_bytes(mut response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, NativeMediaError> {
    let content_length = response.content_length();
    if content_length.is_some_and(|length| length > max_bytes as u64) { return Err(NativeMediaError::TooLarge); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NativeMediaError::Unavailable)? {
        if chunk.len() > max_bytes - bytes.len() { return Err(NativeMediaError::TooLarge); }
        bytes.try_reserve_exact(chunk.len()).map_err(|_| NativeMediaError::Unavailable)?;
        bytes.extend_from_slice(&chunk);
    }
    if content_length.is_some_and(|length| length != bytes.len() as u64) { return Err(NativeMediaError::Unavailable); }
    Ok(bytes)
}
