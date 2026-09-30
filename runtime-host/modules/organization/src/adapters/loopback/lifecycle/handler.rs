use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use super::{DecodeError, Delivery, decode, handle};

pub(crate) const ROUTE: &str = "/api/team/lifecycle";

pub(crate) async fn handle_loopback(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> platform::loopback::Response {
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
    .into_loopback()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
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
    if let super::Request::Delete { target: super::DeleteTarget::Run(run_id), idempotency_key } = request {
        return match owner.admit_team_workflow(crate::call::TeamWorkflow::RunDelete {
            run_id, idempotency_key, observed_at: now_millis(),
        }).await {
            Ok(receipt) => Response { status: 202, body: serde_json::json!(receipt) },
            Err(_) => Response::from_delivery(Delivery::Unavailable),
        };
    }
    Response::from_delivery(handle(&owner, request, now_millis()).await)
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
    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn into_loopback(self) -> platform::loopback::Response {
        platform::loopback::Response::json(self.status, self.body)
    }

    fn bad_request() -> Self {
        Self::fixed(400, "Team lifecycle request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Team lifecycle is unavailable")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Team lifecycle is unavailable")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
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
mod tests {
    use super::*;
}
