use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{
    goal::{SessionGoalCommand, SessionGoalMutation, SessionGoalOutcome},
    state::SessionIdentity,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation_id: String,
    scope: Target,
    target: Target,
    input: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    session_identity: SessionIdentity,
    endpoint_session_id: String,
    goal_id: String,
    operation_id: String,
    issued_at_ms: u64,
}

pub(super) async fn handle(
    request: &loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> loopback::Response {
    let invalid = || loopback::Response::error(400, "Session Goal request is invalid");
    let Some(authorization) = request.bearer_authorization() else {
        return loopback::Response::error(401, "Session Goal authorization is invalid");
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
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
            "/api/sessions/goal",
            "sessions:write",
            "session.goal",
            "session-goal",
        )
        .is_err()
    {
        return loopback::Response::error(401, "Session Goal authorization is invalid");
    }
    let Ok(mut input) = serde_json::from_slice::<Request>(&request.body) else {
        return invalid();
    };
    if input.id != "session.goal"
        || input.scope.kind != "session"
        || input.target.kind != "session"
        || input.scope.identity != input.target.identity
    {
        return invalid();
    }
    let Some(fields) = input.input.as_object_mut() else {
        return invalid();
    };
    let mutation = match input.operation_id.as_str() {
        "sessions.goal.clear" => SessionGoalMutation::Clear,
        "sessions.goal.update" => {
            let mut mutation = serde_json::Map::new();
            for name in ["action", "objective", "note"] {
                if let Some(value) = fields.remove(name) {
                    mutation.insert(name.into(), value);
                }
            }
            match serde_json::from_value::<SessionGoalMutation>(mutation.into()) {
                Ok(SessionGoalMutation::Clear) | Err(_) => return invalid(),
                Ok(mutation) => mutation,
            }
        }
        _ => return invalid(),
    };
    let Ok(identity) = serde_json::from_value::<Identity>(input.input) else {
        return invalid();
    };
    let command = SessionGoalCommand {
        identity: identity.session_identity,
        endpoint_session_id: identity.endpoint_session_id,
        goal_id: identity.goal_id,
        operation_id: identity.operation_id,
        issued_at_ms: identity.issued_at_ms,
        mutation,
    };
    if command.identity != input.scope.identity || command.validate().is_err() {
        return invalid();
    }
    let outcome = session
        .mutate_session_goal(command)
        .await
        .unwrap_or(SessionGoalOutcome::Unavailable);
    loopback::Response::json(
        200,
        serde_json::to_value(outcome).expect("Session Goal outcome serialization"),
    )
}
