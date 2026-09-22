use platform::{
    capability::CapabilityDecisionVerifier, endpoint::runtime_address::RuntimeEndpoint,
};

use serde::Deserialize;
use serde_json::Value;

use crate::session_history::{
    SessionHistoryCommand, SessionHistoryFailure, SessionHistoryOutcome, SessionHistoryRole,
};

const CAPABILITY_ID: &str = "session.management";
const OPERATION: &str = "sessions.history";
const RUNTIME_KIND: &str = "native-runtime";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "session";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/history";
const AUTHORIZATION_SCOPE: &str = "sessions:read";
const AUTHORIZATION_SUBJECT: &str = "session-history";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl Request {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        let request: Self = serde_json::from_value(value).map_err(|_| DecodeError::Invalid)?;
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                CAPABILITY_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), DecodeError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.target.identity == self.scope.identity
            && self.input.session_identity == self.scope.identity
            && self.input.session_key == self.scope.identity.session_key
            && self.scope.identity.endpoint.kind == RUNTIME_KIND)
            .then_some(())
            .ok_or(DecodeError::Invalid)?;
        self.command().map(|_| ()).ok_or(DecodeError::Invalid)
    }

    pub(crate) fn into_command(self) -> Option<SessionHistoryCommand> {
        self.command()
    }

    fn command(&self) -> Option<SessionHistoryCommand> {
        SessionHistoryCommand::new(
            self.scope.identity.endpoint.runtime_endpoint()?,
            self.input.session_key.clone(),
            self.input.endpoint_session_id.clone(),
            self.input.limit,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    identity: Identity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: Identity,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    session_key: String,
    session_identity: Identity,
    #[serde(default)]
    endpoint_session_id: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    endpoint: Endpoint,
    agent_id: String,
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn runtime_endpoint(&self) -> Option<RuntimeEndpoint> {
        (self.kind == RUNTIME_KIND).then(|| {
            RuntimeEndpoint::try_new(
                self.runtime_adapter_id.as_str(),
                self.runtime_instance_id.as_str(),
            )
            .ok()
        })?
    }
}

pub(crate) enum Delivery {
    Loaded(crate::session_history::SessionHistoryView),
    Unavailable,
}

impl Delivery {
    pub(crate) fn from_outcome(outcome: SessionHistoryOutcome) -> Self {
        match outcome {
            SessionHistoryOutcome::Loaded(history) => Self::Loaded(history),
            SessionHistoryOutcome::Failed(
                SessionHistoryFailure::Rejected
                | SessionHistoryFailure::Protocol
                | SessionHistoryFailure::Unavailable
                | SessionHistoryFailure::Deadline,
            ) => Self::Unavailable,
        }
    }

    pub(crate) const fn status_code(&self) -> u16 {
        match self {
            Self::Loaded(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Loaded(history) => serde_json::json!({
                "messages": history.messages.iter().map(|message| {
                    serde_json::json!({
                        "role": match message.role {
                            SessionHistoryRole::User => "user",
                            SessionHistoryRole::Assistant => "assistant",
                        },
                        "text": &message.text,
                    })
                }).collect::<Vec<_>>(),
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session history is unavailable",
            }),
        }
    }
}
