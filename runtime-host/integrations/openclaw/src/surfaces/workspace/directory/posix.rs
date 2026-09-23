use std::{
    ffi::{CStr, CString, OsString},
    fmt,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::{OsStrExt, OsStringExt},
    },
    path::{Component, Path, PathBuf},
};

const OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

#[derive(Clone, Eq, PartialEq)]
pub(in crate::surfaces::workspace) struct CanonicalDirectory(PathBuf);

impl CanonicalDirectory {
    pub(in crate::surfaces::workspace) fn as_path(&self) -> &Path {
        &self.0
    }

    pub(in crate::surfaces::workspace) fn is_within(&self, allow_root: &Self) -> bool {
        self.0.starts_with(&allow_root.0)
    }
}

impl fmt::Debug for CanonicalDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalDirectory(<private>)")
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(in crate::surfaces::workspace) struct DirectoryIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
}

impl fmt::Debug for DirectoryIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DirectoryIdentity(<private>)")
    }
}

pub(in crate::surfaces::workspace) struct DirectoryHandle {
    descriptor: OwnedFd,
}

impl DirectoryHandle {
    pub(in crate::surfaces::workspace) fn as_raw_fd(&self) -> RawFd {
        self.descriptor.as_raw_fd()
    }
}

impl fmt::Debug for DirectoryHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DirectoryHandle")
    }
}

pub(in crate::surfaces::workspace) struct OpenedDirectory {
    canonical: CanonicalDirectory,
    identity: DirectoryIdentity,
    handle: DirectoryHandle,
}

impl OpenedDirectory {
    pub(in crate::surfaces::workspace) fn canonical(&self) -> &CanonicalDirectory {
        &self.canonical
    }

    pub(in crate::surfaces::workspace) const fn identity(&self) -> DirectoryIdentity {
        self.identity
    }

    pub(in crate::surfaces::workspace) fn into_handle(self) -> DirectoryHandle {
        self.handle
    }
}

pub(in crate::surfaces::workspace) fn open(path: &Path) -> Result<OpenedDirectory, DirectoryError> {
    let components = components(path)?;
    let descriptor = open_chain(&components)?;
    let identity = identity(descriptor.as_raw_fd())?;
    let canonical = canonical_path(descriptor.as_raw_fd())?;
    Ok(OpenedDirectory {
        canonical: CanonicalDirectory(canonical),
        identity,
        handle: DirectoryHandle { descriptor },
    })
}

fn components(path: &Path) -> Result<Vec<CString>, DirectoryError> {
    if !path.is_absolute() {
        return Err(DirectoryError);
    }
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                names.push(CString::new(name.as_bytes()).map_err(|_| DirectoryError)?)
            }
            _ => return Err(DirectoryError),
        }
    }
    if names.is_empty() {
        return Err(DirectoryError);
    }
    Ok(names)
}

fn open_chain(components: &[CString]) -> Result<OwnedFd, DirectoryError> {
    let root = unsafe { libc::open(c"/".as_ptr(), OPEN_FLAGS) };
    if root == -1 {
        return Err(DirectoryError);
    }
    // SAFETY: open returned a new directory descriptor.
    let mut current = unsafe { OwnedFd::from_raw_fd(root) };
    for component in components {
        current = open_at(current.as_raw_fd(), component)?;
    }
    Ok(current)
}

fn open_at(parent: RawFd, name: &CStr) -> Result<OwnedFd, DirectoryError> {
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), OPEN_FLAGS) };
    if descriptor == -1 {
        return Err(DirectoryError);
    }
    // SAFETY: openat returned a new directory descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn identity(descriptor: RawFd) -> Result<DirectoryIdentity, DirectoryError> {
    let metadata = metadata(descriptor)?;
    Ok(DirectoryIdentity {
        device: metadata.st_dev,
        inode: metadata.st_ino,
    })
}

fn metadata(descriptor: RawFd) -> Result<libc::stat, DirectoryError> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(DirectoryError);
    }
    // SAFETY: fstat initialized metadata after reporting success.
    Ok(unsafe { metadata.assume_init() })
}

#[cfg(target_os = "linux")]
fn canonical_path(descriptor: RawFd) -> Result<PathBuf, DirectoryError> {
    let link = CString::new(format!("/proc/self/fd/{descriptor}")).map_err(|_| DirectoryError)?;
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize + 1];
    let length =
        unsafe { libc::readlink(link.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len() - 1) };
    if length < 0 || length as usize == buffer.len() - 1 {
        return Err(DirectoryError);
    }
    buffer.truncate(length as usize);
    let path = PathBuf::from(OsString::from_vec(buffer));
    if path.is_absolute() && !path.as_os_str().as_bytes().ends_with(b" (deleted)") {
        Ok(path)
    } else {
        Err(DirectoryError)
    }
}

#[cfg(any(target_os = "macos", target_os = "freebsd"))]
fn canonical_path(descriptor: RawFd) -> Result<PathBuf, DirectoryError> {
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(descriptor, libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(DirectoryError);
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(DirectoryError)?;
    buffer.truncate(length);
    let path = PathBuf::from(OsString::from_vec(buffer));
    path.is_absolute().then_some(path).ok_or(DirectoryError)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::surfaces::workspace) struct DirectoryError;
