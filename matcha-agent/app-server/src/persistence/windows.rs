use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::{
        DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
        SetSecurityDescriptorControl,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        READ_CONTROL,
    },
};

use super::Failure;

pub(super) fn write_path(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    if path.file_name().is_none() {
        return Err(Failure::io("path", io::ErrorKind::InvalidInput.into()));
    }
    let target_name = wide_path(path)?;
    let existing = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            check_regular(&metadata)?;
            let target = OpenOptions::new()
                .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(|error| Failure::io("target_open", error))?;
            check_regular(
                &target
                    .metadata()
                    .map_err(|error| Failure::io("target_stat", error))?,
            )?;
            Some(target)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(Failure::io("target_stat", error)),
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".matcha-write-{}.tmp", uuid::Uuid::new_v4()));
    let temporary_name = wide_path(&temporary)?;
    let output = create_temporary(&temporary_name, existing.as_ref())?;
    let replace_existing = existing.is_some();
    // MoveFileExW can reject an open destination even with FILE_SHARE_DELETE.
    // The original DACL is already applied to output; release the inspection
    // handle before committing, and report its close failure before any write.
    let target_closed = existing.map_or(Ok(()), close_file);
    let mut output = output;
    let prepared = (|| {
        target_closed.map_err(|error| Failure::io("target_close", error))?;
        output
            .write_all(bytes)
            .map_err(|error| Failure::io("write", error))?;
        output
            .flush()
            .map_err(|error| Failure::io("flush", error))?;
        output
            .sync_all()
            .map_err(|error| Failure::io("sync", error))
    })();
    // Close the writer before publishing; keep a failed close distinct from a
    // committed, durable file.
    let closed = close_file(output);
    let result = match (prepared, closed) {
        (Err(mut failure), Err(error)) => {
            failure.cleanup.push(super::CleanupFailure {
                stage: "close",
                source: error,
            });
            Err(failure)
        }
        (Err(failure), Ok(())) => Err(failure),
        (Ok(()), Err(error)) => Err(Failure::io("close", error)),
        (Ok(()), Ok(())) => {
            // The temporary already carries the observed target's DACL. Rename
            // the directory entry itself rather than following a racing symlink.
            // New files must not overwrite an entry created after observation.
            let flags = MOVEFILE_WRITE_THROUGH
                | if replace_existing {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            // SAFETY: both paths are live NUL-terminated UTF-16 buffers. The same
            // parent excludes cross-volume copy; COPY_ALLOWED is deliberately absent.
            if unsafe { MoveFileExW(temporary_name.as_ptr(), target_name.as_ptr(), flags) } == 0 {
                Err(Failure::commit("commit", io::Error::last_os_error()))
            } else {
                Ok(())
            }
        }
    };
    result.map_err(|failure| {
        let cleanup = match fs::remove_file(&temporary) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        };
        failure.with_cleanup("temporary_remove", cleanup)
    })
}

fn check_regular(metadata: &fs::Metadata) -> Result<(), Failure> {
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Err(Failure::io(
            "target_symlink",
            io::ErrorKind::InvalidInput.into(),
        ))
    } else if !metadata.is_file() {
        Err(Failure::io(
            "target_type",
            io::ErrorKind::InvalidInput.into(),
        ))
    } else {
        Ok(())
    }
}

fn wide_path(path: &Path) -> Result<Vec<u16>, Failure> {
    let mut name: Vec<_> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err(Failure::io("path", io::ErrorKind::InvalidInput.into()));
    }
    name.push(0);
    Ok(name)
}

fn create_temporary(name: &[u16], existing: Option<&File>) -> Result<File, Failure> {
    let mut descriptor = existing
        .map(target_dacl)
        .transpose()
        .map_err(|error| Failure::io("permissions", error))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor
            .as_mut()
            .map_or(null_mut(), |descriptor| descriptor.as_mut_ptr().cast()),
        bInheritHandle: 0,
    };
    // Supply the existing DACL at creation, not after it: even an empty file
    // temporarily created with a weaker DACL could have been opened by a reader.
    // SAFETY: the security descriptor, attributes and UTF-16 name remain live.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            if descriptor.is_some() {
                &attributes
            } else {
                null()
            },
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(Failure::io("temporary_create", io::Error::last_os_error()))
    } else {
        // SAFETY: CreateFileW returned an owned, non-inheritable file handle.
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}

fn target_dacl(source: &File) -> io::Result<Vec<usize>> {
    let mut length = 0;
    // SAFETY: querying length writes only to the supplied length pointer.
    let queried = unsafe {
        GetKernelObjectSecurity(
            source.as_raw_handle() as HANDLE,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            0,
            &mut length,
        )
    };
    if queried == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(io::Error::last_os_error());
    }
    // Security descriptors contain pointers; use a suitably aligned allocation.
    let mut descriptor = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the allocation covers length bytes, and the source handle remains live.
    if unsafe {
        GetKernelObjectSecurity(
            source.as_raw_handle() as HANDLE,
            DACL_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
        || unsafe {
            SetSecurityDescriptorControl(
                descriptor.as_mut_ptr().cast(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

fn close_file(file: File) -> io::Result<()> {
    let handle = file.into_raw_handle();
    // SAFETY: into_raw_handle transferred this live handle's ownership to us.
    if unsafe { CloseHandle(handle as HANDLE) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
