use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Write},
    mem::MaybeUninit,
    os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
    sync::atomic::{AtomicU64, Ordering},
};

use super::{WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileError};
use crate::surfaces::workspace::directory::DirectoryHandle;

const FILE_OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
const FILE_CREATE_FLAGS: libc::c_int =
    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW;
const FILE_CREATE_MODE: libc::mode_t = 0o600;
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);
pub(super) fn read_external_file(
    path: &std::path::Path,
    limit: usize,
) -> Result<(Vec<u8>, u64), WorkspaceFileError> {
    let parent = path.parent().ok_or(WorkspaceFileError::InvalidRelative)?;
    let directory = crate::surfaces::workspace::directory::open(parent)
        .map_err(|_| WorkspaceFileError::Unavailable)?
        .into_handle();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    read_file(&directory, &[name.to_owned()], limit)
}

pub(super) fn read_file(
    directory: &DirectoryHandle,
    components: &[String],
    limit: usize,
) -> Result<(Vec<u8>, u64), WorkspaceFileError> {
    let descriptor = open_leaf(directory, components, FILE_OPEN_FLAGS)?;
    let metadata = metadata(descriptor.as_raw_fd())?;
    if is_directory(&metadata) {
        return Err(WorkspaceFileError::NotFile);
    }
    if !is_regular_file(&metadata) || metadata.st_size < 0 {
        return Err(WorkspaceFileError::Unavailable);
    }
    let size = metadata.st_size as u64;
    if size > limit as u64 {
        return Err(WorkspaceFileError::TooLarge);
    }
    // SAFETY: openat returned a new owned descriptor after every component was no-follow opened.
    let file = unsafe { File::from_raw_fd(descriptor.into_raw_fd()) };
    let capacity = usize::try_from(size).map_err(|_| WorkspaceFileError::TooLarge)?;
    let mut content = Vec::with_capacity(capacity);
    file.take(limit as u64 + 1)
        .read_to_end(&mut content)
        .map_err(|_| WorkspaceFileError::Unavailable)?;
    if content.len() > limit {
        return Err(WorkspaceFileError::TooLarge);
    }
    let size = content.len() as u64;
    Ok((content, size))
}

pub(super) fn stat(
    directory: &DirectoryHandle,
    components: &[String],
) -> Result<WorkspaceEntry, WorkspaceFileError> {
    let descriptor = open_leaf(directory, components, FILE_OPEN_FLAGS)?;
    entry(String::new(), &metadata(descriptor.as_raw_fd())?)
}

pub(super) fn list_dir(
    directory: &DirectoryHandle,
    components: &[String],
    include_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, WorkspaceFileError> {
    let directory = if components.is_empty() {
        duplicate(directory.as_raw_fd())?
    } else {
        open_leaf(directory, components, FILE_OPEN_FLAGS)?
    };
    if !is_directory(&metadata(directory.as_raw_fd())?) {
        return Err(WorkspaceFileError::NotDirectory);
    }
    let stream = DirectoryStream::open(directory.as_raw_fd())?;
    let result = (|| {
        let mut entries = Vec::new();
        let stream_descriptor = unsafe { libc::dirfd(stream.as_ptr()) };
        if stream_descriptor < 0 {
            return Err(WorkspaceFileError::Unavailable);
        }
        loop {
            set_errno(0);
            // SAFETY: stream owns this valid directory stream for the closure's duration.
            let directory_entry = unsafe { libc::readdir(stream.as_ptr()) };
            if directory_entry.is_null() {
                return if errno() == 0 {
                    Ok(entries)
                } else {
                    Err(WorkspaceFileError::Unavailable)
                };
            }
            // SAFETY: d_name is NUL-terminated for this directory entry.
            let child = unsafe { CStr::from_ptr((*directory_entry).d_name.as_ptr()) };
            let entry_name = match listed_component(child) {
                Some(name) => name,
                None => continue,
            };
            if !include_hidden && entry_name.starts_with('.') {
                continue;
            }
            let child_descriptor = match open_at(stream_descriptor, child, FILE_OPEN_FLAGS) {
                Ok(descriptor) => unsafe { OwnedFd::from_raw_fd(descriptor) },
                Err(WorkspaceFileError::Unavailable) => continue,
                Err(error) => return Err(error),
            };
            let metadata = metadata(child_descriptor.as_raw_fd())?;
            match entry(entry_name, &metadata) {
                Ok(entry)
                    if entry.kind == WorkspaceEntryKind::Directory
                        && excluded_directory(&entry.name) => {}
                Ok(entry) => entries.push(entry),
                Err(WorkspaceFileError::Unavailable) => continue,
                Err(error) => return Err(error),
            }
        }
    })();
    let mut entries = result?;
    entries.sort_by(|left, right| {
        let kind = matches!(right.kind, WorkspaceEntryKind::Directory)
            .cmp(&matches!(left.kind, WorkspaceEntryKind::Directory));
        kind.then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

pub(super) fn write_file(
    directory: &DirectoryHandle,
    components: &[String],
    content: &[u8],
) -> Result<(), WorkspaceFileError> {
    let (leaf, parents) = components
        .split_last()
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    let root = duplicate(directory.as_raw_fd())?;
    let parent = parents.iter().try_fold(root, |parent, segment| {
        let component = component(segment)?;
        let child = match open_at(parent.as_raw_fd(), &component, FILE_OPEN_FLAGS) {
            Ok(child) => child,
            Err(WorkspaceFileError::Unavailable) => {
                create_directory_at(parent.as_raw_fd(), &component)?
            }
            Err(error) => return Err(error),
        };
        // SAFETY: openat or mkdirat followed by openat returned a new owned descriptor.
        let child = unsafe { OwnedFd::from_raw_fd(child) };
        if !is_directory(&metadata(child.as_raw_fd())?) {
            return Err(WorkspaceFileError::NotDirectory);
        }
        Ok::<OwnedFd, WorkspaceFileError>(child)
    })?;
    let leaf = component(leaf)?;
    let temporary = temporary_name()?;
    let temporary_descriptor = open_at(parent.as_raw_fd(), &temporary, FILE_CREATE_FLAGS)?;
    // SAFETY: openat returned a new owned descriptor.
    let mut temporary_file = unsafe { File::from_raw_fd(temporary_descriptor) };
    if temporary_file.write_all(content).is_err() || temporary_file.sync_all().is_err() {
        drop(temporary_file);
        unlink_at(parent.as_raw_fd(), &temporary);
        return Err(WorkspaceFileError::OutcomeUnknown);
    }
    drop(temporary_file);
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            leaf.as_ptr(),
        )
    } == -1
    {
        unlink_at(parent.as_raw_fd(), &temporary);
        return Err(WorkspaceFileError::OutcomeUnknown);
    }
    Ok(())
}

struct DirectoryStream(*mut libc::DIR);

impl DirectoryStream {
    fn open(directory: RawFd) -> Result<Self, WorkspaceFileError> {
        let descriptor = duplicate(directory)?.into_raw_fd();
        // SAFETY: fdopendir adopts the duplicated descriptor only after success.
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            unsafe {
                libc::close(descriptor);
            }
            return Err(WorkspaceFileError::Unavailable);
        }
        Ok(Self(stream))
    }

    fn as_ptr(&self) -> *mut libc::DIR {
        self.0
    }
}

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: this wrapper exclusively owns the directory stream.
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn open_leaf(
    directory: &DirectoryHandle,
    components: &[String],
    leaf_flags: libc::c_int,
) -> Result<OwnedFd, WorkspaceFileError> {
    let (leaf, parents) = components
        .split_last()
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    let root = duplicate(directory.as_raw_fd())?;
    let parent = parents.iter().try_fold(root, |parent, segment| {
        let component = component(segment)?;
        let child = open_at(parent.as_raw_fd(), &component, FILE_OPEN_FLAGS)?;
        // SAFETY: openat returned a new owned descriptor.
        let child = unsafe { OwnedFd::from_raw_fd(child) };
        if !is_directory(&metadata(child.as_raw_fd())?) {
            return Err(WorkspaceFileError::NotDirectory);
        }
        Ok::<OwnedFd, WorkspaceFileError>(child)
    })?;
    let leaf = component(leaf)?;
    let descriptor = open_at(parent.as_raw_fd(), &leaf, leaf_flags)?;
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn duplicate(descriptor: RawFd) -> Result<OwnedFd, WorkspaceFileError> {
    let duplicate = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate == -1 {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: fcntl returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

fn component(value: &str) -> Result<CString, WorkspaceFileError> {
    CString::new(value).map_err(|_| WorkspaceFileError::InvalidRelative)
}

fn temporary_name() -> Result<CString, WorkspaceFileError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    CString::new(format!(".matcha-write-{}-{sequence}", std::process::id()))
        .map_err(|_| WorkspaceFileError::Unavailable)
}

fn unlink_at(parent: RawFd, name: &CStr) {
    // SAFETY: unlinkat only receives a valid parent descriptor and NUL-terminated temporary name.
    unsafe {
        libc::unlinkat(parent, name.as_ptr(), 0);
    }
}

fn listed_component(value: &CStr) -> Option<String> {
    let value = value.to_str().ok()?;
    super::valid_component(value).then(|| value.to_owned())
}

fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int) -> Result<RawFd, WorkspaceFileError> {
    let descriptor = if flags & libc::O_CREAT != 0 {
        unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                flags,
                FILE_CREATE_MODE as libc::c_uint,
            )
        }
    } else {
        unsafe { libc::openat(parent, name.as_ptr(), flags) }
    };
    if descriptor >= 0 {
        return Ok(descriptor);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EISDIR) => Err(WorkspaceFileError::NotFile),
        Some(libc::ENOTDIR) if flags & libc::O_DIRECTORY != 0 => {
            Err(WorkspaceFileError::NotDirectory)
        }
        _ => Err(WorkspaceFileError::Unavailable),
    }
}

fn create_directory_at(parent: RawFd, name: &CStr) -> Result<RawFd, WorkspaceFileError> {
    let result = unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) };
    if result == -1 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Err(WorkspaceFileError::Unavailable);
    }
    open_at(parent, name, FILE_OPEN_FLAGS)
}

fn metadata(descriptor: RawFd) -> Result<libc::stat, WorkspaceFileError> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: fstat initialized metadata after reporting success.
    Ok(unsafe { metadata.assume_init() })
}

fn entry(name: String, metadata: &libc::stat) -> Result<WorkspaceEntry, WorkspaceFileError> {
    let kind = if is_directory(metadata) {
        WorkspaceEntryKind::Directory
    } else if is_regular_file(metadata) {
        WorkspaceEntryKind::File
    } else {
        return Err(WorkspaceFileError::Unavailable);
    };
    let size = (kind == WorkspaceEntryKind::File && metadata.st_size >= 0)
        .then_some(metadata.st_size as u64)
        .unwrap_or(0);
    Ok(WorkspaceEntry {
        name,
        kind,
        size,
        mtime_ms: mtime_ms(metadata)?,
    })
}

fn mtime_ms(metadata: &libc::stat) -> Result<u64, WorkspaceFileError> {
    let seconds = u64::try_from(metadata.st_mtime).map_err(|_| WorkspaceFileError::Unavailable)?;
    let nanos =
        u64::try_from(metadata.st_mtime_nsec).map_err(|_| WorkspaceFileError::Unavailable)?;
    seconds
        .checked_mul(1_000)
        .and_then(|milliseconds| milliseconds.checked_add(nanos / 1_000_000))
        .ok_or(WorkspaceFileError::Unavailable)
}

fn is_directory(metadata: &libc::stat) -> bool {
    metadata.st_mode & libc::S_IFMT == libc::S_IFDIR
}

fn is_regular_file(metadata: &libc::stat) -> bool {
    metadata.st_mode & libc::S_IFMT == libc::S_IFREG
}

fn excluded_directory(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".venv"
            | "__pycache__"
            | ".git"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
    )
}

#[cfg(target_os = "linux")]
fn errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}

#[cfg(target_os = "linux")]
fn set_errno(value: libc::c_int) {
    unsafe { *libc::__errno_location() = value };
}

#[cfg(target_os = "macos")]
fn errno() -> libc::c_int {
    unsafe { *libc::__error() }
}

#[cfg(target_os = "macos")]
fn set_errno(value: libc::c_int) {
    unsafe { *libc::__error() = value };
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn errno() -> libc::c_int {
    1
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn set_errno(_: libc::c_int) {}
