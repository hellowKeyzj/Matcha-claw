use std::{
    fmt,
    path::{Path, PathBuf},
};

pub(crate) use auth_profiles::{AgentId, PrivateAuthProfiles};

mod auth_profiles;
#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

const REJECTED: &str = "OpenClaw state directory rejected";

#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalStateDir {
    path: PathBuf,
    identity: platform::StateDirIdentity,
}

impl CanonicalStateDir {
    pub fn provision(path: impl AsRef<Path>) -> Result<Self, StateDirError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(StateDirError);
        }

        let (path, identity) = platform::provision(path)?;
        Ok(Self { path, identity })
    }

    pub(crate) fn open(&self) -> Result<StateDirHandle, StateDirError> {
        platform::open(&self.path, &self.identity)
    }

    pub fn read_regular_file_bounded(
        &self,
        name: &str,
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        self.open()?.read_regular_file_bounded(name, byte_limit)
    }

    pub(crate) fn read_nested_regular_file_bounded(
        &self,
        components: &[String],
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        self.open()?
            .read_nested_regular_file_bounded(components, byte_limit)
    }

    pub fn replace_regular_file_bounded(
        &self,
        name: &str,
        contents: &[u8],
        byte_limit: usize,
    ) -> Result<(), StateDirError> {
        self.open()?
            .replace_regular_file_bounded(name, contents, byte_limit)
    }

    pub(crate) fn read_auth_profiles(
        &self,
        agent: &AgentId,
    ) -> Result<Option<PrivateAuthProfiles>, StateDirError> {
        let contents = self.open()?.read_auth_profiles(agent)?;
        contents.map(PrivateAuthProfiles::try_new).transpose()
    }

    #[cfg(test)]
    pub(crate) fn replace_auth_profiles(
        &self,
        agent: &AgentId,
        contents: &PrivateAuthProfiles,
    ) -> Result<(), StateDirError> {
        self.open()?
            .replace_auth_profiles(agent, contents.as_bytes())
    }

    pub fn as_path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for CanonicalStateDir {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalStateDir([REDACTED])")
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct StateDirError;

impl fmt::Debug for StateDirError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StateDirError")
    }
}

impl fmt::Display for StateDirError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(REJECTED)
    }
}

impl std::error::Error for StateDirError {}

#[cfg(unix)]
mod platform {
    pub(super) use super::posix::{StateDirIdentity, open, provision};
}

#[cfg(windows)]
mod platform {
    pub(super) use super::windows::{StateDirIdentity, open, provision};
}

#[cfg(unix)]
pub use posix::StateDirHandle;
#[cfg(windows)]
pub use windows::StateDirHandle;

#[cfg(test)]
mod tests;
