use std::{io, time::Duration};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::broadcast,
    time::{Instant, MissedTickBehavior, interval_at},
};

use crate::sessions::state::SessionDelta;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;

#[derive(Clone, Copy)]
pub(crate) enum BodyPolicy {
    Empty,
    Optional { max_bytes: usize },
    Required { max_bytes: usize },
}

pub(crate) struct RequestHead {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) websocket: bool,
    pub(crate) websocket_key: Option<String>,
    content_length: Option<usize>,
}

impl RequestHead {
    pub(crate) fn bearer_authorization(&self) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .and_then(|(_, value)| value.strip_prefix("Bearer "))
    }
}

pub(crate) struct Request {
    pub(crate) head: RequestHead,
    pub(crate) body: Vec<u8>,
}

impl Request {
    pub(crate) fn method(&self) -> &str {
        &self.head.method
    }

    pub(crate) fn path(&self) -> &str {
        &self.head.path
    }

    pub(crate) fn headers(&self) -> &[(String, String)] {
        &self.head.headers
    }

    pub(crate) fn bearer_authorization(&self) -> Option<&str> {
        self.head.bearer_authorization()
    }
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
    headers: Vec<(String, String)>,
    raw_headers: String,
}

impl Response {
    pub(crate) fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
            raw_headers: String::new(),
        }
    }

    pub(crate) fn error(status: u16, error: &'static str) -> Self {
        Self::json(
            status,
            serde_json::json!({ "success": false, "error": error }),
        )
    }

    pub(crate) fn bad_request() -> Self {
        Self::error(400, "Runtime Host request is invalid")
    }

    pub(crate) fn not_found() -> Self {
        Self::error(404, "Runtime Host route is not available")
    }

    pub(crate) fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub(crate) fn with_raw_headers(mut self, headers: String) -> Self {
        self.raw_headers = headers;
        self
    }
}

pub(crate) struct SseStream {
    receiver: broadcast::Receiver<SessionDelta>,
    keepalive_interval: Duration,
}

impl SseStream {
    pub(crate) fn session_deltas(
        receiver: broadcast::Receiver<SessionDelta>,
        keepalive_interval: Duration,
    ) -> Self {
        Self {
            receiver,
            keepalive_interval,
        }
    }
}

pub(crate) enum Upgrade {
    FleetTerminal {
        path: String,
        key: String,
        websocket: bool,
        terminal: crate::transport::fleet::terminal_stream::ServerDependencies,
    },
}

impl Upgrade {
    async fn serve(self, stream: TcpStream) -> io::Result<()> {
        match self {
            Self::FleetTerminal {
                path,
                key,
                websocket,
                terminal,
            } => {
                crate::transport::fleet::terminal_stream::serve_upgrade(
                    stream, path, key, websocket, terminal,
                )
                .await
            }
        }
    }
}

pub(crate) enum RouteOutcome {
    Response(Response),
    Sse(SseStream),
    Upgrade(Upgrade),
}

impl RouteOutcome {
    pub(crate) async fn write(self, mut stream: TcpStream) -> io::Result<()> {
        match self {
            Self::Response(response) => write_json_response(&mut stream, response).await,
            Self::Sse(streaming) => write_sse_stream(&mut stream, streaming).await,
            Self::Upgrade(upgrade) => upgrade.serve(stream).await,
        }
    }
}

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
        head: RequestHead {
            method: method.to_owned(),
            path: path.to_owned(),
            headers,
            websocket,
            websocket_key,
            content_length,
        },
        buffered_body: bytes[header_end..].to_vec(),
    }))
}

pub(super) async fn finish_request(
    stream: &mut TcpStream,
    mut parts: RequestParts,
    policy: BodyPolicy,
) -> io::Result<Result<Request, Response>> {
    let content_length = match (policy, parts.head.content_length) {
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

async fn write_json_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("localhost response is serializable");
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\n{}{}Content-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason_phrase(response.status),
                response.raw_headers,
                format_headers(&response.headers),
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

async fn write_sse_stream(stream: &mut TcpStream, mut streaming: SseStream) -> io::Result<()> {
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
        )
        .await?;
    stream.flush().await?;
    let mut keepalive = interval_at(
        Instant::now() + streaming.keepalive_interval,
        streaming.keepalive_interval,
    );
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            delta = streaming.receiver.recv() => match delta {
                Ok(delta) => stream.write_all(&session_delta_frame(&delta)).await?,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
            _ = keepalive.tick() => stream.write_all(b":keepalive\n\n").await?,
        }
        stream.flush().await?;
    }
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

fn format_headers(headers: &[(String, String)]) -> String {
    let mut output = String::new();
    for (name, value) in headers {
        output.push_str(name);
        output.push_str(": ");
        output.push_str(value);
        output.push_str("\r\n");
    }
    output
}

fn session_delta_frame(delta: &SessionDelta) -> Vec<u8> {
    let data = serde_json::to_string(delta).expect("session delta SSE data is serializable");
    format!(
        "event: session.delta\nid: {}\ndata: {data}\n\n",
        delta.seq()
    )
    .into_bytes()
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Content",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

#[cfg(test)]
mod tests {
    use std::{io, time::Duration};

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::broadcast,
        time::timeout,
    };

    use super::*;

    #[tokio::test]
    async fn sse_route_outcome_does_not_block_json_route_outcome() {
        let (sender, receiver) = broadcast::channel(1);
        let sse_listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind sse");
        let sse_address = sse_listener.local_addr().expect("sse address");
        let sse_task = tokio::spawn(async move {
            let (stream, _) = sse_listener.accept().await?;
            RouteOutcome::Sse(SseStream::session_deltas(receiver, Duration::from_secs(60)))
                .write(stream)
                .await
        });
        let mut sse_client = TcpStream::connect(sse_address).await.expect("connect sse");
        let sse_head = timeout(Duration::from_secs(1), read_header(&mut sse_client))
            .await
            .expect("sse header deadline")
            .expect("read sse header");
        assert!(String::from_utf8_lossy(&sse_head).contains("Content-Type: text/event-stream"));

        let json_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind json");
        let json_address = json_listener.local_addr().expect("json address");
        let json_task = tokio::spawn(async move {
            let (stream, _) = json_listener.accept().await?;
            RouteOutcome::Response(Response::json(200, serde_json::json!({ "ok": true })))
                .write(stream)
                .await
        });
        let mut json_client = TcpStream::connect(json_address)
            .await
            .expect("connect json");
        json_client.shutdown().await.expect("close json request");
        let mut json_response = Vec::new();
        timeout(
            Duration::from_secs(1),
            json_client.read_to_end(&mut json_response),
        )
        .await
        .expect("json response deadline")
        .expect("read json response");
        assert!(String::from_utf8_lossy(&json_response).contains("{\"ok\":true}"));
        json_task.await.expect("json task").expect("write json");

        drop(sender);
        drop(sse_client);
        timeout(Duration::from_secs(1), sse_task)
            .await
            .expect("sse task deadline")
            .expect("sse task")
            .expect("write sse");
    }

    async fn read_header(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut byte = [0_u8; 1];
        loop {
            stream.read_exact(&mut byte).await?;
            bytes.push(byte[0]);
            if bytes.ends_with(b"\r\n\r\n") {
                return Ok(bytes);
            }
        }
    }
}
