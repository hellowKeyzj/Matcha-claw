use std::fmt;

use zeroize::Zeroizing;

use super::StateDirError;

#[cfg(unix)]
#[path = "auth_profiles/posix.rs"]
mod posix;
#[cfg(windows)]
#[path = "auth_profiles/windows.rs"]
mod windows;

pub(crate) const MAX_AUTH_PROFILES_BYTES: usize = 1_048_576;
const REDACTED: &str = "[REDACTED]";

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AgentId(String);

impl AgentId {
    pub(crate) fn try_new(value: String) -> Result<Self, StateDirError> {
        valid_agent_id(&value)
            .then_some(Self(value))
            .ok_or(StateDirError)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentId([REDACTED])")
    }
}

pub(crate) struct PrivateAuthProfiles(Zeroizing<Vec<u8>>);

impl PrivateAuthProfiles {
    pub(crate) fn try_new(contents: Vec<u8>) -> Result<Self, StateDirError> {
        let contents = Self(Zeroizing::new(contents));
        (contents.0.len() <= MAX_AUTH_PROFILES_BYTES)
            .then_some(contents)
            .ok_or(StateDirError)
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for PrivateAuthProfiles {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("PrivateAuthProfiles")
            .field(&REDACTED)
            .finish()
    }
}

pub(super) fn read(
    state_dir: &super::StateDirHandle,
    agent: &AgentId,
) -> Result<Option<Vec<u8>>, StateDirError> {
    platform::read(state_dir, agent)
}

#[cfg(test)]
pub(super) fn replace(
    state_dir: &super::StateDirHandle,
    agent: &AgentId,
    contents: &[u8],
) -> Result<(), StateDirError> {
    platform::replace(state_dir, agent, contents)
}

fn valid_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && bytes.iter().all(|byte| !byte.is_ascii_uppercase())
}

#[cfg(unix)]
mod platform {
    pub(super) use super::posix::read;

    #[cfg(test)]
    pub(super) use super::posix::replace;
}

#[cfg(windows)]
mod platform {
    pub(super) use super::windows::read;

    #[cfg(test)]
    pub(super) use super::windows::replace;
}
