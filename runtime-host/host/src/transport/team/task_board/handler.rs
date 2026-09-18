use super::{DecodeError, Delivery, decode, handle};
use crate::transport::common::authorization::CapabilityDecisionVerifier;
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const ROUTE: &str = "/api/team/task-board";

pub(crate) async fn handle_localhost(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::organization::OrganizationHandle,
) -> crate::transport::localhost::Response {
    handle_request(
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

async fn handle_request(
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
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix("Bearer "))
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
    Response::from_delivery(handle(&owner, request).await)
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
        Self::fixed(400, "Team task board request is invalid")
    }
    fn unauthorized() -> Self {
        Self::fixed(401, "Team task board authorization is invalid")
    }
    fn not_found() -> Self {
        Self::fixed(404, "Team task board route is not available")
    }
    fn unavailable() -> Self {
        Self::from_delivery(Delivery::Unavailable)
    }
    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({"success":false,"error":error}),
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
