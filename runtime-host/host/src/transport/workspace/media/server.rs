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
    facade::WorkspaceHandle, runtime::driver::WorkspaceMediaPath,
    transport::common::authorization::CapabilityDecisionVerifier,
};

use super::{
    WorkspaceMediaDelivery, WorkspaceMediaRequest, map_prepare, map_resolve, map_stage_buffer,
    map_stage_paths, map_thumbnail, map_thumbnails,
};

const MAX_REQUEST_BYTES: usize = 70 * 1024 * 1024;
const MAX_STAGE_BUFFER_REQUEST_BYTES: usize = 70 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    workspace: WorkspaceHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        workspace: WorkspaceHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            workspace,
        })
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("workspace media transport listener has a local address")
            .port()
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let workspace = self.workspace.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, workspace).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    workspace: WorkspaceHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, workspace).await,
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
    workspace: WorkspaceHandle,
) -> Response {
    if request.method != "POST" || request.path != "/api/workspace/media" {
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
    let request =
        match WorkspaceMediaRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(_) => return Response::unauthorized(),
        };
    drop(verifier);
    let delivery = if request.is_prepare() {
        let result = workspace
            .prepare_media(
                request.session_key(),
                request.relative_path(),
                request.mime_type(),
            )
            .map_err(crate::WorkspaceMediaError::from);
        map_prepare(result)
    } else if request.is_resolve() {
        let result = workspace
            .resolve_media(request.session_key(), request.reference())
            .map_err(crate::WorkspaceMediaError::from);
        map_resolve(result)
    } else if request.is_thumbnail() {
        let result = if request.gateway_url().is_empty() {
            workspace
                .thumbnail_media(
                    request.session_key(),
                    request.relative_path(),
                    request.mime_type(),
                )
                .map_err(crate::WorkspaceMediaError::from)
        } else {
            workspace
                .thumbnail_media_gateway(
                    request.session_key(),
                    request.gateway_url(),
                    request.mime_type(),
                    request.agent_id(),
                )
                .map_err(crate::WorkspaceMediaError::from)
        };
        map_thumbnail(result)
    } else if request.is_thumbnails() {
        let paths = request
            .paths()
            .iter()
            .map(|path| {
                if path.is_gateway() {
                    WorkspaceMediaPath::gateway(
                        path.key().to_owned(),
                        path.gateway_url().to_owned(),
                        path.mime_type().to_owned(),
                        path.agent_id().to_owned(),
                    )
                } else {
                    WorkspaceMediaPath::relative(
                        path.key().to_owned(),
                        path.relative_path().to_owned(),
                        path.mime_type().to_owned(),
                    )
                }
            })
            .collect::<Vec<_>>();
        map_thumbnails(
            workspace
                .thumbnails_media(request.session_key(), &paths)
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else if request.is_stage_paths() {
        let paths = request
            .paths()
            .iter()
            .map(|path| {
                WorkspaceMediaPath::relative(
                    path.key().to_owned(),
                    path.relative_path().to_owned(),
                    path.mime_type().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        map_stage_paths(
            workspace
                .stage_paths_media(request.session_key(), &paths)
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else if request.is_stage_buffer() {
        map_stage_buffer(
            workspace
                .stage_buffer_media(
                    request.session_key(),
                    request.base64(),
                    request.file_name(),
                    request.mime_type(),
                )
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else {
        WorkspaceMediaDelivery::Unavailable
    };
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
        Self::fixed(400, "Workspace media request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Workspace media authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Workspace media route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: WorkspaceMediaDelivery) -> Self {
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
    let Some(content_length) = content_length else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length > MAX_STAGE_BUFFER_REQUEST_BYTES
        || header_end + content_length > MAX_REQUEST_BYTES
    {
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
        .expect("Workspace media public response is serializable");
    let reason = match response.status {
        200 => "OK",
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
mod server_tests;
