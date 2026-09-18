use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    sessions::{
        send::{NativeEndpoint, SessionSendOutcome},
        send_hook::SessionSendHookSet,
    },
    transport::{
        common::authorization::CapabilityDecisionVerifier, sessions::trace as session_trace,
    },
};

use super::{SessionSendDelivery, SessionSendRequest};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
    send_hooks: SessionSendHookSet,
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
        send_hooks,
    )
    .await
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::sessions::SessionHandle,
    send_hooks: SessionSendHookSet,
) -> Response {
    if request.method != "POST" || request.path != "/api/sessions/send" {
        return Response::not_found();
    }
    let trace_id = session_trace::trace_id(&request.headers);
    session_trace::log(
        "runtime.send.request",
        trace_id,
        serde_json::json!({ "method": &request.method, "path": &request.path }),
    );
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log("runtime.send.unauthorized", trace_id, serde_json::json!({}));
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log("runtime.send.bad-json", trace_id, serde_json::json!({}));
            return Response::bad_request();
        }
    };
    let now_millis = now_millis();
    let mut verifier = verifier.lock().await;
    let request = match SessionSendRequest::decode(value, authorization, &mut verifier, now_millis)
    {
        Ok(request) => request,
        Err(super::DecodeError::Unauthorized) => {
            session_trace::log(
                "runtime.send.decode-unauthorized",
                trace_id,
                serde_json::json!({}),
            );
            return Response::unauthorized();
        }
        Err(super::DecodeError::Invalid) => {
            session_trace::log(
                "runtime.send.decode-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let command = match request.into_command(trace_id.map(str::to_owned)) {
        Ok(command) => command,
        Err(_) => {
            session_trace::log(
                "runtime.send.command-invalid",
                trace_id,
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let trace_id = command.trace_id().map(str::to_owned);
    session_trace::log(
        "runtime.send.command",
        trace_id.as_deref(),
        serde_json::json!({
            "endpoint": format!("{:?}", command.endpoint),
            "sessionKey": session_trace::id_shape(Some(&command.session_key)),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
            "runId": session_trace::id_shape(command.run_id.as_deref()),
            "idempotencyKey": session_trace::id_shape(command.idempotency_key.as_deref()),
            "attachmentCount": command.attachments.len(),
        }),
    );
    if matches!(command.endpoint, NativeEndpoint::Unsupported) {
        return Response::from_delivery(SessionSendDelivery::Unsupported);
    }
    drop(verifier);
    let prepared = match send_hooks.prepare(command, now_millis).await {
        Ok(prepared) => prepared,
        Err(_) => {
            session_trace::log(
                "runtime.send.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    let (command, hook_states) = prepared.into_parts();
    let outcome = match session.send_session(command).await {
        Ok(outcome) => outcome,
        Err(_) => {
            session_trace::log(
                "runtime.send.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::unavailable();
        }
    };
    if let SessionSendOutcome::Queued { run_id } = &outcome {
        send_hooks.after_queued(hook_states, session.clone(), run_id.clone());
    }
    session_trace::log(
        "runtime.send.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "outcome": match &outcome {
                SessionSendOutcome::Queued { .. } => "queued",
                SessionSendOutcome::Succeeded { .. } => "succeeded",
                SessionSendOutcome::Rejected => "rejected",
                SessionSendOutcome::Unknown => "unknown",
                SessionSendOutcome::Unsupported => "unsupported",
                SessionSendOutcome::Unavailable => "unavailable",
            }
        }),
    );
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
        Self::fixed(400, "Session send request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session send authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session send route is not available")
    }

    pub(crate) fn unavailable() -> Self {
        Self::from_delivery(SessionSendDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: SessionSendDelivery) -> Self {
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

#[cfg(test)]
mod timeout_tests {
    use serde_json::json;

    use super::Response;

    #[test]
    fn unavailable_projects_unavailable_without_invalid_request() {
        assert_eq!(Response::unavailable().status, 503);
        assert_eq!(
            Response::unavailable().body,
            json!({
                "success": false,
                "error": "Session send is unavailable",
            })
        );
        assert_ne!(Response::unavailable().status, 400);
    }
}
