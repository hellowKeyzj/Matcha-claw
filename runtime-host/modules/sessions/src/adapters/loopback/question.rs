use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::{capability::CapabilityDecisionVerifier, loopback};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{
    question::{
        PendingQuestionsCommand, PendingQuestionsOutcome, SessionQuestionCommand,
        SessionQuestionOutcome,
    },
    state::SessionIdentity,
};

pub(super) const LIST_PATH: &str = "/api/sessions/questions/list";
pub(super) const RESPOND_PATH: &str = "/api/sessions/questions/respond";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request<T> {
    id: String,
    operation_id: String,
    scope: Target,
    target: Target,
    input: T,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    identity: SessionIdentity,
}

impl<T> Request<T> {
    fn matches(&self, operation: &str, identity: &SessionIdentity) -> bool {
        self.id == "session.question"
            && self.operation_id == operation
            && self.scope.kind == "session"
            && self.target.kind == "session"
            && self.scope.identity == self.target.identity
            && &self.scope.identity == identity
    }
}

pub(super) async fn handle(
    request: &loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> loopback::Response {
    let invalid = || loopback::Response::error(400, "Session question request is invalid");
    let unauthorized = || loopback::Response::error(401, "Session question authorization failed");
    let (scope, operation) = match request.path() {
        LIST_PATH => ("sessions:read", "sessions.questions.list"),
        RESPOND_PATH => ("sessions:write", "sessions.questions.respond"),
        _ => return loopback::Response::not_found(),
    };
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
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
            request.path(),
            scope,
            operation,
            "session-question",
        )
        .is_err()
    {
        return unauthorized();
    }
    if request.path() == LIST_PATH {
        let Ok(request) = serde_json::from_slice::<Request<PendingQuestionsCommand>>(&request.body)
        else {
            return invalid();
        };
        if !request.matches(operation, &request.input.identity) || request.input.validate().is_err()
        {
            return invalid();
        }
        let outcome = session
            .pending_questions(request.input)
            .await
            .unwrap_or(PendingQuestionsOutcome::Unavailable);
        loopback::Response::json(
            200,
            serde_json::to_value(outcome).expect("Session questions serialization"),
        )
    } else {
        let Ok(request) = serde_json::from_slice::<Request<SessionQuestionCommand>>(&request.body)
        else {
            return invalid();
        };
        if !request.matches(operation, &request.input.identity) || request.input.validate().is_err()
        {
            return invalid();
        }
        let outcome = session
            .respond_to_question(request.input)
            .await
            .unwrap_or_else(|_| SessionQuestionOutcome::unknown());
        loopback::Response::json(
            200,
            serde_json::to_value(outcome).expect("Session question response serialization"),
        )
    }
}
