use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use super::{SessionAbortDelivery, SessionAbortRequest};
use crate::trace as session_trace;

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    handle_request(
        Request {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: headers.to_vec(),
            body: body.to_vec(),
        },
        verifier,
        session,
    )
    .await
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> Response {
    let started = Instant::now();
    let trace_id = session_trace::trace_id(&request.headers);
    let route_matches = request.method == "POST" && request.path == "/api/sessions/abort";
    session_trace::log(
        "runtime.abort.request",
        trace_id,
        serde_json::json!({ "routeMatches": route_matches, "bodyBytes": request.body.len() }),
    );
    if !route_matches {
        session_trace::log("runtime.abort.not-found", trace_id, serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log("runtime.abort.unauthorized", trace_id, serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.abort.bad-json", trace_id, serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
            return Response::bad_request();
        }
    };
    let approval_ids = value.get("input").and_then(|input| input.get("approvalIds"));
    let approval_ids_shape = serde_json::json!({
        "fieldPresent": approval_ids.is_some(),
        "count": approval_ids.and_then(Value::as_array).map(Vec::len),
        "empty": approval_ids.and_then(Value::as_array).map(Vec::is_empty),
    });
    let mut verifier = verifier.lock().await;
    let request =
        match SessionAbortRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(super::DecodeError::Unauthorized) => {
                session_trace::log("runtime.abort.decode-unauthorized", trace_id, serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
                return Response::unauthorized();
            }
            Err(super::DecodeError::Invalid) => {
                session_trace::log("runtime.abort.decode-invalid", trace_id, serde_json::json!({ "approvalIds": approval_ids_shape, "elapsedMs": started.elapsed().as_millis() }));
                return Response::bad_request();
            }
        };
    session_trace::log("runtime.abort.decode-accepted", trace_id, serde_json::json!({ "approvalIds": approval_ids_shape, "elapsedMs": started.elapsed().as_millis() }));
    let command = match request.into_command() {
        Ok(command) => command.with_trace_id(trace_id.map(str::to_owned)),
        Err(_) => {
            session_trace::log("runtime.abort.command-invalid", trace_id, serde_json::json!({ "approvalIds": approval_ids_shape, "elapsedMs": started.elapsed().as_millis() }));
            return Response::bad_request();
        }
    };
    if matches!(command.endpoint, crate::abort::NativeEndpoint::Unsupported) {
        session.record_boundary_outcome("sessions.abort", crate::call::SessionsCallOutcome::Unsupported).await;
        session_trace::log("runtime.abort.outcome", trace_id, serde_json::json!({ "outcome": "unsupported", "elapsedMs": started.elapsed().as_millis() }));
        return Response::from_delivery(SessionAbortDelivery::Unsupported);
    }
    drop(verifier);
    session_trace::log("runtime.abort.owner.submit", trace_id, serde_json::json!({
        "endpoint": format!("{:?}", command.endpoint),
        "sessionKey": session_trace::id_shape(Some(&command.session_key)),
        "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
        "runId": session_trace::id_shape(command.run_id.as_deref()),
        "approvalIds": approval_ids_shape,
        "elapsedMs": started.elapsed().as_millis(),
    }));
    let outcome = match session.abort_session(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log("runtime.abort.owner-unavailable", trace_id, serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
            return Response::unavailable();
        }
    };
    session_trace::log("runtime.abort.outcome", trace_id, serde_json::json!({ "outcome": outcome, "elapsedMs": started.elapsed().as_millis() }));
    Response::from_delivery(outcome.into())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session abort request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session abort authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session abort route is not available")
    }

    fn unavailable() -> Self {
        Self::from_delivery(SessionAbortDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SessionAbortDelivery) -> Self {
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
