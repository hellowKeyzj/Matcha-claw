use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Eq, PartialEq, Hash, Serialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidId> {
        let value = value.into();
        valid_uuid(&value).then_some(Self(value)).ok_or(InvalidId)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for SessionId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_new(String::deserialize(deserializer)?)
            .map_err(|_| serde::de::Error::custom("invalid native session UUID"))
    }
}
impl fmt::Debug for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionId(<redacted>)")
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidId;

pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sequence(u64);
impl Sequence {
    pub fn try_new(value: u64) -> Result<Self, InvalidId> {
        (value <= sessions_module::state::MAX_SAFE_INTEGER)
            .then_some(Self(value))
            .ok_or(InvalidId)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClassifiedErrorKind {
    InvalidRequest,
    Auth,
    Permission,
    Network,
    Aborted,
    Worker,
    Internal,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: SessionId,
    pub agent_id: String,
    pub status: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub title: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub provider_id: Option<String>,
    pub model_selection_id: Option<String>,
    pub provider_fingerprint: Option<String>,
}

impl SessionRecord {
    pub(crate) fn validate(&self, id: &str, agent: Option<&str>) -> bool {
        self.session_id.as_str() == id
            && valid_agent_id(&self.agent_id)
            && agent.is_none_or(|agent| agent == self.agent_id)
            && matches!(self.status.as_str(), "open" | "closed" | "deleting")
            && self.created_at_ms <= sessions_module::state::MAX_SAFE_INTEGER
            && self.updated_at_ms <= sessions_module::state::MAX_SAFE_INTEGER
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub session_id: String,
    pub message_id: String,
    pub status: RunStatus,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Starting,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}
impl RunStatus {
    pub fn phase(self) -> sessions_module::state::RunPhase {
        use sessions_module::state::RunPhase;
        match self {
            Self::Queued => RunPhase::Queued,
            Self::Starting | Self::Running => RunPhase::Started,
            Self::CancelRequested => RunPhase::CancellationRequested,
            Self::Succeeded => RunPhase::Completed,
            Self::Failed => RunPhase::Failed,
            Self::Cancelled => RunPhase::Cancelled,
            Self::OutcomeUnknown => RunPhase::Interrupted,
        }
    }
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::OutcomeUnknown
        )
    }
}
impl RunRecord {
    pub fn validate(&self, session_id: &str) -> bool {
        self.session_id == session_id && valid_uuid(&self.run_id) && valid_uuid(&self.message_id)
    }
}

pub fn valid_agent_id(value: &str) -> bool {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    #[cfg(windows)]
    {
        let upper = value.to_ascii_uppercase();
        let numbered_device = upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
        if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
            return false;
        }
    }
    true
}
