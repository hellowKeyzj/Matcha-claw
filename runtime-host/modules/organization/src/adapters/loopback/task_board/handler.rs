use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};

use super::{DecodeError, decode, handle};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub(crate) const ROUTE: &str = "/api/team/task-board";

pub(crate) async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Team task board route is not available");
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team task board authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team task board request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team task board authorization is invalid");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team task board request is invalid");
        }
    };
    drop(verifier);
    let delivery = handle(&owner, request).await;
    Response::json(delivery.status_code(), delivery.body())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
