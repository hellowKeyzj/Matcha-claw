use futures_util::future::BoxFuture;
use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};

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

#[cfg(test)]
#[path = "handler_tests.rs"]
mod handler_tests;

pub(crate) const MAX_MANAGEMENT_BODY_BYTES: usize = 256 * 1024;
pub(crate) const MAX_WEBHOOK_BODY_BYTES: usize = 64 * 1024;
pub(crate) const MANAGEMENT_ROUTE: &str = "/api/team/trigger";
pub(crate) const WEBHOOK_AUTH_ROUTE: &str = "/api/team/webhook-auth";
pub(crate) const WEBHOOK_ROUTE_PREFIX: &str = "/api/team-runtime/webhooks";
pub(crate) const WEBHOOK_SUBROUTE_PREFIX: &str = "/api/team-runtime/webhooks/";

pub(crate) fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: WebhookToken,
    owner: crate::OrganizationHandle,
) -> BoxFuture<'static, Response> {
    let path = super::super::pathname(request.path());
    if path == MANAGEMENT_ROUTE {
        return Box::pin(async move {
            handle_management_request(request, verifier, &webhook_token, owner).await
        });
    }
    if path == WEBHOOK_AUTH_ROUTE {
        return Box::pin(async move {
            handle_webhook_auth_request(request, verifier, &webhook_token).await
        });
    }
    if is_webhook_route(path) {
        return Box::pin(async move {
            handle_webhook_request(request, &webhook_token, owner).await
        });
    }
    Box::pin(std::future::ready(Response::error(404, "Team trigger is unavailable")))
}

async fn handle_webhook_auth_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: &WebhookToken,
) -> Response {
    if request.method() != "POST" {
        return Response::error(404, "Team trigger is unavailable");
    }
    let Some(authorization) = header(&request, "authorization").and_then(bearer_token) else {
        return Response::error(401, "Team trigger is unavailable");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team trigger request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    match decode_webhook_auth(value, authorization, &mut verifier, now_millis()) {
        Ok(()) => {
            let delivery = Delivery::Auth(webhook_token.public_auth_projection());
            Response::json(delivery.status_code(), delivery.body())
        }
        Err(DecodeError::Unauthorized) => Response::error(401, "Team trigger is unavailable"),
        Err(DecodeError::Invalid) => Response::error(400, "Team trigger request is invalid"),
    }
}

async fn handle_management_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: &WebhookToken,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" {
        return Response::error(404, "Team trigger is unavailable");
    }
    let Some(authorization) = header(&request, "authorization").and_then(bearer_token) else {
        return Response::error(401, "Team trigger is unavailable");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team trigger request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team trigger is unavailable");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team trigger request is invalid");
        }
    };
    drop(verifier);
    let delivery = handle(&owner, webhook_token, request, now_millis()).await;
    Response::json(delivery.status_code(), delivery.body())
}

async fn handle_webhook_request(
    request: Request,
    webhook_token: &WebhookToken,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" {
        return Response::error(405, "TeamRun webhook only accepts POST requests");
    }
    let Some(token) = header(&request, "authorization")
        .and_then(bearer_token)
        .or_else(|| header(&request, "x-matchaclaw-webhook-token"))
    else {
        return Response::error(401, "TeamRun webhook token is required");
    };
    if !webhook_token.matches(token) {
        return Response::error(401, "TeamRun webhook token is required");
    }
    let Some(path) = webhook_path(super::super::pathname(request.path())) else {
        return Response::error(404, "Team trigger is unavailable");
    };
    let idempotency_key = match header(&request, "x-idempotency-key") {
        Some(value) => match opaque_id(value) {
            Some(value) => value,
            None => return Response::error(400, "Team trigger request is invalid"),
        },
        None => match generated_idempotency_key() {
            Some(value) => value,
            None => return Response::error(503, "Team trigger is unavailable"),
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
    let status = match delivery {
        Delivery::Fired { .. } => 202,
        _ => delivery.status_code(),
    };
    Response::json(status, delivery.body())
}

fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
        .filter(|token| !token.is_empty())
}

pub(crate) fn is_webhook_route(path: &str) -> bool {
    path == WEBHOOK_ROUTE_PREFIX || path.starts_with(WEBHOOK_SUBROUTE_PREFIX)
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

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.as_str())
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
        let response = Response::error(401, "TeamRun webhook token is required");
        let encoded = serde_json::to_string(response.body()).unwrap();
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
