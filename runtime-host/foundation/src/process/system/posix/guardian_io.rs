use std::io;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::os::fd::{FromRawFd, OwnedFd};

pub(super) fn socket_pair_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    #[cfg(target_os = "linux")]
    let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(target_os = "macos")]
    let socket_type = libc::SOCK_STREAM;
    if unsafe { libc::socketpair(libc::AF_UNIX, socket_type, 0, descriptors.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }

    let first = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let second = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    #[cfg(target_os = "macos")]
    {
        super::io::set_close_on_exec(first.as_raw_fd())?;
        super::io::set_close_on_exec(second.as_raw_fd())?;
    }
    Ok((first, second))
}
