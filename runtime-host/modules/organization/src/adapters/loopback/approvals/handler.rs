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

pub(crate) const ROUTE: &str = "/api/team/approvals";

pub(crate) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Team pending approvals route is not available");
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team pending approvals authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team pending approvals request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team pending approvals authorization is invalid");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team pending approvals request is invalid");
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Delivery;

    #[test]
    fn deadline_is_an_explicit_unavailable_response() {
        let delivery = Delivery::Unavailable;
        let response = Response::json(delivery.status_code(), delivery.body());

        assert_eq!(response.status(), 503);
        assert_eq!(
            response.body(),
            &serde_json::json!({
                "success": false,
                "error": "Team pending approvals are unavailable",
            })
        );
        assert_eq!(Delivery::Unavailable.status_code(), 503);
    }
}
