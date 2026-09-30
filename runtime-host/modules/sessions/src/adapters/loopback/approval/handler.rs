use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::approval::endpoint_supports_approval;

use super::{
    PendingApprovalsDelivery, PendingApprovalsRequest, SessionApprovalDelivery,
    SessionApprovalRequest,
};

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
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/sessions/approvals/list") => {
            let request = match PendingApprovalsRequest::decode(
                value,
                authorization,
                &mut verifier,
                now_millis(),
            ) {
                Ok(request) => request,
                Err(super::DecodeError::Unauthorized) => return Response::unauthorized(),
                Err(super::DecodeError::Invalid) => return Response::bad_request(),
            };
            let command = match request.into_command() {
                Ok(command) => command,
                Err(_) => return Response::bad_request(),
            };
            if !endpoint_supports_approval(command.endpoint) {
                session.record_boundary_outcome("sessions.approvals.list", crate::call::SessionsCallOutcome::Unsupported).await;
                return Response::from_pending(PendingApprovalsDelivery::Unsupported);
            }
            drop(verifier);
            let outcome = match session.pending_approvals(command).await {
                Ok(outcome) => outcome,
                Err(_) => return Response::unavailable(),
            };
            Response::from_pending(outcome.into())
        }
        ("POST", "/api/sessions/approvals/respond") => {
            let request = match SessionApprovalRequest::decode(
                value,
                authorization,
                &mut verifier,
                now_millis(),
            ) {
                Ok(request) => request,
                Err(super::DecodeError::Unauthorized) => return Response::unauthorized(),
                Err(super::DecodeError::Invalid) => return Response::bad_request(),
            };
            let command = match request.into_command() {
                Ok(command) => command,
                Err(_) => return Response::bad_request(),
            };
            if !endpoint_supports_approval(command.endpoint) {
                session.record_boundary_outcome("sessions.approvals.respond", crate::call::SessionsCallOutcome::Unsupported).await;
                return Response::from_response(SessionApprovalDelivery::Unsupported);
            }
            drop(verifier);
            let outcome = match session.respond_to_approval(command).await {
                Ok(outcome) => outcome,
                Err(_) => return Response::unavailable(),
            };
            Response::from_response(outcome.into())
        }
        _ => Response::not_found(),
    }
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
        Self::fixed(400, "Session approval request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session approval authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session approval route is not available")
    }

    fn unavailable() -> Self {
        Self::from_response(SessionApprovalDelivery::Unavailable)
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_pending(delivery: PendingApprovalsDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn from_response(delivery: SessionApprovalDelivery) -> Self {
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
