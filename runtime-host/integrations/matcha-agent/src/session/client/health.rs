use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

use super::{AppServerClientError, AppServerEndpoint, REQUEST_DEADLINE};

pub(super) const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub(super) const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;

pub(super) async fn inspect_health(
    endpoint: AppServerEndpoint,
) -> Result<(), AppServerClientError> {
    timeout(REQUEST_DEADLINE, async {
        let mut stream = TcpStream::connect(endpoint.address())
            .await
            .map_err(|_| AppServerClientError::HealthFailed)?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            endpoint.address()
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|_| AppServerClientError::HealthFailed)?;
        let headers = read_headers(&mut stream).await?;
        let body_length = validate_health_response(&headers)?;
        let body = read_body(&mut stream, body_length).await?;
        let health: Health = serde_json::from_slice(&body)
            .map_err(|_| AppServerClientError::HealthFailed)?;
        health
            .ok
            .then_some(())
            .ok_or(AppServerClientError::HealthFailed)
    })
    .await
    .map_err(|_| AppServerClientError::HealthDeadline)?
}

#[derive(Deserialize)]
struct Health {
    ok: bool,
}

#[derive(Clone, Copy)]
pub(super) enum HealthBodyLength {
    Exact(usize),
    UntilEof,
}

pub(super) async fn read_headers(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<Vec<u8>, AppServerClientError> {
    let mut headers = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() == MAX_HTTP_HEADER_BYTES {
            return Err(AppServerClientError::Protocol);
        }
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|_| AppServerClientError::Protocol)?;
        headers.push(byte[0]);
    }
    Ok(headers)
}

pub(super) fn validate_http_response(
    headers: &[u8],
    expected_status: &str,
) -> Result<Option<usize>, AppServerClientError> {
    let headers = std::str::from_utf8(headers).map_err(|_| AppServerClientError::Protocol)?;
    let mut lines = headers.split("\r\n");
    let status = lines.next().ok_or(AppServerClientError::Protocol)?;
    let mut fields = status.split_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.0" | "HTTP/1.1"))
        || fields.next() != Some(expected_status)
    {
        return Err(AppServerClientError::Protocol);
    }
    let mut content_length = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(AppServerClientError::Protocol)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(AppServerClientError::Protocol);
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(AppServerClientError::Protocol);
            }
            content_length = Some(
                value
                    .trim()
                    .parse()
                    .map_err(|_| AppServerClientError::Protocol)?,
            );
        }
    }
    Ok(content_length)
}

pub(super) fn validate_health_response(
    headers: &[u8],
) -> Result<HealthBodyLength, AppServerClientError> {
    match validate_http_response(headers, "200")? {
        Some(length) if length > MAX_HTTP_BODY_BYTES => Err(AppServerClientError::HealthFailed),
        Some(length) => Ok(HealthBodyLength::Exact(length)),
        None => Ok(HealthBodyLength::UntilEof),
    }
}

async fn read_body(
    stream: &mut TcpStream,
    length: HealthBodyLength,
) -> Result<Vec<u8>, AppServerClientError> {
    match length {
        HealthBodyLength::Exact(length) => {
            let mut body = vec![0; length];
            stream
                .read_exact(&mut body)
                .await
                .map_err(|_| AppServerClientError::HealthFailed)?;
            Ok(body)
        }
        HealthBodyLength::UntilEof => {
            let mut body = Vec::with_capacity(1024);
            stream
                .take((MAX_HTTP_BODY_BYTES + 1) as u64)
                .read_to_end(&mut body)
                .await
                .map_err(|_| AppServerClientError::HealthFailed)?;
            if body.len() > MAX_HTTP_BODY_BYTES {
                return Err(AppServerClientError::HealthFailed);
            }
            Ok(body)
        }
    }
}
