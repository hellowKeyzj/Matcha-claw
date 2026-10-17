use std::{
    fmt,
    path::{Path, PathBuf},
};

#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

const REJECTED: &str = "state directory rejected";

/// Publishes a flushed file without replacing an existing destination or copying across volumes.
#[cfg(windows)]
pub fn publish_new_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt};

    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        value.push(0);
        Ok(value)
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source = wide_path(source)?;
    let target = wide_path(target)?;
    // SAFETY: both buffers are live, NUL-terminated UTF-16 paths for the synchronous call.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

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

    /// Also makes an existing self-owned, non-shared-writable directory private.
    pub fn provision_private(path: impl AsRef<Path>) -> Result<Self, StateDirError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(StateDirError);
        }

        let (path, identity) = platform::provision_private(path)?;
        Ok(Self { path, identity })
    }

    pub fn open(&self) -> Result<StateDirHandle, StateDirError> {
        platform::open(&self.path, &self.identity)
    }

    pub fn read_regular_file_bounded(
        &self,
        name: &str,
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        self.open()?.read_regular_file_bounded(name, byte_limit)
    }

    pub fn read_nested_regular_file_bounded(
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StateFileReplaceError {
    commit_unknown: bool,
    cleanup_failed: bool,
}

impl StateFileReplaceError {
    pub const fn commit_unknown(&self) -> bool {
        self.commit_unknown
    }

    pub const fn cleanup_failed(&self) -> bool {
        self.cleanup_failed
    }
}

impl From<StateDirError> for StateFileReplaceError {
    fn from(_: StateDirError) -> Self {
        Self {
            commit_unknown: false,
            cleanup_failed: false,
        }
    }
}

impl fmt::Display for StateFileReplaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("state file replacement failed")
    }
}

impl std::error::Error for StateFileReplaceError {}

#[cfg(unix)]
mod platform {
    pub(super) use super::posix::{StateDirIdentity, open, provision, provision_private};
}

#[cfg(windows)]
mod platform {
    pub(super) use super::windows::{StateDirIdentity, open, provision, provision_private};
}

#[cfg(unix)]
pub use posix::StateDirHandle;
#[cfg(windows)]
pub use windows::StateDirHandle;
