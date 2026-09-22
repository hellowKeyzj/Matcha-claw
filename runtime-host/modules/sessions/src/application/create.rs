use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::{Serialize, Serializer};

use crate::state::{
    MAX_SESSION_KEY_BYTES, SessionIdentity, SessionProvider, SessionState, SessionView,
};

const MAX_AGENT_ID_BYTES: usize = 64;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCreateAdmissionInput {
    endpoint: RuntimeEndpoint,
    agent_id: String,
    endpoint_session_id: Option<String>,
}

impl SessionCreateAdmissionInput {
    pub fn new(
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

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    #[cfg(test)]
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    #[cfg(test)]
    pub fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionAdmission {
    endpoint: RuntimeEndpoint,
    provider: SessionProvider,
    session_key_prefix: Option<&'static str>,
}

impl SessionAdmission {
    pub fn new(
        endpoint: RuntimeEndpoint,
        provider: SessionProvider,
        session_key_prefix: Option<&'static str>,
    ) -> Self {
        Self {
            endpoint,
            provider,
            session_key_prefix,
        }
    }

    pub fn prepare_create(
        &self,
        input: SessionCreateAdmissionInput,
        now_ms: u64,
    ) -> Result<SessionCreateCommand, InvalidSessionCreate> {
        if input.endpoint != self.endpoint {
            return Err(InvalidSessionCreate);
        }
        if !valid_agent_id(&input.agent_id) {
            return Err(InvalidSessionCreate);
        }
        let endpoint_session_id = match input.endpoint_session_id {
            Some(endpoint_session_id) => {
                if !valid_endpoint_session_id(&endpoint_session_id) {
                    return Err(InvalidSessionCreate);
                }
                endpoint_session_id
            }
            None => generated_endpoint_session_id(now_ms)?,
        };
        let session_key = rendered_session_key(
            self.session_key_prefix,
            &input.agent_id,
            &endpoint_session_id,
        )
        .ok_or(InvalidSessionCreate)?;
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
pub struct SessionCreateCommand {
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

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn agent_id_owned(&self) -> String {
        self.agent_id.clone()
    }

    pub fn endpoint_session_id(&self) -> &str {
        &self.endpoint_session_id
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub const fn provider(&self) -> SessionProvider {
        self.provider
    }
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

fn rendered_session_key(
    prefix: Option<&str>,
    agent_id: &str,
    endpoint_session_id: &str,
) -> Option<String> {
    let session_key = match prefix {
        Some(prefix) => format!("{prefix}:{agent_id}:{endpoint_session_id}"),
        None => format!("agent:{agent_id}:{endpoint_session_id}"),
    };
    valid_identity(&session_key, MAX_SESSION_KEY_BYTES).then_some(session_key)
}

fn valid_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=MAX_AGENT_ID_BYTES).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && bytes.iter().all(|byte| !byte.is_ascii_uppercase())
}

fn valid_endpoint_session_id(value: &str) -> bool {
    valid_identity(value, MAX_ENDPOINT_SESSION_ID_BYTES)
        && value
            .get(..6)
            .is_none_or(|prefix| !prefix.eq_ignore_ascii_case("agent:"))
        && !value.split(':').any(str::is_empty)
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidSessionCreate;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionCreateOutcome {
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

pub fn project_matcha_create(
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

pub fn project_created_session_view(
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

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    fn runtime_endpoint(adapter_id: &str) -> RuntimeEndpoint {
        RuntimeEndpoint::try_new(adapter_id, "local").unwrap()
    }

    fn openclaw_admission() -> SessionAdmission {
        SessionAdmission::new(
            runtime_endpoint("openclaw"),
            SessionProvider::OpenClaw,
            None,
        )
    }

    fn matcha_admission() -> SessionAdmission {
        SessionAdmission::new(
            runtime_endpoint("matcha-agent"),
            SessionProvider::MatchaAgent,
            Some("matcha-agent"),
        )
    }

    #[test]
    fn builds_the_agent_scoped_openclaw_create_params() {
        let command = openclaw_admission()
            .prepare_create(
                SessionCreateAdmissionInput::new(
                    runtime_endpoint("openclaw"),
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
                SessionCreateAdmissionInput::new(runtime_endpoint("openclaw"), "main".into(), None),
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
        assert_eq!(command.endpoint_session_id(), format!("session-7-{suffix}"));
    }

    #[test]
    fn generated_matcha_session_key_keeps_native_id_unprefixed() {
        let command = matcha_admission()
            .prepare_create(
                SessionCreateAdmissionInput::new(
                    runtime_endpoint("matcha-agent"),
                    "main".into(),
                    None,
                ),
                7,
            )
            .unwrap();
        let key = command.session_key().to_owned();
        let native_id = command.endpoint_session_id();

        assert!(native_id.starts_with("session-7-"));
        assert!(!native_id.contains(':'));
        assert_eq!(key, format!("matcha-agent:main:{native_id}"));
    }

    #[test]
    fn rejects_invalid_admission_identity() {
        assert!(
            openclaw_admission()
                .prepare_create(
                    SessionCreateAdmissionInput::new(
                        runtime_endpoint("openclaw"),
                        "main".into(),
                        Some(" ".into()),
                    ),
                    1,
                )
                .is_err()
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
