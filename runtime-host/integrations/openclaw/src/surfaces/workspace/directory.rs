#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(super) use posix::*;
#[cfg(windows)]
pub(super) use windows::*;
