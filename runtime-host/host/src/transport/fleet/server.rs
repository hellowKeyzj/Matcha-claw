use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use super::{DecodeError, Delivery, Request, read};
use crate::fleet::handle::FleetHandle;
use crate::transport::common::authorization::CapabilityDecisionVerifier;
use crate::transport::fleet::terminal_stream::ServerDependencies as TerminalServerDependencies;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
    terminal: TerminalServerDependencies,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: FleetHandle,
        terminal: TerminalServerDependencies,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            owner,
            terminal,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let owner = self.owner.clone();
            let terminal = self.terminal.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, owner, terminal).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
    terminal: TerminalServerDependencies,
) -> io::Result<()> {
    let request = match timeout(REQUEST_READ_DEADLINE, read_request(&mut stream)).await {
        Ok(request) => request?,
        Err(_) => return write_response(&mut stream, Response::bad_request()).await,
    };
    if let Ok(request) = &request {
        if is_terminal_route(&request.method, &request.path) {
            let Some(key) = request
                .websocket_key
                .as_deref()
                .filter(|key| !key.is_empty())
            else {
                return crate::transport::fleet::terminal_stream::write_http_error(
                    &mut stream,
                    400,
                    "invalid terminal websocket upgrade",
                )
                .await;
            };
            if !request.websocket {
                return crate::transport::fleet::terminal_stream::write_http_error(
                    &mut stream,
                    400,
                    "invalid terminal websocket upgrade",
                )
                .await;
            }
            return crate::transport::fleet::terminal_stream::serve_upgrade(
                stream,
                request.path.clone(),
                key.to_owned(),
                true,
                terminal,
            )
            .await;
        }
    }
    let response = match request {
        Ok(request) => handle(request, verifier, owner).await,
        Err(response) => response,
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: HttpRequest,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
) -> Response {
    if request.path == "/api/remote-fleet/runtime-agent/ingress" {
        return match super::runtime_agent_ingress::handle(
            &request.method,
            &request.path,
            &request.headers,
            &request.body,
            &owner,
        )
        .await
        {
            Some((status, body)) => Response { status, body },
            None => Response::not_found(),
        };
    }
    if !is_fleet_route(&request.method, &request.path) {
        return Response::not_found();
    }
    let Some(authorization) = bearer_authorization(&request.headers) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match Request::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(read(&owner, request).await)
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    websocket: bool,
    websocket_key: Option<String>,
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Fleet request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Fleet authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Fleet route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<HttpRequest, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            let header_end = end + 4;
            if header_end > MAX_HEADER_BYTES {
                return Ok(Err(Response::bad_request()));
            }
            break header_end;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Ok(Err(Response::bad_request()));
        }
    };
    let headers = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(value) => value.to_owned(),
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = headers.split("\r\n");
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
    let mut parsed_headers = Vec::new();
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
            || parsed_headers.len() == MAX_HEADERS
            || parsed_headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        parsed_headers.push((name, value));
    }
    let has_websocket_upgrade = parsed_headers
        .iter()
        .any(|(name, value)| name == "upgrade" && value.eq_ignore_ascii_case("websocket"));
    let has_connection_upgrade = parsed_headers.iter().any(|(name, value)| {
        name == "connection"
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    });
    let has_websocket_version = parsed_headers
        .iter()
        .any(|(name, value)| name == "sec-websocket-version" && value.trim() == "13");
    let websocket = has_websocket_upgrade && has_connection_upgrade && has_websocket_version;
    let websocket_key = parsed_headers
        .iter()
        .find(|(name, _)| name == "sec-websocket-key")
        .map(|(_, value)| value.clone());
    // WebSocket upgrades have no HTTP request body and therefore normally omit
    // Content-Length. Keep the upgrade on this same active Fleet listener.
    if is_terminal_route(method, path) {
        if !websocket {
            return Ok(Err(Response::bad_request()));
        }
        return Ok(Ok(HttpRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: parsed_headers,
            body: Vec::new(),
            websocket,
            websocket_key,
        }));
    }
    let Some(content_length) = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length > MAX_REQUEST_BYTES || header_end + content_length > MAX_REQUEST_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_REQUEST_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + content_length {
        return Ok(Err(Response::bad_request()));
    }
    Ok(Ok(HttpRequest {
        method: method.to_owned(),
        path: path.to_owned(),
        websocket,
        websocket_key: parsed_headers
            .iter()
            .find(|(name, _)| name == "sec-websocket-key")
            .map(|(_, value)| value.clone()),
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("Fleet response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

fn is_fleet_route(method: &str, path: &str) -> bool {
    method == "POST" && path == "/api/fleet"
}

pub(super) fn is_terminal_route(method: &str, path: &str) -> bool {
    method == "GET"
        && (path == crate::transport::fleet::terminal_stream::TERMINAL_WEBSOCKET_PATH
            || path == crate::transport::fleet::terminal_stream::PRIVATE_TERMINAL_WEBSOCKET_PATH)
}

fn bearer_authorization(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn route_and_authorization_are_exact() {
        assert!(is_fleet_route("POST", "/api/fleet"));
        assert!(!is_fleet_route("GET", "/api/fleet"));
        assert!(!is_fleet_route("POST", "/api/remote-fleet"));
        let headers = vec![("authorization".to_owned(), "Bearer decision".to_owned())];
        assert_eq!(bearer_authorization(&headers), Some("decision"));
        assert!(
            bearer_authorization(&[("authorization".to_owned(), "Basic x".to_owned())]).is_none()
        );
    }

    #[tokio::test]
    async fn write_response_uses_status_reason_phrases() {
        for (status, reason) in [
            (405_u16, "Method Not Allowed"),
            (409, "Conflict"),
            (413, "Payload Too Large"),
            (422, "Unprocessable Entity"),
            (503, "Service Unavailable"),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind test listener");
            let address = listener.local_addr().expect("test listener address");
            let mut client = TcpStream::connect(address)
                .await
                .expect("connect test listener");
            let (mut stream, _) = listener.accept().await.expect("accept test connection");
            write_response(
                &mut stream,
                Response {
                    status,
                    body: serde_json::json!({ "success": false }),
                },
            )
            .await
            .expect("write response");
            drop(stream);

            let mut response = String::new();
            client
                .read_to_string(&mut response)
                .await
                .expect("read response");
            assert!(
                response.starts_with(&format!("HTTP/1.1 {status} {reason}\r\n")),
                "unexpected status line for {status}: {response:?}"
            );
            assert!(
                !response.starts_with(&format!("HTTP/1.1 {status} Internal Server Error\r\n")),
                "status {status} used fallback reason phrase"
            );
        }
    }

    #[tokio::test]
    async fn request_body_limit_is_enforced_before_reading_body() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind test listener");
        let address = listener.local_addr().expect("test listener address");
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address)
                .await
                .expect("connect test listener");
            let request = format!(
                "POST /api/fleet HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
                MAX_REQUEST_BYTES + 1
            );
            stream
                .write_all(request.as_bytes())
                .await
                .expect("write test request");
        });
        let (mut stream, _) = listener.accept().await.expect("accept test connection");
        assert!(matches!(
            read_request(&mut stream).await.expect("read request"),
            Err(_)
        ));
        client.await.expect("client task");
    }
}
