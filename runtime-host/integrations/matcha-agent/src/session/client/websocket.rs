use std::sync::atomic::{Ordering, compiler_fence};

use tokio::{io::AsyncWriteExt, net::TcpStream, time::timeout};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
    },
};

use crate::lifecycle::secret::Secret;

use super::{
    AppServerClientError, AppServerEndpoint, REQUEST_DEADLINE,
    health::{read_headers, validate_http_response},
};

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 1024 * 1024;

pub(super) type AppServerSocket = WebSocketStream<TcpStream>;

pub(super) async fn connect(
    endpoint: AppServerEndpoint,
    secret: &Secret,
) -> Result<AppServerSocket, AppServerClientError> {
    let mut stream = timeout(REQUEST_DEADLINE, TcpStream::connect(endpoint.address()))
        .await
        .map_err(|_| AppServerClientError::UpgradeDeadline)?
        .map_err(|_| AppServerClientError::UpgradeFailed)?;
    let key = generate_key();
    let expected_accept = derive_accept_key(key.as_bytes());
    let token = secret.issue_bearer_token();
    let request = SensitiveRequest(format!(
        "GET /ws HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nAuthorization: Bearer {}\r\n\r\n",
        endpoint.websocket_authority(),
        token.as_str()
    ));
    drop(token);
    timeout(REQUEST_DEADLINE, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| AppServerClientError::UpgradeDeadline)?
        .map_err(|_| AppServerClientError::UpgradeFailed)?;

    let headers = timeout(REQUEST_DEADLINE, read_headers(&mut stream))
        .await
        .map_err(|_| AppServerClientError::UpgradeDeadline)??;
    validate_upgrade(&headers, &expected_accept)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES));
    Ok(WebSocketStream::from_raw_socket(stream, Role::Client, Some(config)).await)
}

fn validate_upgrade(headers: &[u8], expected_accept: &str) -> Result<(), AppServerClientError> {
    validate_http_response(headers, "101")?;
    let headers = std::str::from_utf8(headers).map_err(|_| AppServerClientError::UpgradeFailed)?;
    let has_upgrade = headers.split("\r\n").any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    });
    let has_connection = headers.split("\r\n").any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("connection")
                && value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
    });
    let has_accept = headers.split("\r\n").any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("sec-websocket-accept") && value.trim() == expected_accept
        })
    });
    (has_upgrade && has_connection && has_accept)
        .then_some(())
        .ok_or(AppServerClientError::UpgradeFailed)
}

struct SensitiveRequest(String);

impl SensitiveRequest {
    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl Drop for SensitiveRequest {
    fn drop(&mut self) {
        clear_string(self.0.as_mut_str());
    }
}

fn clear_string(value: &mut str) {
    // SAFETY: replacing UTF-8 bytes with NUL preserves valid UTF-8.
    for byte in unsafe { value.as_bytes_mut() } {
        // SAFETY: `byte` is uniquely borrowed from this allocation.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}
