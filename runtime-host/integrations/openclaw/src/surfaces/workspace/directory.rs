#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(super) use posix::*;
#[cfg(windows)]
pub(super) use windows::*;

pub(crate) fn workspace_resource_key(path: &std::path::Path) -> std::io::Result<String> {
    open(path)
        .and_then(|directory| directory.resource_key())
        .map_err(|_| std::io::Error::other("workspace directory is unavailable"))
}
