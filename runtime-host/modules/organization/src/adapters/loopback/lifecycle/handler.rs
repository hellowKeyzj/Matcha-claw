use futures_util::future::BoxFuture;
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

use super::{DecodeError, DecodedRequest, Delivery, decode, handle};

pub(crate) const ROUTE: &str = "/api/team/lifecycle";

pub(crate) async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Team lifecycle is unavailable");
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team lifecycle is unavailable");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Team lifecycle request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Team lifecycle is unavailable");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Team lifecycle request is invalid");
        }
    };
    drop(verifier);
    let execution: BoxFuture<'_, Response> = match request {
        DecodedRequest::Immediate(request) => {
            let future = handle(&owner, request, now_millis());
            Box::pin(async move {
                let delivery = future.await;
                Response::json(delivery.status_code(), delivery.body())
            })
        }
        DecodedRequest::RunDelete { run_id, idempotency_key } => Box::pin(async move {
            match owner.admit_team_workflow(crate::call::TeamWorkflow::RunDelete {
                run_id, idempotency_key, observed_at: now_millis(),
            }).await {
                Ok(receipt) => Response::json(202, serde_json::json!(receipt)),
                Err(_) => Response::json(Delivery::Unavailable.status_code(), Delivery::Unavailable.body()),
            }
        }),
    };
    execution.await
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
