use std::io;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};

use super::guardian_descriptors::{
    FIRST_UNRESERVED_FD, GUARDIAN_CLEANUP_DIRECTORY_FD, GUARDIAN_CLEANUP_NAMES_FD,
    SENTINEL_CONTROL_FD, SENTINEL_LIVENESS_FD, TARGET_EXECUTION_SOURCE_FD,
    TARGET_PRIVATE_DESCRIPTOR_FD, TARGET_STATE_DIRECTORY_FD, TARGET_STDERR_FD, TARGET_STDIN_FD,
    TARGET_STDOUT_FD, clear_close_on_exec, close_descriptor, relocate_descriptor,
    reserve_descriptor,
};

pub(super) const TARGET_EXEC_STATUS_FD: RawFd = SENTINEL_LIVENESS_FD;

pub(super) fn isolate_sentinel(
    guardian_liveness: OwnedFd,
    control: OwnedFd,
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
    descriptor_limit: RawFd,
) -> io::Result<(
    OwnedFd,
    OwnedFd,
    [OwnedFd; 3],
    Option<OwnedFd>,
    Option<OwnedFd>,
    Option<OwnedFd>,
)> {
    let guardian_liveness = reserve_descriptor(guardian_liveness)?;
    let control = reserve_descriptor(control)?;
    let [target_stdin, target_stdout, target_stderr] = target_stdio;
    let target_stdin = reserve_descriptor(target_stdin)?;
    let target_stdout = reserve_descriptor(target_stdout)?;
    let target_stderr = reserve_descriptor(target_stderr)?;
    let target_state_directory = target_state_directory.map(reserve_descriptor).transpose()?;
    let private_descriptor = private_descriptor.map(reserve_descriptor).transpose()?;
    let execution_source = execution_source.map(reserve_descriptor).transpose()?;
    let guardian_liveness = relocate_descriptor(guardian_liveness, SENTINEL_LIVENESS_FD)?;
    let control = relocate_descriptor(control, SENTINEL_CONTROL_FD)?;
    let target_stdin = relocate_descriptor(target_stdin, TARGET_STDIN_FD)?;
    let target_stdout = relocate_descriptor(target_stdout, TARGET_STDOUT_FD)?;
    let target_stderr = relocate_descriptor(target_stderr, TARGET_STDERR_FD)?;
    let target_state_directory = target_state_directory
        .map(|descriptor| relocate_descriptor(descriptor, TARGET_STATE_DIRECTORY_FD))
        .transpose()?;
    let private_descriptor = private_descriptor
        .map(|descriptor| relocate_descriptor(descriptor, TARGET_PRIVATE_DESCRIPTOR_FD))
        .transpose()?;
    let execution_source = execution_source
        .map(|descriptor| relocate_descriptor(descriptor, TARGET_EXECUTION_SOURCE_FD))
        .transpose()?;
    close_descriptor(libc::STDIN_FILENO)?;
    close_descriptor(libc::STDOUT_FILENO)?;
    close_descriptor(libc::STDERR_FILENO)?;
    close_descriptor(GUARDIAN_CLEANUP_DIRECTORY_FD)?;
    close_descriptor(GUARDIAN_CLEANUP_NAMES_FD)?;
    close_from(FIRST_UNRESERVED_FD, descriptor_limit)?;
    Ok((
        guardian_liveness,
        control,
        [target_stdin, target_stdout, target_stderr],
        target_state_directory,
        private_descriptor,
        execution_source,
    ))
}

pub(super) fn prepare_target_exec(
    status: OwnedFd,
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
    descriptor_limit: RawFd,
) -> Result<(OwnedFd, Option<OwnedFd>), (RawFd, io::Error)> {
    let status = status.into_raw_fd();
    if unsafe { libc::dup2(status, TARGET_EXEC_STATUS_FD) } == -1 {
        return Err((status, io::Error::last_os_error()));
    }
    if status != TARGET_EXEC_STATUS_FD {
        unsafe { libc::close(status) };
    }
    for (descriptor, target) in
        target_stdio
            .into_iter()
            .zip([libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO])
    {
        if unsafe { libc::dup2(descriptor.as_raw_fd(), target) } == -1 {
            return Err((TARGET_EXEC_STATUS_FD, io::Error::last_os_error()));
        }
    }
    if let Some(target_state_directory) = target_state_directory {
        if let Err(error) = clear_close_on_exec(target_state_directory.as_raw_fd()) {
            return Err((TARGET_EXEC_STATUS_FD, error));
        }
        let _ = target_state_directory.into_raw_fd();
    } else if let Err(error) = close_descriptor(TARGET_STATE_DIRECTORY_FD) {
        return Err((TARGET_EXEC_STATUS_FD, error));
    }
    if let Some(private_descriptor) = private_descriptor {
        if let Err(error) = clear_close_on_exec(private_descriptor.as_raw_fd()) {
            return Err((TARGET_EXEC_STATUS_FD, error));
        }
        let _ = private_descriptor.into_raw_fd();
    } else if let Err(error) = close_descriptor(TARGET_PRIVATE_DESCRIPTOR_FD) {
        return Err((TARGET_EXEC_STATUS_FD, error));
    }
    let execution_source = match execution_source {
        Some(execution_source) => {
            if let Err(error) = clear_close_on_exec(execution_source.as_raw_fd()) {
                return Err((TARGET_EXEC_STATUS_FD, error));
            }
            Some(execution_source)
        }
        None => None,
    };
    if let Err(error) = set_close_on_exec(TARGET_EXEC_STATUS_FD)
        .and_then(|()| close_descriptor(SENTINEL_CONTROL_FD))
        .and_then(|()| close_descriptor(TARGET_STDIN_FD))
        .and_then(|()| close_descriptor(TARGET_STDOUT_FD))
        .and_then(|()| close_descriptor(TARGET_STDERR_FD))
        .and_then(|()| close_descriptor(GUARDIAN_CLEANUP_DIRECTORY_FD))
        .and_then(|()| close_descriptor(GUARDIAN_CLEANUP_NAMES_FD))
        .and_then(|()| {
            if execution_source.is_none() {
                close_descriptor(TARGET_EXECUTION_SOURCE_FD)
            } else {
                Ok(())
            }
        })
        .and_then(|()| close_from(FIRST_UNRESERVED_FD, descriptor_limit))
    {
        return Err((TARGET_EXEC_STATUS_FD, error));
    }
    Ok((
        unsafe { OwnedFd::from_raw_fd(TARGET_EXEC_STATUS_FD) },
        execution_source,
    ))
}

#[cfg(target_os = "linux")]
fn close_from(first: RawFd, limit: RawFd) -> io::Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            first as libc::c_uint,
            libc::c_uint::MAX,
            0_u32,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ENOSYS) {
        return Err(error);
    }
    let mut descriptor = first;
    while descriptor < limit {
        if unsafe { libc::close(descriptor) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EBADF) {
                return Err(error);
            }
        }
        descriptor += 1;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn close_from(first: RawFd, limit: RawFd) -> io::Result<()> {
    let mut descriptor = first;
    while descriptor < limit {
        if unsafe { libc::close(descriptor) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EBADF) {
                return Err(error);
            }
        }
        descriptor += 1;
    }
    Ok(())
}

fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    use super::super::guardian_descriptors::{
        FIRST_UNRESERVED_FD, GUARDIAN_CLEANUP_DIRECTORY_FD, GUARDIAN_CLEANUP_NAMES_FD,
        SENTINEL_CONTROL_FD, TARGET_EXECUTION_SOURCE_FD, TARGET_PRIVATE_DESCRIPTOR_FD,
        TARGET_STATE_DIRECTORY_FD, TARGET_STDERR_FD, TARGET_STDIN_FD, TARGET_STDOUT_FD,
        relocate_descriptor, reserve_descriptor,
    };
    use super::{TARGET_EXEC_STATUS_FD, prepare_target_exec};

    #[test]
    fn sentinel_does_not_retain_host_control_descriptors() {
        let child = unsafe { libc::fork() };
        assert_ne!(child, -1);
        if child == 0 {
            let status = match sentinel_descriptor_state() {
                Some(true) => 0,
                Some(false) => 1,
                None => 2,
            };
            unsafe { libc::_exit(status) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[test]
    fn target_exec_retains_only_the_state_directory_capability() {
        let child = unsafe { libc::fork() };
        assert_ne!(child, -1);
        if child == 0 {
            let status = match target_descriptor_state(None, None) {
                Some(true) => 0,
                Some(false) => 1,
                None => 2,
            };
            unsafe { libc::_exit(status) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[test]
    fn target_exec_retains_private_descriptor_without_close_on_exec() {
        let child = unsafe { libc::fork() };
        assert_ne!(child, -1);
        if child == 0 {
            let private_descriptor = reserve_null(libc::O_RDONLY);
            let status = match private_descriptor
                .and_then(|descriptor| target_descriptor_state(Some(descriptor), None))
            {
                Some(true) => 0,
                Some(false) => 1,
                None => 2,
            };
            unsafe { libc::_exit(status) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[test]
    fn target_exec_retains_execution_source_without_close_on_exec() {
        let child = unsafe { libc::fork() };
        assert_ne!(child, -1);
        if child == 0 {
            let execution_source = reserve_null(libc::O_RDONLY);
            let status = match execution_source
                .and_then(|descriptor| target_descriptor_state(None, Some(descriptor)))
            {
                Some(true) => 0,
                Some(false) => 1,
                None => 2,
            };
            unsafe { libc::_exit(status) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::EXIT_SUCCESS, libc::WEXITSTATUS(status));
    }

    fn sentinel_descriptor_state() -> Option<bool> {
        let guardian_liveness = reserve_null(libc::O_RDONLY)?;
        let control = reserve_null(libc::O_RDWR)?;
        let target_stdio = [
            reserve_null(libc::O_RDONLY)?,
            reserve_null(libc::O_WRONLY)?,
            reserve_null(libc::O_WRONLY)?,
        ];
        let _descriptors = super::isolate_sentinel(
            guardian_liveness,
            control,
            target_stdio,
            None,
            None,
            None,
            super::super::guardian_descriptors::descriptor_limit().ok()?,
        )
        .ok()?;
        Some(
            [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO]
                .into_iter()
                .all(is_closed),
        )
    }

    fn target_descriptor_state(
        private_descriptor: Option<OwnedFd>,
        execution_source: Option<OwnedFd>,
    ) -> Option<bool> {
        let status = reserve_null(libc::O_WRONLY)?;
        let target_stdio = [
            reserve_null(libc::O_RDONLY)?,
            reserve_null(libc::O_WRONLY)?,
            reserve_null(libc::O_WRONLY)?,
        ];
        let state_directory =
            relocate_descriptor(reserve_directory()?, TARGET_STATE_DIRECTORY_FD).ok()?;
        let private_descriptor = private_descriptor
            .map(|descriptor| relocate_descriptor(descriptor, TARGET_PRIVATE_DESCRIPTOR_FD))
            .transpose()
            .ok()?;
        let execution_source = execution_source
            .map(|descriptor| relocate_descriptor(descriptor, TARGET_EXECUTION_SOURCE_FD))
            .transpose()
            .ok()?;
        for descriptor in [
            SENTINEL_CONTROL_FD,
            TARGET_STDIN_FD,
            TARGET_STDOUT_FD,
            TARGET_STDERR_FD,
            GUARDIAN_CLEANUP_DIRECTORY_FD,
            GUARDIAN_CLEANUP_NAMES_FD,
            FIRST_UNRESERVED_FD,
        ] {
            let descriptor = relocate_descriptor(reserve_null(libc::O_RDONLY)?, descriptor).ok()?;
            let _ = descriptor.into_raw_fd();
        }

        let has_private_descriptor = private_descriptor.is_some();
        let has_execution_source = execution_source.is_some();
        let (status, execution_source) = prepare_target_exec(
            status,
            target_stdio,
            Some(state_directory),
            private_descriptor,
            execution_source,
            super::super::guardian_descriptors::descriptor_limit().ok()?,
        )
        .ok()?;
        Some(
            status.as_raw_fd() == TARGET_EXEC_STATUS_FD
                && has_close_on_exec(status.as_raw_fd())
                && is_directory(TARGET_STATE_DIRECTORY_FD)
                && (has_private_descriptor
                    && !has_close_on_exec(TARGET_PRIVATE_DESCRIPTOR_FD)
                    && !is_closed(TARGET_PRIVATE_DESCRIPTOR_FD)
                    || !has_private_descriptor && is_closed(TARGET_PRIVATE_DESCRIPTOR_FD))
                && (has_execution_source
                    && execution_source.is_some_and(|source| {
                        source.as_raw_fd() == TARGET_EXECUTION_SOURCE_FD
                            && !has_close_on_exec(TARGET_EXECUTION_SOURCE_FD)
                            && !is_closed(TARGET_EXECUTION_SOURCE_FD)
                    })
                    || !has_execution_source && is_closed(TARGET_EXECUTION_SOURCE_FD))
                && [
                    SENTINEL_CONTROL_FD,
                    TARGET_STDIN_FD,
                    TARGET_STDOUT_FD,
                    TARGET_STDERR_FD,
                    GUARDIAN_CLEANUP_DIRECTORY_FD,
                    GUARDIAN_CLEANUP_NAMES_FD,
                ]
                .into_iter()
                .all(is_closed)
                && (FIRST_UNRESERVED_FD..=FIRST_UNRESERVED_FD + 32).all(is_closed),
        )
    }

    fn reserve_null(access: libc::c_int) -> Option<OwnedFd> {
        let path = CString::new("/dev/null").expect("static path");
        let descriptor = unsafe { libc::open(path.as_ptr(), access | libc::O_CLOEXEC) };
        if descriptor == -1 {
            return None;
        }
        reserve_descriptor(unsafe { OwnedFd::from_raw_fd(descriptor) }).ok()
    }

    fn reserve_directory() -> Option<OwnedFd> {
        let path = CString::new(std::env::temp_dir().as_os_str().as_bytes()).ok()?;
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if descriptor == -1 {
            return None;
        }
        reserve_descriptor(unsafe { OwnedFd::from_raw_fd(descriptor) }).ok()
    }

    fn has_close_on_exec(descriptor: libc::c_int) -> bool {
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        flags != -1 && flags & libc::FD_CLOEXEC != 0
    }

    fn is_directory(descriptor: libc::c_int) -> bool {
        let mut metadata = std::mem::MaybeUninit::uninit();
        (unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) == 0 })
            && (unsafe { metadata.assume_init().st_mode & libc::S_IFMT == libc::S_IFDIR })
    }

    fn is_closed(descriptor: libc::c_int) -> bool {
        (unsafe { libc::fcntl(descriptor, libc::F_GETFD) }) == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF)
    }
}
