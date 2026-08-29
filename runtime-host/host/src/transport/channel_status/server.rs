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

use crate::{channel::ChannelHandle, transport::authorization::CapabilityDecisionVerifier};

use super::{ChannelStatusDelivery, ChannelStatusRequest, DecodeError, decode};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const MAX_BODY_BYTES: usize = 256;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        channel: ChannelHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            channel,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let channel = self.channel.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, channel).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, channel).await,
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
    channel: ChannelHandle,
) -> Response {
    if request.method != "POST" || request.path != "/api/channels/status" {
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
    let request = {
        let mut verifier = verifier.lock().await;
        match decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(DecodeError::Unauthorized) => return Response::unauthorized(),
            Err(DecodeError::Invalid) => return Response::bad_request(),
        }
    };
    match request {
        ChannelStatusRequest::Accounts => match channel.status().await {
            Ok(outcome) => Response::from_delivery(ChannelStatusDelivery::Accounts(outcome)),
            Err(_) => Response::unavailable(),
        },
        ChannelStatusRequest::Snapshot => match channel.snapshot().await {
            Ok(outcome) => Response::from_delivery(ChannelStatusDelivery::Snapshot(outcome)),
            Err(_) => Response::unavailable(),
        },
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
        Self::fixed(400, "Channel status request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Channel status authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Channel status route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(ChannelStatusDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ChannelStatusDelivery) -> Self {
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
    let Some(content_length) = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .filter(|length| *length <= MAX_BODY_BYTES)
    else {
        return Ok(Err(Response::bad_request()));
    };
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
    let body =
        serde_json::to_vec(&response.body).expect("Channel status public response is serializable");
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
