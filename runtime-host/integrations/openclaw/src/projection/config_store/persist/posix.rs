use std::{
    ffi::CString,
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::lifecycle::state_dir::StateDirHandle;

use super::PersistError;

const CANONICAL_CONFIG_FILE: &[u8] = b"openclaw.json\0";
const TEMPORARY_MODE: libc::mode_t = 0o600;

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn replace(state_dir: &StateDirHandle, contents: &[u8]) -> Result<(), PersistError> {
    let directory = state_dir
        .clone_descriptor()
        .map_err(|_| PersistError::TemporaryCreateFailed)?;
    let (mut temporary, name) = create_temporary_file(&directory)?;
    let result = write_and_replace(&directory, &temporary, &name, contents);
    match result {
        Ok(()) => Ok(()),
        Err(error) => match remove_temporary(&directory, &name) {
            Ok(()) => Err(error),
            Err(()) => Err(PersistError::CleanupFailed),
        },
    }
}

fn create_temporary_file(directory: &OwnedFd) -> Result<(OwnedFd, CString), PersistError> {
    for _ in 0..128 {
        let name = temporary_name()?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                TEMPORARY_MODE,
            )
        };
        if descriptor >= 0 {
            // SAFETY: openat returned a new owned descriptor.
            return Ok((unsafe { OwnedFd::from_raw_fd(descriptor) }, name));
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(PersistError::TemporaryCreateFailed);
        }
    }
    Err(PersistError::TemporaryCreateFailed)
}

fn temporary_name() -> Result<CString, PersistError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    CString::new(format!(
        ".openclaw.json.{:x}.{sequence:x}.tmp",
        std::process::id()
    ))
    .map_err(|_| PersistError::TemporaryCreateFailed)
}

fn write_and_replace(
    directory: &OwnedFd,
    temporary: &OwnedFd,
    temporary_name: &CString,
    contents: &[u8],
) -> Result<(), PersistError> {
    write_all(temporary, contents)?;
    if unsafe { libc::fsync(temporary.as_raw_fd()) } != 0 {
        return Err(PersistError::TemporarySyncFailed);
    }
    let canonical = CString::from_vec_with_nul(CANONICAL_CONFIG_FILE.to_vec())
        .expect("OpenClaw canonical config name is valid");
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            temporary_name.as_ptr(),
            directory.as_raw_fd(),
            canonical.as_ptr(),
        )
    } != 0
    {
        return Err(PersistError::ReplaceFailed);
    }
    if unsafe { libc::fsync(directory.as_raw_fd()) } != 0 {
        return Err(PersistError::CommittedButNotDurable);
    }
    Ok(())
}

fn write_all(file: &OwnedFd, contents: &[u8]) -> Result<(), PersistError> {
    let mut remaining = contents;
    while !remaining.is_empty() {
        let written =
            unsafe { libc::write(file.as_raw_fd(), remaining.as_ptr().cast(), remaining.len()) };
        if written <= 0 {
            return Err(PersistError::TemporaryWriteFailed);
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

fn remove_temporary(directory: &OwnedFd, name: &CString) -> Result<(), ()> {
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOENT) => Ok(()),
        _ => Err(()),
    }
}
