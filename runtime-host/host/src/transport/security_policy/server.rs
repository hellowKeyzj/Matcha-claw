use std::{
    io,
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
use crate::{
    security::SecurityHandle,
    transport::{authorization::CapabilityDecisionVerifier, session_trace},
};

const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const PUBLIC_AUDIT_ENDPOINT: &str = "/api/security/audit";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
}
impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        security: SecurityHandle,
    ) -> io::Result<Self> {
        security
            .recover_pending()
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            security,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let security = self.security.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, security).await;
            });
        }
    }
}
async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, handle(&mut stream, verifier, security)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response.status, &response.body).await
}
async fn handle(
    stream: &mut TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> io::Result<Response> {
    let request = read_request(stream).await?;
    let trace_id = request.trace_id.as_deref();
    if request.method == "GET" {
        if request.path == READ_ENDPOINT {
            session_trace::log(
                "runtime.security.policy.request",
                trace_id,
                json!({ "method": &request.method, "endpoint": READ_ENDPOINT }),
            );
            if !verify_read(
                &verifier,
                request.authorization.as_deref(),
                READ_ENDPOINT,
                POLICY_READ_SUBJECT,
            )
            .await
            {
                session_trace::log(
                    "runtime.security.policy.authorization-rejected",
                    trace_id,
                    json!({ "status": 401, "contract": "unauthorized" }),
                );
                return Ok(Response::unauthorized());
            }
            let policy = match security.current_policy().await {
                Ok(policy) => policy,
                Err(_) => {
                    session_trace::log(
                        "runtime.security.policy.owner-error",
                        trace_id,
                        json!({ "status": 503, "contract": "owner-error" }),
                    );
                    return Err(io::Error::from(io::ErrorKind::Other));
                }
            };
            session_trace::log(
                "runtime.security.policy.response",
                trace_id,
                json!({ "status": 200, "contract": "policy" }),
            );
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
        let outcome = security
            .audit(query)
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
        return security
            .operation(correlation, operation_id, input)
            .await
            .map(|outcome| Response::from_security_operation(outcome))
            .map_err(|_| io::Error::from(io::ErrorKind::Other));
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
    let settlement = security
        .replace_policy(correlation, decision)
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
    Ok(Response::settled(settlement))
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
    fn settled(settlement: crate::security_delivery::Settlement) -> Self {
        match settlement.outcome {
            crate::security_delivery::Outcome::Rejected => {
                Self::fixed(422, "Security policy effect was rejected")
            }
            crate::security_delivery::Outcome::Confirmed
            | crate::security_delivery::Outcome::Unknown => Self::ok(json!({
                "desired": {
                    "revision": settlement.revision,
                    "outcome": settlement.outcome.as_str()
                }
            })),
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
