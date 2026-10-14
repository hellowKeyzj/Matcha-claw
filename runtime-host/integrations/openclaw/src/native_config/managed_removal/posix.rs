use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

use super::marker_changed;

const DIRECTORY_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const MARKER: &CStr = c".matchaclaw-managed";

pub(super) struct DirectoryCustody {
    extensions: OwnedFd,
    target: OwnedFd,
    retained_name: CString,
}

impl DirectoryCustody {
    pub(super) fn open(extensions: &Path, id: &str, _removing: bool) -> io::Result<Option<Self>> {
        let extensions_name = CString::new(extensions.as_os_str().as_bytes())
            .map_err(|_| marker_changed())?;
        let descriptor = unsafe { libc::open(extensions_name.as_ptr(), DIRECTORY_FLAGS) };
        if descriptor == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: open returned a new directory descriptor.
        let extensions = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let name = CString::new(id).map_err(|_| marker_changed())?;
        let descriptor = unsafe {
            libc::openat(extensions.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS)
        };
        if descriptor == -1 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: openat returned a new directory descriptor.
        let target = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let identity = metadata(target.as_raw_fd())?;
        let retained_name = CString::new(format!(
            ".{id}.removing-{:x}-{:x}", identity.st_dev, identity.st_ino,
        )).map_err(|_| marker_changed())?;
        Ok(Some(Self { extensions, target, retained_name }))
    }

    pub(super) fn open_marker(&self) -> io::Result<Option<File>> {
        open_file(self.target.as_raw_fd(), MARKER)
    }

    pub(super) fn open_retained(&self) -> io::Result<Option<File>> {
        open_file(self.extensions.as_raw_fd(), &self.retained_name)
    }

    pub(super) fn retain_marker(&self, marker: &File) -> io::Result<()> {
        self.require_same(self.target.as_raw_fd(), MARKER, marker)?;
        link(
            self.target.as_raw_fd(), MARKER,
            self.extensions.as_raw_fd(), &self.retained_name,
        )
    }

    pub(super) fn restore_marker(&self, retained: &File) -> io::Result<()> {
        self.require_same(self.extensions.as_raw_fd(), &self.retained_name, retained)?;
        match link(
            self.extensions.as_raw_fd(), &self.retained_name,
            self.target.as_raw_fd(), MARKER,
        ) {
            Ok(()) => self.require_same(self.target.as_raw_fd(), MARKER, retained),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                self.require_same(self.target.as_raw_fd(), MARKER, retained)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn remove_marker(&self, marker: &File) -> io::Result<()> {
        self.require_same(self.target.as_raw_fd(), MARKER, marker)?;
        unlink(self.target.as_raw_fd(), MARKER)
    }

    pub(super) fn remove_target(&self, target: &Path) -> io::Result<()> {
        // The existing final name-based rmdir is unchanged; marker recovery uses only target fd.
        std::fs::remove_dir(target)
    }

    pub(super) fn remove_retained(&self, retained: &File) -> io::Result<()> {
        self.require_same(self.extensions.as_raw_fd(), &self.retained_name, retained)?;
        unlink(self.extensions.as_raw_fd(), &self.retained_name)
    }

    fn require_same(&self, directory: RawFd, name: &CStr, expected: &File) -> io::Result<()> {
        let file = open_file(directory, name)?.ok_or_else(marker_changed)?;
        if same_file(&file, expected)? {
            Ok(())
        } else {
            Err(marker_changed())
        }
    }
}

pub(super) fn same_file(left: &File, right: &File) -> io::Result<bool> {
    let left = metadata(left.as_raw_fd())?;
    let right = metadata(right.as_raw_fd())?;
    Ok(left.st_dev == right.st_dev && left.st_ino == right.st_ino)
}

fn open_file(directory: RawFd, name: &CStr) -> io::Result<Option<File>> {
    let descriptor = unsafe {
        libc::openat(
            directory, name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ELOOP) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: openat returned a new file descriptor; read_marker rejects non-regular files.
    Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
}

fn metadata(descriptor: RawFd) -> io::Result<libc::stat> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat initialized metadata after reporting success.
    Ok(unsafe { metadata.assume_init() })
}

fn link(source: RawFd, from: &CStr, destination: RawFd, to: &CStr) -> io::Result<()> {
    if unsafe { libc::linkat(source, from.as_ptr(), destination, to.as_ptr(), 0) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unlink(directory: RawFd, name: &CStr) -> io::Result<()> {
    if unsafe { libc::unlinkat(directory, name.as_ptr(), 0) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
