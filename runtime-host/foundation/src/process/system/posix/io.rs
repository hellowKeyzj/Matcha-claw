use std::io;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

use super::protocol::{Frame, HEADER_BYTES};

pub(super) fn pipe_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::pipe(descriptors.as_mut_ptr()) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }

    let read_end = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write_end = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    #[cfg(target_os = "macos")]
    {
        set_close_on_exec(read_end.as_raw_fd())?;
        set_close_on_exec(write_end.as_raw_fd())?;
    }
    Ok((read_end, write_end))
}

pub(super) fn read_frame(descriptor: RawFd, deadline: Instant) -> io::Result<Frame> {
    let mut header = [0_u8; HEADER_BYTES];
    read_exact_until(descriptor, &mut header, deadline)?;
    let header = Frame::decode_header(&header)?;
    let mut payload = vec![0_u8; header.payload_len];
    read_exact_until(descriptor, &mut payload, deadline)?;
    Frame::from_header(header, payload)
}

pub(super) fn write_frame(descriptor: RawFd, frame: &Frame, deadline: Instant) -> io::Result<()> {
    write_all_until(descriptor, &frame.encode(), deadline)
}

pub(super) fn read_exact_until(
    descriptor: RawFd,
    bytes: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        wait_ready(descriptor, libc::POLLIN, deadline)?;
        let read_count = unsafe {
            libc::read(
                descriptor,
                bytes[offset..].as_mut_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if read_count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "custody control peer closed",
            ));
        }
        if read_count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        offset += read_count as usize;
    }
    Ok(())
}

pub(super) fn write_all_until(
    descriptor: RawFd,
    bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        wait_ready(descriptor, libc::POLLOUT, deadline)?;
        let written = unsafe {
            libc::write(
                descriptor,
                bytes[offset..].as_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "custody control peer accepted no bytes",
            ));
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        offset += written as usize;
    }
    Ok(())
}

pub(super) fn wait_ready(descriptor: RawFd, events: i16, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(timeout)?;
        let mut poll_descriptor = libc::pollfd {
            fd: descriptor,
            events,
            revents: 0,
        };
        let ready =
            unsafe { libc::poll(&mut poll_descriptor, 1, duration_to_poll_millis(remaining)) };
        if ready == 0 {
            return Err(timeout());
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if poll_descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "custody control descriptor failed",
            ));
        }
        return Ok(());
    }
}

pub(super) fn timeout() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "custody control operation timed out",
    )
}

#[cfg(target_os = "macos")]
pub(super) fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    let current = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if current == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, current | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn duration_to_poll_millis(duration: Duration) -> i32 {
    duration.as_millis().max(1).min(i32::MAX as u128) as i32
}
