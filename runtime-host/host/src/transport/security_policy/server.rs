use std::{
    io,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use super::{
    AUDIT_ENDPOINT, AUDIT_READ_SUBJECT, DecodeError, ENDPOINT, OPERATION_ENDPOINT,
    POLICY_READ_SUBJECT, READ_CAPABILITY, READ_ENDPOINT, READ_SCOPE, catalog, decode,
    decode_operation,
    wire::{bearer_token, read_request, write_response},
};
use crate::transport::authorization::CapabilityDecisionVerifier;

const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const PUBLIC_AUDIT_ENDPOINT: &str = "/api/security/audit";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Arc<crate::security_delivery::Owner>,
    operation_owner: Arc<crate::security_operation::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
}
impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: Arc<crate::security_delivery::Owner>,
        state_dir: &Path,
        host: crate::owner::Handle,
    ) -> io::Result<Self> {
        let canonical_state_dir =
            openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let operation_owner = Arc::new(
            crate::security_operation::Owner::open(state_dir)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?,
        );
        let server = Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            owner,
            operation_owner,
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
                let outcome =
                    apply_policy_effect(self.state_dir.clone(), &self.host, desired).await;
                let _ = self.owner.settle(revision, outcome);
            })
            .await;
        let _ = self.operation_owner.recover_pending();
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let owner = Arc::clone(&self.owner);
            let operation_owner = Arc::clone(&self.operation_owner);
            let state_dir = self.state_dir.clone();
            let host = self.host.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, owner, operation_owner, state_dir, host).await;
            });
        }
    }
}
async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Arc<crate::security_delivery::Owner>,
    operation_owner: Arc<crate::security_operation::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
) -> io::Result<()> {
    let response = match timeout(
        REQUEST_DEADLINE,
        handle(
            &mut stream,
            verifier,
            owner,
            operation_owner,
            state_dir,
            host,
        ),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response.status, &response.body).await
}
async fn handle(
    stream: &mut TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Arc<crate::security_delivery::Owner>,
    operation_owner: Arc<crate::security_operation::Owner>,
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: crate::owner::Handle,
) -> io::Result<Response> {
    let request = read_request(stream).await?;
    if request.method == "GET" {
        if request.path == READ_ENDPOINT {
            if !verify_read(
                &verifier,
                request.authorization.as_deref(),
                READ_ENDPOINT,
                POLICY_READ_SUBJECT,
            )
            .await
            {
                return Ok(Response::unauthorized());
            }
            let policy = owner
                .policy()
                .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
            return Ok(Response::ok(policy));
        }
        if let Some(platform) = catalog::parse_target(&request.path) {
            return Ok(Response::catalog(platform.as_deref()));
        }
        let query = match parse_audit_target(&request.path) {
            Ok(Some(query)) => query,
            Ok(None) => return Ok(Response::not_found()),
            Err(()) => return Ok(Response::audit_bad_request()),
        };
        if !verify_read(
            &verifier,
            request.authorization.as_deref(),
            AUDIT_ENDPOINT,
            AUDIT_READ_SUBJECT,
        )
        .await
        {
            return Ok(Response::unauthorized());
        }
        let outcome = host
            .query_security_audit(query)
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
        return Ok(Response::from_audit(outcome));
    }
    if request.method == "POST" && request.path == OPERATION_ENDPOINT {
        let Some(token) = bearer_token(request.authorization.as_deref()) else {
            return Ok(Response::operation_unauthorized());
        };
        let value = match serde_json::from_slice::<Value>(&request.body) {
            Ok(value) => value,
            Err(_) => return Ok(Response::operation_bad_request()),
        };
        let mut verifier = verifier.lock().await;
        let (operation_id, correlation, input) =
            match decode_operation(value, token, &mut verifier, now_millis()) {
                Ok(value) => value,
                Err(DecodeError::Unauthorized) => return Ok(Response::operation_unauthorized()),
                Err(DecodeError::Invalid) => return Ok(Response::operation_bad_request()),
            };
        drop(verifier);
        return operation_owner
            .serialize_effect(async {
                if let Some(outcome) = operation_owner
                    .begin(&correlation)
                    .map_err(|_| io::Error::from(io::ErrorKind::Other))?
                {
                    return Ok(Response::from_security_operation(outcome));
                }
                let outcome = host
                    .security_operation(operation_id, input)
                    .await
                    .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
                let outcome = crate::security_operation::Outcome::from_native(outcome);
                operation_owner
                    .settle(&correlation, outcome.clone())
                    .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
                Ok(Response::from_security_operation(outcome))
            })
            .await;
    }
    if request.method != "POST" || request.path != ENDPOINT {
        return Ok(Response::not_found());
    }
    let Some(token) = bearer_token(request.authorization.as_deref()) else {
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
    let desired = match crate::security_delivery::Desired::try_from_wire(&decision) {
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
                    let outcome = apply_policy_effect(state_dir.clone(), &host, pending).await;
                    owner
                        .settle(revision, outcome)
                        .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
                    outcome
                }
                _ => crate::security_delivery::Outcome::Unknown,
            };
            Ok(Response::settled(revision, outcome))
        })
        .await
}
async fn apply_policy_effect(
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    host: &crate::owner::Handle,
    desired: crate::security_delivery::Desired,
) -> crate::security_delivery::Outcome {
    let policy = desired.into_policy();
    let runtime = match policy.get("runtime").and_then(Value::as_object) {
        Some(runtime) => runtime,
        None => return crate::security_delivery::Outcome::Rejected,
    };
    if openclaw::projection::security::apply_normalized(state_dir, runtime).is_err() {
        return crate::security_delivery::Outcome::Unknown;
    }
    match host.restart_open_claw().await {
        Ok(Ok(_)) => host
            .sync_security_policy(policy)
            .await
            .unwrap_or(crate::security_delivery::Outcome::Unknown),
        Ok(Err(_)) | Err(_) => crate::security_delivery::Outcome::Unknown,
    }
}

async fn verify_read(
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    authorization: Option<&str>,
    endpoint: &str,
    subject: &str,
) -> bool {
    let Some(token) = bearer_token(authorization) else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            now_millis(),
            endpoint,
            READ_SCOPE,
            READ_CAPABILITY,
            subject,
        )
        .is_ok()
}

struct Response {
    status: u16,
    body: Value,
}
impl Response {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }
    fn catalog(platform: Option<&str>) -> Self {
        Self::ok(catalog::response_body(platform))
    }
    fn from_audit(outcome: crate::security_audit::Outcome) -> Self {
        match outcome {
            crate::security_audit::Outcome::Observed(receipt) => Self::ok(json!({
                "page": receipt.page,
                "pageSize": receipt.page_size,
                "total": receipt.total,
                "items": receipt.items.into_iter().map(|item| {
                    let mut projected = json!({
                        "ts": item.ts,
                        "toolName": item.tool_name,
                        "risk": item.risk,
                        "action": item.action,
                        "decision": item.decision,
                    });
                    if let Some(rule_id) = item.rule_id {
                        projected["ruleId"] = Value::String(rule_id);
                    }
                    projected
                }).collect::<Vec<_>>(),
            })),
            crate::security_audit::Outcome::Rejected => {
                Self::fixed(422, "Security audit request was rejected")
            }
            crate::security_audit::Outcome::Unavailable
            | crate::security_audit::Outcome::Unknown => {
                Self::unavailable("Security audit is unavailable")
            }
        }
    }
    fn from_security_operation(outcome: crate::security_operation::Outcome) -> Self {
        match outcome {
            crate::security_operation::Outcome::Confirmed(value) => Self::ok(value),
            crate::security_operation::Outcome::Rejected => {
                Self::fixed(422, "Security operation was rejected")
            }
            crate::security_operation::Outcome::Unavailable
            | crate::security_operation::Outcome::Unknown => {
                Self::unavailable("Security operation is unavailable")
            }
        }
    }
    fn settled(revision: u64, outcome: crate::security_delivery::Outcome) -> Self {
        match outcome {
            crate::security_delivery::Outcome::Rejected => {
                Self::fixed(422, "Security policy effect was rejected")
            }
            crate::security_delivery::Outcome::Confirmed
            | crate::security_delivery::Outcome::Unknown => Self::ok(
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
    fn unavailable(error: &'static str) -> Self {
        Self::fixed(503, error)
    }
    fn bad_request() -> Self {
        Self::fixed(400, "Security policy request is invalid")
    }
    fn operation_bad_request() -> Self {
        Self::fixed(400, "Security operation request is invalid")
    }
    fn audit_bad_request() -> Self {
        Self::fixed(400, "Security audit request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Security policy authorization is invalid")
    }
    fn operation_unauthorized() -> Self {
        Self::fixed(401, "Security operation authorization is invalid")
    }
    fn not_found() -> Self {
        Self::fixed(404, "Security policy route is not available")
    }
}
fn is_audit_endpoint(path: &str) -> bool {
    path == AUDIT_ENDPOINT || path == PUBLIC_AUDIT_ENDPOINT
}

fn parse_audit_target(path: &str) -> Result<Option<crate::security_audit::Query>, ()> {
    let Some((pathname, query)) = path.split_once('?') else {
        return Ok(is_audit_endpoint(path)
            .then(|| crate::security_audit::Query::new(1, 20))
            .flatten());
    };
    if !is_audit_endpoint(pathname) {
        return Ok(None);
    }
    if query.is_empty() {
        return Ok(crate::security_audit::Query::new(1, 20));
    }
    let mut page = None;
    let mut page_size = None;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            return Err(());
        };
        if value.is_empty() {
            return Err(());
        }
        let parsed = value.parse::<u64>().map_err(|_| ())?;
        match name {
            "page" if page.replace(parsed).is_none() => {}
            "pageSize" if page_size.replace(parsed).is_none() => {}
            _ => return Err(()),
        }
    }
    crate::security_audit::Query::new(page.unwrap_or(1), page_size.unwrap_or(20))
        .ok_or(())
        .map(Some)
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod server_tests;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
