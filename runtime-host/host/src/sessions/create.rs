use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{AgentId, EndpointSessionId, SessionCreateParams, SessionCreateResult},
};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use platform::exchange::InvocationOutcome;
use serde::{Serialize, Serializer};

use crate::sessions::state::{
    MAX_SESSION_KEY_BYTES, SessionIdentity, SessionProvider, SessionState, SessionView,
};

const MAX_AGENT_ID_BYTES: usize = 64;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCreateAdmissionInput {
    endpoint: RuntimeEndpoint,
    agent_id: String,
    endpoint_session_id: Option<String>,
}

impl SessionCreateAdmissionInput {
    pub(crate) fn new(
        endpoint: RuntimeEndpoint,
        agent_id: String,
        endpoint_session_id: Option<String>,
    ) -> Self {
        Self {
            endpoint,
            agent_id,
            endpoint_session_id,
        }
    }

    pub(crate) fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    #[cfg(test)]
    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    #[cfg(test)]
    pub(crate) fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionAdmission {
    endpoint: RuntimeEndpoint,
    provider: SessionProvider,
    generated_key_namespace: &'static str,
}

impl SessionAdmission {
    pub(crate) fn agent_scoped(
        endpoint: RuntimeEndpoint,
        provider: SessionProvider,
        generated_key_namespace: &'static str,
    ) -> Self {
        Self {
            endpoint,
            provider,
            generated_key_namespace,
        }
    }

    pub(crate) fn prepare_create(
        &self,
        input: SessionCreateAdmissionInput,
        now_ms: u64,
    ) -> Result<SessionCreateCommand, InvalidSessionCreate> {
        if input.endpoint != self.endpoint || !valid_identity(&input.agent_id, MAX_AGENT_ID_BYTES) {
            return Err(InvalidSessionCreate);
        }
        let endpoint_session_id = match input.endpoint_session_id {
            Some(endpoint_session_id) => {
                if !valid_identity(&endpoint_session_id, MAX_ENDPOINT_SESSION_ID_BYTES) {
                    return Err(InvalidSessionCreate);
                }
                endpoint_session_id
            }
            None => generated_endpoint_session_id(now_ms)?,
        };
        let session_key = generated_local_session_key(
            self.generated_key_namespace,
            &input.agent_id,
            &endpoint_session_id,
        );
        SessionCreateCommand::from_prepared(
            self.endpoint.clone(),
            self.provider,
            input.agent_id,
            endpoint_session_id,
            session_key,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCreateCommand {
    endpoint: RuntimeEndpoint,
    provider: SessionProvider,
    agent_id: String,
    endpoint_session_id: String,
    session_key: String,
}

impl SessionCreateCommand {
    fn from_prepared(
        endpoint: RuntimeEndpoint,
        provider: SessionProvider,
        agent_id: String,
        endpoint_session_id: String,
        session_key: String,
    ) -> Result<Self, InvalidSessionCreate> {
        if !valid_identity(&agent_id, MAX_AGENT_ID_BYTES)
            || !valid_identity(&endpoint_session_id, MAX_ENDPOINT_SESSION_ID_BYTES)
            || !valid_identity(&session_key, MAX_SESSION_KEY_BYTES)
        {
            return Err(InvalidSessionCreate);
        }
        Ok(Self {
            endpoint,
            provider,
            agent_id,
            endpoint_session_id,
            session_key,
        })
    }

    pub(crate) fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) fn agent_id_owned(&self) -> String {
        self.agent_id.clone()
    }

    pub(crate) fn endpoint_session_id(&self) -> &str {
        &self.endpoint_session_id
    }

    pub(crate) fn into_openclaw_params(self) -> Result<SessionCreateParams, InvalidSessionCreate> {
        if self.provider != SessionProvider::OpenClaw {
            return Err(InvalidSessionCreate);
        }
        let agent_id = AgentId::try_new(self.agent_id).map_err(|_| InvalidSessionCreate)?;
        let endpoint_session_id = EndpointSessionId::try_new(self.endpoint_session_id)
            .map_err(|_| InvalidSessionCreate)?;
        SessionCreateParams::try_new(agent_id, endpoint_session_id)
            .map_err(|_| InvalidSessionCreate)
    }

    pub(crate) fn into_matcha_session_id(
        self,
    ) -> Result<matcha_agent::session::model::SessionId, InvalidSessionCreate> {
        if self.provider != SessionProvider::MatchaAgent {
            return Err(InvalidSessionCreate);
        }
        matcha_agent::session::model::SessionId::try_new(self.endpoint_session_id)
            .map_err(|_| InvalidSessionCreate)
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.session_key
    }

    pub(crate) const fn provider(&self) -> SessionProvider {
        self.provider
    }
}

fn generated_local_session_key(
    namespace: &str,
    agent_id: &str,
    endpoint_session_id: &str,
) -> String {
    format!("{namespace}:{agent_id}:{endpoint_session_id}")
}

fn generated_endpoint_session_id(now_ms: u64) -> Result<String, InvalidSessionCreate> {
    random_uuid_v4().map(|uuid| format!("session-{now_ms}-{uuid}"))
}

fn random_uuid_v4() -> Result<String, InvalidSessionCreate> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| InvalidSessionCreate)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
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
        InvocationOutcome::Succeeded(_) => {
            let session_key = command.session_key().to_owned();
            project_created_session_view(
                session_key,
                Some(command.endpoint_session_id().to_owned()),
                SessionProvider::OpenClaw,
                Some(command.agent_id().to_owned()),
                epoch,
            )
            .map(SessionCreateOutcome::Succeeded)
            .unwrap_or(SessionCreateOutcome::Unknown)
        }
        InvocationOutcome::TargetRejected(_) => SessionCreateOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionCreateOutcome::Unknown,
    }
}

pub(crate) fn project_matcha_create(
    session_key: String,
    endpoint_session_id: String,
    agent_id: Option<String>,
    epoch: u64,
) -> SessionCreateOutcome {
    project_created_session_view(
        session_key,
        Some(endpoint_session_id),
        SessionProvider::MatchaAgent,
        agent_id,
        epoch,
    )
    .map(SessionCreateOutcome::Succeeded)
    .unwrap_or(SessionCreateOutcome::Unknown)
}

fn project_created_session_view(
    session_key: String,
    endpoint_session_id: Option<String>,
    provider: SessionProvider,
    agent_id: Option<String>,
    epoch: u64,
) -> Option<SessionView> {
    let identity = SessionIdentity::new(session_key, provider, agent_id)?;
    SessionState::new(identity, epoch)
        .and_then(|state| state.with_endpoint_session_id(endpoint_session_id))
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
        | OpenClawSessionError::Protocol(_)
        | OpenClawSessionError::EventBackpressure => SessionCreateOutcome::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;
    use crate::runtime_driver::RuntimeDriverIdentity;

    fn openclaw_admission() -> SessionAdmission {
        SessionAdmission::agent_scoped(
            RuntimeDriverIdentity::open_claw().endpoint(),
            SessionProvider::OpenClaw,
            "agent",
        )
    }

    fn matcha_admission() -> SessionAdmission {
        SessionAdmission::agent_scoped(
            RuntimeDriverIdentity::matcha_agent().endpoint(),
            SessionProvider::MatchaAgent,
            "matcha-agent",
        )
    }

    #[test]
    fn builds_the_agent_scoped_openclaw_create_params() {
        let command = openclaw_admission()
            .prepare_create(
                SessionCreateAdmissionInput::new(
                    RuntimeDriverIdentity::open_claw().endpoint(),
                    "main".into(),
                    Some("session-1".into()),
                ),
                0,
            )
            .unwrap();
        assert_eq!(command.session_key(), "agent:main:session-1");
    }

    #[test]
    fn generates_old_ts_shaped_openclaw_session_key_with_uuid_suffix() {
        let command = openclaw_admission()
            .prepare_create(
                SessionCreateAdmissionInput::new(
                    RuntimeDriverIdentity::open_claw().endpoint(),
                    "main".into(),
                    None,
                ),
                7,
            )
            .unwrap();
        let key = command.session_key();
        let suffix = key.strip_prefix("agent:main:session-7-").unwrap();

        assert_eq!(suffix.len(), 36);
        assert_eq!(suffix.as_bytes()[8], b'-');
        assert_eq!(suffix.as_bytes()[13], b'-');
        assert_eq!(suffix.as_bytes()[14], b'4');
        assert_eq!(suffix.as_bytes()[18], b'-');
        assert!(matches!(suffix.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_eq!(suffix.as_bytes()[23], b'-');
        assert_eq!(
            command
                .clone()
                .into_openclaw_params()
                .unwrap()
                .key()
                .as_str(),
            key
        );
    }

    #[test]
    fn generated_matcha_session_key_keeps_native_id_unprefixed() {
        let command = matcha_admission()
            .prepare_create(
                SessionCreateAdmissionInput::new(
                    RuntimeDriverIdentity::matcha_agent().endpoint(),
                    "main".into(),
                    None,
                ),
                7,
            )
            .unwrap();
        let key = command.session_key().to_owned();
        let native_id = command.clone().into_matcha_session_id().unwrap();

        assert!(native_id.as_str().starts_with("session-7-"));
        assert!(!native_id.as_str().contains(':'));
        assert_eq!(key, format!("matcha-agent:main:{}", native_id.as_str()));
    }

    #[test]
    fn rejects_invalid_admission_identity() {
        assert!(
            openclaw_admission()
                .prepare_create(
                    SessionCreateAdmissionInput::new(
                        RuntimeDriverIdentity::open_claw().endpoint(),
                        "main".into(),
                        Some(" ".into()),
                    ),
                    1,
                )
                .is_err()
        );
    }

    #[test]
    fn preserves_unavailable_client_delivery_and_unknown_native_receipts() {
        assert_eq!(
            project_openclaw_client_error(OpenClawSessionError::RequestDeadline),
            SessionCreateOutcome::Unavailable
        );
        assert_eq!(
            project_openclaw_create(
                &openclaw_admission()
                    .prepare_create(
                        SessionCreateAdmissionInput::new(
                            RuntimeDriverIdentity::open_claw().endpoint(),
                            "main".into(),
                            Some("session-1".into()),
                        ),
                        0,
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
        let value = to_value(project_matcha_create(
            "matcha-agent:main:matcha-session-1".into(),
            "matcha-session-1".into(),
            Some("main".into()),
            1,
        ))
        .unwrap();
        assert_eq!(
            value["sessionKey"],
            json!("matcha-agent:main:matcha-session-1")
        );
        assert_eq!(value["endpointSessionId"], json!("matcha-session-1"));
        assert_eq!(value["identity"]["agentId"], json!("main"));
        assert_eq!(
            value["identity"]["endpoint"]["runtimeAdapterId"],
            json!("matcha-agent")
        );
        assert!(value.get("outcome").is_none());
    }
}
