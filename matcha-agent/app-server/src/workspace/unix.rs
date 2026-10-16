use std::{
    ffi::{CStr, CString, OsStr},
    fs::File,
    io::{self, Read},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::Path,
};

use crate::{persistence, rpc};

use super::{
    Entry, Kind,
    access::{absolute_components, denied, io_error, name_string},
};

const DIRECTORY_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

pub(super) struct Directory {
    file: File,
}

impl Directory {
    pub fn open(path: &Path) -> rpc::Result<Self> {
        let (root, names) = absolute_components(path)?;
        let root = component(root.as_os_str())?;
        // SAFETY: root is a NUL-terminated absolute filesystem root.
        let descriptor = unsafe { libc::open(root.as_ptr(), DIRECTORY_FLAGS) };
        let mut directory = Self {
            file: owned_file(descriptor, "open_root")?,
        };
        for name in names {
            directory.descend(name)?;
        }
        Ok(directory)
    }

    pub fn descend(&mut self, name: &OsStr) -> rpc::Result<()> {
        let name = component(name)?;
        // SAFETY: self owns the parent; name is a single validated directory component.
        let descriptor =
            unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS) };
        self.file = owned_file(descriptor, "open_directory")?;
        Ok(())
    }

    pub fn verify_canonical(&self, path: &Path) -> rpc::Result<()> {
        let held = self
            .file
            .metadata()
            .map_err(|error| io_error("root_stat", error))?;
        let observed = std::fs::metadata(path).map_err(|error| io_error("root_stat", error))?;
        if held.dev() != observed.dev() || held.ino() != observed.ino() {
            return Err(denied());
        }
        Ok(())
    }

    pub fn read(&self, name: &OsStr) -> rpc::Result<Vec<u8>> {
        let name = component(name)?;
        // O_NONBLOCK avoids blocking on a FIFO/device before its regular-file type is checked.
        // SAFETY: the parent descriptor is owned and name is a NUL-terminated component.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        let mut file = owned_file(descriptor, "read_open")?;
        let metadata = file
            .metadata()
            .map_err(|error| io_error("read_stat", error))?;
        if !metadata.is_file() {
            return Err(rpc::Error::conflict(
                "workspace_not_file",
                "Only regular workspace files may be read",
            ));
        }
        if metadata.nlink() != 1 {
            return Err(rpc::Error::new(
                -32007,
                "workspace_hardlink_forbidden",
                "Files with multiple hard links cannot be read through the workspace API",
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| io_error("read", error))?;
        Ok(bytes)
    }

    pub fn stat_entry(&self, name: Option<&OsStr>) -> rpc::Result<super::Stat> {
        let file = match name {
            Some(name) => {
                let name = component(name)?;
                // SAFETY: parent is held, name is one component, and the final link is not followed.
                let descriptor = unsafe {
                    libc::openat(
                        self.file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    )
                };
                owned_file(descriptor, "stat_open")?
            }
            None => self
                .file
                .try_clone()
                .map_err(|error| io_error("stat_clone", error))?,
        };
        let metadata = file.metadata().map_err(|error| io_error("stat", error))?;
        let kind = if metadata.is_file() {
            Kind::File
        } else if metadata.is_dir() {
            Kind::Directory
        } else {
            Kind::Other
        };
        super::stat_metadata(
            name.map(name_string).transpose()?.unwrap_or_default(),
            kind,
            metadata,
        )
    }

    pub fn kind(&self, name: &OsStr) -> rpc::Result<Option<Kind>> {
        let name = component(name)?;
        self.stat(&name)
            .map(|metadata| metadata.map(|metadata| kind(&metadata)))
    }

    pub fn list(&self) -> rpc::Result<Vec<Entry>> {
        let duplicate = self
            .file
            .try_clone()
            .map_err(|error| io_error("list_clone", error))?;
        let descriptor = duplicate.into_raw_fd();
        // SAFETY: fdopendir adopts this duplicate only on success.
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir did not adopt the duplicate descriptor.
            drop(unsafe { File::from_raw_fd(descriptor) });
            return Err(io_error("list_open", error));
        }
        let result = (|| {
            let mut entries = Vec::new();
            loop {
                set_errno(0);
                // SAFETY: this operation owns stream until the explicit closedir below.
                let item = unsafe { libc::readdir(stream) };
                if item.is_null() {
                    return if errno() == 0 {
                        Ok(entries)
                    } else {
                        Err(io_error("list_next", io::Error::last_os_error()))
                    };
                }
                // SAFETY: readdir returned a live entry whose name is NUL-terminated.
                let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) };
                if matches!(name.to_bytes(), b"." | b"..") {
                    continue;
                }
                let Some(metadata) = self.stat(name)? else {
                    return Err(rpc::Error::conflict(
                        "workspace_directory_changed",
                        "A directory entry disappeared during listing; list again",
                    ));
                };
                let name = name_string(OsStr::from_bytes(name.to_bytes()))?;
                let kind = kind(&metadata);
                entries.push(Entry {
                    name,
                    path: String::new(),
                    kind,
                    size: (kind == Kind::File).then_some(metadata.st_size.max(0) as u64),
                });
            }
        })();
        // SAFETY: stream is owned and has not been closed; closedir releases its descriptor.
        let cleanup = unsafe { libc::closedir(stream) };
        if cleanup == 0 {
            result
        } else {
            let cleanup = io_error("list_close", io::Error::last_os_error());
            match result {
                Ok(_) => Err(cleanup),
                Err(primary) => Err(primary.with_data(serde_json::json!({
                    "cleanup": { "kind": "workspace_directory_close", "error": cleanup }
                }))),
            }
        }
    }

    fn stat(&self, name: &CStr) -> rpc::Result<Option<libc::stat>> {
        let mut metadata = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: metadata is a correctly-sized output, parent/name remain alive for fstatat.
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            // SAFETY: fstatat initialized metadata after returning success.
            Ok(Some(unsafe { metadata.assume_init() }))
        } else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(io_error("stat", error))
            }
        }
    }

    pub async fn write(&self, name: &OsStr, bytes: &[u8]) -> rpc::Result<()> {
        persistence::atomic_write_at(&self.file, name, bytes).await
    }

    pub fn mkdir(&self, name: &OsStr) -> rpc::Result<()> {
        let name = component(name)?;
        // SAFETY: mkdirat receives an owned parent and a single NUL-terminated component.
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), 0o700) } == -1 {
            return Err(io_error("mkdir", io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn remove(&self, name: &OsStr, expected: Kind) -> rpc::Result<()> {
        let name = component(name)?;
        // unlinkat never follows a final symlink; AT_REMOVEDIR only removes empty directories.
        // SAFETY: the descriptor and component are valid for this syscall.
        let result = unsafe {
            libc::unlinkat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                if expected == Kind::Directory {
                    libc::AT_REMOVEDIR
                } else {
                    0
                },
            )
        };
        if result == -1 {
            return Err(io_error("remove", io::Error::last_os_error()));
        }
        Ok(())
    }
}

fn component(name: &OsStr) -> rpc::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| rpc::Error::invalid("Path contains a NUL byte"))
}

fn owned_file(descriptor: libc::c_int, operation: &'static str) -> rpc::Result<File> {
    if descriptor == -1 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ELOOP) {
            Err(denied().with_source(error))
        } else {
            Err(io_error(operation, error))
        };
    }
    // SAFETY: the preceding open/openat returned a new descriptor owned by the caller.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn kind(metadata: &libc::stat) -> Kind {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFREG => Kind::File,
        libc::S_IFDIR => Kind::Directory,
        libc::S_IFLNK => Kind::Symlink,
        _ => Kind::Other,
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn errno() -> libc::c_int {
    // SAFETY: libc exposes this thread's errno location.
    unsafe { *libc::__errno_location() }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: libc exposes this thread's errno location.
    unsafe { *libc::__errno_location() = value };
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn errno() -> libc::c_int {
    // SAFETY: libc exposes this thread's errno location.
    unsafe { *libc::__error() }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: libc exposes this thread's errno location.
    unsafe { *libc::__error() = value };
}
