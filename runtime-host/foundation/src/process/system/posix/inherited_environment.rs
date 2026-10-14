use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::time::Instant;

use super::guardian_descriptors::reserve_descriptor;
use super::guardian_io::socket_pair_cloexec;
use super::io::{read_exact_until, write_all_until};

pub(super) struct PendingEnvironment {
    descriptor: OwnedFd,
    bytes: Vec<u8>,
}

pub(super) fn prepare(
    environment: &[(OsString, OsString)],
) -> io::Result<(OwnedFd, PendingEnvironment)> {
    let length = environment.iter().try_fold(0_usize, |length, (key, value)| {
        length
            .checked_add(key.as_bytes().len())
            .and_then(|length| length.checked_add(1))
            .and_then(|length| length.checked_add(value.as_bytes().len()))
            .and_then(|length| length.checked_add(1))
            .ok_or_else(invalid_environment)
    })?;
    validate_native_length(length)?;
    u64::try_from(length).map_err(|_| invalid_environment())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| allocation_failed())?;
    for (key, value) in environment {
        bytes.extend_from_slice(key.as_bytes());
        bytes.push(b'=');
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
    }
    let (read, write) = socket_pair_cloexec()?;
    let read = reserve_descriptor(read)?;
    let write = reserve_descriptor(write)?;
    let flags = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(write.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok((
        read,
        PendingEnvironment {
            descriptor: write,
            bytes,
        },
    ))
}

impl PendingEnvironment {
    pub(super) fn write(
        self,
        nonce: [u8; 16],
        request_id: u64,
        deadline: Instant,
    ) -> io::Result<()> {
        let mut header = [0_u8; 32];
        header[..16].copy_from_slice(&nonce);
        header[16..24].copy_from_slice(&request_id.to_le_bytes());
        let length = u64::try_from(self.bytes.len()).map_err(|_| invalid_environment())?;
        header[24..].copy_from_slice(&length.to_le_bytes());
        write_all_until(self.descriptor.as_raw_fd(), &header, deadline)?;
        write_all_until(self.descriptor.as_raw_fd(), &self.bytes, deadline)
    }
}

pub(super) fn read(
    descriptor: OwnedFd,
    nonce: [u8; 16],
    request_id: u64,
    deadline: Instant,
) -> io::Result<Vec<CString>> {
    let mut header = [0_u8; 32];
    read_exact_until(descriptor.as_raw_fd(), &mut header, deadline)?;
    if header[..16] != nonce || header[16..24] != request_id.to_le_bytes() {
        return Err(invalid_environment());
    }
    let length = u64::from_le_bytes(header[24..].try_into().map_err(|_| invalid_environment())?);
    let length = usize::try_from(length).map_err(|_| invalid_environment())?;
    validate_native_length(length)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| allocation_failed())?;
    bytes.resize(length, 0);
    read_exact_until(descriptor.as_raw_fd(), &mut bytes, deadline)?;
    drop(descriptor);
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err(invalid_environment());
    }
    let count = bytes.iter().filter(|byte| **byte == 0).count();
    let mut environment = Vec::new();
    environment
        .try_reserve_exact(count)
        .map_err(|_| allocation_failed())?;
    for entry in bytes.split_inclusive(|byte| *byte == 0) {
        if !entry
            .iter()
            .position(|byte| *byte == b'=')
            .is_some_and(|index| index > 0)
        {
            return Err(invalid_environment());
        }
        let mut value = Vec::new();
        value
            .try_reserve_exact(entry.len())
            .map_err(|_| allocation_failed())?;
        value.extend_from_slice(entry);
        environment.push(CString::from_vec_with_nul(value).map_err(|_| invalid_environment())?);
    }
    Ok(environment)
}

fn validate_native_length(length: usize) -> io::Result<()> {
    let limit = unsafe { libc::sysconf(libc::_SC_ARG_MAX) };
    if limit > 0 && length as u128 > limit as u128 {
        return Err(invalid_environment());
    }
    Ok(())
}

fn invalid_environment() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid inherited environment snapshot",
    )
}

fn allocation_failed() -> io::Error {
    io::Error::new(
        io::ErrorKind::OutOfMemory,
        "inherited environment allocation failed",
    )
}
