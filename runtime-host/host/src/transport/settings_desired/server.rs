use std::{
    io,
    path::Path,
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
    owner: Arc<crate::settings_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        state_dir: &Path,
        host: crate::owner::Handle,
    ) -> io::Result<Self> {
        let owner = crate::settings_delivery::Owner::open(state_dir)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let canonical_state_dir =
            openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let server = Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            owner: Arc::new(owner),
            state_dir: canonical_state_dir,
            host,
        };
        server.recover_pending().await;
        Ok(server)
    }
    async fn recover_pending(&self) {
        self.owner
            .serialize_effect(async {
                let Ok(Some((revision, desired))) = self.owner.pending() else {
                    return;
                };
                let (effect, restarted) =
                    apply_and_restart(self.state_dir.clone(), &desired, &self.host).await;
                let outcome = settle_outcome(effect, restarted);
                let _ = self.owner.settle(revision, outcome);
            })
            .await;
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let owner = Arc::clone(&self.owner);
            let state_dir = self.state_dir.clone();
            let host = self.host.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, owner, state_dir, host).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Arc<crate::settings_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
) -> io::Result<()> {
    let response = match timeout(
        REQUEST_DEADLINE,
        handle(&mut stream, verifier, owner, state_dir, host),
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
    owner: Arc<crate::settings_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
) -> io::Result<Response> {
    let request = read_request(stream).await?;
    if request.method == "GET" && request.path == READ_ENDPOINT {
        let settings = owner
            .desired_snapshot()
            .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
        return Ok(Response::ok(settings));
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
    let desired = match crate::settings_delivery::Desired::try_from_wire(&decision) {
        Ok(desired) => desired,
        Err(()) => return Ok(Response::bad_request()),
    };
    owner
        .serialize_effect(async {
            let (revision, prior_outcome) = owner
                .replace(&correlation, desired)
                .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
            if let Some(prior_outcome) = prior_outcome {
                return Ok(Response::settled(revision, prior_outcome));
            }
            let outcome = match owner
                .pending()
                .map_err(|_| io::Error::from(io::ErrorKind::Other))?
            {
                Some((pending_revision, pending)) if pending_revision == revision => {
                    let (effect, restarted) =
                        apply_and_restart(state_dir.clone(), &pending, &host).await;
                    let outcome = settle_outcome(effect, restarted);
                    owner
                        .settle(revision, outcome)
                        .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
                    outcome
                }
                _ => crate::settings_delivery::Outcome::Unknown,
            };
            Ok(Response::settled(revision, outcome))
        })
        .await
}

#[derive(Debug, Eq, PartialEq)]
enum EffectError {
    Rejected,
    Unknown,
}

fn settle_outcome(
    effect: Result<(), EffectError>,
    restarted: bool,
) -> crate::settings_delivery::Outcome {
    match effect {
        Ok(()) if restarted => crate::settings_delivery::Outcome::Confirmed,
        Ok(()) | Err(EffectError::Unknown) => crate::settings_delivery::Outcome::Unknown,
        Err(EffectError::Rejected) => crate::settings_delivery::Outcome::Rejected,
    }
}

fn restart_succeeded(changed: bool, restarted: bool) -> bool {
    !changed || restarted
}

async fn apply_and_restart(
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    desired: &crate::settings_delivery::Desired,
    host: &crate::owner::Handle,
) -> (Result<(), EffectError>, bool) {
    let changed = match apply_settings(state_dir, desired) {
        Ok(changed) => changed,
        Err(error) => return (Err(error), false),
    };
    let restarted = if changed {
        matches!(host.restart_open_claw().await, Ok(Ok(_)))
    } else {
        false
    };
    (Ok(()), restart_succeeded(changed, restarted))
}

fn apply_settings(
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    desired: &crate::settings_delivery::Desired,
) -> Result<bool, EffectError> {
    openclaw::projection::settings::apply(
        state_dir,
        desired.browser_mode(),
        desired.proxy_endpoint(),
    )
    .map_err(map_projection_error)
}

fn map_projection_error(
    error: openclaw::projection::settings::SettingsProjectionError,
) -> EffectError {
    match error {
        openclaw::projection::settings::SettingsProjectionError::InvalidProxy => {
            EffectError::Rejected
        }
        openclaw::projection::settings::SettingsProjectionError::ConfigStore => {
            EffectError::Unknown
        }
    }
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
    fn settled(revision: u64, outcome: crate::settings_delivery::Outcome) -> Self {
        match outcome {
            crate::settings_delivery::Outcome::Rejected => {
                Self::fixed(422, "Settings desired request was rejected")
            }
            crate::settings_delivery::Outcome::Confirmed
            | crate::settings_delivery::Outcome::Unknown => Self::ok(
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
    use std::{
        fs,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::{EffectError, Response, map_projection_error, restart_succeeded, settle_outcome};
    use crate::settings_delivery::Outcome;

    #[test]
    fn unchanged_projection_confirms_without_a_restart() {
        assert!(restart_succeeded(false, false));
        assert_eq!(
            settle_outcome(Ok(()), restart_succeeded(false, false)),
            Outcome::Confirmed
        );
    }

    #[test]
    fn changed_projection_requires_a_successful_restart() {
        assert!(!restart_succeeded(true, false));
        assert!(restart_succeeded(true, true));
        assert_eq!(
            settle_outcome(Ok(()), restart_succeeded(true, false)),
            Outcome::Unknown
        );
    }

    #[test]
    fn projection_failures_keep_their_distinct_outcomes() {
        assert_eq!(
            map_projection_error(
                openclaw::projection::settings::SettingsProjectionError::InvalidProxy
            ),
            EffectError::Rejected
        );
        assert_eq!(
            map_projection_error(
                openclaw::projection::settings::SettingsProjectionError::ConfigStore
            ),
            EffectError::Unknown
        );
        assert_eq!(
            settle_outcome(Err(EffectError::Rejected), false),
            Outcome::Rejected
        );
        assert_eq!(
            settle_outcome(Err(EffectError::Unknown), false),
            Outcome::Unknown
        );
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

    #[tokio::test]
    async fn owner_serializes_effect_operations() {
        let root = std::env::temp_dir().join(format!(
            "settings-desired-transport-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let owner = Arc::new(crate::settings_delivery::Owner::open(&root).unwrap());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));

        let first = serialized_probe(
            Arc::clone(&owner),
            Arc::clone(&active),
            Arc::clone(&maximum),
        );
        let second = serialized_probe(owner, active, maximum.clone());
        tokio::join!(first, second);

        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(root);
    }

    async fn serialized_probe(
        owner: Arc<crate::settings_delivery::Owner>,
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
    ) {
        owner
            .serialize_effect(async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(current, Ordering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, Ordering::SeqCst);
            })
            .await;
    }
}
