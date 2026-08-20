use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::{authorization::CapabilityDecisionVerifier, session_trace};

use super::{DecodeError, SessionCreateDelivery, SessionCreateRequest};

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
    owner: crate::owner::Handle,
) -> Response {
    let trace_id = session_trace::trace_id(headers);
    session_trace::log("runtime.create.request", trace_id, serde_json::json!({}));
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.create.unauthorized",
            trace_id,
            serde_json::json!({}),
        );
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.create.bad-json", trace_id, serde_json::json!({}));
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request =
        match SessionCreateRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(DecodeError::Unauthorized) => {
                session_trace::log(
                    "runtime.create.decode-unauthorized",
                    trace_id,
                    serde_json::json!({}),
                );
                return Response::unauthorized();
            }
            Err(DecodeError::Invalid) => {
                session_trace::log(
                    "runtime.create.decode-invalid",
                    trace_id,
                    serde_json::json!({}),
                );
                return Response::bad_request();
            }
        };
    let command = match request.into_command() {
        Ok(command) => command,
        Err(_) => return Response::bad_request(),
    };
    drop(verifier);
    let outcome = match owner.create_open_claw_session(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.create.owner-unavailable",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    let delivery = SessionCreateDelivery::Outcome(outcome);
    session_trace::log(
        "runtime.create.outcome",
        trace_id,
        serde_json::json!({ "status": delivery.status_code() }),
    );
    Response::from_delivery(delivery)
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session create request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session create authorization is invalid")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionCreateDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SessionCreateDelivery) -> Self {
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
