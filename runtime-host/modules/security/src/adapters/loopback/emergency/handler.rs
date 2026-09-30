use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::api::SecurityHandle;

use super::{DecodeError, SecurityEmergencyDelivery, decode};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> platform::loopback::Response {
    handle_request(method, path, headers, body, verifier, security)
        .await
        .into()
}

async fn handle_request(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
) -> Response {
    if method != "POST" || path != "/api/security/emergency" {
        return Response::not_found();
    }
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
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
    match security.emergency(correlation).await {
        Ok(receipt) => Response { status: 202, body: serde_json::json!(receipt) },
        Err(_) => Response::unavailable(),
    }
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

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
