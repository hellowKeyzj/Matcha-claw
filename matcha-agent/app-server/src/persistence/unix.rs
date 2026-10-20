use std::{
    ffi::{CString, OsStr},
    fs::{File, OpenOptions},
    io::{self, Write},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    path::Path,
};

use super::Failure;

pub(super) fn write_path(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    let name = path
        .file_name()
        .ok_or_else(|| Failure::io("path", io::ErrorKind::InvalidInput.into()))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|error| Failure::io("directory_open", error))?;
    write_at(&directory, name, bytes)
}

pub(super) fn write_at(directory: &File, name: &OsStr, bytes: &[u8]) -> Result<(), Failure> {
    let name = component(name)?;
    if !directory
        .metadata()
        .map_err(|error| Failure::io("directory_stat", error))?
        .is_dir()
    {
        return Err(Failure::io(
            "directory_stat",
            io::ErrorKind::NotADirectory.into(),
        ));
    }
    let directory_fd = directory.as_raw_fd();
    let existing = target_stat(directory_fd, &name)?;
    if let Some(stat) = &existing {
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFLNK => {
                return Err(Failure::io(
                    "target_symlink",
                    io::ErrorKind::InvalidInput.into(),
                ));
            }
            libc::S_IFREG => {}
            _ => {
                return Err(Failure::io(
                    "target_type",
                    io::ErrorKind::InvalidInput.into(),
                ));
            }
        }
    }
    let temporary = CString::new(format!(".matcha-write-{}.tmp", uuid::Uuid::new_v4()))
        .expect("UUID temporary names contain no NUL");
    // SAFETY: the borrowed directory descriptor and NUL-terminated name are live.
    let descriptor = unsafe {
        libc::openat(
            directory_fd,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600 as libc::c_uint,
        )
    };
    if descriptor == -1 {
        return Err(Failure::io("temporary_create", io::Error::last_os_error()));
    }
    // SAFETY: openat returned a new, owned file descriptor.
    let mut output = unsafe { File::from_raw_fd(descriptor) };
    let result = (|| {
        output
            .write_all(bytes)
            .map_err(|error| Failure::io("write", error))?;
        output
            .flush()
            .map_err(|error| Failure::io("flush", error))?;
        // Keep unpublished bytes owner-only until complete; fchmod after writing also
        // avoids writes silently clearing an existing file's set-ID permission bits.
        if let Some(stat) = existing {
            let temporary_stat = output
                .metadata()
                .map_err(|error| Failure::io("permissions", error))?;
            use std::os::unix::fs::MetadataExt;
            if (temporary_stat.uid() != stat.st_uid || temporary_stat.gid() != stat.st_gid)
                // SAFETY: the owned temporary descriptor is live; ownership comes
                // from the existing target, never from caller-supplied numeric IDs.
                && unsafe { libc::fchown(output.as_raw_fd(), stat.st_uid, stat.st_gid) } != 0
            {
                return Err(Failure::io("permissions", io::Error::last_os_error()));
            }
            // SAFETY: the descriptor is live and mode only contains permission bits.
            if unsafe { libc::fchmod(output.as_raw_fd(), stat.st_mode & 0o7777) } != 0 {
                return Err(Failure::io("permissions", io::Error::last_os_error()));
            }
        }
        output
            .sync_all()
            .map_err(|error| Failure::io("sync", error))?;
        // SAFETY: both names are single components relative to the same held directory.
        if unsafe {
            libc::renameat(
                directory_fd,
                temporary.as_ptr(),
                directory_fd,
                name.as_ptr(),
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            // POSIX rename errors leave the destination unchanged, except I/O errors
            // cannot establish which metadata reached storage.
            return Err(
                if error.kind() == io::ErrorKind::Other || error.raw_os_error() == Some(libc::EIO) {
                    Failure::commit("commit", error)
                } else {
                    Failure::io("rename", error)
                },
            );
        }
        directory
            .sync_all()
            .map_err(|error| Failure::commit("directory_sync", error))
    })();
    // close can report late I/O failure even after fsync. Never retry close: on
    // Linux an error may already have released the descriptor for reuse.
    let descriptor = output.into_raw_fd();
    let closed = if unsafe { libc::close(descriptor) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    };
    let result = match (result, closed) {
        (Err(failure), closed) => Err(failure.with_cleanup("close", closed)),
        (Ok(()), Err(error)) => Err(Failure::commit("commit_sync", error)),
        (Ok(()), Ok(())) => Ok(()),
    };
    result.map_err(|failure| {
        // SAFETY: temporary is our exclusive-created entry in the held directory.
        let cleanup = if unsafe { libc::unlinkat(directory_fd, temporary.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
        let cleanup = match cleanup {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        };
        failure.with_cleanup("temporary_remove", cleanup)
    })
}

fn component(name: &OsStr) -> Result<CString, Failure> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || matches!(bytes, b"." | b"..") || bytes.contains(&b'/') {
        return Err(Failure::io("path", io::ErrorKind::InvalidInput.into()));
    }
    CString::new(bytes).map_err(|_| Failure::io("path", io::ErrorKind::InvalidInput.into()))
}

fn target_stat(directory: libc::c_int, name: &CString) -> Result<Option<libc::stat>, Failure> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstatat initializes stat on success; the name and descriptor are live.
    if unsafe {
        libc::fstatat(
            directory,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0
    {
        // SAFETY: the successful fstatat initialized every field.
        Ok(Some(unsafe { stat.assume_init() }))
    } else {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(Failure::io("target_stat", error))
        }
    }
}
