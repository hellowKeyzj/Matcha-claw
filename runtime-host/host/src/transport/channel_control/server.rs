use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::transport::authorization::CapabilityDecisionVerifier;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use super::{ChannelControlDelivery, DecodeError, decode};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 20 * 1024;
const MAX_HEADERS: usize = 32;
const CONTROL_REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const LOGIN_REQUEST_DEADLINE: Duration = Duration::from_secs(305);
const DELETE_CONFIG_PATH: &str = "/api/channels/delete-config";
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
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> io::Result<()> {
    let request = match timeout(CONTROL_REQUEST_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(Ok(request))) => request,
        Ok(Ok(Err(response))) => return write_response(&mut stream, response).await,
        Ok(Err(error)) => return Err(error),
        Err(_) => return write_response(&mut stream, Response::bad_request()).await,
    };
    let deadline = if request.path == "/api/channels/login" {
        LOGIN_REQUEST_DEADLINE
    } else {
        CONTROL_REQUEST_DEADLINE
    };
    let cancellation = tokio_util::sync::CancellationToken::new();
    let response = if request.path == "/api/channels/login" {
        let response = handle(request, verifier, owner, cancellation.clone());
        tokio::pin!(response);
        tokio::select! {
            response = &mut response => response,
            result = wait_for_disconnect(&mut stream) => {
                let _ = result;
                cancellation.cancel();
                return Ok(());
            }
            _ = tokio::time::sleep(deadline) => {
                cancellation.cancel();
                Response::bad_request()
            },
        }
    } else {
        match timeout(deadline, handle(request, verifier, owner, cancellation)).await {
            Ok(response) => response,
            Err(_) => Response::bad_request(),
        }
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
    cancellation: tokio_util::sync::CancellationToken,
) -> Response {
    if request.path == "/api/channels/login" {
        let (status, body) = crate::transport::channel_login::server::handle_login(
            &request.method,
            &request.path,
            &request.headers,
            &request.body,
            verifier,
            owner,
            cancellation,
        )
        .await;
        return Response { status, body };
    }
    if request.path == DELETE_CONFIG_PATH {
        return handle_delete_config(request, verifier, owner).await;
    }
    if request.method != "POST" || request.path != "/api/channels/control" {
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
    let command = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(command) => command,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    match owner
        .control_open_claw_channel_account(command.action, command.channel, command.account)
        .await
    {
        Ok(outcome) => Response::from_delivery(ChannelControlDelivery::Outcome(outcome.into())),
        Err(_) => Response::unavailable(),
    }
}

async fn handle_delete_config(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" {
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
    let command = match crate::transport::channel_delete::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(command) => command,
        Err(crate::transport::channel_delete::DecodeError::Unauthorized) => {
            return Response::unauthorized();
        }
        Err(crate::transport::channel_delete::DecodeError::Invalid) => {
            return Response::bad_request();
        }
    };
    drop(verifier);
    let delivery = match owner
        .delete_channel_config(command.channel, command.account_id)
        .await
    {
        Ok(outcome) => crate::transport::channel_delete::Delivery::Outcome(outcome),
        Err(_) => crate::transport::channel_delete::Delivery::Unavailable,
    };
    Response {
        status: delivery.status_code(),
        body: delivery.body(),
    }
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
        Self::fixed(400, "Channel control request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Channel control authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Channel control route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(ChannelControlDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ChannelControlDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

async fn wait_for_disconnect(stream: &mut TcpStream) -> io::Result<()> {
    let mut buffer = [0_u8; 1];
    loop {
        stream.readable().await?;
        match stream.try_read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error),
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
        if name.is_empty()
            || parsed_headers.len() == MAX_HEADERS
            || parsed_headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        parsed_headers.push((name, value.trim().to_owned()));
    }
    let content_length = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let Some(content_length) = content_length else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length == 0 || content_length > MAX_BODY_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_HEADER_BYTES + content_length {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + content_length {
        return Ok(Err(Response::bad_request()));
    }
    Ok(Ok(Request {
        method,
        path,
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body)
        .expect("Channel control public response is serializable");
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
