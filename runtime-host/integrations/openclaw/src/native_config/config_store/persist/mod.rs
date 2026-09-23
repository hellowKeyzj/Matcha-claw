use ::platform::state_dir::StateDirHandle;

#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use posix as state_dir_platform;
#[cfg(windows)]
use windows as state_dir_platform;

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
    state_dir_platform::replace(state_dir, contents)
}
