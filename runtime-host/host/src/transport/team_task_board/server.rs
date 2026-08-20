use super::{DecodeError, Delivery, decode, handle};
use crate::transport::authorization::CapabilityDecisionVerifier;
use serde_json::Value;
use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    task::JoinHandle,
    time::timeout,
};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

pub(crate) struct Server {
    listener: TcpListener,
    port: u16,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
}

pub(crate) struct Task {
    handle: JoinHandle<io::Result<()>>,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: crate::owner::Handle,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listener,
            port,
            verifier: Arc::new(Mutex::new(verifier)),
            owner,
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn spawn(self) -> Task {
        Task {
            handle: tokio::spawn(self.run()),
        }
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

impl Task {
    pub(crate) fn abort(&self) {
        self.handle.abort();
    }
    pub(crate) async fn r#await(self) -> Result<Result<(), io::Error>, tokio::task::JoinError> {
        self.handle.await
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
            Ok(request) => handle_request(request, verifier, owner).await,
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::unavailable(),
    };
    write_response(&mut stream, response).await
}
async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != "/api/team/task-board" {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix("Bearer "))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(handle(&owner, request).await)
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
        Self::fixed(400, "Team task board request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Team task board authorization is invalid")
    }
    fn not_found() -> Self {
        Self::fixed(404, "Team task board route is not available")
    }
    fn unavailable() -> Self {
        Self::from_delivery(Delivery::Unavailable)
    }
    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({"success":false,"error":error}),
        }
    }
    fn from_delivery(delivery: Delivery) -> Self {
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
        if bytes.len() > MAX_HEADER_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let header = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(header) => header,
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = header.split("\r\n");
    let Some(request_line) = lines.next() else {
        return Ok(Err(Response::bad_request()));
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(path), Some(_version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if parts.next().is_some() {
        return Ok(Err(Response::bad_request()));
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(Response::bad_request()));
        };
        if headers.len() >= MAX_HEADERS {
            return Ok(Err(Response::bad_request()));
        }
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HEADER_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    let mut body = bytes[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        body.extend_from_slice(&buffer[..read]);
        if body.len() > content_length {
            return Ok(Err(Response::bad_request()));
        }
    }
    Ok(Ok(Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
        body,
    }))
}
async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("task board response must serialize");
    let status = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream.write_all(format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, status, body.len()).as_bytes()).await?;
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
