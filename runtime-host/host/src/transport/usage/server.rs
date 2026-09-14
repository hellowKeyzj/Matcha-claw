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

use crate::{facade::UsageHandle, transport::authorization::CapabilityDecisionVerifier};

use super::{DecodeError, UsageDelivery, decode_limit};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const PATH: &str = "/api/usage/recent";
const SESSION_TIMESERIES_PATH: &str = "/api/usage/session-timeseries";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    usage: UsageHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        usage: UsageHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            usage,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let usage = self.usage.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, usage).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    usage: UsageHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, usage).await,
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
    usage: UsageHandle,
) -> Response {
    if request.method != "GET" || !matches!(request.route, Route::Recent | Route::SessionTimeseries)
    {
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
    let mut verifier = verifier.lock().await;
    let limit = match decode_limit(
        authorization,
        request.limit.as_deref(),
        &mut verifier,
        now_millis(),
    ) {
        Ok(limit) => limit,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    let result = match request.route {
        Route::Recent => usage.recent(limit).await,
        Route::SessionTimeseries => {
            usage
                .session_timeseries(&request.agent_id, &request.session_id)
                .await
        }
        Route::Unknown => return Response::not_found(),
    };
    Response::from_delivery(UsageDelivery::from_native(result))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Route {
    Recent,
    SessionTimeseries,
    Unknown,
}

struct Request {
    method: String,
    route: Route,
    limit: Option<String>,
    session_id: String,
    agent_id: String,
    headers: Vec<(String, String)>,
}

#[derive(Debug)]
struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "OpenClaw usage history request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "OpenClaw usage history authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "OpenClaw usage history route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: UsageDelivery) -> Self {
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
        if read == 0 || bytes.len() + read > MAX_HEADER_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
    };
    if bytes.len() != header_end {
        return Ok(Err(Response::bad_request()));
    }
    parse_headers(&bytes)
}

fn parse_headers(bytes: &[u8]) -> io::Result<Result<Request, Response>> {
    let headers = match std::str::from_utf8(bytes) {
        Ok(value) => value,
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = headers.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(Err(Response::bad_request()));
    };
    let mut parts = start.split_whitespace();
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(Response::bad_request()));
    }
    let target = match target.split_once('?') {
        Some((pathname, query)) => (pathname, Some(query)),
        None => (target, None),
    };
    let query = match parse_query(target.0, target.1) {
        Ok(query) => query,
        Err(()) => return Ok(Err(Response::bad_request())),
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
        if name.is_empty()
            || parsed_headers.len() == MAX_HEADERS
            || parsed_headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        parsed_headers.push((name, value.trim().to_owned()));
    }
    Ok(Ok(Request {
        method: method.to_owned(),
        route: query.route,
        limit: query.limit,
        session_id: query.session_id,
        agent_id: query.agent_id,
        headers: parsed_headers,
    }))
}

struct Query {
    route: Route,
    limit: Option<String>,
    session_id: String,
    agent_id: String,
}

fn parse_query(pathname: &str, query: Option<&str>) -> Result<Query, ()> {
    let route = match pathname {
        PATH => Route::Recent,
        SESSION_TIMESERIES_PATH => Route::SessionTimeseries,
        _ => Route::Unknown,
    };
    let mut limit = None;
    let mut session_id = None;
    let mut agent_id = None;
    if let Some(query) = query {
        for pair in query.split('&') {
            let Some((name, value)) = pair.split_once('=') else {
                return Err(());
            };
            let name = percent_decode_query_component(name).ok_or(())?;
            let value = percent_decode_query_component(value).ok_or(())?;
            match name.as_str() {
                "limit" if limit.is_none() => limit = Some(value),
                "sessionId" if session_id.is_none() => session_id = Some(value),
                "agentId" if agent_id.is_none() => agent_id = Some(value),
                _ => return Err(()),
            }
        }
    }
    match route {
        Route::Recent if session_id.is_some() || agent_id.is_some() => return Err(()),
        Route::SessionTimeseries
            if session_id.is_none() || agent_id.is_none() || limit.is_some() =>
        {
            return Err(());
        }
        _ => {}
    }
    Ok(Query {
        route,
        limit,
        session_id: session_id.unwrap_or_default(),
        agent_id: agent_id.unwrap_or_default(),
    })
}

fn percent_decode_query_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        match byte {
            b'+' => bytes.push(b' '),
            b'%' => {
                let high = hex(input.next()?)?;
                let low = hex(input.next()?)?;
                bytes.push((high << 4) | low);
            }
            byte => bytes.push(byte),
        }
    }
    String::from_utf8(bytes).ok()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("Usage public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
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
    use super::*;

    #[test]
    fn parses_only_the_fixed_limit_query() {
        let request = parse_headers(
            b"GET /api/usage/recent?limit=12 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer signed\r\n\r\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(request.route, Route::Recent);
        assert_eq!(request.limit.as_deref(), Some("12"));
        assert_eq!(request.headers.len(), 2);

        for target in [
            "/api/usage/recent?other=value",
            "/api/usage/recent?limit=1&limit=2",
            "/api/usage/recent?limit",
            "/api/usage/recent?",
            "/api/usage/recent?sessionId=session-1",
            "/api/usage/recent?sessionKey=agent:main:session-1",
            "/api/usage/session-timeseries",
            "/api/usage/session-timeseries?limit=1&sessionId=session-1&agentId=main",
            "/api/usage/session-timeseries?sessionId=session-1&agentId=main&agentId=other",
        ] {
            let response = parse_headers(
                format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes(),
            )
            .unwrap();
            assert!(matches!(response, Err(Response { status: 400, .. })));
        }
    }

    #[test]
    fn parses_session_timeseries_query() {
        let request = parse_headers(
            b"GET /api/usage/session-timeseries?sessionId=session-1&agentId=main HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer signed\r\n\r\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(request.route, Route::SessionTimeseries);
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.agent_id, "main");
    }

    #[test]
    fn fixed_error_responses_do_not_echo_request_content() {
        for response in [
            Response::bad_request(),
            Response::unauthorized(),
            Response::not_found(),
        ] {
            let body = response.body.to_string();
            assert!(!body.contains("private"));
            assert!(!body.contains("/agents/"));
            assert!(!body.contains("transcript"));
        }
    }
}
