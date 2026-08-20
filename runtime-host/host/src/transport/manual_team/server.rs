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

use super::{DecodeError, Delivery, decode, dispatch};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const ROUTE: &str = "/api/team/manual-materialize-and-create";

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
        self.listener.local_addr().expect("listener address").port()
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
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response).await
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != ROUTE {
        return Response::not_found();
    }
    let Some(authorization) = request.header("authorization").and_then(bearer_token) else {
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
    Response::from_delivery(dispatch(&owner, request).await)
}

fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
        .filter(|token| !token.is_empty())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn bad_request() -> Self {
        Self::fixed(400, "Manual Team materialization request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Manual Team materialization authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Manual Team materialization route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<Request, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
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
    let mut parts = request_line.split_ascii_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" || path.contains('?') {
        return Ok(Err(Response::bad_request()));
    }
    let method = method.to_owned();
    let path = path.to_owned();
    let mut headers = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(Response::bad_request()));
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty()
            || headers.len() == MAX_HEADERS
            || headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        headers.push((name, value.trim().to_owned()));
    }
    let Some(content_length) = headers
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
        if read == 0 || bytes.len() + read > header_end + content_length {
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
        headers,
        body: bytes.split_off(header_end),
    }))
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("fixed response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason,
                body.len()
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
#[path = "manual_team_server_tests.rs"]
mod server_tests;

#[cfg(test)]
mod tests {
    use tokio::{io::AsyncWriteExt, net::TcpStream};

    use super::*;

    #[tokio::test]
    async fn reads_only_an_exact_bounded_http_request() {
        let body = br#"{"teamId":"team:manual","teamName":"Manual","idempotencyKey":"manual:one","roles":[]}"#;
        let request = receive(&format!(
            "POST {ROUTE} HTTP/1.1\r\nAuthorization: Bearer decision\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap(),
        ))
        .await;
        let Ok(Ok(request)) = request else {
            panic!("request must parse");
        };
        assert_eq!(request.path, ROUTE);
        assert_eq!(request.body, body);
    }

    #[tokio::test]
    async fn rejects_raw_extra_bytes_and_body_overflow() {
        for request in [
            format!("POST {ROUTE} HTTP/1.1\r\nContent-Length: 2\r\n\r\n{{}}private"),
            format!(
                "POST {ROUTE} HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                MAX_REQUEST_BYTES + 1
            ),
        ] {
            assert!(matches!(
                receive(&request).await,
                Ok(Err(Response { status: 400, .. }))
            ));
        }
    }

    #[test]
    fn fixed_errors_are_redacted() {
        for response in [
            Response::bad_request(),
            Response::unauthorized(),
            Response::not_found(),
        ] {
            let body = response.body.to_string();
            assert!(!body.contains("workspace"));
            assert!(!body.contains("Bearer"));
            assert!(!body.contains("runId"));
        }
    }

    async fn receive(bytes: &str) -> io::Result<Result<Request, Response>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let bytes = bytes.as_bytes().to_vec();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await?;
            stream.write_all(&bytes).await
        });
        let (mut stream, _) = listener.accept().await?;
        client.await.expect("client task")?;
        read_request(&mut stream).await
    }
}
