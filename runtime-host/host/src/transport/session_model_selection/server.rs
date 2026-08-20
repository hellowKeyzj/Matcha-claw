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

use crate::transport::authorization::CapabilityDecisionVerifier;

use super::{SessionModelSelectionDelivery, SessionModelSelectionRequest};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const REJECTION_REASON_HEADER: &str = "x-runtime-host-session-model-rejection";
const OPENCLAW_PEER_CODE_HEADER: &str = "x-runtime-host-session-model-openclaw-code";
const OPENCLAW_PEER_MESSAGE_HEADER: &str = "x-runtime-host-session-model-openclaw-message";
const DIAGNOSTIC_ACCOUNT_HEADER: &str = "x-runtime-host-session-model-account";
const DIAGNOSTIC_MODEL_HEADER: &str = "x-runtime-host-session-model-model";
const DIAGNOSTIC_PROTOCOL_HEADER: &str = "x-runtime-host-session-model-protocol";
const DIAGNOSTIC_AUTH_MODE_HEADER: &str = "x-runtime-host-session-model-auth-mode";
const MAX_DIAGNOSTIC_HEADER_BYTES: usize = 1024;

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: crate::owner::Handle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            owner,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let owner = self.owner.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, owner).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, owner).await,
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != "/api/sessions/model" {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match SessionModelSelectionRequest::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(super::DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(super::DecodeError::Invalid) => return Response::bad_request(),
    };
    let command = match request.into_command() {
        Ok(command) => command,
        Err(_) => return Response::bad_request(),
    };
    if matches!(
        command.endpoint,
        crate::session_model_selection::NativeEndpoint::Unsupported
    ) {
        return Response::from_delivery(SessionModelSelectionDelivery::Unsupported);
    }
    drop(verifier);
    let outcome = match owner.select_session_model(command).await {
        Ok(outcome) => outcome,
        Err(_) => return Response::unavailable(),
    };
    Response::from_delivery(outcome.into())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: Value,
    rejection_reason: Option<&'static str>,
    openclaw_peer_code: Option<String>,
    openclaw_peer_message: Option<String>,
    diagnostic_account: Option<String>,
    diagnostic_model: Option<String>,
    diagnostic_protocol: Option<&'static str>,
    diagnostic_auth_mode: Option<&'static str>,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session model selection request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session model selection authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session model selection route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionModelSelectionDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
            rejection_reason: None,
            openclaw_peer_code: None,
            openclaw_peer_message: None,
            diagnostic_account: None,
            diagnostic_model: None,
            diagnostic_protocol: None,
            diagnostic_auth_mode: None,
        }
    }

    fn from_delivery(delivery: SessionModelSelectionDelivery) -> Self {
        let rejection_reason = delivery.rejection_reason();
        let openclaw_peer = delivery.openclaw_patch_rejection().map(|rejection| {
            (
                header_value(rejection.code()),
                header_value(rejection.message()),
            )
        });
        let diagnostic = delivery.diagnostic();
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
            rejection_reason,
            openclaw_peer_code: openclaw_peer.as_ref().map(|(code, _)| code.clone()),
            openclaw_peer_message: openclaw_peer.map(|(_, message)| message),
            diagnostic_account: diagnostic.map(|diagnostic| header_value(diagnostic.account_id())),
            diagnostic_model: diagnostic.map(|diagnostic| header_value(diagnostic.model_id())),
            diagnostic_protocol: diagnostic.and_then(|diagnostic| diagnostic.protocol()),
            diagnostic_auth_mode: diagnostic.map(|diagnostic| diagnostic.auth_mode()),
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<Request, Response>> {
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
    let content_length = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let Some(content_length) = content_length else {
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
    Ok(Ok(Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body)
        .expect("Session model selection public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        422 => "Unprocessable Content",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    let mut diagnostic_headers = String::new();
    if let Some(reason) = response.rejection_reason {
        diagnostic_headers.push_str(&format!("{REJECTION_REASON_HEADER}: {reason}\r\n"));
    }
    if let Some(code) = response.openclaw_peer_code {
        diagnostic_headers.push_str(&format!("{OPENCLAW_PEER_CODE_HEADER}: {code}\r\n"));
    }
    if let Some(message) = response.openclaw_peer_message {
        diagnostic_headers.push_str(&format!("{OPENCLAW_PEER_MESSAGE_HEADER}: {message}\r\n"));
    }
    if let Some(account) = response.diagnostic_account {
        diagnostic_headers.push_str(&format!("{DIAGNOSTIC_ACCOUNT_HEADER}: {account}\r\n"));
    }
    if let Some(model) = response.diagnostic_model {
        diagnostic_headers.push_str(&format!("{DIAGNOSTIC_MODEL_HEADER}: {model}\r\n"));
    }
    if let Some(protocol) = response.diagnostic_protocol {
        diagnostic_headers.push_str(&format!("{DIAGNOSTIC_PROTOCOL_HEADER}: {protocol}\r\n"));
    }
    if let Some(auth_mode) = response.diagnostic_auth_mode {
        diagnostic_headers.push_str(&format!("{DIAGNOSTIC_AUTH_MODE_HEADER}: {auth_mode}\r\n"));
    }
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason,
                diagnostic_headers,
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

fn header_value(value: &str) -> String {
    let mut header = String::with_capacity(value.len().min(MAX_DIAGNOSTIC_HEADER_BYTES));
    for character in value.chars() {
        let character = match character {
            '\r' | '\n' => ' ',
            value if value.is_control() => continue,
            value => value,
        };
        if header.len() + character.len_utf8() > MAX_DIAGNOSTIC_HEADER_BYTES {
            break;
        }
        header.push(character);
    }
    header
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
