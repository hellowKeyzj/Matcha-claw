use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, SystemTime},
};

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

use crate::{
    composition::PeerHandle,
    facade::{PlatformRuntimeHandle, PluginsHandle, SkillsHandle, ToolchainHandle},
    host_actor,
    sessions::SessionHandle,
};

use super::{
    dispatch,
    wire::{DispatchRequest, DispatchResponse, HealthResponse, MAX_BODY_BYTES, VERSION},
};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const SHUTDOWN_RETRY_DELAY: Duration = Duration::from_millis(50);
const LIFECYCLE_RUNNING: u8 = 0;
const LIFECYCLE_STOPPING: u8 = 1;
const LIFECYCLE_STOPPED: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Lifecycle {
    Running,
    Stopping,
    Stopped,
    Error,
}

impl Lifecycle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Error => "error",
        }
    }
}

pub(crate) struct Server {
    listener: TcpListener,
    owner: host_actor::Handle,
    peer: PeerHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    session: SessionHandle,
    lifecycle: Arc<AtomicU8>,
    started_at: SystemTime,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        owner: host_actor::Handle,
        peer: PeerHandle,
        platform_runtime: PlatformRuntimeHandle,
        toolchain: ToolchainHandle,
        plugins: PluginsHandle,
        skills: SkillsHandle,
        session: SessionHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            owner,
            peer,
            platform_runtime,
            toolchain,
            plugins,
            skills,
            session,
            lifecycle: Arc::new(AtomicU8::new(LIFECYCLE_RUNNING)),
            started_at: SystemTime::now(),
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let owner = self.owner.clone();
            let peer = self.peer.clone();
            let platform_runtime = self.platform_runtime.clone();
            let toolchain = self.toolchain.clone();
            let plugins = self.plugins.clone();
            let skills = self.skills.clone();
            let session = self.session.clone();
            let lifecycle = Arc::clone(&self.lifecycle);
            let started_at = self.started_at;
            tokio::spawn(async move {
                let _ = serve(
                    stream,
                    owner,
                    peer,
                    platform_runtime,
                    toolchain,
                    plugins,
                    skills,
                    session,
                    lifecycle,
                    started_at,
                )
                .await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    owner: host_actor::Handle,
    peer: PeerHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    session: SessionHandle,
    lifecycle: Arc<AtomicU8>,
    started_at: SystemTime,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, read_request(&mut stream)).await {
        Ok(Ok(Ok(request))) => {
            handle(
                request,
                owner,
                peer,
                platform_runtime,
                toolchain,
                plugins,
                skills,
                session,
                lifecycle,
                started_at,
            )
            .await
        }
        Ok(Ok(Err(response))) => CompatibilityResponse::Dispatch(response),
        Ok(Err(_)) => CompatibilityResponse::Dispatch(DispatchResponse::bad_request(
            "Request could not be read",
        )),
        Err(_) => CompatibilityResponse::Dispatch(DispatchResponse::bad_request(
            "Request deadline exceeded",
        )),
    };
    write_json(&mut stream, response.status(), response.into_json()).await
}

async fn handle(
    request: Request,
    owner: host_actor::Handle,
    peer: PeerHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    session: SessionHandle,
    lifecycle: Arc<AtomicU8>,
    started_at: SystemTime,
) -> CompatibilityResponse {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => {
            CompatibilityResponse::Health(build_health_response(lifecycle, started_at))
        }
        ("POST", "/dispatch") => {
            if lifecycle_from_atomic(lifecycle.load(Ordering::Acquire)) != Lifecycle::Running {
                return CompatibilityResponse::Dispatch(stopped_dispatch_response());
            }
            let request = match serde_json::from_slice::<DispatchRequest>(&request.body) {
                Ok(request) => request,
                Err(_) => {
                    return CompatibilityResponse::Dispatch(DispatchResponse::bad_request(
                        "Dispatch envelope is invalid",
                    ));
                }
            };
            CompatibilityResponse::Dispatch(
                dispatch::execute(
                    &owner,
                    &peer,
                    &platform_runtime,
                    &toolchain,
                    &plugins,
                    &skills,
                    &session,
                    request,
                )
                .await,
            )
        }
        ("POST", "/lifecycle/restart") => {
            CompatibilityResponse::Dispatch(DispatchResponse::lifecycle_restart_unavailable())
        }
        ("POST", "/lifecycle/stop") => {
            let accepted = lifecycle
                .compare_exchange(
                    LIFECYCLE_RUNNING,
                    LIFECYCLE_STOPPING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok();
            if accepted {
                tokio::spawn(shutdown_until_terminal(
                    owner.clone(),
                    Arc::clone(&lifecycle),
                ));
            }
            let current = lifecycle_from_atomic(lifecycle.load(Ordering::Acquire));
            CompatibilityResponse::Dispatch(DispatchResponse::Success(
                super::wire::DispatchSuccess {
                    version: VERSION,
                    success: true,
                    status: 200,
                    data: serde_json::json!({
                        "lifecycle": if current == Lifecycle::Stopped { "stopped" } else { "accepted" }
                    }),
                },
            ))
        }
        _ => CompatibilityResponse::Dispatch(DispatchResponse::not_found(
            &request.method,
            &request.path,
        )),
    }
}

async fn shutdown_until_terminal(owner: host_actor::Handle, lifecycle: Arc<AtomicU8>) {
    loop {
        match owner.shutdown().await {
            Ok(attempt) if attempt.terminal => {
                lifecycle.store(LIFECYCLE_STOPPED, Ordering::Release);
                break;
            }
            Ok(_) => tokio::time::sleep(SHUTDOWN_RETRY_DELAY).await,
            Err(_) => break,
        }
    }
}

fn stopped_dispatch_response() -> DispatchResponse {
    DispatchResponse::Failure(super::wire::DispatchFailure {
        version: VERSION,
        success: false,
        status: 503,
        error: super::wire::ErrorBody {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Runtime Host is stopping".to_owned(),
        },
    })
}

enum CompatibilityResponse {
    Health(HealthResponse),
    Dispatch(DispatchResponse),
}

impl CompatibilityResponse {
    fn status(&self) -> u16 {
        match self {
            Self::Health(_) => 200,
            Self::Dispatch(response) => response.status(),
        }
    }

    fn into_json(self) -> Value {
        match self {
            Self::Health(response) => response.into_json(),
            Self::Dispatch(response) => response.into_json(),
        }
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_request(
    stream: &mut (impl AsyncRead + Unpin),
) -> io::Result<Result<Request, DispatchResponse>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(DispatchResponse::bad_request("Request is incomplete")));
        }
        if bytes.len() + read > MAX_HEADER_BYTES {
            return Ok(Err(DispatchResponse::bad_request(
                "Request headers are too large",
            )));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let header = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(header) => header,
        Err(_) => {
            return Ok(Err(DispatchResponse::bad_request(
                "Request headers are invalid",
            )));
        }
    };
    let mut lines = header.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(Err(DispatchResponse::bad_request(
            "Request line is invalid",
        )));
    };
    let mut parts = start.split_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(Err(DispatchResponse::bad_request(
            "Request line is invalid",
        )));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(DispatchResponse::bad_request(
            "HTTP version is invalid",
        )));
    }
    let method = method.to_owned();
    let path = path.to_owned();
    let mut content_length = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(DispatchResponse::bad_request(
                "Request header is invalid",
            )));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Ok(Err(DispatchResponse::bad_request(
                    "Content-Length is duplicated",
                )));
            }
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let content_length = content_length.unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Ok(Err(DispatchResponse::payload_too_large()));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(DispatchResponse::bad_request(
                "Request body is incomplete",
            )));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > header_end + MAX_BODY_BYTES {
            return Ok(Err(DispatchResponse::payload_too_large()));
        }
    }
    if bytes.len() != header_end + content_length {
        return Ok(Err(DispatchResponse::bad_request(
            "Request body is invalid",
        )));
    }
    Ok(Ok(Request {
        method,
        path,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_json(
    stream: &mut (impl AsyncWrite + Unpin),
    status: u16,
    value: Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(&value).expect("compatibility response serializable");
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
        .await?;
    stream.write_all(&body).await
}

fn build_health_response(lifecycle: Arc<AtomicU8>, started_at: SystemTime) -> HealthResponse {
    let lifecycle_value = lifecycle_from_atomic(lifecycle.load(Ordering::Acquire));
    HealthResponse {
        version: VERSION,
        ok: lifecycle_value == Lifecycle::Running,
        lifecycle: lifecycle_value.as_str(),
        pid: std::process::id(),
        uptime_sec: SystemTime::now()
            .duration_since(started_at)
            .unwrap_or_default()
            .as_secs(),
    }
}

fn lifecycle_from_atomic(value: u8) -> Lifecycle {
    match value {
        LIFECYCLE_RUNNING => Lifecycle::Running,
        LIFECYCLE_STOPPING => Lifecycle::Stopping,
        LIFECYCLE_STOPPED => Lifecycle::Stopped,
        _ => Lifecycle::Error,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicU8, Ordering},
        },
        time::{Duration, SystemTime},
    };

    use super::{
        CompatibilityResponse, LIFECYCLE_RUNNING, LIFECYCLE_STOPPED, LIFECYCLE_STOPPING, Lifecycle,
        VERSION, build_health_response, lifecycle_from_atomic, stopped_dispatch_response,
    };
    use crate::transport::compatibility::wire::DispatchResponse;

    #[test]
    fn lifecycle_stop_moves_through_stopping_before_terminal_stopped() {
        let lifecycle = Arc::new(AtomicU8::new(LIFECYCLE_RUNNING));

        let previous = lifecycle.swap(LIFECYCLE_STOPPING, Ordering::AcqRel);
        assert_eq!(previous, LIFECYCLE_RUNNING);
        assert_eq!(
            lifecycle_from_atomic(lifecycle.load(Ordering::Acquire)),
            Lifecycle::Stopping
        );

        lifecycle.store(LIFECYCLE_STOPPED, Ordering::Release);
        assert_eq!(
            lifecycle_from_atomic(lifecycle.load(Ordering::Acquire)),
            Lifecycle::Stopped
        );
    }

    #[test]
    fn repeated_stop_reports_stopped_without_restarting_shutdown() {
        let lifecycle = Arc::new(AtomicU8::new(LIFECYCLE_STOPPED));

        let accepted = lifecycle
            .compare_exchange(
                LIFECYCLE_RUNNING,
                LIFECYCLE_STOPPING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();

        assert!(!accepted);
        assert_eq!(
            lifecycle_from_atomic(lifecycle.load(Ordering::Acquire)),
            Lifecycle::Stopped,
        );
    }

    #[test]
    fn stopped_dispatch_response_uses_stable_transport_unavailable_envelope() {
        let response = stopped_dispatch_response().into_json();

        assert_eq!(response["version"], 1);
        assert_eq!(response["success"], false);
        assert_eq!(response["status"], 503);
        assert_eq!(response["error"]["code"], "UPSTREAM_UNAVAILABLE");
        assert_eq!(response["error"]["message"], "Runtime Host is stopping");
    }

    #[test]
    fn lifecycle_restart_unavailable_uses_stable_transport_envelope() {
        let response = DispatchResponse::lifecycle_restart_unavailable().into_json();

        assert_eq!(response["version"], 1);
        assert_eq!(response["success"], false);
        assert_eq!(response["status"], 503);
        assert_eq!(response["error"]["code"], "UPSTREAM_UNAVAILABLE");
        assert_eq!(
            response["error"]["message"],
            "Runtime Host lifecycle restart is unavailable"
        );
    }

    #[test]
    fn root_health_response_is_not_dispatch_envelope() {
        let lifecycle = Arc::new(AtomicU8::new(LIFECYCLE_RUNNING));
        let response = CompatibilityResponse::Health(build_health_response(
            lifecycle,
            SystemTime::now() - Duration::from_secs(12),
        ));

        assert_eq!(response.status(), 200);
        let payload = response.into_json();
        assert_eq!(payload["version"], VERSION);
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["lifecycle"], "running");
        assert_eq!(payload["pid"], std::process::id());
        assert!(payload["uptimeSec"].as_u64().unwrap() >= 12);
        assert!(payload.get("success").is_none());
        assert!(payload.get("status").is_none());
        assert!(payload.get("data").is_none());
    }

    #[test]
    fn invalid_lifecycle_state_projects_safe_error_health() {
        let lifecycle = Arc::new(AtomicU8::new(u8::MAX));
        let payload = build_health_response(lifecycle, SystemTime::now()).into_json();

        assert_eq!(payload["version"], VERSION);
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["lifecycle"], "error");
    }
}
