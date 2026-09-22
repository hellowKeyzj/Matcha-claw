use std::io;

use platform::loopback::{BodyPolicy, Request, RequestHead, Response};
use tokio::{io::AsyncReadExt, net::TcpStream};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;

pub(super) struct RequestParts {
    pub(super) head: RequestHead,
    buffered_body: Vec<u8>,
}

pub(super) async fn read_head(
    stream: &mut TcpStream,
) -> io::Result<Result<RequestParts, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        if bytes.len() + read > MAX_HEADER_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let header = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(value) => value,
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = header.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(Err(Response::bad_request()));
    };
    let mut start = start.split_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (start.next(), start.next(), start.next(), start.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(Response::bad_request()));
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(Response::bad_request()));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if name.is_empty()
            || headers.len() == MAX_HEADERS
            || headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        headers.push((name, value));
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let websocket = has_websocket_upgrade(&headers);
    let websocket_key = headers
        .iter()
        .find(|(name, _)| name == "sec-websocket-key")
        .map(|(_, value)| value.clone());
    Ok(Ok(RequestParts {
        head: RequestHead::new(
            method.to_owned(),
            path.to_owned(),
            headers,
            websocket,
            websocket_key,
            content_length,
        ),
        buffered_body: bytes[header_end..].to_vec(),
    }))
}

pub(super) async fn finish_request(
    stream: &mut TcpStream,
    mut parts: RequestParts,
    policy: BodyPolicy,
) -> io::Result<Result<Request, Response>> {
    let content_length = match (policy, parts.head.content_length()) {
        (BodyPolicy::Empty, Some(0) | None) => 0,
        (BodyPolicy::Empty, Some(_)) => return Ok(Err(Response::bad_request())),
        (BodyPolicy::Optional { max_bytes }, Some(length)) if length <= max_bytes => length,
        (BodyPolicy::Optional { .. }, Some(_)) => return Ok(Err(Response::bad_request())),
        (BodyPolicy::Optional { .. }, None) => 0,
        (BodyPolicy::Required { max_bytes }, Some(length)) if length <= max_bytes => length,
        (BodyPolicy::Required { .. }, Some(_)) => return Ok(Err(Response::bad_request())),
        (BodyPolicy::Required { .. }, None) => return Ok(Err(Response::bad_request())),
    };
    if parts.buffered_body.len() > content_length {
        return Ok(Err(Response::bad_request()));
    }
    let mut buffer = [0_u8; 8192];
    while parts.buffered_body.len() < content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || parts.buffered_body.len() + read > content_length {
            return Ok(Err(Response::bad_request()));
        }
        parts.buffered_body.extend_from_slice(&buffer[..read]);
    }
    Ok(Ok(Request {
        head: parts.head,
        body: parts.buffered_body,
    }))
}

fn has_websocket_upgrade(headers: &[(String, String)]) -> bool {
    let has_upgrade = headers
        .iter()
        .any(|(name, value)| name == "upgrade" && value.eq_ignore_ascii_case("websocket"));
    let has_connection_upgrade = headers.iter().any(|(name, value)| {
        name == "connection"
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    });
    let has_websocket_version = headers
        .iter()
        .any(|(name, value)| name == "sec-websocket-version" && value.trim() == "13");
    has_upgrade && has_connection_upgrade && has_websocket_version
}
