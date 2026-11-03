use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{StatusCode, header::CONTENT_TYPE, redirect::Policy};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use workspace_module::session_images::SessionImageFailure;

use super::{
    client::{GatewayClient, GatewayClientError, RPC_DEADLINE, close_quietly, exchange},
    wire,
};
use crate::session::operation::artifacts::{MAX_IMAGE_BYTES, image_mime, managed_attachment};

// A 50 MiB original expands to base64; leave bounded room for native metadata/envelope.
const MAX_DOWNLOAD_RESPONSE_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1024 * 1024;

impl GatewayClient {
    pub(crate) async fn query_artifact(
        &self,
        request: wire::RpcRequest,
    ) -> Result<wire::GatewayResponse, GatewayClientError> {
        let config = match request.method() {
            "artifacts.list" => WebSocketConfig::default(),
            "artifacts.download" => WebSocketConfig::default()
                .max_message_size(Some(MAX_DOWNLOAD_RESPONSE_BYTES))
                .max_frame_size(Some(MAX_DOWNLOAD_RESPONSE_BYTES)),
            _ => return Err(GatewayClientError::Protocol),
        };
        // Keep large replies and transport failures off the shared control connection.
        let (mut socket, _) = self
            .connect_with_hello_config(&["operator.read"], config)
            .await?;
        let result = timeout(RPC_DEADLINE, exchange(&mut socket, &request))
            .await
            .map_err(|_| GatewayClientError::RpcDeadline)
            .and_then(|result| result);
        close_quietly(&mut socket).await;
        result
    }

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

pub(crate) fn artifact_url(
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
    let attachment = managed_attachment(reference).ok_or(SessionImageFailure::InvalidReference)?;
    let path = format!(
        "/api/chat/media/outgoing/{}/{attachment}/full",
        encode_component(session_key)
    );
    let mut query = url.query_pairs();
    let valid = url.path() == path
        && query
            .next()
            .is_some_and(|(key, value)| key == "mediaTicket" && valid_managed_ticket(&value))
        && query.next().is_none();
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
