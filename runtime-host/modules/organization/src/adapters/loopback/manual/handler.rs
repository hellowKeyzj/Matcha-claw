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

use super::{DecodeError, Delivery, decode};

pub(crate) const ROUTE: &str = "/api/team/manual-materialize-and-create";

pub(crate) async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::error(404, "Manual Team materialization route is not available");
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| bearer_token(value))
    else {
        return Response::error(401, "Manual Team materialization authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::error(400, "Manual Team materialization request is invalid"),
    };
    let mut verifier = verifier.lock().await;
    let request = match decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => {
            return Response::error(401, "Manual Team materialization authorization is invalid");
        }
        Err(DecodeError::Invalid) => {
            return Response::error(400, "Manual Team materialization request is invalid");
        }
    };
    drop(verifier);
    match owner.admit_team_workflow(crate::call::TeamWorkflow::Manual(request)).await {
        Ok(receipt) => Response::json(202, serde_json::json!(receipt)),
        Err(_) => Response::json(Delivery::Unavailable.status_code(), Delivery::Unavailable.body()),
    }
}

fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
        .filter(|token| !token.is_empty())
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
            Response::error(400, "Manual Team materialization request is invalid"),
            Response::error(401, "Manual Team materialization authorization is invalid"),
            Response::error(404, "Manual Team materialization route is not available"),
        ] {
            let body = response.body().to_string();
            assert!(!body.contains("workspace"));
            assert!(!body.contains("Bearer"));
            assert!(!body.contains("runId"));
        }
    }
}
