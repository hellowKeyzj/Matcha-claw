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

use super::{DecodeError, decode, handle};

pub(crate) const ROUTE: &str = "/api/team/decision";

pub(crate) async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Team human decision route is not available");
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team human decision authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team human decision request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team human decision authorization is invalid");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team human decision request is invalid");
        }
    };
    drop(verifier);
    let delivery = handle(&owner, request, now_millis()).await;
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
    fn deadline_is_an_explicit_unknown_failure() {
        let delivery = Delivery::OutcomeUnknown;
        let response = Response::json(delivery.status_code(), delivery.body());

        assert_eq!(response.status(), 409);
        assert_eq!(
            response.body(),
            &serde_json::json!({
                "success": false,
                "outcome": "outcome-unknown",
                "error": "Team approval outcome is unknown",
            })
        );
        assert_eq!(Delivery::Recorded.status_code(), 200);
        assert_eq!(Delivery::Replayed.status_code(), 200);
        assert_eq!(Delivery::OutcomeUnknown.status_code(), 409);
        assert_eq!(Delivery::Rejected.status_code(), 409);
    }
}
