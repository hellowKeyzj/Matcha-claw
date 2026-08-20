use std::{
    ffi::OsStr,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    ptr::null_mut,
};

#[cfg(test)]
use std::{
    mem::offset_of,
    sync::atomic::{AtomicU64, Ordering},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
};

use super::super::super::StateDirError;
use crate::lifecycle::state_dir::windows::security;

const AUTH_PROFILES: &str = "auth-profiles.json";
#[cfg(test)]
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn read(directory: &OwnedHandle) -> Result<Option<Vec<u8>>, StateDirError> {
    let Some(file) = open_existing(directory, AUTH_PROFILES)? else {
        return Ok(None);
    };
    verify(&file)?;
    let mut length = 0_i64;
    if unsafe { FS::GetFileSizeEx(file.as_raw_handle() as F::HANDLE, &mut length) } == 0
        || length < 0
        || length as usize > super::super::MAX_AUTH_PROFILES_BYTES
    {
        return Err(StateDirError);
    }
    let mut contents = Vec::new();
    contents
        .try_reserve_exact(length as usize)
        .map_err(|_| StateDirError)?;
    let mut buffer = [0_u8; 4096];
    loop {
        let mut read = 0_u32;
        if unsafe {
            FS::ReadFile(
                file.as_raw_handle() as F::HANDLE,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(StateDirError);
        }
        if read == 0 {
            break;
        }
        let read = read as usize;
        if contents
            .len()
            .checked_add(read)
            .is_none_or(|length| length > super::super::MAX_AUTH_PROFILES_BYTES)
        {
            return Err(StateDirError);
        }
        contents.extend_from_slice(&buffer[..read]);
    }
    Ok(Some(contents))
}

#[cfg(test)]
pub(super) fn replace(directory: &OwnedHandle, contents: &[u8]) -> Result<(), StateDirError> {
    let mut temporary = create_temporary(directory)?;
    if write_all(&temporary, contents).is_err()
        || unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0
        || rename_into_place(directory, &temporary).is_err()
    {
        let _ = remove(&mut temporary);
        return Err(StateDirError);
    }
    if unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0 {
        return Err(StateDirError);
    }
    Ok(())
}

fn open_existing(
    directory: &OwnedHandle,
    name: &str,
) -> Result<Option<OwnedHandle>, StateDirError> {
    let name = relative_name(name)?;
    let mut object_name = unicode_string(&name);
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory.as_raw_handle() as F::HANDLE,
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: null_mut(),
        SecurityQualityOfService: null_mut(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut handle = null_mut();
    let result = unsafe {
        NFS::NtCreateFile(
            &mut handle,
            FS::FILE_GENERIC_READ | FS::WRITE_DAC | FS::SYNCHRONIZE,
            &attributes,
            &mut status,
            null_mut(),
            0,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_OPEN,
            NFS::FILE_NON_DIRECTORY_FILE
                | NFS::FILE_OPEN_REPARSE_POINT
                | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null_mut(),
            0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_NOT_FOUND {
        return Ok(None);
    }
    if result < 0 {
        return Err(StateDirError);
    }
    // SAFETY: NtCreateFile returned a newly owned handle.
    Ok(Some(unsafe {
        OwnedHandle::from_raw_handle(handle as RawHandle)
    }))
}

#[cfg(test)]
fn create_temporary(directory: &OwnedHandle) -> Result<OwnedHandle, StateDirError> {
    let security = security::SecurityDescriptor::owner_only()?;
    for _ in 0..128 {
        let name = temporary_name()?;
        let mut object_name = unicode_string(&name);
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: directory.as_raw_handle() as F::HANDLE,
            ObjectName: &mut object_name,
            Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
            SecurityDescriptor: security.attributes().lpSecurityDescriptor.cast(),
            SecurityQualityOfService: null_mut(),
        };
        let mut status = IO_STATUS_BLOCK::default();
        let mut handle = null_mut();
        let result = unsafe {
            NFS::NtCreateFile(
                &mut handle,
                F::GENERIC_WRITE
                    | FS::FILE_READ_ATTRIBUTES
                    | FS::READ_CONTROL
                    | FS::DELETE
                    | FS::SYNCHRONIZE,
                &attributes,
                &mut status,
                null_mut(),
                FS::FILE_ATTRIBUTE_NORMAL,
                FS::FILE_SHARE_READ,
                NFS::FILE_CREATE,
                NFS::FILE_NON_DIRECTORY_FILE
                    | NFS::FILE_OPEN_REPARSE_POINT
                    | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
                null_mut(),
                0,
            )
        };
        if result == F::STATUS_OBJECT_NAME_COLLISION {
            continue;
        }
        if result < 0 {
            return Err(StateDirError);
        }
        // SAFETY: NtCreateFile returned a newly owned handle.
        return Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
    }
    Err(StateDirError)
}

#[cfg(test)]
fn write_all(file: &OwnedHandle, contents: &[u8]) -> Result<(), ()> {
    let mut remaining = contents;
    while !remaining.is_empty() {
        let mut written = 0_u32;
        if unsafe {
            FS::WriteFile(
                file.as_raw_handle() as F::HANDLE,
                remaining.as_ptr(),
                remaining.len().try_into().unwrap_or(u32::MAX),
                &mut written,
                null_mut(),
            )
        } == 0
            || written == 0
        {
            return Err(());
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

#[cfg(test)]
fn rename_into_place(directory: &OwnedHandle, file: &OwnedHandle) -> Result<(), ()> {
    let target = relative_name(AUTH_PROFILES).map_err(|_| ())?;
    let header_length = offset_of!(NFS::FILE_RENAME_INFORMATION, FileName);
    let total_length = header_length
        .checked_add(size_of_val(target.as_slice()))
        .ok_or(())?;
    let mut information = vec![0_u64; total_length.div_ceil(size_of::<u64>())];
    let bytes = information.as_mut_ptr().cast::<u8>();
    // SAFETY: the u64 allocation supplies adequate alignment for FILE_RENAME_INFORMATION, and
    // the trailing flexible array receives exactly target.len() UTF-16 code units.
    unsafe {
        let header = bytes.cast::<NFS::FILE_RENAME_INFORMATION>();
        (*header).Anonymous.ReplaceIfExists = true;
        (*header).RootDirectory = directory.as_raw_handle() as F::HANDLE;
        (*header).FileNameLength = size_of_val(target.as_slice()) as u32;
        bytes
            .add(header_length)
            .cast::<u16>()
            .copy_from_nonoverlapping(target.as_ptr(), target.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    if unsafe {
        NFS::NtSetInformationFile(
            file.as_raw_handle() as F::HANDLE,
            &mut status,
            bytes.cast(),
            total_length as u32,
            NFS::FileRenameInformation,
        )
    } < 0
    {
        Err(())
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn remove(file: &mut OwnedHandle) -> Result<(), StateDirError> {
    let disposition = FS::FILE_DISPOSITION_INFO_EX {
        Flags: FS::FILE_DISPOSITION_FLAG_DELETE
            | FS::FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FS::FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        FS::SetFileInformationByHandle(
            file.as_raw_handle() as F::HANDLE,
            FS::FileDispositionInfoEx,
            (&disposition as *const FS::FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FS::FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        Err(StateDirError)
    } else {
        Ok(())
    }
}

fn verify(file: &OwnedHandle) -> Result<(), StateDirError> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            file.as_raw_handle() as F::HANDLE,
            FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(StateDirError);
    }
    security::ensure_owner_only(file.as_raw_handle() as F::HANDLE)?;
    security::verify_owner_only(file.as_raw_handle() as F::HANDLE)
}

#[cfg(test)]
fn temporary_name() -> Result<Vec<u16>, StateDirError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    relative_name(&format!(
        ".auth-profiles.{:x}.{sequence:x}.tmp",
        std::process::id()
    ))
}

fn relative_name(value: &str) -> Result<Vec<u16>, StateDirError> {
    if value.is_empty() || value.contains(['\\', '/']) || value == "." || value == ".." {
        return Err(StateDirError);
    }
    let encoded: Vec<u16> = OsStr::new(value).encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2))
        .then_some(encoded)
        .ok_or(StateDirError)
}

fn unicode_string(value: &[u16]) -> F::UNICODE_STRING {
    F::UNICODE_STRING {
        Length: size_of_val(value) as u16,
        MaximumLength: size_of_val(value) as u16,
        Buffer: value.as_ptr().cast_mut(),
    }
}
