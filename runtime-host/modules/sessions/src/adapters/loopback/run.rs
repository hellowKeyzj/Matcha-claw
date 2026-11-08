use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{
    execution::{SessionRunReadCommand, SessionRunSelector},
    state::SessionIdentity,
};

pub(super) const PATH: &str = "/api/sessions/run";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation_id: String,
    scope: Target,
    target: Target,
    input: Input,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    identity: SessionIdentity,
    run_id: String,
}

pub(super) async fn handle(
    request: &loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> loopback::Response {
    let Some(authorization) = request.bearer_authorization() else {
        return loopback::Response::error(401, "Session run authorization is invalid");
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    if verifier.lock().await.verify(
        authorization, now, PATH, "sessions:read", "session.management", "session-run",
    ).is_err() {
        return loopback::Response::error(401, "Session run authorization is invalid");
    }
    let Ok(input) = serde_json::from_slice::<Request>(&request.body) else {
        return loopback::Response::error(400, "Session run request is invalid");
    };
    if input.id != "session.management"
        || input.operation_id != "sessions.run.read"
        || input.scope.kind != "session"
        || input.target.kind != "session"
        || input.scope.identity != input.target.identity
        || input.scope.identity != input.input.identity
        || input.input.identity.endpoint.kind != "native-runtime"
        || input.input.identity.endpoint.runtime_instance_id != "local"
    {
        return loopback::Response::error(400, "Session run request is invalid");
    }
    let Ok(command) = SessionRunReadCommand::try_new(
        input.input.identity, None, SessionRunSelector::RunId(input.input.run_id),
    ) else {
        return loopback::Response::error(400, "Session run request is invalid");
    };
    let SessionRunSelector::RunId(run_id) = command.selector else { unreachable!() };
    let Ok(Some(result)) = session.read_execution_result(command.identity, run_id).await else {
        return unavailable();
    };
    let Ok(body) = serde_json::to_value(result) else { return unavailable(); };
    if !serde_json::to_vec(&body).is_ok_and(|wire| wire.len() <= MAX_RESPONSE_BYTES) {
        return unavailable();
    }
    loopback::Response::json(200, body)
}

pub(super) fn unavailable() -> loopback::Response {
    loopback::Response::error(503, "Session run is unavailable")
}
