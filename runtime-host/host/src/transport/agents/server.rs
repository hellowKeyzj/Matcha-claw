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

use crate::{
    facade::AgentsHandle,
    transport::{authorization::CapabilityDecisionVerifier, session_trace},
};

use super::{AgentsRequest, Delivery, map_outcome};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const ROUTE: &str = "/api/subagents/agents";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: AgentsHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        handle: AgentsHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            handle,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let agents_handle = self.handle.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, agents_handle).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: AgentsHandle,
) -> io::Result<()> {
    let request = match timeout(REQUEST_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => return Err(error),
        Err(_) => return write_response(&mut stream, Response::bad_request()).await,
    };
    let response = match request {
        Ok(request) => self::handle(request, verifier, handle).await,
        Err(response) => response,
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: AgentsHandle,
) -> Response {
    let trace_id = session_trace::trace_id(&request.headers).map(str::to_owned);
    session_trace::log(
        "runtime.agents.request",
        trace_id.as_deref(),
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    if request.method != "POST" || request.path != ROUTE {
        session_trace::log(
            "runtime.agents.not-found",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.agents.unauthorized",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log(
                "runtime.agents.bad-json",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match AgentsRequest::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(_) => {
            session_trace::log(
                "runtime.agents.decode-invalid",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::unauthorized();
        }
    };
    session_trace::log(
        "runtime.agents.decode-accepted",
        trace_id.as_deref(),
        serde_json::json!({
            "capability": &request.id,
            "operation": &request.operation_id,
            "adapter": &request.scope.endpoint.runtime_adapter_id,
            "instance": &request.scope.endpoint.runtime_instance_id,
            "scopeAgentId": session_trace::id_shape(Some(&request.scope.agent_id)),
            "targetSubagentId": session_trace::id_shape(request.target.subagent_id.as_deref()),
        }),
    );
    let operation_id = request.operation_id.clone();
    let command = match request.command(trace_id.as_deref()) {
        Ok(command) => command,
        Err(_) => {
            session_trace::log(
                "runtime.agents.command-invalid",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            return Response::bad_request();
        }
    };
    drop(verifier);
    session_trace::log(
        "runtime.agents.command",
        trace_id.as_deref(),
        serde_json::json!({ "operation": operation_id }),
    );
    let delivery = match handle.agents(command).await {
        Ok(outcome) => map_outcome(outcome),
        Err(_) => {
            session_trace::log(
                "runtime.agents.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            Delivery::Unavailable
        }
    };
    session_trace::log(
        "runtime.agents.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "operation": operation_id,
            "status": delivery.status_code(),
            "delivery": delivery_trace_kind(&delivery),
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

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Subagent request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Subagent authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Subagent route is not available")
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

fn delivery_trace_kind(delivery: &Delivery) -> &'static str {
    match delivery {
        Delivery::Agents { .. } => "agents",
        Delivery::Wait(_) => "wait",
        Delivery::Created(_) => "created",
        Delivery::Updated(_) => "updated",
        Delivery::Deleted(_) => "deleted",
        Delivery::Files(_) => "files",
        Delivery::File(_) => "file",
        Delivery::Configuration(_) => "configuration",
        Delivery::ConfigurationApplied => "configurationApplied",
        Delivery::SkillConfiguration(_) => "skillConfiguration",
        Delivery::ToolConfiguration(_) => "toolConfiguration",
        Delivery::PackageExport(_) => "packageExport",
        Delivery::PackageInstall(_) => "packageInstall",
        Delivery::Rejected => "rejected",
        Delivery::OutcomeUnknown => "outcomeUnknown",
        Delivery::WaitUnknown => "waitUnknown",
        Delivery::Unsupported => "unsupported",
        Delivery::Unavailable => "unavailable",
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<Request, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
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
    let body =
        serde_json::to_vec(&response.body).expect("Subagent public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
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
