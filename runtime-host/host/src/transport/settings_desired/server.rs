use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use super::{DecodeError, ENDPOINT, READ_ENDPOINT, decode};
use crate::transport::authorization::CapabilityDecisionVerifier;

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings_handle: crate::settings::SettingsHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        settings_handle: crate::settings::SettingsHandle,
    ) -> io::Result<Self> {
        let server = Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            settings_handle,
        };
        server.settings_handle.recover_pending().await;
        Ok(server)
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let settings_handle = self.settings_handle.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, settings_handle).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings_handle: crate::settings::SettingsHandle,
) -> io::Result<()> {
    let response = match timeout(
        REQUEST_DEADLINE,
        handle(&mut stream, verifier, settings_handle),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    stream: &mut TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings_handle: crate::settings::SettingsHandle,
) -> io::Result<Response> {
    let request = read_request(stream).await?;
    if request.method == "GET" && request.path == READ_ENDPOINT {
        let snapshot = settings_handle.desired_snapshot().await;
        return Ok(Response::ok(snapshot.to_json()));
    }
    if request.method != "POST" || request.path != ENDPOINT {
        return Ok(Response::not_found());
    }
    let Some(token) = request
        .authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return Ok(Response::unauthorized());
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Ok(Response::bad_request()),
    };
    let mut verifier = verifier.lock().await;
    let (decision, correlation) = match decode(value, token, &mut verifier, now_millis()) {
        Ok(value) => value,
        Err(DecodeError::Unauthorized) => return Ok(Response::unauthorized()),
        Err(DecodeError::Invalid) => return Ok(Response::bad_request()),
    };
    drop(verifier);
    let desired = match crate::settings::desired::Desired::try_from_wire(&decision) {
        Ok(desired) => desired,
        Err(()) => return Ok(Response::bad_request()),
    };

    let settlement = settings_handle.replace(correlation, desired).await;
    Ok(Response::settled(settlement.revision, settlement.outcome))
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}
struct Response {
    status: u16,
    body: Value,
}
impl Response {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }
    fn settled(revision: u64, outcome: crate::settings::desired::Outcome) -> Self {
        match outcome {
            crate::settings::desired::Outcome::Rejected => {
                Self::fixed(422, "Settings desired request was rejected")
            }
            crate::settings::desired::Outcome::Confirmed
            | crate::settings::desired::Outcome::Unknown => Self::ok(
                json!({ "desired": { "revision": revision, "outcome": outcome.as_str() } }),
            ),
        }
    }
    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: json!({"success": false, "error": error}),
        }
    }
    fn bad_request() -> Self {
        Self::fixed(400, "Settings desired request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Settings desired authorization is invalid")
    }
    fn not_found() -> Self {
        Self::fixed(404, "Settings desired route is not available")
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
        if bytes.len() > 8192 {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
    };
    let (method, path, length, authorization, content_type) = {
        let header = std::str::from_utf8(&bytes[..header_end])
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let mut lines = header.split("\r\n");
        let start = lines
            .next()
            .ok_or(io::Error::from(io::ErrorKind::InvalidData))?;
        let mut parts = start.split_whitespace();
        let (Some(method), Some(path), Some("HTTP/1.1"), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        };
        let mut length = None;
        let mut authorization = None;
        let mut content_type = false;
        for line in lines.filter(|line| !line.is_empty()) {
            let Some((name, value)) = line.split_once(':') else {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            };
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse::<usize>().ok(),
                "authorization" => authorization = Some(value.trim().into()),
                "content-type" => content_type = value.trim() == "application/json",
                _ => {}
            }
        }
        (
            method.to_owned(),
            path.to_owned(),
            length,
            authorization,
            content_type,
        )
    };
    if method == "GET" {
        if length.is_some_and(|length| length != 0) || bytes.len() != header_end {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        return Ok(Request {
            method,
            path,
            authorization,
            body: Vec::new(),
        });
    }
    let Some(length) = length else {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    };
    if !content_type || length > MAX_REQUEST_BYTES - header_end {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    while bytes.len() < header_end + length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_REQUEST_BYTES {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + length {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(Request {
        method,
        path,
        authorization,
        body: bytes[header_end..].to_vec(),
    })
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("settings response serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        422 => "Unprocessable Content",
        _ => "Internal Server Error",
    };
    stream.write_all(format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, reason, body.len()).as_bytes()).await?;
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
    use super::Response;
    use crate::settings::desired::Outcome;

    #[test]
    fn unchanged_projection_confirms_without_a_restart() {
        assert_eq!(Response::settled(7, Outcome::Confirmed).status, 200);
    }

    #[test]
    fn response_keeps_unknown_recoverable_and_rejection_fixed() {
        let unknown = Response::settled(7, Outcome::Unknown);
        assert_eq!(unknown.status, 200);
        assert_eq!(unknown.body["desired"]["outcome"], "outcome_unknown");

        let rejected = Response::settled(7, Outcome::Rejected);
        assert_eq!(rejected.status, 422);
        assert_eq!(rejected.body["success"], false);
    }
}
