use platform::capability::CapabilityDecisionVerifier;

use std::{
    io,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::{
    AUDIT_ENDPOINT, AUDIT_READ_SUBJECT, DecodeError, ENDPOINT, OPERATION_ENDPOINT,
    POLICY_READ_SUBJECT, READ_CAPABILITY, READ_ENDPOINT, READ_SCOPE,
    OPERATION_RECEIPT_ENDPOINT, OPERATION_RECEIPT_SUBJECT, catalog, decode,
    decode_operation, wire::bearer_token,
};
use crate::{
    api::SecurityHandle,
    application::trace::security_trace,
    audit as security_audit,
    operation as security_operation,
};

const PUBLIC_AUDIT_ENDPOINT: &str = "/api/security/audit";

pub async fn handle_route(
    method: &str,
    path: &str,
    authorization: Option<&str>,
    trace_id: Option<&str>,
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> io::Result<platform::loopback::Response> {
    handle_request(
        super::wire::Request {
            method: method.to_owned(),
            path: path.to_owned(),
            authorization: authorization.map(str::to_owned),
            trace_id: trace_id.map(str::to_owned),
            body: body.to_vec(),
        },
        verifier,
        security,
    )
    .await
    .map(Into::into)
}

async fn handle_request(
    request: super::wire::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> io::Result<Response> {
    let trace_id = request.trace_id.as_deref();
    if request.method == "GET" {
        if request.path == READ_ENDPOINT {
            security_trace(
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
                security_trace(
                    "runtime.security.policy.authorization-rejected",
                    trace_id,
                    json!({ "status": 401, "contract": "unauthorized" }),
                );
                return Ok(Response::unauthorized());
            }
            let policy = match security.current_policy().await {
                Ok(policy) => policy,
                Err(_) => {
                    security_trace(
                        "runtime.security.policy.owner-error",
                        trace_id,
                        json!({ "status": 503, "contract": "owner-error" }),
                    );
                    return Err(io::Error::from(io::ErrorKind::Other));
                }
            };
            security_trace(
                "runtime.security.policy.response",
                trace_id,
                json!({ "status": 200, "contract": "policy" }),
            );
            return Ok(Response::policy(policy));
        }
        if let Some(platform) = catalog::parse_target(&request.path) {
            security.rule_catalog_call().await.map_err(|_| io::Error::from(io::ErrorKind::Other))?;
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
    if request.method == "POST" && request.path == OPERATION_RECEIPT_ENDPOINT {
        if !verify_read(&verifier, request.authorization.as_deref(), OPERATION_RECEIPT_ENDPOINT, OPERATION_RECEIPT_SUBJECT).await {
            return Ok(Response::operation_unauthorized());
        }
        let value = match serde_json::from_slice::<Value>(&request.body) {
            Ok(Value::Object(value)) if value.len() == 1 => value,
            _ => return Ok(Response::operation_bad_request()),
        };
        let Some(correlation) = value.get("correlation").and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256 && !value.contains('\0')) else {
            return Ok(Response::operation_bad_request());
        };
        return security.operation_receipt(correlation.to_owned()).await
            .map(|outcome| match outcome {
                Some(outcome) => Response::from_security_operation(outcome),
                None => Response::fixed(404, "Security operation receipt is not available"),
            }).map_err(|_| io::Error::from(io::ErrorKind::Other));
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
            .map(Response::accepted)
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
    let receipt = security
        .replace_policy(correlation, decision)
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::Other))?;
    Ok(Response::accepted(receipt))
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
impl From<Response> for platform::loopback::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }
    fn policy(policy: Value) -> Self {
        Self::ok(policy)
    }
    fn catalog(platform: Option<&str>) -> Self {
        Self::ok(catalog::response_body(platform))
    }
    fn from_audit(outcome: security_audit::Outcome) -> Self {
        match outcome {
            security_audit::Outcome::Observed(receipt) => Self::ok(json!({
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
            security_audit::Outcome::Rejected => {
                Self::fixed(422, "Security audit request was rejected")
            }
            security_audit::Outcome::Unavailable | security_audit::Outcome::Unknown => {
                Self::unavailable("Security audit is unavailable")
            }
        }
    }
    fn from_security_operation(outcome: security_operation::Outcome) -> Self {
        match outcome {
            security_operation::Outcome::Confirmed(body) => Self::ok(body),
            security_operation::Outcome::Rejected => {
                Self::fixed(422, "Security operation was rejected")
            }
            security_operation::Outcome::Unavailable | security_operation::Outcome::Unknown => {
                Self::unavailable("Security operation is unavailable")
            }
        }
    }
    fn accepted(receipt: platform::call::CallReceipt) -> Self {
        Self { status: 202, body: json!(receipt) }
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

fn parse_audit_target(path: &str) -> Result<Option<security_audit::Query>, ()> {
    let Some((pathname, query)) = path.split_once('?') else {
        return Ok(is_audit_endpoint(path)
            .then(|| security_audit::Query::new(1, 20))
            .flatten());
    };
    if !is_audit_endpoint(pathname) {
        return Ok(None);
    }
    if query.is_empty() {
        return Ok(security_audit::Query::new(1, 20));
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
    security_audit::Query::new(page.unwrap_or(1), page_size.unwrap_or(20))
        .ok_or(())
        .map(Some)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
