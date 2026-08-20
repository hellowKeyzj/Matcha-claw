use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

pub(super) const SENTINEL_LIVENESS_FD: RawFd = 3;
pub(super) const SENTINEL_CONTROL_FD: RawFd = 4;
pub(super) const TARGET_STDIN_FD: RawFd = 5;
pub(super) const TARGET_STDOUT_FD: RawFd = 6;
pub(super) const TARGET_STDERR_FD: RawFd = 7;
pub(super) const TARGET_STATE_DIRECTORY_FD: RawFd = 8;
pub(super) const TARGET_PRIVATE_DESCRIPTOR_FD: RawFd = 9;
pub(super) const GUARDIAN_CLEANUP_DIRECTORY_FD: RawFd = 10;
pub(super) const GUARDIAN_CLEANUP_NAMES_FD: RawFd = 11;
pub(super) const TARGET_EXECUTION_SOURCE_FD: RawFd = 12;
pub(super) const FIRST_UNRESERVED_FD: RawFd = 13;

pub(super) fn clear_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn reserve_descriptor(descriptor: OwnedFd) -> io::Result<OwnedFd> {
    let reserved = unsafe {
        libc::fcntl(
            descriptor.as_raw_fd(),
            libc::F_DUPFD_CLOEXEC,
            FIRST_UNRESERVED_FD,
        )
    };
    if reserved == -1 {
        return Err(io::Error::last_os_error());
    }
    drop(descriptor);
    Ok(unsafe { OwnedFd::from_raw_fd(reserved) })
}

pub(super) fn relocate_descriptor(descriptor: OwnedFd, target: RawFd) -> io::Result<OwnedFd> {
    if descriptor.as_raw_fd() == target {
        return Ok(descriptor);
    }
    if unsafe { libc::dup2(descriptor.as_raw_fd(), target) } == -1 {
        return Err(io::Error::last_os_error());
    }
    drop(descriptor);
    Ok(unsafe { OwnedFd::from_raw_fd(target) })
}

pub(super) fn close_descriptor(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::close(descriptor) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EBADF) {
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn descriptor_limit() -> io::Result<RawFd> {
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let limit = unsafe { limit.assume_init().rlim_cur };
    Ok(limit.min(RawFd::MAX as libc::rlim_t) as RawFd)
}
