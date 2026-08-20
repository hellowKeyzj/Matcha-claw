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

use crate::{
    security_emergency::SecurityEmergencyOutcome,
    transport::authorization::CapabilityDecisionVerifier,
};

use super::{DecodeError, SecurityEmergencyDelivery, decode};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    policy: Arc<crate::security_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    owner: crate::owner::Handle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        policy: Arc<crate::security_delivery::Owner>,
        state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
        owner: crate::owner::Handle,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        Ok(Self {
            listener,
            verifier: Arc::new(Mutex::new(verifier)),
            policy,
            state_dir,
            owner,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let policy = Arc::clone(&self.policy);
            let state_dir = self.state_dir.clone();
            let owner = self.owner.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, policy, state_dir, owner).await;
            });
        }
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    policy: Arc<crate::security_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    owner: crate::owner::Handle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => handle(request, verifier, policy, state_dir, owner).await,
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
    policy: Arc<crate::security_delivery::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    owner: crate::owner::Handle,
) -> Response {
    if request.method != "POST" || request.path != "/api/security/emergency" {
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
    let correlation = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(correlation) => correlation,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    policy
        .serialize_effect(async {
            let desired = match policy
                .policy()
                .and_then(crate::security_delivery::emergency_lockdown)
            {
                Ok(desired) => desired,
                Err(()) => return Response::unavailable(),
            };
            let (revision, prior_outcome) = match policy.replace(&correlation, desired) {
                Ok(result) => result,
                Err(()) => return Response::unavailable(),
            };
            if prior_outcome
                .is_some_and(|outcome| outcome != crate::security_delivery::Outcome::Confirmed)
            {
                return Response::from_delivery(SecurityEmergencyOutcome::OutcomeUnknown.into());
            }
            let outcome = match policy.pending() {
                Ok(Some((pending_revision, pending))) if pending_revision == revision => {
                    let outcome = match apply_policy(state_dir, pending) {
                        Ok(()) => match owner.restart_open_claw().await {
                            Ok(Ok(_)) => crate::security_delivery::Outcome::Confirmed,
                            Ok(Err(_)) | Err(_) => crate::security_delivery::Outcome::Unknown,
                        },
                        Err(EffectError::Rejected) => crate::security_delivery::Outcome::Rejected,
                        Err(EffectError::Unknown) => crate::security_delivery::Outcome::Unknown,
                    };
                    if policy.settle(revision, outcome).is_err() {
                        return Response::from_delivery(
                            SecurityEmergencyOutcome::OutcomeUnknown.into(),
                        );
                    }
                    outcome
                }
                Ok(None) if prior_outcome == Some(crate::security_delivery::Outcome::Confirmed) => {
                    crate::security_delivery::Outcome::Confirmed
                }
                _ => crate::security_delivery::Outcome::Unknown,
            };
            if outcome != crate::security_delivery::Outcome::Confirmed {
                return Response::from_delivery(SecurityEmergencyOutcome::OutcomeUnknown.into());
            }
            match owner.run_security_emergency().await {
                Ok(SecurityEmergencyOutcome::Applied) => {
                    Response::from_delivery(SecurityEmergencyOutcome::Applied.into())
                }
                Ok(SecurityEmergencyOutcome::Rejected) => {
                    Response::from_delivery(SecurityEmergencyOutcome::Rejected.into())
                }
                Ok(
                    SecurityEmergencyOutcome::OutcomeUnknown
                    | SecurityEmergencyOutcome::Unavailable,
                )
                | Err(_) => {
                    Response::from_delivery(SecurityEmergencyOutcome::OutcomeUnknown.into())
                }
            }
        })
        .await
}

enum EffectError {
    Rejected,
    Unknown,
}

fn apply_policy(
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    desired: crate::security_delivery::Desired,
) -> Result<(), EffectError> {
    let policy = desired.into_policy();
    let runtime = policy
        .get("runtime")
        .and_then(Value::as_object)
        .ok_or(EffectError::Rejected)?;
    openclaw::projection::security::apply_normalized(state_dir, runtime)
        .map(|_| ())
        .map_err(|_| EffectError::Unknown)
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
        Self::fixed(400, "Security emergency request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Security emergency authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Security emergency route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SecurityEmergencyDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SecurityEmergencyDelivery) -> Self {
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
    let (method, path, parsed_headers) = {
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
        (method.to_owned(), path.to_owned(), parsed_headers)
    };
    let content_length = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let Some(content_length) = content_length else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length != 2 {
        return Ok(Err(Response::bad_request()));
    }
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
    let body = serde_json::to_vec(&response.body)
        .expect("Security emergency public response is serializable");
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

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
