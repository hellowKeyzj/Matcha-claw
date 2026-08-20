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

use super::{AgentsRequest, Delivery, map_outcome};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const ROUTE: &str = "/api/subagents/agents";

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
    let request = match timeout(REQUEST_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => return Err(error),
        Err(_) => return write_response(&mut stream, Response::bad_request()).await,
    };
    let response = match request {
        Ok(request) => handle(request, verifier, owner).await,
        Err(response) => response,
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != ROUTE {
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
    let request = match AgentsRequest::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(_) => return Response::unauthorized(),
    };
    drop(verifier);
    let command = match request.command() {
        Ok(command) => command,
        Err(_) => return Response::bad_request(),
    };
    let outcome = match command {
        crate::agents::Command::List { endpoint } => owner.agents_list(endpoint).await,
        crate::agents::Command::Wait { endpoint, input } => {
            owner.agents_wait(endpoint, input).await
        }
        crate::agents::Command::Create { endpoint, input } => {
            owner.agents_create(endpoint, input).await
        }
        crate::agents::Command::Update { endpoint, input } => {
            owner.agents_update(endpoint, input).await
        }
        crate::agents::Command::Delete { endpoint, input } => {
            owner.agents_delete(endpoint, input).await
        }
        crate::agents::Command::ListFiles { endpoint, agent_id } => {
            owner.agents_files_list(endpoint, agent_id).await
        }
        crate::agents::Command::GetFile {
            endpoint,
            agent_id,
            name,
        } => owner.agents_files_get(endpoint, agent_id, name).await,
        crate::agents::Command::SetFile {
            endpoint,
            agent_id,
            name,
            content,
        } => {
            owner
                .agents_files_set(endpoint, agent_id, name, content)
                .await
        }
        crate::agents::Command::DisplayConfiguration { endpoint } => {
            owner.agents_configuration_display(endpoint).await
        }
        crate::agents::Command::SetDescription {
            endpoint,
            agent_id,
            description,
        } => {
            owner
                .agents_set_description(endpoint, agent_id, description)
                .await
        }
        crate::agents::Command::SetConfigurationModel {
            endpoint,
            agent_id,
            model,
        } => {
            owner
                .agents_set_configuration_model(endpoint, agent_id, model)
                .await
        }
        crate::agents::Command::SetSkills {
            endpoint,
            agent_id,
            skills,
        } => owner.agents_set_skills(endpoint, agent_id, skills).await,
        crate::agents::Command::SkillConfiguration { endpoint, agent_id } => {
            owner.agents_skill_configuration(endpoint, agent_id).await
        }
        crate::agents::Command::SetSkillConfiguration {
            endpoint,
            agent_id,
            revision,
            selection,
        } => {
            owner
                .agents_set_skill_configuration(endpoint, agent_id, revision, selection)
                .await
        }
        crate::agents::Command::ToolConfiguration { endpoint, agent_id } => {
            owner.agents_tool_configuration(endpoint, agent_id).await
        }
        crate::agents::Command::SetToolConfiguration {
            endpoint,
            agent_id,
            revision,
            selection,
        } => {
            owner
                .agents_set_tool_configuration(endpoint, agent_id, revision, selection)
                .await
        }
    };
    match outcome {
        Ok(outcome) => Response::from_delivery(map_outcome(outcome)),
        Err(_) => Response::from_delivery(Delivery::Unavailable),
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
        Self::fixed(400, "Subagent request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Subagent authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Subagent route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
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
    let content_length = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
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
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body =
        serde_json::to_vec(&response.body).expect("Subagent public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
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
