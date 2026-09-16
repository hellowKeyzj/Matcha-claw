use std::{
    io,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use crate::transport::common::authorization::CapabilityDecisionVerifier;

use crate::provider::accounts::ProviderAccountsDelivery;

use super::{ProviderAccountsRequest, RequestError};

const ENDPOINT: &str = "/api/provider-accounts";
const AUTHORIZATION_SCOPE: &str = "providers:accounts";
const AUTHORIZATION_SUBJECT: &str = "provider-accounts";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: crate::provider::ProviderHandle,
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
    owner: crate::provider::ProviderHandle,
) -> io::Result<()> {
    let started = Instant::now();
    let response = match timeout(REQUEST_READ_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(Ok(request))) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=request-read detail=received elapsed_ms={}",
                started.elapsed().as_millis()
            );
            let handling_started = Instant::now();
            let response = handle(request, verifier, owner).await;
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=request-handle detail=completed status={} elapsed_ms={}",
                response.status,
                handling_started.elapsed().as_millis()
            );
            response
        }
        Ok(Ok(Err(response))) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=request-read detail=invalid elapsed_ms={}",
                started.elapsed().as_millis()
            );
            response
        }
        Ok(Err(error)) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=request-read detail=io-error elapsed_ms={}",
                started.elapsed().as_millis()
            );
            return Err(error);
        }
        Err(_) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=request-read detail=timeout elapsed_ms={}",
                started.elapsed().as_millis()
            );
            Response::fixed(408, "Request reception timed out")
        }
    };
    let write_started = Instant::now();
    let result = write_response(&mut stream, response).await;
    eprintln!(
        "[startup-trace] source=provider-accounts-transport phase=response-write detail={} elapsed_ms={}",
        match &result {
            Ok(()) => "written",
            Err(_) => "io-error",
        },
        write_started.elapsed().as_millis()
    );
    result
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if request.method == "GET" {
        let (path, query) = request
            .path
            .split_once('?')
            .map_or((request.path.as_str(), None), |(path, query)| {
                (path, Some(query))
            });
        if query.is_some() {
            return Response::bad_request();
        }
        return match path {
            ENDPOINT => handle_get_list(request, verifier, owner).await,
            path if path.starts_with("/api/provider-accounts/") => {
                handle_get_account(request, verifier, owner).await
            }
            _ => Response::not_found(),
        };
    }
    if request.method != "POST" || request.path != ENDPOINT {
        return Response::not_found();
    }
    let Some(authorization) = authorization(&request.headers) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command = match ProviderAccountsRequest::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    )
    .and_then(ProviderAccountsRequest::into_command)
    {
        Ok(command) => command,
        Err(RequestError::Invalid) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=decode detail=invalid-request"
            );
            return Response::bad_request();
        }
        Err(RequestError::Unauthorized) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=decode detail=unauthorized"
            );
            return Response::unauthorized();
        }
    };
    log_command("decode", &command);
    drop(verifier);
    let delivery = match command {
        super::ProviderAccountsCommand::List => owner.list_provider_accounts().await,
        super::ProviderAccountsCommand::Get(id) => owner.get_provider_account(id).await,
        super::ProviderAccountsCommand::Replace(draft) => {
            owner.replace_provider_account(draft).await
        }
        super::ProviderAccountsCommand::Delete(id, revision) => {
            owner.delete_provider_account(id, revision).await
        }
    };
    Response::from_delivery(delivery.unwrap_or(ProviderAccountsDelivery::Unavailable))
}

async fn handle_get_list(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !request.body.is_empty() {
        return Response::bad_request();
    }
    if !verify_get_authorization(
        &request.headers,
        &verifier,
        ENDPOINT,
        "providerAccounts.list",
    )
    .await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .list_provider_accounts()
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn handle_get_account(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !request.body.is_empty() {
        return Response::bad_request();
    }
    let Some(id) = request.path.strip_prefix("/api/provider-accounts/") else {
        return Response::not_found();
    };
    if id.is_empty() || id.contains('/') {
        return Response::not_found();
    }
    let Ok(id) = environment::ProviderAccountId::try_new(id.to_owned()) else {
        return Response::bad_request();
    };
    if !verify_get_authorization(
        &request.headers,
        &verifier,
        request.path.as_str(),
        "providerAccounts.get",
    )
    .await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .get_provider_account(id)
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn verify_get_authorization(
    headers: &[(String, String)],
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    capability: &str,
) -> bool {
    let Some(token) = authorization(headers) else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

fn authorization(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
}

fn log_command(phase: &str, command: &super::ProviderAccountsCommand) {
    match command {
        super::ProviderAccountsCommand::List => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=list"
        ),
        super::ProviderAccountsCommand::Get(id) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=get account_id_len={}",
            id.as_str().len()
        ),
        super::ProviderAccountsCommand::Replace(draft) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=replace provider={} auth_mode={} kind={} enabled={} revision={} endpoint_present={} protocol={} media_protocol={}",
            draft.provider(),
            draft.auth_mode(),
            draft.kind(),
            draft.enabled(),
            draft.revision_value(),
            draft.has_endpoint(),
            draft.protocol().unwrap_or("none"),
            draft.media_protocol().unwrap_or("none")
        ),
        super::ProviderAccountsCommand::Delete(id, revision) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=delete account_id_len={} revision={}",
            id.as_str().len(),
            revision.get()
        ),
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
        Self::fixed(400, "Provider account request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider account authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Provider account route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ProviderAccountsDelivery) -> Self {
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
        Ok(value) => value.to_owned(),
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
    if parsed_headers
        .iter()
        .any(|(name, _)| name == "transfer-encoding")
    {
        return Ok(Err(Response::bad_request()));
    }
    let content_length_header = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| value);
    let content_length = match content_length_header {
        Some(value) => match value.parse::<usize>() {
            Ok(value) => value,
            Err(_) => return Ok(Err(Response::bad_request())),
        },
        None if method == "GET" && is_get_path(path) && bytes.len() == header_end => 0,
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
    if method == "GET" && is_get_path(path) && content_length != 0 {
        return Ok(Err(Response::bad_request()));
    }
    Ok(Ok(Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

fn is_get_path(path: &str) -> bool {
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    path == ENDPOINT || path.starts_with("/api/provider-accounts/")
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body =
        serde_json::to_vec(&response.body).expect("Provider account response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        422 => "Unprocessable Content",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
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
