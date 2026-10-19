use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{
        self, BodyPolicy, ModuleDescriptor, ModuleId, Request, Response, RouteDescriptor,
        RouteHeadPlan, RoutePath,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{AUTHORIZATION_SCOPE, EXECUTE_PATH, api::BoardHandle, model::*};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const BODY_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) fn descriptor(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: BoardHandle,
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("board"),
        vec![RouteDescriptor::bound(
            "board.loopback",
            &[RoutePath::Exact(EXECUTE_PATH)],
            head_plan,
            move |request| {
                let verifier = verifier.clone();
                let handle = handle.clone();
                Box::pin(async move { handle_request(request, verifier, handle).await.into() })
            },
        )],
    )
}

fn head_plan(head: &loopback::RequestHead) -> Option<RouteHeadPlan> {
    (head.path == EXECUTE_PATH).then(|| {
        RouteHeadPlan::body_deadline(
            BodyPolicy::Required {
                max_bytes: MAX_REQUEST_BYTES,
            },
            BODY_DEADLINE,
            || failure_response(BoardFailure::Invalid),
        )
    })
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: BoardHandle,
) -> Response {
    if request.method() != "POST" || request.path() != EXECUTE_PATH {
        return Response::not_found();
    }
    if request.body.len() > MAX_REQUEST_BYTES {
        return failure_response(BoardFailure::Invalid);
    }
    let authorization = request
        .head
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .and_then(|(_, value)| value.strip_prefix("Bearer "));
    let Some(authorization) = authorization else {
        return failure_response(BoardFailure::Forbidden);
    };
    let input = match serde_json::from_slice::<ExecuteRequest>(&request.body) {
        Ok(input) => input,
        Err(_) => return failure_response(BoardFailure::Invalid),
    };
    if input.operation.validate().is_err() {
        return failure_response(BoardFailure::Invalid);
    }
    let identity = match input.identity.into_identity() {
        Ok(identity) => identity,
        Err(failure) => return failure_response(failure),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    if verifier
        .lock()
        .await
        .verify(
            authorization,
            now,
            EXECUTE_PATH,
            AUTHORIZATION_SCOPE,
            input.operation.method().as_str(),
            &identity.canonical_key(),
        )
        .is_err()
    {
        return failure_response(BoardFailure::Forbidden);
    }
    match handle.execute(identity, input.operation).await {
        Ok(result) => Response::json(
            200,
            serde_json::to_value(result).expect("typed Board result serializes"),
        ),
        Err(failure) => failure_response(failure),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteRequest {
    identity: IdentityRequest,
    operation: BoardOperation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityRequest {
    endpoint: EndpointRequest,
    agent_id: String,
    session_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointRequest {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl IdentityRequest {
    fn into_identity(self) -> Result<BoardIdentity, BoardFailure> {
        if self.endpoint.kind != "native-runtime" {
            return Err(BoardFailure::Invalid);
        }
        let endpoint = RuntimeEndpoint::try_new(
            self.endpoint.runtime_adapter_id,
            self.endpoint.runtime_instance_id,
        )
        .map_err(|_| BoardFailure::Invalid)?;
        BoardIdentity::try_new(endpoint, self.agent_id, self.session_key)
            .map_err(|_| BoardFailure::Invalid)
    }
}

pub(crate) fn decode_identity(value: Value) -> Option<BoardIdentity> {
    serde_json::from_value::<IdentityRequest>(value)
        .ok()?
        .into_identity()
        .ok()
}

fn failure_response(failure: BoardFailure) -> Response {
    let status = match failure {
        BoardFailure::Invalid => 400,
        BoardFailure::Forbidden => 401,
        BoardFailure::Stale | BoardFailure::Expired => 409,
        BoardFailure::MissingSource => 404,
        BoardFailure::Unsupported | BoardFailure::Unavailable => 503,
        BoardFailure::Unknown => 500,
    };
    Response::json(
        status,
        json!({ "error": { "code": failure, "message": failure.message() } }),
    )
}
