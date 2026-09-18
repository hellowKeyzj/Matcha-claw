use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{
    DecodeError, Delivery, Request as TeamTriggerRequest, WebhookToken, decode,
    decode_webhook_auth, handle,
};
use crate::transport::common::authorization::CapabilityDecisionVerifier;

#[cfg(test)]
#[path = "handler_tests.rs"]
mod handler_tests;

pub(crate) const MAX_MANAGEMENT_BODY_BYTES: usize = 256 * 1024;
pub(crate) const MAX_WEBHOOK_BODY_BYTES: usize = 64 * 1024;
pub(crate) const MANAGEMENT_ROUTE: &str = "/api/team/trigger";
pub(crate) const WEBHOOK_AUTH_ROUTE: &str = "/api/team/webhook-auth";
pub(crate) const WEBHOOK_ROUTE_PREFIX: &str = "/api/team-runtime/webhooks";

pub(crate) async fn handle_localhost(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: WebhookToken,
    owner: crate::organization::OrganizationHandle,
) -> crate::transport::localhost::Response {
    handle_request(
        Request {
            method,
            path,
            headers,
            body,
        },
        verifier,
        webhook_token,
        owner,
    )
    .await
    .into_localhost()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: WebhookToken,
    owner: crate::organization::OrganizationHandle,
) -> Response {
    if request.path == MANAGEMENT_ROUTE {
        return handle_management_request(request, verifier, &webhook_token, owner).await;
    }
    if request.path == WEBHOOK_AUTH_ROUTE {
        return handle_webhook_auth_request(request, verifier, &webhook_token).await;
    }
    if is_webhook_route(&request.path) {
        return handle_webhook_request(request, &webhook_token, owner).await;
    }
    Response::not_found()
}

async fn handle_webhook_auth_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: &WebhookToken,
) -> Response {
    if request.method != "POST" {
        return Response::not_found();
    }
    let Some(authorization) = request.header("authorization").and_then(bearer_token) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    match decode_webhook_auth(value, authorization, &mut verifier, now_millis()) {
        Ok(()) => Response::from_delivery(Delivery::Auth(webhook_token.public_auth_projection())),
        Err(DecodeError::Unauthorized) => Response::unauthorized(),
        Err(DecodeError::Invalid) => Response::bad_request(),
    }
}

async fn handle_management_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: &WebhookToken,
    owner: crate::organization::OrganizationHandle,
) -> Response {
    if request.method != "POST" {
        return Response::not_found();
    }
    let Some(authorization) = request.header("authorization").and_then(bearer_token) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(handle(&owner, webhook_token, request, now_millis()).await)
}

async fn handle_webhook_request(
    request: Request,
    webhook_token: &WebhookToken,
    owner: crate::organization::OrganizationHandle,
) -> Response {
    if request.method != "POST" {
        return Response::method_not_allowed();
    }
    let Some(token) = request
        .header("authorization")
        .and_then(bearer_token)
        .or_else(|| request.header("x-matchaclaw-webhook-token"))
    else {
        return Response::webhook_unauthorized();
    };
    if !webhook_token.matches(token) {
        return Response::webhook_unauthorized();
    }
    let Some(path) = webhook_path(&request.path) else {
        return Response::not_found();
    };
    let idempotency_key = match request.header("x-idempotency-key") {
        Some(value) => match opaque_id(value) {
            Some(value) => value,
            None => return Response::bad_request(),
        },
        None => match generated_idempotency_key() {
            Some(value) => value,
            None => return Response::unavailable(),
        },
    };

    let delivery = handle(
        &owner,
        webhook_token,
        TeamTriggerRequest::Webhook {
            path,
            idempotency_key,
        },
        now_millis(),
    )
    .await;
    Response::from_webhook_delivery(delivery)
}

fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
        .filter(|token| !token.is_empty())
}

pub(crate) fn is_webhook_route(path: &str) -> bool {
    path == WEBHOOK_ROUTE_PREFIX || path.starts_with(&format!("{WEBHOOK_ROUTE_PREFIX}/"))
}

fn webhook_path(value: &str) -> Option<String> {
    let path = value
        .strip_prefix(WEBHOOK_ROUTE_PREFIX)?
        .strip_prefix('/')?;
    let path = percent_decode(path)?;
    let path = path.trim().trim_matches('/');
    (!path.is_empty() && !path.contains("..") && !path.chars().any(char::is_control))
        .then(|| path.to_owned())
}

fn percent_decode(value: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut bytes = value.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }
        let high = hex_value(bytes.next()?)?;
        let low = hex_value(bytes.next()?)?;
        decoded.push(high << 4 | low);
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn max_body_bytes(path: &str) -> usize {
    if is_webhook_route(path) {
        MAX_WEBHOOK_BODY_BYTES
    } else {
        MAX_MANAGEMENT_BODY_BYTES
    }
}

fn opaque_id(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')))
    .then(|| value.to_owned())
}

fn generated_idempotency_key() -> Option<String> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).ok()?;
    Some(format!("webhook:{}", URL_SAFE_NO_PAD.encode(entropy)))
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn from_webhook_delivery(delivery: Delivery) -> Self {
        let status = match delivery {
            Delivery::Fired { .. } => 202,
            _ => delivery.status_code(),
        };
        Self {
            status,
            body: delivery.body(),
        }
    }

    fn bad_request() -> Self {
        Self::fixed(400, "Team trigger request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Team trigger is unavailable")
    }

    fn webhook_unauthorized() -> Self {
        Self::fixed(401, "TeamRun webhook token is required")
    }

    fn method_not_allowed() -> Self {
        Self::fixed(405, "TeamRun webhook only accepts POST requests")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Team trigger is unavailable")
    }

    fn unavailable() -> Self {
        Self::fixed(503, "Team trigger is unavailable")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({"success": false, "error": error}),
        }
    }

    fn into_localhost(self) -> crate::transport::localhost::Response {
        crate::transport::localhost::Response::json(self.status, self.body)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_token_is_constant_time_and_never_debuggable() {
        let value = format!("mctwh_{}", "a".repeat(64));
        let token = WebhookToken::try_new(&value).unwrap();
        assert!(token.matches(&value));
        assert!(!token.matches(&format!("mctwh_{}", "a".repeat(63))));
        assert!(!token.matches(&format!("mctwh_{}", "b".repeat(64))));
    }

    #[test]
    fn webhook_path_is_fixed_percent_decoded_and_fail_closed() {
        assert_eq!(
            webhook_path("/api/team-runtime/webhooks/deploy%2Fready"),
            Some("deploy/ready".into())
        );
        for path in [
            "/api/team-runtime/webhooks",
            "/api/team-runtime/webhooks/%2e%2e/deploy",
            "/api/team-runtime/webhooks/%ZZ",
            "/api/team-runtime/webhooks/%00",
        ] {
            assert_eq!(webhook_path(path), None, "{path}");
        }
    }

    #[test]
    fn external_idempotency_is_opaque_or_fresh_and_never_uses_body_data() {
        assert_eq!(opaque_id("retry:deploy-1"), Some("retry:deploy-1".into()));
        assert_eq!(opaque_id("private body value"), None);
        let generated = generated_idempotency_key().unwrap();
        assert!(generated.starts_with("webhook:"));
        assert!(opaque_id(&generated).is_some());
    }

    #[test]
    fn external_responses_do_not_echo_request_secrets() {
        let response = Response::webhook_unauthorized();
        let encoded = serde_json::to_string(&response.body).unwrap();
        assert!(!encoded.contains("private-webhook-token"));
        assert!(!encoded.contains("authorization"));
    }

    #[test]
    fn external_webhook_requires_an_exact_bounded_body_length() {
        let oversized = MAX_WEBHOOK_BODY_BYTES + 1;
        assert!(oversized > MAX_WEBHOOK_BODY_BYTES);
        assert_eq!(MAX_WEBHOOK_BODY_BYTES, 64 * 1024);
    }
}
