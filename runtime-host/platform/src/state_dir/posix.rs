use std::{
    ffi::{CStr, CString, OsString},
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::{OsStrExt, OsStringExt},
    },
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use super::StateDirError;

const DIRECTORY_MODE: libc::mode_t = 0o700;
const TEMPORARY_MODE: libc::mode_t = 0o600;
const OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const FILE_OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC;

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub struct StateDirHandle {
    _descriptor: OwnedFd,
}

#[derive(Clone)]
pub(super) struct StateDirIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
    _descriptor: Arc<OwnedFd>,
}

impl PartialEq for StateDirIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }
}

impl Eq for StateDirIdentity {}

impl std::fmt::Debug for StateDirHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StateDirHandle")
    }
}

impl StateDirHandle {
    pub fn clone_descriptor(&self) -> Result<OwnedFd, StateDirError> {
        let descriptor =
            unsafe { libc::fcntl(self._descriptor.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if descriptor == -1 {
            return Err(StateDirError);
        }
        // SAFETY: fcntl returned a new owned descriptor with close-on-exec set.
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
    }

    pub fn replace_regular_file_bounded(
        &self,
        name: &str,
        contents: &[u8],
        byte_limit: usize,
    ) -> Result<(), StateDirError> {
        if contents.len() > byte_limit {
            return Err(StateDirError);
        }
        let name = relative_name(name)?;
        let (temporary, temporary_name) = create_temporary_file(self)?;
        let result = write_and_replace(self, &temporary, &temporary_name, &name, contents);
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                if remove_temporary(self, &temporary_name).is_err() {
                    return Err(StateDirError);
                }
                Err(error)
            }
        }
    }

    pub fn read_regular_file_bounded(
        &self,
        name: &str,
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        let name = relative_name(name)?;
        let descriptor =
            unsafe { libc::openat(self._descriptor.as_raw_fd(), name.as_ptr(), FILE_OPEN_FLAGS) };
        if descriptor == -1 {
            return match io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => Ok(None),
                _ => Err(StateDirError),
            };
        }
        // SAFETY: openat returned a new owned descriptor.
        Ok(Some(read_regular_descriptor(
            unsafe { OwnedFd::from_raw_fd(descriptor) },
            byte_limit,
        )?))
    }

    pub fn read_nested_regular_file_bounded(
        &self,
        components: &[String],
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        let (leaf, parents) = components.split_last().ok_or(StateDirError)?;
        let mut parent = self.clone_descriptor()?;
        for component in parents {
            let component = nested_component(component)?;
            let descriptor =
                unsafe { libc::openat(parent.as_raw_fd(), component.as_ptr(), OPEN_FLAGS) };
            if descriptor == -1 {
                return match io::Error::last_os_error().raw_os_error() {
                    Some(libc::ENOENT) => Ok(None),
                    _ => Err(StateDirError),
                };
            }
            // SAFETY: openat returned a new owned directory descriptor.
            parent = unsafe { OwnedFd::from_raw_fd(descriptor) };
        }
        let leaf = nested_component(leaf)?;
        let descriptor =
            unsafe { libc::openat(parent.as_raw_fd(), leaf.as_ptr(), FILE_OPEN_FLAGS) };
        if descriptor == -1 {
            return match io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => Ok(None),
                _ => Err(StateDirError),
            };
        }
        // SAFETY: openat returned a new owned descriptor.
        Ok(Some(read_regular_descriptor(
            unsafe { OwnedFd::from_raw_fd(descriptor) },
            byte_limit,
        )?))
    }
}

fn relative_name(name: &str) -> Result<CString, StateDirError> {
    let name = CString::new(name).map_err(|_| StateDirError)?;
    if name.as_bytes().is_empty()
        || name.as_bytes().contains(&b'/')
        || matches!(name.as_bytes(), b"." | b"..")
    {
        return Err(StateDirError);
    }
    Ok(name)
}

fn nested_component(name: &str) -> Result<CString, StateDirError> {
    let component = relative_name(name)?;
    if component.as_bytes().contains(&b'\\') {
        return Err(StateDirError);
    }
    Ok(component)
}

fn read_regular_descriptor(file: OwnedFd, byte_limit: usize) -> Result<Vec<u8>, StateDirError> {
    let metadata = metadata(file.as_raw_fd())?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_size < 0
        || metadata.st_size as u64 > byte_limit as u64
    {
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
            .is_none_or(|length| length > byte_limit)
        {
            return Err(StateDirError);
        }
        contents.extend_from_slice(&buffer[..read]);
    }
    Ok(contents)
}

fn create_temporary_file(directory: &StateDirHandle) -> Result<(OwnedFd, CString), StateDirError> {
    for _ in 0..128 {
        let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
        let name = relative_name(&format!(
            ".state-file.{:x}.{sequence:x}.tmp",
            std::process::id()
        ))?;
        let descriptor = unsafe {
            libc::openat(
                directory._descriptor.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                TEMPORARY_MODE as libc::c_uint,
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

fn write_and_replace(
    directory: &StateDirHandle,
    temporary: &OwnedFd,
    temporary_name: &CString,
    target_name: &CString,
    contents: &[u8],
) -> Result<(), StateDirError> {
    write_all(temporary, contents)?;
    if unsafe { libc::fsync(temporary.as_raw_fd()) } != 0 {
        return Err(StateDirError);
    }
    let directory_fd = directory._descriptor.as_raw_fd();
    if unsafe {
        libc::renameat(
            directory_fd,
            temporary_name.as_ptr(),
            directory_fd,
            target_name.as_ptr(),
        )
    } != 0
    {
        return Err(StateDirError);
    }
    if unsafe { libc::fsync(directory_fd) } != 0 {
        return Err(StateDirError);
    }
    Ok(())
}

fn write_all(file: &OwnedFd, contents: &[u8]) -> Result<(), StateDirError> {
    let mut remaining = contents;
    while !remaining.is_empty() {
        let written =
            unsafe { libc::write(file.as_raw_fd(), remaining.as_ptr().cast(), remaining.len()) };
        if written <= 0 {
            return Err(StateDirError);
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

fn remove_temporary(directory: &StateDirHandle, name: &CString) -> Result<(), StateDirError> {
    if unsafe { libc::unlinkat(directory._descriptor.as_raw_fd(), name.as_ptr(), 0) } == 0
        || io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
    {
        Ok(())
    } else {
        Err(StateDirError)
    }
}

pub(super) fn provision(path: &Path) -> Result<(PathBuf, StateDirIdentity), StateDirError> {
    let components = components(path)?;
    let (parent_components, leaf) = components.split_at(components.len() - 1);
    let parent = open_chain(parent_components)?;
    let leaf = &leaf[0];

    let created = if mkdir_at(parent.as_raw_fd(), leaf) {
        true
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(StateDirError);
        }
        false
    };

    let directory = open_at(parent.as_raw_fd(), leaf)?;
    if created {
        secure_created(directory.as_raw_fd())?;
    }
    let identity = identity(directory.as_raw_fd())?;
    verify_private(directory.as_raw_fd())?;
    let path = canonical_path(directory.as_raw_fd())?;
    Ok((
        path,
        StateDirIdentity {
            device: identity.device,
            inode: identity.inode,
            _descriptor: Arc::new(directory),
        },
    ))
}

pub(super) fn open(
    path: &Path,
    expected: &StateDirIdentity,
) -> Result<StateDirHandle, StateDirError> {
    let components = components(path)?;
    let directory = open_chain(&components)?;
    verify_private(directory.as_raw_fd())?;
    let identity = identity(directory.as_raw_fd())?;
    if identity.device != expected.device || identity.inode != expected.inode {
        return Err(StateDirError);
    }
    Ok(StateDirHandle {
        _descriptor: directory,
    })
}

fn components(path: &Path) -> Result<Vec<CString>, StateDirError> {
    if !path.is_absolute() {
        return Err(StateDirError);
    }

    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                names.push(CString::new(name.as_bytes()).map_err(|_| StateDirError)?)
            }
            _ => return Err(StateDirError),
        }
    }
    if names.is_empty() {
        return Err(StateDirError);
    }
    Ok(names)
}

fn open_chain(components: &[CString]) -> Result<OwnedFd, StateDirError> {
    let root = unsafe { libc::open(c"/".as_ptr(), OPEN_FLAGS) };
    if root == -1 {
        return Err(StateDirError);
    }
    // SAFETY: open returned a new owned descriptor.
    let mut current = unsafe { OwnedFd::from_raw_fd(root) };
    for component in components {
        current = open_at(current.as_raw_fd(), component)?;
    }
    Ok(current)
}

fn open_at(parent: RawFd, name: &CStr) -> Result<OwnedFd, StateDirError> {
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), OPEN_FLAGS) };
    if descriptor == -1 {
        return Err(StateDirError);
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn mkdir_at(parent: RawFd, name: &CStr) -> bool {
    (unsafe { libc::mkdirat(parent, name.as_ptr(), DIRECTORY_MODE) }) == 0
}

fn verify_private(descriptor: RawFd) -> Result<(), StateDirError> {
    verify_owner_only(descriptor, libc::S_IFDIR, DIRECTORY_MODE)
}

pub(super) fn verify_owner_only(
    descriptor: RawFd,
    expected_kind: libc::mode_t,
    expected_mode: libc::mode_t,
) -> Result<(), StateDirError> {
    let metadata = metadata(descriptor)?;
    if metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode & libc::S_IFMT != expected_kind
        || metadata.st_mode & 0o777 != expected_mode
    {
        return Err(StateDirError);
    }
    verify_no_extended_acl(descriptor)
}

fn identity(descriptor: RawFd) -> Result<FileIdentity, StateDirError> {
    let metadata = metadata(descriptor)?;
    Ok(FileIdentity {
        device: metadata.st_dev,
        inode: metadata.st_ino,
    })
}

struct FileIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
}

fn metadata(descriptor: RawFd) -> Result<libc::stat, StateDirError> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(StateDirError);
    }
    // SAFETY: fstat initialized metadata after reporting success.
    Ok(unsafe { metadata.assume_init() })
}

#[cfg(not(target_os = "macos"))]
fn verify_no_extended_acl(_descriptor: RawFd) -> Result<(), StateDirError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_no_extended_acl(descriptor: RawFd) -> Result<(), StateDirError> {
    use std::ptr::null_mut;

    type Acl = *mut std::ffi::c_void;
    const ACL_TYPE_EXTENDED: libc::c_int = 0x100;

    unsafe extern "C" {
        fn acl_get_fd_np(descriptor: libc::c_int, acl_type: libc::c_int) -> Acl;
        fn acl_free(value: *mut std::ffi::c_void) -> libc::c_int;
    }

    set_errno(0);
    let acl = unsafe { acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) };
    if acl != null_mut() {
        unsafe { acl_free(acl) };
        return Err(StateDirError);
    }
    if io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        Ok(())
    } else {
        Err(StateDirError)
    }
}

#[cfg(not(target_os = "macos"))]
fn secure_created(descriptor: RawFd) -> Result<(), StateDirError> {
    if unsafe { libc::fchmod(descriptor, DIRECTORY_MODE) } == -1 {
        Err(StateDirError)
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn secure_created(descriptor: RawFd) -> Result<(), StateDirError> {
    use std::{ffi::c_void, ptr};

    type FileSec = *mut c_void;
    const FILESEC_ACL: libc::c_int = 5;
    const REMOVE_ACL: *const c_void = ptr::without_provenance(1);

    unsafe extern "C" {
        fn filesec_init() -> FileSec;
        fn filesec_free(file_sec: FileSec);
        fn filesec_set_property(
            file_sec: FileSec,
            property: libc::c_int,
            value: *const c_void,
        ) -> libc::c_int;
        fn fchmodx_np(descriptor: libc::c_int, file_sec: FileSec) -> libc::c_int;
    }

    let file_sec = unsafe { filesec_init() };
    if file_sec.is_null() {
        return Err(StateDirError);
    }
    let result = unsafe {
        if filesec_set_property(file_sec, FILESEC_ACL, REMOVE_ACL) == 0
            && fchmodx_np(descriptor, file_sec) == 0
        {
            Ok(())
        } else {
            Err(StateDirError)
        }
    };
    unsafe { filesec_free(file_sec) };
    result?;
    if unsafe { libc::fchmod(descriptor, DIRECTORY_MODE) } == -1 {
        Err(StateDirError)
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn set_errno(value: libc::c_int) {
    unsafe { *libc::__error() = value };
}

#[cfg(target_os = "linux")]
fn canonical_path(descriptor: RawFd) -> Result<PathBuf, StateDirError> {
    let link = CString::new(format!("/proc/self/fd/{descriptor}")).map_err(|_| StateDirError)?;
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize + 1];
    let length =
        unsafe { libc::readlink(link.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len() - 1) };
    if length < 0 || length as usize == buffer.len() - 1 {
        return Err(StateDirError);
    }
    buffer.truncate(length as usize);
    let path = PathBuf::from(OsString::from_vec(buffer));
    if path.is_absolute() && !path.as_os_str().as_bytes().ends_with(b" (deleted)") {
        Ok(path)
    } else {
        Err(StateDirError)
    }
}

#[cfg(any(target_os = "macos", target_os = "freebsd"))]
fn canonical_path(descriptor: RawFd) -> Result<PathBuf, StateDirError> {
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(descriptor, libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(StateDirError);
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(StateDirError)?;
    buffer.truncate(length);
    let path = PathBuf::from(OsString::from_vec(buffer));
    path.is_absolute().then_some(path).ok_or(StateDirError)
}
