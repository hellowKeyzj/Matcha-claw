use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
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

use platform::state_dir::StateDirHandle;

use super::PersistError;

const FILE_SDDL: &str = "D:P(A;;FA;;;OW)";

pub(crate) struct WriterLock(Option<OwnedHandle>);

impl WriterLock {
    pub(crate) fn acquire(
        state_dir: &StateDirHandle,
        payload: &[u8],
    ) -> Result<Self, PersistError> {
        reject_reclaim(state_dir)?;
        let security = SecurityDescriptor::new(FILE_SDDL)?;
        let name = relative_name("openclaw.json.lock")?;
        let mut raw = create_file(state_dir, &name, &security)?;
        let mut reclaim = None;
        if raw.is_null() {
            let snapshot = LockSnapshot::read(state_dir, false)?;
            if !super::writer::owner_is_dead(&snapshot.bytes) {
                return Err(PersistError::TemporaryCreateFailed);
            }
            let guard = ReclaimGuard::acquire(state_dir, &security)?;
            // Deny writes/replacement while the dead sidecar is held for handle-based deletion.
            let current = LockSnapshot::read(state_dir, true)?;
            snapshot.verify(&current)?;
            if !super::writer::owner_is_dead(&current.bytes) {
                return Err(PersistError::TemporaryCreateFailed);
            }
            current.verify(&LockSnapshot::read(state_dir, false)?)?;
            remove_file(current.file.as_raw_handle() as F::HANDLE)
                .map_err(|()| PersistError::TemporaryCreateFailed)?;
            drop(current);
            raw = create_file(state_dir, &name, &security)?;
            if raw.is_null() {
                return Err(PersistError::TemporaryCreateFailed);
            }
            reclaim = Some(guard);
        }
        // SAFETY: NtCreateFile returned a new owned handle; FILE_SHARE_READ prevents replacement.
        let mut writer = Self(Some(unsafe {
            OwnedHandle::from_raw_handle(raw as RawHandle)
        }));
        let result = write_all(writer.0.as_ref().expect("writer handle"), payload).and_then(|()| {
            if let Some(guard) = &mut reclaim {
                // Keep the native guard until our fresh exclusive sidecar has its payload.
                guard.release()
            } else {
                reject_reclaim(state_dir)
            }
        });
        if let Err(error) = result {
            if writer.release().is_err() {
                super::writer::report_cleanup_failure();
            }
            return Err(error);
        }
        Ok(writer)
    }

    pub(crate) fn release(&mut self) -> Result<(), PersistError> {
        if let Some(file) = &self.0 {
            remove_file(file.as_raw_handle() as F::HANDLE)
                .map_err(|()| PersistError::CleanupFailed)?;
            self.0.take();
        }
        Ok(())
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

struct LockSnapshot {
    file: File,
    bytes: Vec<u8>,
    identity: (u64, [u8; 16]),
}

impl LockSnapshot {
    fn read(state_dir: &StateDirHandle, for_removal: bool) -> Result<Self, PersistError> {
        let name = relative_name("openclaw.json.lock")?;
        let mut object_name = F::UNICODE_STRING {
            Length: size_of_val(name.as_slice()) as u16,
            MaximumLength: size_of_val(name.as_slice()) as u16,
            Buffer: name.as_ptr().cast_mut(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: state_dir.raw_handle(),
            ObjectName: &mut object_name,
            Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut status = IO_STATUS_BLOCK::default();
        let mut raw = null_mut();
        let access = F::GENERIC_READ | FS::SYNCHRONIZE | if for_removal { FS::DELETE } else { 0 };
        let sharing = if for_removal {
            FS::FILE_SHARE_READ
        } else {
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE
        };
        if unsafe {
            NFS::NtCreateFile(
                &mut raw,
                access,
                &attributes,
                &mut status,
                null(),
                0,
                sharing,
                NFS::FILE_OPEN,
                NFS::FILE_NON_DIRECTORY_FILE
                    | NFS::FILE_OPEN_REPARSE_POINT
                    | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
                null(),
                0,
            )
        } < 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        // SAFETY: NtCreateFile returned a new owned no-follow file handle.
        let mut file = unsafe { File::from_raw_handle(raw as RawHandle) };
        let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe {
            FS::GetFileInformationByHandleEx(
                raw,
                FS::FileAttributeTagInfo,
                (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
            || attributes.FileAttributes
                & (FS::FILE_ATTRIBUTE_REPARSE_POINT | FS::FILE_ATTRIBUTE_DIRECTORY)
                != 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        let mut identity = FS::FILE_ID_INFO::default();
        if unsafe {
            FS::GetFileInformationByHandleEx(
                raw,
                FS::FileIdInfo,
                (&mut identity as *mut FS::FILE_ID_INFO).cast(),
                size_of::<FS::FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(super::writer::MAX_LOCK_PAYLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| PersistError::TemporaryCreateFailed)?;
        if bytes.len() as u64 > super::writer::MAX_LOCK_PAYLOAD_BYTES {
            return Err(PersistError::TemporaryCreateFailed);
        }
        Ok(Self {
            file,
            bytes,
            identity: (identity.VolumeSerialNumber, identity.FileId.Identifier),
        })
    }

    fn verify(&self, current: &Self) -> Result<(), PersistError> {
        if self.identity != current.identity || self.bytes != current.bytes {
            return Err(PersistError::TemporaryCreateFailed);
        }
        Ok(())
    }
}

struct ReclaimGuard(Option<OwnedHandle>);

impl ReclaimGuard {
    fn acquire(
        state_dir: &StateDirHandle,
        security: &SecurityDescriptor,
    ) -> Result<Self, PersistError> {
        let name = relative_name("openclaw.json.lock.reclaim")?;
        let raw = create_entry(state_dir, &name, security, true)?;
        if raw.is_null() {
            return Err(PersistError::TemporaryCreateFailed);
        }
        // SAFETY: FILE_CREATE created this directory; its held handle denies replacement.
        Ok(Self(Some(unsafe {
            OwnedHandle::from_raw_handle(raw as RawHandle)
        })))
    }

    fn release(&mut self) -> Result<(), PersistError> {
        if let Some(directory) = &self.0 {
            remove_file(directory.as_raw_handle() as F::HANDLE)
                .map_err(|()| PersistError::CleanupFailed)?;
            self.0.take();
        }
        Ok(())
    }
}

impl Drop for ReclaimGuard {
    fn drop(&mut self) {
        if self.release().is_err() {
            super::writer::report_cleanup_failure();
        }
    }
}

fn reject_reclaim(state_dir: &StateDirHandle) -> Result<(), PersistError> {
    match state_dir.read_regular_file_bounded("openclaw.json.lock.reclaim", 1) {
        Ok(None) => Ok(()),
        _ => Err(PersistError::TemporaryCreateFailed),
    }
}
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
    create_entry(state_dir, name, security, false)
}

fn create_entry(
    state_dir: &StateDirHandle,
    name: &[u16],
    security: &SecurityDescriptor,
    directory: bool,
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
            if directory {
                FS::FILE_ATTRIBUTE_DIRECTORY
            } else {
                FS::FILE_ATTRIBUTE_NORMAL
            },
            FS::FILE_SHARE_READ,
            NFS::FILE_CREATE,
            (if directory {
                NFS::FILE_DIRECTORY_FILE
            } else {
                NFS::FILE_NON_DIRECTORY_FILE
            }) | NFS::FILE_OPEN_REPARSE_POINT
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
