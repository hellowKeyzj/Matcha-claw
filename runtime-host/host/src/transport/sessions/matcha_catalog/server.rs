use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::common::authorization::CapabilityDecisionVerifier;

use super::{DecodeError, Delivery, Request};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

pub(crate) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
) -> Response {
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
    match Request::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(_) => {}
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    }
    drop(verifier);
    match session.list_matcha_sessions().await {
        Ok(outcome) => Response::from_delivery(Delivery::from(outcome)),
        Err(_) => Response::unavailable(),
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Matcha session catalog request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Matcha session catalog authorization is invalid")
    }

    fn unavailable() -> Self {
        Self::from_delivery(Delivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: Delivery) -> Self {
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
