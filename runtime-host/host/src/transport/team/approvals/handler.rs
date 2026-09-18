use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::common::authorization::CapabilityDecisionVerifier;

use super::{DecodeError, Delivery, decode, read};

const AUTHORIZATION_HEADER: &str = "authorization";
const ROUTE: &str = "/api/team/approvals";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle_localhost(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::organization::OrganizationHandle,
) -> crate::transport::localhost::Response {
    handle(
        Request {
            method,
            path,
            headers,
            body,
        },
        verifier,
        owner,
    )
    .await
    .into_localhost()
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::organization::OrganizationHandle,
) -> Response {
    if request.method != "POST" || request.path != ROUTE {
        return Response::not_found();
    }
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
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(read(&owner, request).await)
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Team pending approvals request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Team pending approvals authorization is invalid")
    }
    fn deadline() -> Self {
        Self::from_delivery(Delivery::Unavailable)
    }
    fn not_found() -> Self {
        Self::fixed(404, "Team pending approvals route is not available")
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

    fn into_localhost(self) -> crate::transport::localhost::Response {
        crate::transport::localhost::Response::json(self.status, self.body)
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
mod tests {
    use super::*;

    #[test]
    fn deadline_is_an_explicit_unavailable_response() {
        let response = Response::deadline();

        assert_eq!(response.status, 503);
        assert_eq!(
            response.body,
            serde_json::json!({
                "success": false,
                "error": "Team pending approvals are unavailable",
            })
        );
        assert_eq!(Delivery::Unavailable.status_code(), 503);
    }
}
