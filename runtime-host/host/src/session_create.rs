use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{AgentId, EndpointSessionId, SessionCreateParams, SessionCreateResult},
};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use platform::exchange::InvocationOutcome;
use serde::{Serialize, Serializer};

use crate::{
    runtime_driver::RuntimeDriverIdentity,
    session_state::{SessionIdentity, SessionProvider, SessionState, SessionView},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
    Unsupported,
}

impl NativeEndpoint {
    pub(crate) fn from_runtime_endpoint(endpoint: RuntimeEndpoint) -> Self {
        if endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            Self::OpenClawLocal
        } else if endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            Self::MatchaAgentLocal
        } else {
            Self::Unsupported
        }
    }

    pub(crate) fn runtime_endpoint(self) -> Option<RuntimeEndpoint> {
        match self {
            Self::OpenClawLocal => Some(RuntimeDriverIdentity::open_claw().endpoint()),
            Self::MatchaAgentLocal => Some(RuntimeDriverIdentity::matcha_agent().endpoint()),
            Self::Unsupported => None,
        }
    }
}

const MAX_AGENT_ID_BYTES: usize = 64;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCreateCommand {
    pub(crate) endpoint: NativeEndpoint,
    agent_id: String,
    endpoint_session_id: Option<String>,
}

impl SessionCreateCommand {
    pub(crate) fn new(
        endpoint: NativeEndpoint,
        agent_id: String,
        endpoint_session_id: Option<String>,
    ) -> Result<Self, InvalidSessionCreate> {
        if !valid_identity(&agent_id, MAX_AGENT_ID_BYTES)
            || endpoint_session_id
                .as_deref()
                .is_some_and(|value| !valid_identity(value, MAX_ENDPOINT_SESSION_ID_BYTES))
        {
            return Err(InvalidSessionCreate);
        }
        Ok(Self {
            endpoint,
            agent_id,
            endpoint_session_id,
        })
    }

    pub(crate) fn with_endpoint_session_id(
        mut self,
        endpoint_session_id: String,
    ) -> Result<Self, InvalidSessionCreate> {
        if !valid_identity(&endpoint_session_id, MAX_ENDPOINT_SESSION_ID_BYTES) {
            return Err(InvalidSessionCreate);
        }
        self.endpoint_session_id = Some(endpoint_session_id);
        Ok(self)
    }

    pub(crate) fn endpoint_session_id_missing(&self) -> bool {
        self.endpoint_session_id.is_none()
    }

    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) fn agent_id_owned(&self) -> String {
        self.agent_id.clone()
    }

    pub(crate) fn into_openclaw_params(self) -> Result<SessionCreateParams, InvalidSessionCreate> {
        if self.endpoint != NativeEndpoint::OpenClawLocal {
            return Err(InvalidSessionCreate);
        }
        let agent_id = AgentId::try_new(self.agent_id).map_err(|_| InvalidSessionCreate)?;
        let endpoint_session_id =
            EndpointSessionId::try_new(self.endpoint_session_id.ok_or(InvalidSessionCreate)?)
                .map_err(|_| InvalidSessionCreate)?;
        SessionCreateParams::try_new(agent_id, endpoint_session_id)
            .map_err(|_| InvalidSessionCreate)
    }

    pub(crate) fn into_matcha_session_id(
        self,
    ) -> Result<matcha_agent::session::model::SessionId, InvalidSessionCreate> {
        if self.endpoint != NativeEndpoint::MatchaAgentLocal {
            return Err(InvalidSessionCreate);
        }
        matcha_agent::session::model::SessionId::try_new(
            self.endpoint_session_id.ok_or(InvalidSessionCreate)?,
        )
        .map_err(|_| InvalidSessionCreate)
    }

    pub(crate) fn session_key(&self) -> Result<String, InvalidSessionCreate> {
        match self.endpoint {
            NativeEndpoint::OpenClawLocal => self
                .clone()
                .into_openclaw_params()
                .map(|params| params.key().as_str().to_owned()),
            NativeEndpoint::MatchaAgentLocal => self
                .clone()
                .into_matcha_session_id()
                .map(|session_id| session_id.as_str().to_owned()),
            NativeEndpoint::Unsupported => Err(InvalidSessionCreate),
        }
    }

    pub(crate) fn session_key_from_native_id(
        &self,
        native_session_id: String,
    ) -> Result<String, InvalidSessionCreate> {
        if !valid_identity(&native_session_id, MAX_ENDPOINT_SESSION_ID_BYTES) {
            return Err(InvalidSessionCreate);
        }
        match self.endpoint {
            NativeEndpoint::OpenClawLocal => {
                let agent_id =
                    AgentId::try_new(self.agent_id.clone()).map_err(|_| InvalidSessionCreate)?;
                let native_session_id = EndpointSessionId::try_new(native_session_id)
                    .map_err(|_| InvalidSessionCreate)?;
                openclaw::session::protocol::AgentScopedSessionKey::try_new(
                    agent_id,
                    native_session_id,
                )
                .map(|key| key.as_str().to_owned())
                .map_err(|_| InvalidSessionCreate)
            }
            NativeEndpoint::MatchaAgentLocal => {
                matcha_agent::session::model::SessionId::try_new(native_session_id)
                    .map(|session_id| session_id.as_str().to_owned())
                    .map_err(|_| InvalidSessionCreate)
            }
            NativeEndpoint::Unsupported => Err(InvalidSessionCreate),
        }
    }
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidSessionCreate;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionCreateOutcome {
    Succeeded(SessionView),
    TargetRejected,
    Unknown,
    Unavailable,
}

impl Serialize for SessionCreateOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Succeeded(view) => view.serialize(serializer),
            Self::TargetRejected => OutcomeTag::TargetRejected.serialize(serializer),
            Self::Unknown => OutcomeTag::Unknown.serialize(serializer),
            Self::Unavailable => OutcomeTag::Unavailable.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum OutcomeTag {
    TargetRejected,
    Unknown,
    Unavailable,
}

pub(crate) fn project_openclaw_create(
    command: &SessionCreateCommand,
    outcome: InvocationOutcome<SessionCreateResult, OpenClawSessionError>,
    epoch: u64,
) -> SessionCreateOutcome {
    match outcome {
        InvocationOutcome::Succeeded(result) => {
            match command.session_key_from_native_id(result.native_session_id().as_str().to_owned())
            {
                Ok(session_key) => project_created_session_view(
                    session_key,
                    SessionProvider::OpenClaw,
                    Some(command.agent_id().to_owned()),
                    epoch,
                )
                .map(SessionCreateOutcome::Succeeded)
                .unwrap_or(SessionCreateOutcome::Unknown),
                Err(_) => SessionCreateOutcome::Unknown,
            }
        }
        InvocationOutcome::TargetRejected(_) => SessionCreateOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionCreateOutcome::Unknown,
    }
}

pub(crate) fn project_matcha_create(
    session_key: String,
    agent_id: Option<String>,
    epoch: u64,
) -> SessionCreateOutcome {
    project_created_session_view(session_key, SessionProvider::MatchaAgent, agent_id, epoch)
        .map(SessionCreateOutcome::Succeeded)
        .unwrap_or(SessionCreateOutcome::Unknown)
}

fn project_created_session_view(
    session_key: String,
    provider: SessionProvider,
    agent_id: Option<String>,
    epoch: u64,
) -> Option<SessionView> {
    let identity = SessionIdentity::new(session_key, provider, agent_id)?;
    SessionState::new(identity, epoch)
        .ok()
        .map(|state| state.view())
}

pub(crate) const fn project_openclaw_client_error(
    error: OpenClawSessionError,
) -> SessionCreateOutcome {
    match error {
        OpenClawSessionError::TargetRejected => SessionCreateOutcome::TargetRejected,
        OpenClawSessionError::SessionConnection
        | OpenClawSessionError::RequestIdExhausted
        | OpenClawSessionError::RequestDeadline
        | OpenClawSessionError::ConnectionClosed
        | OpenClawSessionError::UnknownResponse
        | OpenClawSessionError::Transport
        | OpenClawSessionError::Protocol
        | OpenClawSessionError::EventBackpressure => SessionCreateOutcome::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    #[test]
    fn builds_the_agent_scoped_openclaw_create_params() {
        let command = SessionCreateCommand::new(
            NativeEndpoint::OpenClawLocal,
            "main".into(),
            Some("session-1".into()),
        )
        .unwrap();
        assert_eq!(command.session_key().unwrap(), "agent:main:session-1");
    }

    #[test]
    fn rejects_invalid_native_identity_projection() {
        let command = SessionCreateCommand::new(
            NativeEndpoint::OpenClawLocal,
            "main".into(),
            Some("requested-id".into()),
        )
        .unwrap();
        assert!(command.session_key_from_native_id(" ".into()).is_err());
    }

    #[test]
    fn preserves_unavailable_client_delivery_and_unknown_native_receipts() {
        assert_eq!(
            project_openclaw_client_error(OpenClawSessionError::RequestDeadline),
            SessionCreateOutcome::Unavailable
        );
        assert_eq!(
            project_openclaw_create(
                &SessionCreateCommand::new(
                    NativeEndpoint::OpenClawLocal,
                    "main".into(),
                    Some("session-1".into()),
                )
                .unwrap(),
                InvocationOutcome::Unknown,
                1,
            ),
            SessionCreateOutcome::Unknown
        );
    }

    #[test]
    fn serializes_success_as_the_session_view_contract() {
        let value = to_value(project_matcha_create("matcha-session-1".into(), None, 1)).unwrap();
        assert_eq!(value["sessionKey"], json!("matcha-session-1"));
        assert_eq!(
            value["identity"]["endpoint"]["runtimeAdapterId"],
            json!("matcha-agent")
        );
        assert!(value.get("outcome").is_none());
    }
}
