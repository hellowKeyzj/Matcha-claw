use std::{
    ffi::{CStr, CString},
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

use super::super::{AgentId, StateDirError};
use crate::lifecycle::state_dir::{StateDirHandle, posix::verify_owner_only};

const AGENTS: &[u8] = b"agents\0";
const AGENT: &[u8] = b"agent\0";
const AUTH_PROFILES: &[u8] = b"auth-profiles.json\0";
const DIRECTORY_MODE: libc::mode_t = 0o700;
const FILE_MODE: libc::mode_t = 0o600;
const DIRECTORY_OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const FILE_OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC;

#[cfg(test)]
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn read(
    state_dir: &StateDirHandle,
    agent: &AgentId,
) -> Result<Option<Vec<u8>>, StateDirError> {
    let Some(directory) = auth_directory(state_dir, agent, false)? else {
        return Ok(None);
    };
    let file = open_file_if_present(directory.as_raw_fd(), canonical_auth_profiles_name())?;
    let Some(file) = file else {
        return Ok(None);
    };
    read_bounded(&file)
}

#[cfg(test)]
pub(super) fn replace(
    state_dir: &StateDirHandle,
    agent: &AgentId,
    contents: &[u8],
) -> Result<(), StateDirError> {
    let directory = auth_directory(state_dir, agent, true)?.ok_or(StateDirError)?;
    replace_in_directory(&directory, contents)
}

#[cfg(test)]
fn replace_in_directory(directory: &OwnedFd, contents: &[u8]) -> Result<(), StateDirError> {
    let (temporary, name) = create_temporary_file(directory)?;
    let result = write_and_replace(directory, &temporary, &name, contents);
    match result {
        Ok(()) => Ok(()),
        Err(()) => {
            remove_temporary(directory, &name)?;
            Err(StateDirError)
        }
    }
}

fn auth_directory(
    state_dir: &StateDirHandle,
    agent: &AgentId,
    create: bool,
) -> Result<Option<OwnedFd>, StateDirError> {
    let root = state_dir.clone_descriptor()?;
    let Some(agents) = open_or_create_directory(&root, cstr(AGENTS), create)? else {
        return Ok(None);
    };
    let agent_name = CString::new(agent.as_str()).map_err(|_| StateDirError)?;
    let Some(agent_directory) = open_or_create_directory(&agents, &agent_name, create)? else {
        return Ok(None);
    };
    open_or_create_directory(&agent_directory, cstr(AGENT), create)
}

fn open_or_create_directory(
    parent: &OwnedFd,
    name: &CStr,
    create: bool,
) -> Result<Option<OwnedFd>, StateDirError> {
    match open_directory(parent.as_raw_fd(), name) {
        Ok(directory) => verify_private_directory(&directory).map(|()| Some(directory)),
        Err(()) if create => {
            if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), DIRECTORY_MODE) } != 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                return Err(StateDirError);
            }
            let directory = open_directory(parent.as_raw_fd(), name).map_err(|_| StateDirError)?;
            verify_private_directory(&directory)?;
            Ok(Some(directory))
        }
        Err(()) => match io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            _ => Err(StateDirError),
        },
    }
}

fn open_directory(parent: libc::c_int, name: &CStr) -> Result<OwnedFd, ()> {
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), DIRECTORY_OPEN_FLAGS) };
    if descriptor < 0 {
        return Err(());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn verify_private_directory(directory: &OwnedFd) -> Result<(), StateDirError> {
    verify_owner_only(directory.as_raw_fd(), libc::S_IFDIR, DIRECTORY_MODE)
}

fn open_file_if_present(
    parent: libc::c_int,
    name: &CStr,
) -> Result<Option<OwnedFd>, StateDirError> {
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), FILE_OPEN_FLAGS) };
    if descriptor < 0 {
        return match io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            _ => Err(StateDirError),
        };
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(descriptor) }))
}

fn read_bounded(file: &OwnedFd) -> Result<Option<Vec<u8>>, StateDirError> {
    let metadata = metadata(file.as_raw_fd())?;
    verify_owner_only(file.as_raw_fd(), libc::S_IFREG, FILE_MODE)?;
    if metadata.st_size < 0 || metadata.st_size as usize > super::MAX_AUTH_PROFILES_BYTES {
        return Err(StateDirError);
    }
    let mut contents = Vec::new();
    contents
        .try_reserve_exact(metadata.st_size as usize)
        .map_err(|_| StateDirError)?;
    let mut buffer = [0_u8; 4096];
    loop {
        let read =
            unsafe { libc::read(file.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
        if read < 0 {
            return Err(StateDirError);
        }
        if read == 0 {
            break;
        }
        let read = read as usize;
        if contents
            .len()
            .checked_add(read)
            .is_none_or(|length| length > super::MAX_AUTH_PROFILES_BYTES)
        {
            return Err(StateDirError);
        }
        contents.extend_from_slice(&buffer[..read]);
    }
    Ok(Some(contents))
}

#[cfg(test)]
fn create_temporary_file(directory: &OwnedFd) -> Result<(OwnedFd, CString), StateDirError> {
    for _ in 0..128 {
        let name = temporary_name()?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                FILE_MODE,
            )
        };
        if descriptor >= 0 {
            // SAFETY: openat returned a new owned descriptor.
            return Ok((unsafe { OwnedFd::from_raw_fd(descriptor) }, name));
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(StateDirError);
        }
    }
    Err(StateDirError)
}

#[cfg(test)]
fn temporary_name() -> Result<CString, StateDirError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    CString::new(format!(
        ".auth-profiles.{:x}.{sequence:x}.tmp",
        std::process::id()
    ))
    .map_err(|_| StateDirError)
}

#[cfg(test)]
fn write_and_replace(
    directory: &OwnedFd,
    temporary: &OwnedFd,
    temporary_name: &CStr,
    contents: &[u8],
) -> Result<(), ()> {
    write_all(temporary, contents)?;
    if unsafe { libc::fsync(temporary.as_raw_fd()) } != 0 {
        return Err(());
    }
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            temporary_name.as_ptr(),
            directory.as_raw_fd(),
            canonical_auth_profiles_name().as_ptr(),
        )
    } != 0
    {
        return Err(());
    }
    (unsafe { libc::fsync(directory.as_raw_fd()) } == 0)
        .then_some(())
        .ok_or(())
}

#[cfg(test)]
fn write_all(file: &OwnedFd, contents: &[u8]) -> Result<(), ()> {
    let mut remaining = contents;
    while !remaining.is_empty() {
        let written =
            unsafe { libc::write(file.as_raw_fd(), remaining.as_ptr().cast(), remaining.len()) };
        if written <= 0 {
            return Err(());
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

#[cfg(test)]
fn remove_temporary(directory: &OwnedFd, name: &CStr) -> Result<(), StateDirError> {
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0
        || io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
    {
        Ok(())
    } else {
        Err(StateDirError)
    }
}

fn canonical_auth_profiles_name() -> &'static CStr {
    cstr(AUTH_PROFILES)
}

fn cstr(value: &'static [u8]) -> &'static CStr {
    CStr::from_bytes_with_nul(value).expect("state directory path component is valid")
}

fn metadata(descriptor: libc::c_int) -> Result<libc::stat, StateDirError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } != 0 {
        return Err(StateDirError);
    }
    // SAFETY: fstat initialized metadata after reporting success.
    Ok(unsafe { metadata.assume_init() })
}
