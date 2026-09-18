use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::common::authorization::CapabilityDecisionVerifier;

use super::{DecodeError, Delivery, decode, dispatch};

pub(crate) const ROUTE: &str = "/api/team/manual-materialize-and-create";

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
    let Some(authorization) = request.header("authorization").and_then(bearer_token) else {
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
    Response::from_delivery(dispatch(&owner, request).await)
}

fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
        .filter(|token| !token.is_empty())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn bad_request() -> Self {
        Self::fixed(400, "Manual Team materialization request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Manual Team materialization authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Manual Team materialization route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
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
#[path = "handler_tests.rs"]
mod handler_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_errors_are_redacted() {
        for response in [
            Response::bad_request(),
            Response::unauthorized(),
            Response::not_found(),
        ] {
            let body = response.body.to_string();
            assert!(!body.contains("workspace"));
            assert!(!body.contains("Bearer"));
            assert!(!body.contains("runId"));
        }
    }
}
