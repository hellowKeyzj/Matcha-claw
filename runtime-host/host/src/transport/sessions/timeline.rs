use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::state::{SessionCompleteness, SessionView},
    sessions::timeline::{Command, Direction, Outcome, Provider, WindowRequest},
    transport::common::authorization::CapabilityDecisionVerifier,
};

const CAPABILITY_ID: &str = "session.management";
const LOAD_OPERATION: &str = "sessions.load";
const WINDOW_OPERATION: &str = "sessions.window";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_INSTANCE_ID: &str = "local";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "session";
const LOAD_AUTHORIZATION_ENDPOINT: &str = "/api/sessions/load";
const WINDOW_AUTHORIZATION_ENDPOINT: &str = "/api/sessions/window";
const AUTHORIZATION_SCOPE: &str = "sessions:read";
const AUTHORIZATION_SUBJECT: &str = "session-timeline";
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;

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
        if !matches!(
            request.operation_id.as_str(),
            LOAD_OPERATION | WINDOW_OPERATION
        ) {
            return Err(DecodeError::Invalid);
        }
        verifier
            .verify(
                authorization,
                now,
                authorization_endpoint(&request.operation_id).ok_or(DecodeError::Invalid)?,
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
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.target.identity == self.scope.identity
            && self.input.session_identity == self.scope.identity
            && self.input.session_key == self.scope.identity.session_key
            && self.scope.identity.endpoint.is_local_provider()
            && valid_endpoint_session_id(self.input.endpoint_session_id.as_deref()))
        .then_some(())
        .ok_or(DecodeError::Invalid)?;

        match self.operation_id.as_str() {
            LOAD_OPERATION => {
                if self.input.mode.is_some() || self.input.offset.is_some() {
                    return Err(DecodeError::Invalid);
                }
            }
            WINDOW_OPERATION => {
                if self.input.mode.is_none() {
                    return Err(DecodeError::Invalid);
                }
            }
            _ => return Err(DecodeError::Invalid),
        }
        WindowRequest::new(
            self.input.mode.unwrap_or(DirectionWire::Latest).into(),
            self.input.limit.unwrap_or(WindowRequest::latest().limit()),
            self.input.offset,
        )
        .ok_or(DecodeError::Invalid)?;
        Ok(())
    }

    pub(crate) fn into_command(self) -> Option<Command> {
        let window = WindowRequest::new(
            self.input.mode.unwrap_or(DirectionWire::Latest).into(),
            self.input.limit.unwrap_or(WindowRequest::latest().limit()),
            self.input.offset,
        )?;
        Command::new(
            self.scope.identity.endpoint.provider()?,
            self.input.session_key,
            Some(self.scope.identity.agent_id.clone()),
            window,
            self.input.endpoint_session_id,
            self.input.include_canonical.unwrap_or(true),
        )
    }

    pub(crate) fn identity(&self) -> &Identity {
        &self.scope.identity
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
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
    mode: Option<DirectionWire>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    include_canonical: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DirectionWire {
    Latest,
    Older,
    Newer,
}

impl From<DirectionWire> for Direction {
    fn from(value: DirectionWire) -> Self {
        match value {
            DirectionWire::Latest => Self::Latest,
            DirectionWire::Older => Self::Older,
            DirectionWire::Newer => Self::Newer,
        }
    }
}

fn authorization_endpoint(operation: &str) -> Option<&'static str> {
    match operation {
        LOAD_OPERATION => Some(LOAD_AUTHORIZATION_ENDPOINT),
        WINDOW_OPERATION => Some(WINDOW_AUTHORIZATION_ENDPOINT),
        _ => None,
    }
}

fn valid_endpoint_session_id(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !value.is_empty()
            && value.len() <= MAX_ENDPOINT_SESSION_ID_BYTES
            && value.trim() == value
            && !value.chars().any(char::is_control)
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
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
    fn provider(&self) -> Option<Provider> {
        (self.kind == RUNTIME_KIND && self.runtime_instance_id == RUNTIME_INSTANCE_ID).then_some(
            match self.runtime_adapter_id.as_str() {
                "openclaw" => Some(Provider::OpenClaw),
                "matcha-agent" => Some(Provider::Matcha),
                _ => None,
            },
        )?
    }

    fn is_local_provider(&self) -> bool {
        self.provider().is_some()
    }
}

pub(crate) enum Delivery {
    Complete(SessionView),
    Unavailable,
}

impl Delivery {
    pub(crate) fn from_outcome(identity: &Identity, outcome: Outcome) -> Self {
        match outcome {
            Outcome::Complete(view) if identity_matches_view(identity, &view) => {
                Self::Complete(view)
            }
            Outcome::Complete(_) => Self::Unavailable,
            Outcome::Incomplete(view) if identity_matches_view(identity, &view) => {
                Self::Complete(view)
            }
            Outcome::Incomplete(_) | Outcome::Unavailable(_) => Self::Unavailable,
        }
    }

    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Complete(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Complete(view) => crate::transport::sessions::presenter::session_view(view),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session timeline is unavailable",
            }),
        }
    }
}

fn identity_matches_view(identity: &Identity, view: &SessionView) -> bool {
    view.session_key() == identity.session_key
        && view.identity.session_key() == identity.session_key
        && view.identity.agent_id.as_deref() == Some(identity.agent_id.as_str())
        && view.identity.endpoint.kind == identity.endpoint.kind
        && view.identity.endpoint.runtime_instance_id == identity.endpoint.runtime_instance_id
        && matches!(
            (
                identity.endpoint.runtime_adapter_id.as_str(),
                view.identity.endpoint.provider()
            ),
            (
                "openclaw",
                crate::sessions::state::SessionProvider::OpenClaw
            ) | (
                "matcha-agent",
                crate::sessions::state::SessionProvider::MatchaAgent
            )
        )
        && !matches!(
            view.completeness,
            SessionCompleteness::Unavailable | SessionCompleteness::Unknown
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::state::{
        MissingFact, RunPhase, RuntimeView, SessionCompleteness, SessionFact, SessionIdentity,
        SessionProvider, SessionWindow,
    };

    #[test]
    fn accepts_canonical_controls_on_window_requests() {
        let value = serde_json::json!({
            "id": CAPABILITY_ID,
            "operationId": WINDOW_OPERATION,
            "scope": { "kind": "session", "identity": identity_json() },
            "target": { "kind": "session", "identity": identity_json() },
            "input": {
                "sessionKey": "session-1",
                "sessionIdentity": identity_json(),
                "endpointSessionId": "endpoint-session-1",
                "mode": "older",
                "limit": 20,
                "offset": 3,
                "includeCanonical": true
            }
        });
        let request = serde_json::from_value::<Request>(value).unwrap();
        let command = request.into_command().unwrap();
        assert!(command.include_canonical());
        assert_eq!(command.endpoint_session_id(), Some("endpoint-session-1"));
    }

    #[test]
    fn incomplete_source_backed_timeline_is_delivered_as_client_seed() {
        let identity = serde_json::from_value::<Identity>(identity_json()).unwrap();
        let delivery = Delivery::from_outcome(&identity, Outcome::Incomplete(source_backed_view()));

        assert_eq!(delivery.status_code(), 200);
        let body = delivery.body();
        assert_eq!(body["sessionKey"], "session-1");
        assert_eq!(body["identity"], identity_json());
        assert_eq!(body["items"]["complete"][0]["kind"], "userMessage");
        assert_eq!(body["items"]["complete"][0]["text"], "seeded history");
        assert_eq!(
            body["completeness"],
            serde_json::json!({"incomplete": {"missing": ["bounded_history", "partial_runtime"]}})
        );
    }

    fn source_backed_view() -> SessionView {
        SessionView {
            session_key: "session-1".to_owned(),
            endpoint_session_id: None,
            identity: SessionIdentity::new(
                "session-1",
                SessionProvider::OpenClaw,
                Some("agent-1".to_owned()),
            )
            .unwrap(),
            epoch: 1,
            seq: 0,
            cursor: 0,
            items: SessionFact::Complete(vec![crate::sessions::state::SessionItem::UserMessage {
                item_id: "message-1".to_owned(),
                message_id: Some("message-1".to_owned()),
                text: "seeded history".to_owned(),
                content: vec![crate::sessions::state::SessionContent::Text {
                    text: "seeded history".to_owned(),
                }],
                status: crate::sessions::state::ItemStatus::Final,
            }]),
            tools: SessionFact::Complete(Vec::new()),
            approvals: SessionFact::Incomplete {
                facts: Vec::new(),
                gaps: vec![MissingFact::EventOnly],
            },
            runtime: SessionFact::Incomplete {
                facts: RuntimeView {
                    phase: RunPhase::Completed,
                    active_run_id: None,
                    issue: None,
                    runtime_activity: None,
                    error_detail: None,
                },
                gaps: vec![MissingFact::PartialRuntime],
            },
            window: SessionFact::Complete(SessionWindow::latest(1)),
            completeness: SessionCompleteness::Incomplete {
                missing: vec![MissingFact::BoundedHistory, MissingFact::PartialRuntime],
            },
        }
    }

    fn identity_json() -> Value {
        serde_json::json!({
            "endpoint": {
                "kind": RUNTIME_KIND,
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": RUNTIME_INSTANCE_ID
            },
            "agentId": "agent-1",
            "sessionKey": "session-1"
        })
    }
}
