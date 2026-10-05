use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{ports::{SessionObserveCommand, SessionObserveOutcome, SessionReleaseOutcome}, state::SessionIdentity, timeline::{Direction, WindowRequest}};

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    session_identity: SessionIdentity,
    session_key: String,
    lease_id: String,
    limit: Option<usize>,
}

pub(super) async fn handle(request: &loopback::Request, verifier: Arc<Mutex<CapabilityDecisionVerifier>>, session: crate::SessionHandle) -> loopback::Response {
    let release = request.path() == "/api/sessions/release";
    let invalid = || error(400, "Session observation request is invalid");
    let unavailable = || error(503, "Session observation is unavailable");
    let Some(authorization) = request.headers().iter().find(|(name, _)| name == "authorization").and_then(|(_, value)| value.strip_prefix("Bearer ")) else {
        return error(401, "Session observation authorization is invalid");
    };
    let Ok(input) = serde_json::from_slice::<Request>(&request.body) else { return invalid(); };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().try_into().unwrap_or(u64::MAX);
    if verifier.lock().await.verify(authorization, now, request.path(), "sessions:read", "session.management", "session-timeline").is_err() {
        return error(401, "Session observation authorization is invalid");
    }
    if input.id != "session.management" || input.operation_id != if release { "sessions.release" } else { "sessions.observe" }
        || input.scope.kind != "session" || input.target.kind != "session"
        || input.scope.identity != input.target.identity || input.scope.identity != input.input.session_identity
        || input.input.session_key != input.scope.identity.session_key
        || input.scope.identity.validate().is_err()
        || input.input.lease_id.is_empty() || input.input.lease_id.len() > 4096
        || input.input.lease_id.trim() != input.input.lease_id || input.input.lease_id.chars().any(char::is_control)
        || input.input.limit.is_some_and(|limit| !(1..=200).contains(&limit))
        || (release && input.input.limit.is_some()) {
        return invalid();
    }
    let Some(window) = WindowRequest::new(Direction::Latest, input.input.limit.unwrap_or(WindowRequest::latest().limit()), None) else { return invalid(); };
    if release {
        match session.release_observation(input.input.session_identity, input.input.lease_id).await {
            Ok(SessionReleaseOutcome::Released) => loopback::Response::json(200, serde_json::json!({ "outcome": "released" })),
            Ok(SessionReleaseOutcome::NotFound) => loopback::Response::json(200, serde_json::json!({ "outcome": "not-found" })),
            Ok(SessionReleaseOutcome::Rejected) => invalid(),
            Ok(SessionReleaseOutcome::Unavailable) | Err(()) => unavailable(),
        }
    } else {
        match session.observe_session(SessionObserveCommand { identity: input.input.session_identity, lease_id: input.input.lease_id, window }).await {
            Ok(SessionObserveOutcome::Observed { lease_id, view }) => loopback::Response::json(200, serde_json::json!({ "leaseId": lease_id, "view": super::presenter::session_view(&view) })),
            Ok(SessionObserveOutcome::Released { lease_id }) => loopback::Response::json(200, serde_json::json!({ "leaseId": lease_id, "outcome": "released" })),
            Ok(SessionObserveOutcome::Rejected) => invalid(),
            Ok(SessionObserveOutcome::Unavailable | SessionObserveOutcome::Unknown) | Err(()) => unavailable(),
        }
    }
}

fn error(status: u16, message: &'static str) -> loopback::Response {
    loopback::Response::json(status, serde_json::json!({ "success": false, "error": message }))
}
