use std::time::Duration;

use reqwest::{StatusCode, header::CONTENT_TYPE, redirect::Policy};

use super::client::GatewayClient;

pub(crate) const MAX_NATIVE_MEDIA_BYTES: usize = 2 * 1024 * 1024;
const ASSISTANT_MEDIA_PATH: &str = "/__openclaw__/assistant-media";

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

impl GatewayClient {
    // The caller must first verify this source against the current native session/message/fact.
    pub(crate) async fn read_session_media(
        &self,
        session_key: &str,
        agent_id: &str,
        source: &str,
    ) -> Result<NativeMedia, NativeMediaError> {
        let id = source
            .strip_prefix("media://inbound/")
            .ok_or(NativeMediaError::Invalid)?;
        if session_key.trim().is_empty()
            || agent_id.trim().is_empty()
            || id.is_empty()
            || source.len() > 8 * 1024
            || source.chars().any(char::is_control)
        {
            return Err(NativeMediaError::Invalid);
        }

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| NativeMediaError::Unavailable)?;
        let request = client
            .get(format!("{}{ASSISTANT_MEDIA_PATH}", self.http_origin()))
            .query(&[
                ("source", source),
                ("sessionKey", session_key),
                ("agentId", agent_id),
            ]);
        let mut response = self
            .authenticate_media_request(request)
            .map_err(|_| NativeMediaError::Unavailable)?
            .send()
            .await
            .map_err(|_| NativeMediaError::Unavailable)?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::PAYLOAD_TOO_LARGE => return Err(NativeMediaError::TooLarge),
            _ => return Err(NativeMediaError::Unavailable),
        }

        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > MAX_NATIVE_MEDIA_BYTES as u64) {
            return Err(NativeMediaError::TooLarge);
        }
        let mime_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .ok_or(NativeMediaError::Unavailable)?
            .trim()
            .to_ascii_lowercase();
        if !mime_type
            .strip_prefix("image/")
            .is_some_and(|subtype| !subtype.is_empty() && !subtype.contains(char::is_whitespace))
        {
            return Err(NativeMediaError::Unavailable);
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NativeMediaError::Unavailable)?
        {
            if chunk.len() > MAX_NATIVE_MEDIA_BYTES - bytes.len() {
                return Err(NativeMediaError::TooLarge);
            }
            bytes
                .try_reserve_exact(chunk.len())
                .map_err(|_| NativeMediaError::Unavailable)?;
            bytes.extend_from_slice(&chunk);
        }
        let size_bytes = bytes.len() as u64;
        if bytes.is_empty() || content_length.is_some_and(|length| length != size_bytes) {
            return Err(NativeMediaError::Unavailable);
        }
        Ok(NativeMedia {
            bytes,
            size_bytes,
            mime_type,
        })
    }
}
