use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;

const MAX_CLEANUP_NAME_BYTES: usize = 255;

pub(crate) fn acquire_lease(directory: Option<&OwnedFd>) -> io::Result<()> {
    let Some(directory) = directory else {
        return Ok(());
    };
    if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn remove_names(directory: Option<&OwnedFd>, names: &[OsString]) -> io::Result<()> {
    if names.is_empty() {
        return Ok(());
    }
    let directory = directory.ok_or_else(invalid_names)?;
    for name in names {
        validate_name(name)?;
        let name = CString::new(name.as_os_str().as_bytes()).map_err(|_| invalid_names())?;
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOENT) {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_name(name: &OsString) -> io::Result<()> {
    let bytes = name.as_os_str().as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_CLEANUP_NAME_BYTES
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&0)
        || bytes.contains(&b'/')
    {
        return Err(invalid_names());
    }
    Ok(())
}

fn invalid_names() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "guardian cleanup names are invalid",
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::time::SystemTime;

    use super::remove_names;

    #[test]
    fn cleanup_is_exact_and_retry_safe_after_partial_success() {
        let directory = std::env::temp_dir().join(format!(
            "matcha-guardian-cleanup-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let first = directory.join("first");
        let second = directory.join("second");
        let unrelated = directory.join("unrelated");
        fs::write(&first, []).unwrap();
        fs::write(&second, []).unwrap();
        fs::write(&unrelated, []).unwrap();
        let directory_fd = open_directory(&directory);

        fs::remove_file(&second).unwrap();
        remove_names(Some(&directory_fd), &["first".into(), "second".into()]).unwrap();

        assert!(!first.exists());
        assert!(unrelated.exists());
        drop(directory_fd);
        fs::remove_file(&unrelated).unwrap();
        fs::remove_dir(&directory).unwrap();
    }

    fn open_directory(path: &std::path::Path) -> OwnedFd {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        assert_ne!(descriptor, -1);
        unsafe { OwnedFd::from_raw_fd(descriptor) }
    }
}
