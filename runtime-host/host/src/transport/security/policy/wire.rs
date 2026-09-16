use std::io;

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::transport::sessions::trace as session_trace;

const MAX_REQUEST_BYTES: usize = 72 * 1024;
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    authorization
        .and_then(|value| value.strip_prefix(BEARER_PREFIX))
        .filter(|value| !value.is_empty())
}

pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) authorization: Option<String>,
    pub(crate) trace_id: Option<String>,
    pub(crate) body: Vec<u8>,
}

pub(crate) async fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
        if bytes.len() > 8192 {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
    };
    let (method, path, length, authorization, trace_id, content_type) = {
        let header = std::str::from_utf8(&bytes[..header_end])
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let mut lines = header.split("\r\n");
        let start = lines
            .next()
            .ok_or(io::Error::from(io::ErrorKind::InvalidData))?;
        let mut parts = start.split_whitespace();
        let (Some(method), Some(path), Some("HTTP/1.1"), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        };
        let mut length = None;
        let mut authorization = None;
        let mut trace_id = None;
        let mut content_type = false;
        for line in lines.filter(|line| !line.is_empty()) {
            let Some((name, value)) = line.split_once(':') else {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            };
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "content-length" => length = value.parse::<usize>().ok(),
                "authorization" => authorization = Some(value.into()),
                "content-type" => content_type = value == "application/json",
                _ if name == session_trace::HEADER => {
                    if !value.is_empty()
                        && value.len() <= 256
                        && !value.chars().any(char::is_control)
                    {
                        trace_id = Some(value.into());
                    }
                }
                _ => {}
            }
        }
        (
            method.to_owned(),
            path.to_owned(),
            length,
            authorization,
            trace_id,
            content_type,
        )
    };
    if method == "GET" {
        if length.is_some_and(|length| length != 0) || bytes.len() != header_end {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        return Ok(Request {
            method,
            path,
            authorization,
            trace_id,
            body: Vec::new(),
        });
    }
    let Some(length) = length else {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    };
    if !content_type || length > MAX_REQUEST_BYTES - header_end {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    while bytes.len() < header_end + length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_REQUEST_BYTES {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + length {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(Request {
        method,
        path,
        authorization,
        trace_id,
        body: bytes[header_end..].to_vec(),
    })
}

pub(crate) async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: &Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(body).expect("security response serializable");
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        422 => "Unprocessable Content",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                status,
                reason,
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}
