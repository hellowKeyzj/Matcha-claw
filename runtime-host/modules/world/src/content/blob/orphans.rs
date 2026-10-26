use platform::state_dir::{CanonicalStateDir, StateDirHandle};

use super::{Error, Failure, open_regular, remove, sync_directory};

/// The caller holds the exclusive lifetime owner and short publication lock.
/// Committed content lives at digest names; no durable reference depends on these private leaves.
pub(super) fn reconcile(root: &CanonicalStateDir, directory: &StateDirHandle) -> Result<(), Error> {
    let result = scan(root, directory, |name| {
        if !private_leaf(name) {
            return Ok(());
        }
        // Reject links/special files before unlinking; never traverse or touch digest names.
        let file = open_regular(root, directory, name, false)?;
        drop(file);
        remove(root, directory, name).map_err(|cause| Error::caused(Failure::Cleanup, cause))
    });
    let synced = sync_directory(directory);
    match (result, synced) {
        (Ok(()), result) => result,
        (Err(mut error), synced) => {
            error.cleanup = synced.err().map(|cause| Box::new(cause) as _);
            Err(error)
        }
    }
}

fn private_leaf(name: &str) -> bool {
    let parts: Vec<_> = name.split('.').collect();
    match parts.as_slice() {
        ["", "stage", digest, id] => {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == *id)
        }
        ["", "blob", process, sequence, "tmp"] => {
            !process.is_empty()
                && process.bytes().all(|byte| byte.is_ascii_digit())
                && process.parse::<u32>().is_ok()
                && !sequence.is_empty()
                && sequence.bytes().all(|byte| byte.is_ascii_digit())
                && sequence.parse::<u64>().is_ok()
        }
        _ => false,
    }
}

#[cfg(windows)]
fn scan(
    root: &CanonicalStateDir,
    _directory: &StateDirHandle,
    mut visit: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    // The retained Platform directory handle denies rename/deletion on Windows.
    for entry in
        std::fs::read_dir(root.as_path()).map_err(|cause| Error::caused(Failure::Read, cause))?
    {
        let entry = entry.map_err(|cause| Error::caused(Failure::Read, cause))?;
        if let Some(name) = entry.file_name().to_str() {
            visit(name)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn scan(
    _root: &CanonicalStateDir,
    directory: &StateDirHandle,
    mut visit: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    use std::{
        ffi::CStr,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
    };

    let descriptor = directory
        .clone_descriptor()
        .map_err(|cause| Error::caused(Failure::Read, cause))?;
    // Open a fresh directory description; dup alone would share the saved enumeration offset.
    let fresh = unsafe {
        libc::openat(
            descriptor.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fresh < 0 {
        return Err(Error::caused(
            Failure::Read,
            std::io::Error::last_os_error(),
        ));
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(fresh) };
    let stream = unsafe { libc::fdopendir(descriptor.as_raw_fd()) };
    if stream.is_null() {
        return Err(Error::caused(
            Failure::Read,
            std::io::Error::last_os_error(),
        ));
    }
    std::mem::forget(descriptor); // fdopendir now owns and closes the descriptor.
    let result = (|| {
        loop {
            set_errno(0);
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error() == Some(0) {
                    Ok(())
                } else {
                    Err(Error::caused(Failure::Read, error))
                };
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if let Ok(name) = name.to_str() {
                visit(name)?;
            }
        }
    })();
    let closed = unsafe { libc::closedir(stream) };
    result?;
    if closed != 0 {
        return Err(Error::caused(
            Failure::Read,
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_errno(value: libc::c_int) {
    unsafe { *libc::__errno_location() = value };
}

#[cfg(target_os = "macos")]
fn set_errno(value: libc::c_int) {
    unsafe { *libc::__error() = value };
}
