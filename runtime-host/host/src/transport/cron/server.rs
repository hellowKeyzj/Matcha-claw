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

use crate::{facade::CronHandle, transport::authorization::CapabilityDecisionVerifier};

use super::{
    CREATE_PATH, CronHistoryQuery, CronRequest, DELETE_PATH, DecodeError, LIST_PATH,
    SESSION_HISTORY_PATH, TOGGLE_PATH, TRIGGER_PATH, UPDATE_PATH, delete_body, history_body,
    job_body, list_body, trigger_body,
};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
// The renderer's authenticated Host API request has a 30-second public budget.
// Keep the native operation inside that budget: a 5-second transport cutoff
// incorrectly reclassified an in-flight Gateway handshake as malformed input.
pub(crate) const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
pub(crate) const AUTHORIZATION_HEADER: &str = "authorization";
pub(crate) const BEARER_PREFIX: &str = "Bearer ";

fn debug_cron_transport(stage: &'static str) {
    if std::env::var_os("MATCHACLAW_DEBUG_CRON_PROVIDER").is_some() {
        eprintln!("[DEBUG-cron-provider] host={stage}");
    }
}

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        cron: CronHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            cron,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let cron = self.cron.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, cron).await;
            });
        }
    }
}

pub(crate) struct BrokerServer {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
    ledger: Arc<Mutex<super::broker::OperationLedger>>,
}

impl BrokerServer {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        cron: CronHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            cron,
            ledger: super::broker::new_operation_ledger(),
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let cron = self.cron.clone();
            let ledger = Arc::clone(&self.ledger);
            tokio::spawn(async move {
                let _ = serve_broker(stream, verifier, cron, ledger).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, cron).await,
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::gateway_timeout(),
    };
    write_response(&mut stream, response).await
}

async fn serve_broker(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
    ledger: Arc<Mutex<super::broker::OperationLedger>>,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) if request.path == super::broker::PATH => {
                super::broker::handle(request, verifier, cron, ledger).await
            }
            Ok(_) => Response::not_found(),
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::gateway_timeout(),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
) -> Response {
    debug_cron_transport("request_entered");
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        debug_cron_transport("authorization_missing");
        return Response::unauthorized();
    };

    if request.method == "GET" && request.path == SESSION_HISTORY_PATH {
        let mut verifier = verifier.lock().await;
        let query = match CronHistoryQuery::decode(
            request.query.as_deref(),
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(query) => query,
            Err(DecodeError::Unauthorized) => {
                debug_cron_transport("authorization_rejected");
                return Response::unauthorized();
            }
            Err(DecodeError::Invalid) => {
                debug_cron_transport("request_invalid");
                return Response::bad_request();
            }
        };
        drop(verifier);
        return handle_history(cron, query).await;
    }

    if request.method != "POST"
        || !matches!(
            request.path.as_str(),
            LIST_PATH | CREATE_PATH | UPDATE_PATH | DELETE_PATH | TOGGLE_PATH | TRIGGER_PATH
        )
        || request.query.is_some()
    {
        debug_cron_transport("route_rejected");
        return Response::not_found();
    }
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            debug_cron_transport("json_invalid");
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match CronRequest::decode(
        &request.path,
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            debug_cron_transport("authorization_rejected");
            return Response::unauthorized();
        }
        Err(DecodeError::Invalid) => {
            debug_cron_transport("request_invalid");
            return Response::bad_request();
        }
    };
    drop(verifier);

    let (status, body) = match request {
        CronRequest::List => {
            debug_cron_transport("owner_request_entered");
            match cron.list().await {
                Ok(jobs) => list_body(crate::cron::CronListOutcome::Listed(jobs)),
                Err(failure) => {
                    debug_cron_transport("owner_request_failed");
                    list_body(failure.into())
                }
            }
        }
        CronRequest::Create(command) => job_body(cron.create(command).await),
        CronRequest::Update(command) => job_body(cron.update(command).await),
        CronRequest::Delete(command) => delete_body(cron.delete(command).await),
        CronRequest::Trigger(job_id) => trigger_body(cron.trigger(job_id).await),
    };
    Response { status, body }
}

async fn handle_history(cron: CronHandle, query: CronHistoryQuery) -> Response {
    let command = match query.into_command() {
        Ok(command) => command,
        Err(DecodeError::Invalid | DecodeError::Unauthorized) => return Response::bad_request(),
    };
    let (status, body) = history_body(cron.load_history(command).await);
    Response { status, body }
}

pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) query: Option<String>,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

impl Response {
    pub(crate) fn bad_request() -> Self {
        Self::fixed(400, "Cron request is invalid")
    }

    pub(crate) fn unauthorized() -> Self {
        Self::fixed(401, "Cron authorization is invalid")
    }

    pub(crate) fn not_found() -> Self {
        Self::fixed(404, "Cron route is not available")
    }

    pub(crate) fn gateway_timeout() -> Self {
        Self::fixed(504, "Cron service deadline exceeded")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }
}

pub(crate) async fn read_request(stream: &mut TcpStream) -> io::Result<Result<Request, Response>> {
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
    let (Some(method), Some(target), Some(version), None) =
        (start.next(), start.next(), start.next(), start.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(Response::bad_request()));
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) if !path.is_empty() && !query.is_empty() => {
            (path, Some(query.to_owned()))
        }
        Some(_) => return Ok(Err(Response::bad_request())),
        None => (target, None),
    };
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
    if method == "GET" {
        if content_length.is_some_and(|length| length != 0) || bytes.len() != header_end {
            return Ok(Err(Response::bad_request()));
        }
        return Ok(Ok(Request {
            method: method.to_owned(),
            path: path.to_owned(),
            query,
            headers: parsed_headers,
            body: Vec::new(),
        }));
    }
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
        query,
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

pub(crate) async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("Cron public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Content",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
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
mod tests {
    use super::*;

    async fn tcp_pair() -> io::Result<(TcpStream, TcpStream)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (client, server) = tokio::join!(TcpStream::connect(address), listener.accept());
        Ok((client?, server?.0))
    }

    #[tokio::test]
    async fn accepts_get_history_with_query_and_zero_body() {
        let (mut client, mut server) = tcp_pair().await.expect("TCP pair");
        let request = b"GET /api/cron/session-history?sessionKey=agent%3Amain%3Acron%3Ajob-1&limit=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n";
        client.write_all(request).await.unwrap();
        let parsed = read_request(&mut server).await.unwrap().unwrap();
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.path, SESSION_HISTORY_PATH);
        assert_eq!(
            parsed.query.as_deref(),
            Some("sessionKey=agent%3Amain%3Acron%3Ajob-1&limit=2")
        );
        assert!(parsed.body.is_empty());
    }

    #[tokio::test]
    async fn accepts_get_history_without_content_length() {
        let (mut client, mut server) = tcp_pair().await.expect("TCP pair");
        client
            .write_all(
                b"GET /api/cron/session-history?sessionKey=a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
        let parsed = read_request(&mut server).await.unwrap().unwrap();
        assert_eq!(parsed.method, "GET");
        assert!(parsed.body.is_empty());
    }

    #[tokio::test]
    async fn rejects_get_history_with_nonzero_content_length_or_inline_body() {
        let (mut client, mut server) = tcp_pair().await.expect("TCP pair");
        client
            .write_all(
                b"GET /api/cron/session-history?sessionKey=a HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\n\r\nx",
            )
            .await
            .unwrap();
        let parsed = read_request(&mut server).await.unwrap();
        assert!(matches!(parsed, Err(Response { status: 400, .. })));
    }

    #[tokio::test]
    async fn requires_content_length_for_crud_post() {
        let (mut client, mut server) = tcp_pair().await.expect("TCP pair");
        client
            .write_all(b"POST /api/cron/jobs HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let parsed = read_request(&mut server).await.unwrap();
        assert!(matches!(parsed, Err(Response { status: 400, .. })));
    }

    #[test]
    fn response_reason_covers_gateway_timeout() {
        assert_eq!(Response::gateway_timeout().status, 504);
        assert_eq!(Response::gateway_timeout().body["success"], false);
    }
}
