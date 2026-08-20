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

use crate::transport::{authorization::CapabilityDecisionVerifier, session_trace};

use super::{SessionSendDelivery, SessionSendRequest};

const MAX_REQUEST_BYTES: usize = (20_usize * 1024 * 1024).div_ceil(3) * 4 + 64 * 1024 + 128 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

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

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("session send transport listener has a local address")
            .port()
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod server_tests;

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> io::Result<()> {
    let mut request_received = false;
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => {
                request_received = true;
                handle(request, verifier, owner).await
            }
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) if request_received => Response::deadline(),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != "/api/sessions/send" {
        return Response::not_found();
    }
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.send.request",
        trace_id,
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log("runtime.send.unauthorized", trace_id, serde_json::json!({}));
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.send.bad-json", trace_id, serde_json::json!({}));
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request =
        match SessionSendRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(super::DecodeError::Unauthorized) => {
                session_trace::log(
                    "runtime.send.decode-unauthorized",
                    trace_id,
                    serde_json::json!({}),
                );
                return Response::unauthorized();
            }
            Err(super::DecodeError::Invalid) => {
                session_trace::log(
                    "runtime.send.decode-invalid",
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
                "runtime.send.command-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let trace_id = command.trace_id().map(str::to_owned);
    session_trace::log(
        "runtime.send.command",
        trace_id.as_deref(),
        serde_json::json!({
            "endpoint": format!("{:?}", command.endpoint),
            "sessionKey": session_trace::id_shape(Some(&command.session_key)),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
            "runId": session_trace::id_shape(command.run_id.as_deref().or(command.idempotency_key.as_deref())),
            "attachmentCount": command.attachments.len(),
        }),
    );
    if matches!(
        command.endpoint,
        crate::session_send::NativeEndpoint::Unsupported
    ) {
        return Response::from_delivery(SessionSendDelivery::Unsupported);
    }
    drop(verifier);
    let outcome = match owner.send_session(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.send.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    session_trace::log(
        "runtime.send.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "outcome": match &outcome {
                crate::session_send::SessionSendOutcome::Queued { .. } => "queued",
                crate::session_send::SessionSendOutcome::Succeeded { .. } => "succeeded",
                crate::session_send::SessionSendOutcome::Rejected => "rejected",
                crate::session_send::SessionSendOutcome::Unknown => "unknown",
                crate::session_send::SessionSendOutcome::Unsupported => "unsupported",
                crate::session_send::SessionSendOutcome::Unavailable => "unavailable",
            }
        }),
    );
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
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session send request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session send authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session send route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionSendDelivery::Unavailable)
    }

    fn deadline() -> Self {
        Self::unavailable()
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SessionSendDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
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
        .expect("Workspace write public response is serializable");
    let reason = match response.status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        422 => "Unprocessable Content",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason,
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
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

    use super::Response;

    #[test]
    fn deadline_projects_unavailable_without_invalid_request() {
        assert_eq!(Response::deadline().status, 503);
        assert_eq!(
            Response::deadline().body,
            json!({
                "success": false,
                "error": "Session send is unavailable",
            })
        );
        assert_ne!(Response::deadline().status, 400);
    }
}
