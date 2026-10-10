use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback::Response};
use serde_json::{Value, json};
use tokio::sync::Mutex;

pub(crate) const ROUTE: &str = "/api/team/runtime/execute";

const AUTHORIZATION_SCOPE: &str = "team.runtime";
const AUTHORIZATION_CAPABILITY: &str = "team.runtime";
const AUTHORIZATION_SUBJECT: &str = "team-runtime-execute";

pub(crate) async fn handle_loopback(
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
    resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
) -> Response {
    if method != "POST" || path != ROUTE {
        return Response::not_found();
    }
    let Some(authorization) = authorization else {
        return unauthorized();
    };
    if verifier
        .lock()
        .await
        .verify(
            &authorization,
            now_millis(),
            ROUTE,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        return unauthorized();
    }
    let value = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let request = match crate::decode_team_runtime_capability_request(value) {
        Ok(request) => request,
        Err(error) => return decode_error(error),
    };
    if matches!(request.operation_id(), "team.provisionAgents" | "team.delete" | "team.runDelete") {
        return match owner.admit_team_capability(resolver, request).await {
            Ok(receipt) => Response::json(202, json!(receipt)),
            Err(error) => decode_error(error),
        };
    }
    let outcome = match owner
        .execute_team_runtime_capability_request(resolver, request)
        .await
    {
        Ok((_, outcome)) => outcome,
        Err(error) => return decode_error(error),
    };
    project_outcome(outcome)
}

fn project_outcome(outcome: crate::TeamRuntimeControlOutcome) -> Response {
    match outcome {
        crate::TeamRuntimeControlOutcome::Succeeded(result)
        | crate::TeamRuntimeControlOutcome::Unknown(result) => Response::json(200, result),
        crate::TeamRuntimeControlOutcome::Unavailable => unavailable(),
        crate::TeamRuntimeControlOutcome::InvalidInput => invalid_request(),
        crate::TeamRuntimeControlOutcome::Failed(message) => failed(message),
    }
}

fn decode_error(error: crate::TeamRuntimeDecodeError) -> Response {
    match error {
        crate::TeamRuntimeDecodeError::InvalidInput
        | crate::TeamRuntimeDecodeError::InvalidField { .. } => invalid_request(),
        crate::TeamRuntimeDecodeError::Unavailable => unavailable(),
        crate::TeamRuntimeDecodeError::GraphDefinition(error) => Response::json(
            200,
            crate::application::team_mcp::design_rejected(crate::StoreFault::GraphPatch(
                crate::GraphPatchError::Definition(error),
            )),
        ),
    }
}

fn invalid_request() -> Response {
    Response::json(
        400,
        json!({ "success": false, "error": "Team runtime request is invalid" }),
    )
}

fn unauthorized() -> Response {
    Response::json(
        401,
        json!({ "success": false, "error": "Team runtime authorization is invalid" }),
    )
}

fn unavailable() -> Response {
    Response::json(
        503,
        json!({ "success": false, "error": "Team runtime operation is unavailable" }),
    )
}

fn failed(message: &'static str) -> Response {
    Response::json(400, json!({ "success": false, "error": message }))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
