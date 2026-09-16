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
    composition::PeerHandle, facade::PlatformToolsHandle,
    transport::common::authorization::CapabilityDecisionVerifier,
};

use super::{
    DecodeError, SessionListDelivery, SessionListRequest, content, map_catalog_outcome, timeline,
};
use crate::transport::{
    runtime::{peer_directory, platform_tools},
    sessions::{create, delete, matcha_catalog, permission, rename, trace as session_trace},
};

#[cfg(test)]
mod server_tests;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    platform_tools: PlatformToolsHandle,
    peer: PeerHandle,
    session: crate::sessions::SessionHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        platform_tools: PlatformToolsHandle,
        peer: PeerHandle,
        session: crate::sessions::SessionHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            platform_tools,
            peer,
            session,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let platform_tools = self.platform_tools.clone();
            let peer = self.peer.clone();
            let session = self.session.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, platform_tools, peer, session).await;
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("session transport listener has a local address")
            .port()
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    platform_tools: PlatformToolsHandle,
    peer: PeerHandle,
    session: crate::sessions::SessionHandle,
) -> io::Result<()> {
    let mut request_path = None;
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => {
                request_path = Some(request.path.clone());
                handle(request, verifier, platform_tools, peer, session).await
            }
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::deadline(request_path.as_deref()),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    platform_tools: PlatformToolsHandle,
    peer: PeerHandle,
    session: crate::sessions::SessionHandle,
) -> Response {
    if request.method == "GET" && request.path == "/api/runtime-endpoints/list" {
        let response = peer_directory::server::handle(&request.headers, verifier, peer).await;
        return Response::from_peer_directory(response);
    }
    if request.method == "GET" && request.path == "/api/platform/tools" {
        return Response::from_platform_tools(
            platform_tools::server::handle(&request.headers, verifier, platform_tools).await,
        );
    }
    if request.method != "POST" {
        return Response::not_found();
    }
    if request.path == "/api/sessions/create" {
        let response =
            create::server::handle(&request.headers, &request.body, verifier, session.clone())
                .await;
        return Response::from_create(response);
    }
    if request.path == "/api/sessions/delete" {
        let response =
            delete::server::handle(&request.headers, &request.body, verifier, session.clone())
                .await;
        return Response::from_delete(response);
    }
    if request.path == "/api/sessions/rename" {
        return Response::from_rename(
            rename::handle(&request.headers, &request.body, verifier, session.clone()).await,
        );
    }
    if request.path == "/api/sessions/permission" {
        return Response::from_permission(
            permission::server::handle(&request.headers, &request.body, verifier, session.clone())
                .await,
        );
    }
    if request.path == "/api/matcha/sessions" {
        let response = matcha_catalog::server::handle(
            &request.headers,
            &request.body,
            verifier,
            session.clone(),
        )
        .await;
        return Response::from_matcha_catalog(response);
    }
    if matches!(
        request.path.as_str(),
        "/api/sessions/load" | "/api/sessions/window"
    ) {
        return handle_timeline(request, verifier, session).await;
    }
    if request.path == "/api/sessions/content" {
        return handle_content(request, verifier, session).await;
    }
    if request.path != "/api/sessions" {
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
    let _request =
        match SessionListRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(DecodeError::Unauthorized) => return Response::unauthorized(),
            Err(DecodeError::Invalid) => return Response::bad_request(),
        };
    drop(verifier);
    let delivery = match session.list_openclaw_sessions().await {
        Ok(result) => map_catalog_outcome(result),
        Err(_) => SessionListDelivery::Unavailable,
    };
    Response::from_delivery(delivery)
}

async fn handle_content(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Response {
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.content.request",
        trace_id,
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::content_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::content_bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match content::Request::decode(value, authorization, &mut verifier, now_millis())
    {
        Ok(request) => request,
        Err(content::DecodeError::Unauthorized) => return Response::content_unauthorized(),
        Err(content::DecodeError::Invalid) => return Response::content_bad_request(),
    };
    let Some(command) = request.into_command() else {
        return Response::content_bad_request();
    };
    drop(verifier);
    session_trace::log(
        "runtime.content.command",
        trace_id,
        serde_json::json!({
            "provider": command.provider().as_str(),
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "agentId": session_trace::id_shape(command.agent_id()),
            "contentRef": session_trace::id_shape(Some(command.content_ref())),
            "offset": command.offset(),
            "limit": command.limit(),
        }),
    );
    let outcome = match session.load_content(command).await {
        Ok(outcome) => outcome,
        Err(_) => return Response::content_unavailable(),
    };
    let reason = match &outcome {
        crate::sessions::timeline::ContentOutcome::Unavailable(reason) => Some(reason.as_str()),
        crate::sessions::timeline::ContentOutcome::Complete(_) => None,
    };
    let delivery = content::Delivery::from_outcome(outcome);
    session_trace::log(
        "runtime.content.outcome",
        trace_id,
        serde_json::json!({
            "status": delivery.status_code(),
            "reason": reason,
        }),
    );
    Response::from_content(delivery)
}

async fn handle_timeline(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Response {
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.timeline.request",
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
            "runtime.timeline.unauthorized",
            trace_id,
            serde_json::json!({}),
        );
        return Response::timeline_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.timeline.bad-json", trace_id, serde_json::json!({}));
            return Response::timeline_bad_request();
        }
    };
    let expected_operation = match request.path.as_str() {
        "/api/sessions/load" => "sessions.load",
        "/api/sessions/window" => "sessions.window",
        _ => return Response::timeline_bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match timeline::Request::decode(value, authorization, &mut verifier, now_millis())
    {
        Ok(request) if request.operation_id() == expected_operation => request,
        Err(timeline::DecodeError::Unauthorized) => {
            session_trace::log(
                "runtime.timeline.decode-unauthorized",
                trace_id,
                serde_json::json!({}),
            );
            return Response::timeline_unauthorized();
        }
        Ok(_) | Err(timeline::DecodeError::Invalid) => {
            session_trace::log(
                "runtime.timeline.decode-invalid",
                trace_id,
                serde_json::json!({ "operation": expected_operation }),
            );
            return Response::timeline_bad_request();
        }
    };
    let identity = request.identity().clone();
    let Some(command) = request.into_command() else {
        return Response::timeline_bad_request();
    };
    drop(verifier);
    session_trace::log(
        "runtime.timeline.command",
        trace_id,
        serde_json::json!({
            "operation": expected_operation,
            "provider": command.provider().as_str(),
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "agentId": session_trace::id_shape(command.agent_id()),
            "direction": command.direction().as_str(),
            "limit": command.limit(),
            "offset": command.offset(),
            "includeCanonical": command.include_canonical(),
        }),
    );
    let outcome = match session.load_timeline(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.timeline.owner-unavailable",
                trace_id,
                serde_json::json!({ "operation": expected_operation }),
            );
            return Response::timeline_unavailable();
        }
    };
    let unavailable_reason = outcome.unavailable_reason().map(|reason| reason.as_str());
    let unavailable_diagnostic = outcome.unavailable_diagnostic().map(|diagnostic| {
        serde_json::json!({
            "source": diagnostic.source(),
            "messageIndex": diagnostic.message_index(),
            "blockIndex": diagnostic.block_index(),
            "blockType": diagnostic.block_type(),
            "field": diagnostic.field(),
            "reason": diagnostic.reason(),
            "actualType": diagnostic.actual(),
        })
    });
    let delivery = timeline::Delivery::from_outcome(&identity, outcome);
    let delivery_reason = unavailable_reason
        .or_else(|| (delivery.status_code() == 503).then_some("delivery.identity_mismatch"));
    session_trace::log(
        "runtime.timeline.outcome",
        trace_id,
        serde_json::json!({
            "operation": expected_operation,
            "status": delivery.status_code(),
            "reason": delivery_reason,
            "diagnostic": unavailable_diagnostic,
        }),
    );
    Response::from_timeline(delivery)
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
        Self::fixed(400, "Session list request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session list authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session list route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionListDelivery::Unavailable)
    }

    fn deadline(path: Option<&str>) -> Self {
        match path {
            Some("/api/sessions/create") => Self::fixed(503, "Session create is unavailable"),
            Some("/api/sessions/delete") => Self::fixed(503, "Session delete is unavailable"),
            Some("/api/sessions/rename") => Self::fixed(503, "Session rename is unavailable"),
            Some("/api/sessions/permission") => {
                Self::fixed(503, "Session permission is unavailable")
            }
            Some("/api/matcha/sessions") => {
                Self::fixed(503, "Matcha session catalog is unavailable")
            }
            Some("/api/sessions") => Self::unavailable(),
            Some("/api/sessions/load") | Some("/api/sessions/window") => {
                Self::timeline_unavailable()
            }
            Some("/api/sessions/content") => Self::content_unavailable(),
            Some("/api/platform/tools") => {
                Self::fixed(503, "Platform tools catalog is unavailable")
            }
            _ => Self::bad_request(),
        }
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SessionListDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn from_create(response: create::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_delete(response: delete::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_rename(response: rename::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_permission(response: permission::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_matcha_catalog(response: matcha_catalog::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_peer_directory(response: peer_directory::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn from_platform_tools(response: platform_tools::server::Response) -> Self {
        Self {
            status: response.status,
            body: response.body,
        }
    }

    fn timeline_bad_request() -> Self {
        Self::fixed(400, "Session timeline request is invalid")
    }

    fn timeline_unauthorized() -> Self {
        Self::fixed(401, "Session timeline authorization is invalid")
    }

    fn timeline_unavailable() -> Self {
        Self::from_timeline(timeline::Delivery::Unavailable)
    }

    fn from_timeline(delivery: timeline::Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn content_bad_request() -> Self {
        Self::fixed(400, "Session content request is invalid")
    }

    fn content_unauthorized() -> Self {
        Self::fixed(401, "Session content authorization is invalid")
    }

    fn content_unavailable() -> Self {
        Self::from_content(content::Delivery::Unavailable)
    }

    fn from_content(delivery: content::Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
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
        Ok(value) => value,
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
    let method = method.to_owned();
    let path = path.to_owned();
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
    let content_length = match content_length {
        Some(value) => value,
        None if method == "GET" => 0,
        None => return Ok(Err(Response::bad_request())),
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
        serde_json::to_vec(&response.body).expect("Session list public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
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
    fn deadline_projects_session_routes_without_invalid_request() {
        for path in ["/api/sessions", "/api/sessions/create"] {
            assert_eq!(Response::deadline(Some(path)).status, 503);
        }
        assert_eq!(
            Response::deadline(Some("/api/sessions")).body,
            json!({
                "success": false,
                "error": "Session catalog is unavailable",
            })
        );
        assert_eq!(
            Response::deadline(Some("/api/sessions/create")).body,
            json!({
                "success": false,
                "error": "Session create is unavailable",
            })
        );
        for path in ["/api/sessions/load", "/api/sessions/window"] {
            assert_eq!(Response::deadline(Some(path)).status, 503);
            assert_eq!(
                Response::deadline(Some(path)).body,
                json!({
                    "success": false,
                    "error": "Session timeline is unavailable",
                })
            );
        }
        assert_eq!(
            Response::deadline(Some("/api/sessions/content")).status,
            503
        );
        assert_eq!(
            Response::deadline(Some("/api/sessions/content")).body,
            json!({
                "success": false,
                "error": "Session content is unavailable",
            })
        );
        assert_eq!(Response::deadline(None).status, 400);
        assert_eq!(
            Response::deadline(None).body,
            json!({
                "success": false,
                "error": "Session list request is invalid",
            })
        );
    }
}
