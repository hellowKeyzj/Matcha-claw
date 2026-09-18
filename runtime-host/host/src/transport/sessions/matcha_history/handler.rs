use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::{common::authorization::CapabilityDecisionVerifier, localhost};

use super::{DecodeError, MatchaHistoryDelivery, MatchaHistoryRequest};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle_localhost(
    request: &localhost::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Option<localhost::Response> {
    route(
        request.method(),
        request.path(),
        request.headers(),
        &request.body,
        verifier,
        session,
    )
    .await
    .map(Response::into_localhost)
}

async fn route(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Option<Response> {
    if path != "/api/matcha-agent/chat/history" {
        return None;
    }
    if method != "POST" {
        return Some(Response::not_found());
    }
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Some(Response::unauthorized());
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Some(Response::bad_request()),
    };
    let mut verifier = verifier.lock().await;
    let request =
        match MatchaHistoryRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(DecodeError::Unauthorized) => return Some(Response::unauthorized()),
            Err(DecodeError::Invalid) => return Some(Response::bad_request()),
        };
    let command = match request.into_command() {
        Ok(command) => command,
        Err(_) => return Some(Response::bad_request()),
    };
    drop(verifier);
    let outcome = match session.load_matcha_history(command).await {
        Ok(outcome) => outcome,
        Err(_) => return Some(Response::unavailable()),
    };
    Some(Response::from_delivery(
        MatchaHistoryDelivery::from_outcome(outcome),
    ))
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Matcha Agent chat history request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Matcha Agent chat history authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Matcha Agent chat history route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(MatchaHistoryDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: MatchaHistoryDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn into_localhost(self) -> localhost::Response {
        localhost::Response::json(self.status, self.body)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
