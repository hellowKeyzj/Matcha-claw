use std::{
    ffi::OsStr,
    mem::{offset_of, size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{
        Foundation as F,
        Security::{self as S, Authorization as A},
        Storage::FileSystem as FS,
        System::IO::IO_STATUS_BLOCK,
    },
};

use crate::lifecycle::state_dir::StateDirHandle;

use super::PersistError;

const FILE_SDDL: &str = "D:P(A;;FA;;;OW)";
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn replace(state_dir: &StateDirHandle, contents: &[u8]) -> Result<(), PersistError> {
    let mut temporary = create_temporary_file(state_dir)?;
    if let Err(error) = write_all(&temporary, contents) {
        return cleanup_after_failure(&mut temporary, error);
    }
    if unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0 {
        return cleanup_after_failure(&mut temporary, PersistError::TemporarySyncFailed);
    }
    if let Err(error) = rename_into_place(&temporary, state_dir) {
        return cleanup_after_failure(&mut temporary, error);
    }
    if unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0 {
        return Err(PersistError::CommittedButNotDurable);
    }
    Ok(())
}

fn create_temporary_file(state_dir: &StateDirHandle) -> Result<OwnedHandle, PersistError> {
    let security = SecurityDescriptor::new(FILE_SDDL)?;
    for _ in 0..128 {
        let name = temporary_name()?;
        let raw = create_file(state_dir, &name, &security)?;
        if !raw.is_null() {
            // SAFETY: NtCreateFile returned a new owned file handle.
            return Ok(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) });
        }
    }
    Err(PersistError::TemporaryCreateFailed)
}

fn temporary_name() -> Result<Vec<u16>, PersistError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    relative_name(&format!(
        ".openclaw.json.{:x}.{sequence:x}.tmp",
        std::process::id()
    ))
}

fn create_file(
    state_dir: &StateDirHandle,
    name: &[u16],
    security: &SecurityDescriptor,
) -> Result<F::HANDLE, PersistError> {
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name) as u16,
        MaximumLength: size_of_val(name) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: state_dir.raw_handle(),
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: security.0.cast(),
        SecurityQualityOfService: null(),
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
            null(),
            FS::FILE_ATTRIBUTE_NORMAL,
            FS::FILE_SHARE_READ,
            NFS::FILE_CREATE,
            NFS::FILE_NON_DIRECTORY_FILE
                | NFS::FILE_OPEN_REPARSE_POINT
                | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_COLLISION {
        return Ok(null_mut());
    }
    if result < 0 {
        return Err(PersistError::TemporaryCreateFailed);
    }
    Ok(handle)
}

fn write_all(file: &OwnedHandle, contents: &[u8]) -> Result<(), PersistError> {
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
            return Err(PersistError::TemporaryWriteFailed);
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

fn rename_into_place(file: &OwnedHandle, state_dir: &StateDirHandle) -> Result<(), PersistError> {
    let target = relative_name("openclaw.json")?;
    let header_length = offset_of!(NFS::FILE_RENAME_INFORMATION, FileName);
    let total_length = header_length
        .checked_add(size_of_val(target.as_slice()))
        .ok_or(PersistError::ReplaceFailed)?;
    let mut information = vec![0_u64; total_length.div_ceil(size_of::<u64>())];
    let bytes = information.as_mut_ptr().cast::<u8>();
    // SAFETY: the u64 allocation supplies adequate alignment for FILE_RENAME_INFORMATION, and
    // the trailing flexible array receives exactly target.len() UTF-16 code units.
    unsafe {
        let header = bytes.cast::<NFS::FILE_RENAME_INFORMATION>();
        (*header).Anonymous.ReplaceIfExists = true;
        (*header).RootDirectory = state_dir.raw_handle();
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
        return Err(PersistError::ReplaceFailed);
    }
    Ok(())
}

fn cleanup_after_failure(file: &mut OwnedHandle, error: PersistError) -> Result<(), PersistError> {
    match remove_file(file.as_raw_handle() as F::HANDLE) {
        Ok(()) => Err(error),
        Err(()) => Err(PersistError::CleanupFailed),
    }
}

fn remove_file(handle: F::HANDLE) -> Result<(), ()> {
    let disposition = FS::FILE_DISPOSITION_INFO_EX {
        Flags: FS::FILE_DISPOSITION_FLAG_DELETE
            | FS::FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FS::FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        FS::SetFileInformationByHandle(
            handle,
            FS::FileDispositionInfoEx,
            (&disposition as *const FS::FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FS::FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } != 0
    {
        Ok(())
    } else {
        Err(())
    }
}

fn relative_name(name: &str) -> Result<Vec<u16>, PersistError> {
    if name.is_empty() || name.contains(['\\', '/']) || name == "." || name == ".." {
        return Err(PersistError::TemporaryCreateFailed);
    }
    let encoded: Vec<u16> = OsStr::new(name).encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2))
        .then_some(encoded)
        .ok_or(PersistError::TemporaryCreateFailed)
}

struct SecurityDescriptor(S::PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn new(sddl: &str) -> Result<Self, PersistError> {
        let encoded: Vec<u16> = OsStr::new(sddl).encode_wide().chain([0]).collect();
        let mut descriptor = null_mut();
        if unsafe {
            A::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                encoded.as_ptr(),
                A::SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        Ok(Self(descriptor))
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { F::LocalFree(self.0) };
    }
}
