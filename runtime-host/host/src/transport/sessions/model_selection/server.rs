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

use crate::transport::{
    common::authorization::CapabilityDecisionVerifier, sessions::trace as session_trace,
};

use super::{SessionModelSelectionDelivery, SessionModelSelectionRequest};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
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
    session: crate::sessions::SessionHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        session: crate::sessions::SessionHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            session,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let session = self.session.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, session).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> io::Result<()> {
    let mut request_context = None;
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => {
                request_context = Some(RequestContext::from(&request));
                handle(request, verifier, session).await
            }
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => match request_context {
            Some(context) => {
                session_trace::log(
                    "runtime.model-selection.deadline",
                    context.trace_id.as_deref(),
                    serde_json::json!({
                        "method": &context.method,
                        "path": &context.path,
                    }),
                );
                Response::deadline()
            }
            None => Response::bad_request(),
        },
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Response {
    if request.method != "POST" || request.path != "/api/sessions/model" {
        return Response::not_found();
    }
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.model-selection.request",
        trace_id,
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.model-selection.unauthorized",
            trace_id,
            serde_json::json!({}),
        );
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.bad-json",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match SessionModelSelectionRequest::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(super::DecodeError::Unauthorized) => {
            session_trace::log(
                "runtime.model-selection.decode-unauthorized",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unauthorized();
        }
        Err(super::DecodeError::Invalid) => {
            session_trace::log(
                "runtime.model-selection.decode-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let command = match request.into_command(trace_id.map(str::to_owned)) {
        Ok(command) => command,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.command-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    session_trace::log(
        "runtime.model-selection.command",
        trace_id,
        serde_json::json!({
            "endpoint": format!("{:?}", command.endpoint),
            "sessionKey": session_trace::id_shape(Some(&command.session_key)),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
            "modelSelectionId": session_trace::id_shape(Some(&command.model_selection_id)),
        }),
    );
    if matches!(
        command.endpoint,
        crate::sessions::model_selection::NativeEndpoint::Unsupported
    ) {
        session_trace::log(
            "runtime.model-selection.unsupported",
            trace_id,
            serde_json::json!({}),
        );
        return Response::from_delivery(SessionModelSelectionDelivery::Unsupported);
    }
    drop(verifier);
    let outcome = match session.select_model(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.model-selection.owner-unavailable",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    let delivery = SessionModelSelectionDelivery::from(outcome);
    session_trace::log(
        "runtime.model-selection.outcome",
        trace_id,
        serde_json::json!({
            "status": delivery.status_code(),
            "rejectionReason": delivery.rejection_reason(),
        }),
    );
    Response::from_delivery(delivery)
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct RequestContext {
    method: String,
    path: String,
    trace_id: Option<String>,
}

impl RequestContext {
    fn from(request: &Request) -> Self {
        Self {
            method: request.method.clone(),
            path: request.path.clone(),
            trace_id: session_trace::trace_id(&request.headers).map(str::to_owned),
        }
    }
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

    fn deadline() -> Self {
        Self::from_delivery(SessionModelSelectionDelivery::Outcome(
            crate::sessions::model_selection::SessionModelSelectionOutcome::OutcomeUnknown,
        ))
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

#[cfg(test)]
mod timeout_tests {
    use serde_json::json;

    use super::{REQUEST_DEADLINE, Response};

    #[test]
    fn peer_operation_deadline_matches_openclaw_rpc_and_is_not_invalid_request() {
        assert_eq!(REQUEST_DEADLINE.as_secs(), 30);
        assert_eq!(Response::deadline().status, 200);
        assert_eq!(
            Response::deadline().body,
            json!({ "outcome": "outcome_unknown" })
        );
        assert_ne!(Response::deadline().status, 400);
    }
}
