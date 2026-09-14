use crate::lifecycle::state_dir::StateDirHandle;

#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use posix as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PersistError {
    TemporaryCreateFailed,
    TemporaryWriteFailed,
    TemporarySyncFailed,
    ReplaceFailed,
    CleanupFailed,
    CommittedButNotDurable,
}

pub(super) fn replace(state_dir: &StateDirHandle, contents: &[u8]) -> Result<(), PersistError> {
    platform::replace(state_dir, contents)
}
