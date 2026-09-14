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

use super::{DecodeError, Delivery, decode, handle};

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const ROUTE: &str = "/api/team/role-chat";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::organization::OrganizationHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: crate::organization::OrganizationHandle,
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
    owner: crate::organization::OrganizationHandle,
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
        Err(_) => Response::deadline(),
    };
    write_response(&mut stream, response).await
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::organization::OrganizationHandle,
) -> Response {
    if request.method != "POST" || request.path != ROUTE {
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
    Response::from_delivery(handle(&owner, request, now_millis()).await)
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
    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn bad_request() -> Self {
        Self::fixed(400, "Team role chat request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Team role chat authorization is invalid")
    }

    fn deadline() -> Self {
        Self::from_delivery(Delivery::OutcomeUnknown)
    }

    fn not_found() -> Self {
        Self::fixed(404, "Team role chat route is not available")
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
    let mut buffer = [0_u8; 8192];
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
    let mut request_parts = request_line.split_whitespace();
    let (Some(method), Some(path), Some(_version)) = (
        request_parts.next(),
        request_parts.next(),
        request_parts.next(),
    ) else {
        return Ok(Err(Response::bad_request()));
    };
    if request_parts.next().is_some() {
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
    let Some(content_length) = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length > MAX_REQUEST_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    let mut body = bytes[header_end..].to_vec();
    if body.len() > content_length {
        return Ok(Err(Response::bad_request()));
    }
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
    let body = serde_json::to_vec(&response.body).expect("fixed response must serialize");
    let status_text = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                status_text,
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
mod tests {
    use tokio::{io::AsyncWriteExt, net::TcpStream};

    use super::*;

    #[test]
    fn deadline_is_an_explicit_unknown_failure() {
        let response = Response::deadline();

        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            serde_json::json!({
                "success": false,
                "outcome": "outcome-unknown",
                "error": "Team role chat outcome is unknown",
            })
        );
        assert_eq!(Delivery::Accepted.status_code(), 200);
        assert_eq!(Delivery::Rejected.status_code(), 200);
        assert_eq!(Delivery::OutcomeUnknown.status_code(), 409);
    }

    #[tokio::test]
    async fn reads_a_bounded_closed_http_request() {
        let request = receive(
            b"POST /api/team/role-chat HTTP/1.1\r\nAuthorization: Bearer decision\r\nContent-Length: 106\r\n\r\n{\"teamId\":\"team-1\",\"runId\":\"run-1\",\"roleId\":\"leader\",\"message\":\"safe text\",\"idempotencyKey\":\"role-chat-1\"}",
        )
        .await;

        let Ok(Ok(request)) = request else {
            panic!("request must parse");
        };
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, ROUTE);
        assert_eq!(
            request.headers,
            vec![
                ("authorization".to_owned(), "Bearer decision".to_owned()),
                ("content-length".to_owned(), "106".to_owned())
            ]
        );
        assert_eq!(
            request.body,
            br#"{"teamId":"team-1","runId":"run-1","roleId":"leader","message":"safe text","idempotencyKey":"role-chat-1"}"#
        );
    }

    #[tokio::test]
    async fn rejects_body_bytes_after_the_declared_content_length() {
        let request =
            receive(b"POST /api/team/role-chat HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}private")
                .await;

        assert!(matches!(request, Ok(Err(Response { status: 400, .. }))));
    }

    #[tokio::test]
    async fn rejects_requests_without_content_length() {
        let request = receive(
            b"POST /api/team/role-chat HTTP/1.1\r\nAuthorization: Bearer decision\r\n\r\n{}",
        )
        .await;

        assert!(matches!(request, Ok(Err(Response { status: 400, .. }))));
    }

    async fn receive(bytes: &[u8]) -> io::Result<Result<Request, Response>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let bytes = bytes.to_vec();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await?;
            stream.write_all(&bytes).await
        });
        let (mut stream, _) = listener.accept().await?;
        client.await.expect("client task")?;
        read_request(&mut stream).await
    }
}
