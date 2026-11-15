use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use super::{DecodeError, decode, read};

pub(crate) const ROUTE: &str = "/api/team/public";

pub(crate) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Team public projection route is not available");
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team public projection authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team public projection request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team public projection authorization is invalid");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team public projection request is invalid");
        }
    };
    drop(verifier);
    let delivery = read(&owner, request).await;
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
