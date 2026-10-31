use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{StatusCode, header::CONTENT_TYPE, redirect::Policy};
use workspace_module::session_images::SessionImageFailure;

use super::client::GatewayClient;
use crate::session::operation::artifacts::{MAX_IMAGE_BYTES, image_mime, managed_attachment};

impl GatewayClient {
    pub(crate) async fn read_artifact_image(
        &self,
        session_key: &str,
        reference: &str,
        locator: &str,
    ) -> Result<(Vec<u8>, String), SessionImageFailure> {
        let url = artifact_url(&self.http_origin(), session_key, reference, locator)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| SessionImageFailure::Unavailable)?;
        // The exact-resource ticket owns authorization; never forward the private bearer.
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| SessionImageFailure::Unavailable)?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::NOT_FOUND => return Err(SessionImageFailure::InvalidReference),
            StatusCode::PAYLOAD_TOO_LARGE => return Err(SessionImageFailure::TooLarge),
            _ => return Err(SessionImageFailure::Unavailable),
        }
        let length = response.content_length();
        if length.is_some_and(|length| length > MAX_IMAGE_BYTES as u64) {
            return Err(SessionImageFailure::TooLarge);
        }
        let mime = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or(SessionImageFailure::Unavailable)?;
        if !mime
            .split(';')
            .next()
            .is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("image/"))
        {
            return Err(SessionImageFailure::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| SessionImageFailure::Unavailable)?
        {
            if chunk.len() > MAX_IMAGE_BYTES - bytes.len() {
                return Err(SessionImageFailure::TooLarge);
            }
            bytes
                .try_reserve_exact(chunk.len())
                .map_err(|_| SessionImageFailure::Unavailable)?;
            bytes.extend_from_slice(&chunk);
        }
        if length.is_some_and(|length| length != bytes.len() as u64) {
            return Err(SessionImageFailure::Unavailable);
        }
        let mime = image_mime(&bytes, Some(&mime))?;
        Ok((bytes, mime))
    }
}

fn artifact_url(
    origin: &str,
    session_key: &str,
    reference: &str,
    locator: &str,
) -> Result<reqwest::Url, SessionImageFailure> {
    if !locator.starts_with('/')
        || locator.starts_with("//")
        || locator.contains(['\\', '#'])
        || locator.chars().any(char::is_control)
    {
        return Err(SessionImageFailure::InvalidReference);
    }
    let origin = reqwest::Url::parse(origin).map_err(|_| SessionImageFailure::Unavailable)?;
    let url = origin
        .join(locator)
        .map_err(|_| SessionImageFailure::InvalidReference)?;
    let valid = if let Some(attachment) = managed_attachment(reference) {
        let path = format!(
            "/api/chat/media/outgoing/{}/{attachment}/full",
            encode_component(session_key)
        );
        let mut query = url.query_pairs();
        url.path() == path
            && query
                .next()
                .is_some_and(|(key, value)| key == "mediaTicket" && valid_managed_ticket(&value))
            && query.next().is_none()
    } else {
        url.path()
            .strip_prefix("/api/artifacts/download/")
            .is_some_and(valid_transcript_ticket)
            && url.query().is_none()
    };
    if !valid
        || url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(SessionImageFailure::InvalidReference);
    }
    Ok(url)
}

fn valid_transcript_ticket(locator: &str) -> bool {
    let Some((connection, ticket)) = locator.split_once('/') else {
        return false;
    };
    !connection.is_empty()
        && connection.len() <= 256
        && connection != "."
        && connection != ".."
        && connection
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
        && ticket.len() == 43
        && URL_SAFE_NO_PAD
            .decode(ticket)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == ticket)
}

fn valid_managed_ticket(ticket: &str) -> bool {
    if ticket.len() > 64 * 1024 {
        return false;
    }
    let Some((payload, signature)) = ticket
        .strip_prefix("v1.")
        .and_then(|value| value.split_once('.'))
    else {
        return false;
    };
    // Native verifies the signature, expiry and resource binding; this only checks wire shape.
    !payload.is_empty()
        && URL_SAFE_NO_PAD.decode(payload).is_ok()
        && signature.len() == 43
        && URL_SAFE_NO_PAD
            .decode(signature)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == signature)
}

fn encode_component(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("write to string");
        }
    }
    encoded
}
