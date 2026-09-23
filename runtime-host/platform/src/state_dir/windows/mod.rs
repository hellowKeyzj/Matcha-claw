pub(crate) mod security;

use std::{
    ffi::{OsStr, OsString},
    io,
    mem::{offset_of, size_of, size_of_val},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Component, Path, PathBuf},
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
};

use self::security::{SecurityDescriptor, ensure_owner_only, verify_owner_only};
use super::StateDirError;

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub struct StateDirHandle {
    _handle: OwnedHandle,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) struct StateDirIdentity {
    volume: u64,
    file: [u8; 16],
}

impl std::fmt::Debug for StateDirHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StateDirHandle")
    }
}

impl StateDirHandle {
    pub fn raw_handle(&self) -> F::HANDLE {
        self._handle.as_raw_handle() as F::HANDLE
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
        let target = relative_name(name)?;
        let mut temporary = create_temporary_file(self)?;
        if write_all(&temporary, contents).is_err()
            || unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0
            || rename_into_place(&temporary, self, &target).is_err()
        {
            remove_file(&mut temporary)?;
            return Err(StateDirError);
        }
        if unsafe { FS::FlushFileBuffers(temporary.as_raw_handle() as F::HANDLE) } == 0 {
            return Err(StateDirError);
        }
        Ok(())
    }

    pub fn read_regular_file_bounded(
        &self,
        name: &str,
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        let name = relative_name(name)?;
        let Some(file) = open_file_relative(self.raw_handle(), &name)? else {
            return Ok(None);
        };
        Ok(Some(read_regular_handle(file, byte_limit)?))
    }

    pub fn read_nested_regular_file_bounded(
        &self,
        components: &[String],
        byte_limit: usize,
    ) -> Result<Option<Vec<u8>>, StateDirError> {
        let (leaf, parents) = components.split_last().ok_or(StateDirError)?;
        let mut parent = self.raw_handle();
        let mut custody = Vec::with_capacity(parents.len());
        for component in parents {
            let component = nested_component(component)?;
            let Some(directory) = open_directory_relative(parent, &component)? else {
                return Ok(None);
            };
            parent = directory.as_raw_handle() as F::HANDLE;
            custody.push(directory);
        }
        let leaf = nested_component(leaf)?;
        let Some(file) = open_file_relative(parent, &leaf)? else {
            return Ok(None);
        };
        Ok(Some(read_regular_handle(file, byte_limit)?))
    }
}

fn open_directory_relative(
    parent: F::HANDLE,
    name: &[u16],
) -> Result<Option<OwnedHandle>, StateDirError> {
    let Some(handle) = open_relative(
        parent,
        name,
        FS::FILE_LIST_DIRECTORY | FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
        NFS::FILE_DIRECTORY_FILE | NFS::FILE_OPEN_REPARSE_POINT | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
    )?
    else {
        return Ok(None);
    };
    verify_attributes(handle.as_raw_handle() as F::HANDLE)?;
    Ok(Some(handle))
}

fn open_file_relative(
    parent: F::HANDLE,
    name: &[u16],
) -> Result<Option<OwnedHandle>, StateDirError> {
    let Some(handle) = open_relative(
        parent,
        name,
        FS::FILE_GENERIC_READ | FS::SYNCHRONIZE,
        NFS::FILE_NON_DIRECTORY_FILE
            | NFS::FILE_OPEN_REPARSE_POINT
            | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
    )?
    else {
        return Ok(None);
    };
    verify_regular_file(handle.as_raw_handle() as F::HANDLE)?;
    Ok(Some(handle))
}

fn open_relative(
    parent: F::HANDLE,
    name: &[u16],
    access: u32,
    options: u32,
) -> Result<Option<OwnedHandle>, StateDirError> {
    let mut object_name = unicode_string(name);
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut raw = null_mut();
    let result = unsafe {
        NFS::NtCreateFile(
            &mut raw,
            access,
            &attributes,
            &mut status,
            null(),
            0,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_OPEN,
            options,
            null(),
            0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_NOT_FOUND || result == F::STATUS_OBJECT_PATH_NOT_FOUND {
        return Ok(None);
    }
    if result < 0 {
        return Err(StateDirError);
    }
    // SAFETY: NtCreateFile returned a new owned handle.
    Ok(Some(unsafe {
        OwnedHandle::from_raw_handle(raw as RawHandle)
    }))
}

fn read_regular_handle(file: OwnedHandle, byte_limit: usize) -> Result<Vec<u8>, StateDirError> {
    verify_regular_file(file.as_raw_handle() as F::HANDLE)?;
    let mut length = 0_i64;
    if unsafe { FS::GetFileSizeEx(file.as_raw_handle() as F::HANDLE, &mut length) } == 0
        || length < 0
        || length as u64 > byte_limit as u64
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
            .is_none_or(|length| length > byte_limit)
        {
            return Err(StateDirError);
        }
        contents.extend_from_slice(&buffer[..read]);
    }
    Ok(contents)
}

fn nested_component(name: &str) -> Result<Vec<u16>, StateDirError> {
    relative_name(name)
}

fn unicode_string(value: &[u16]) -> F::UNICODE_STRING {
    F::UNICODE_STRING {
        Length: size_of_val(value) as u16,
        MaximumLength: size_of_val(value) as u16,
        Buffer: value.as_ptr().cast_mut(),
    }
}

fn create_temporary_file(state_dir: &StateDirHandle) -> Result<OwnedHandle, StateDirError> {
    let security = security::SecurityDescriptor::owner_only()?;
    for _ in 0..128 {
        let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
        let name = relative_name(&format!(
            ".state-file.{:x}.{sequence:x}.tmp",
            std::process::id()
        ))?;
        let mut object_name = unicode_string(&name);
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: state_dir.raw_handle(),
            ObjectName: &mut object_name,
            Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
            SecurityDescriptor: security.attributes().lpSecurityDescriptor.cast(),
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

fn write_all(file: &OwnedHandle, contents: &[u8]) -> Result<(), StateDirError> {
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
            return Err(StateDirError);
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

fn rename_into_place(
    file: &OwnedHandle,
    state_dir: &StateDirHandle,
    target: &[u16],
) -> Result<(), StateDirError> {
    let header_length = offset_of!(NFS::FILE_RENAME_INFORMATION, FileName);
    let total_length = header_length
        .checked_add(size_of_val(target))
        .ok_or(StateDirError)?;
    let mut information = vec![0_u64; total_length.div_ceil(size_of::<u64>())];
    let bytes = information.as_mut_ptr().cast::<u8>();
    // SAFETY: the u64 allocation supplies adequate alignment for FILE_RENAME_INFORMATION, and
    // the trailing flexible array receives exactly target.len() UTF-16 code units.
    unsafe {
        let header = bytes.cast::<NFS::FILE_RENAME_INFORMATION>();
        (*header).Anonymous.ReplaceIfExists = true;
        (*header).RootDirectory = state_dir.raw_handle();
        (*header).FileNameLength = size_of_val(target) as u32;
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
        Err(StateDirError)
    } else {
        Ok(())
    }
}

fn remove_file(file: &mut OwnedHandle) -> Result<(), StateDirError> {
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

pub(super) fn provision(path: &Path) -> Result<(PathBuf, StateDirIdentity), StateDirError> {
    validate_components(path)?;
    let parent = path.parent().ok_or(StateDirError)?;
    open_ancestor_components(parent)?;

    let descriptor = SecurityDescriptor::owner_only()?;
    let attributes = descriptor.attributes();
    let path_name = wide(path.as_os_str())?;
    let created = if unsafe { FS::CreateDirectoryW(path_name.as_ptr(), &attributes) } != 0 {
        true
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(F::ERROR_ALREADY_EXISTS as i32) {
            return Err(StateDirError);
        }
        false
    };

    let directory = open_directory(path)?;
    if created {
        verify_owner_only(directory.as_raw_handle() as F::HANDLE)?;
    } else {
        ensure_owner_only(directory.as_raw_handle() as F::HANDLE)?;
        verify_owner_only(directory.as_raw_handle() as F::HANDLE)?;
    }
    let identity = identity(directory.as_raw_handle() as F::HANDLE)?;
    let path = canonical_path(directory.as_raw_handle() as F::HANDLE)?;
    Ok((path, identity))
}

pub(super) fn open(
    path: &Path,
    expected: &StateDirIdentity,
) -> Result<StateDirHandle, StateDirError> {
    validate_components(path)?;
    open_ancestor_components(path.parent().ok_or(StateDirError)?)?;
    let directory = open_directory(path)?;
    if &identity(directory.as_raw_handle() as F::HANDLE)? != expected {
        return Err(StateDirError);
    }
    Ok(StateDirHandle { _handle: directory })
}

fn relative_name(name: &str) -> Result<Vec<u16>, StateDirError> {
    if name.is_empty() || name.contains(['\\', '/']) || name == "." || name == ".." {
        return Err(StateDirError);
    }
    let encoded: Vec<u16> = OsStr::new(name).encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2))
        .then_some(encoded)
        .ok_or(StateDirError)
}

fn verify_regular_file(handle: F::HANDLE) -> Result<(), StateDirError> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle,
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
    Ok(())
}

fn validate_components(path: &Path) -> Result<(), StateDirError> {
    if !path.is_absolute() {
        return Err(StateDirError);
    }
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {}
            _ => return Err(StateDirError),
        }
    }
    path.file_name()
        .is_some()
        .then_some(())
        .ok_or(StateDirError)
}

fn open_ancestor_components(path: &Path) -> Result<(), StateDirError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Normal(_)) {
            open_directory_no_reparse(&current)?;
        }
    }
    Ok(())
}

fn open_directory_no_reparse(path: &Path) -> Result<(), StateDirError> {
    let handle = open_handle(path, 0)?;
    verify_attributes(handle.as_raw_handle() as F::HANDLE)
}

fn open_directory(path: &Path) -> Result<OwnedHandle, StateDirError> {
    let handle = open_handle(path, FS::FILE_ADD_FILE | FS::WRITE_DAC)?;
    verify_attributes(handle.as_raw_handle() as F::HANDLE)?;
    Ok(handle)
}

fn open_handle(path: &Path, additional_access: u32) -> Result<OwnedHandle, StateDirError> {
    let name = wide(path.as_os_str())?;
    let raw = unsafe {
        FS::CreateFileW(
            name.as_ptr(),
            FS::FILE_READ_ATTRIBUTES | FS::READ_CONTROL | additional_access,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
            null(),
            FS::OPEN_EXISTING,
            FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == F::INVALID_HANDLE_VALUE {
        return Err(StateDirError);
    }
    // SAFETY: CreateFileW returned a new owned directory handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) })
}

fn verify_attributes(handle: F::HANDLE) -> Result<(), StateDirError> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle,
            FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(StateDirError);
    }
    Ok(())
}

fn identity(handle: F::HANDLE) -> Result<StateDirIdentity, StateDirError> {
    let mut identity = FS::FILE_ID_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle,
            FS::FileIdInfo,
            (&mut identity as *mut FS::FILE_ID_INFO).cast(),
            size_of::<FS::FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(StateDirError);
    }
    Ok(StateDirIdentity {
        volume: identity.VolumeSerialNumber,
        file: identity.FileId.Identifier,
    })
}

fn canonical_path(handle: F::HANDLE) -> Result<PathBuf, StateDirError> {
    let required = unsafe {
        FS::GetFinalPathNameByHandleW(
            handle,
            null_mut(),
            0,
            FS::FILE_NAME_NORMALIZED | FS::VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return Err(StateDirError);
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let length = unsafe {
        FS::GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FS::FILE_NAME_NORMALIZED | FS::VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(StateDirError);
    }
    buffer.truncate(length as usize);
    let path = PathBuf::from(OsString::from_wide(&external_path(buffer)?));
    path.is_absolute().then_some(path).ok_or(StateDirError)
}

fn external_path(path: Vec<u16>) -> Result<Vec<u16>, StateDirError> {
    const EXTENDED_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const EXTENDED_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    if let Some(path) = path.strip_prefix(EXTENDED_UNC_PREFIX) {
        let mut external = vec![b'\\' as u16, b'\\' as u16];
        external.extend_from_slice(path);
        return Ok(external);
    }
    let Some(path) = path.strip_prefix(EXTENDED_PREFIX) else {
        return Ok(path);
    };
    if path.len() >= 3 && path[1] == b':' as u16 && path[2] == b'\\' as u16 {
        return Ok(path.to_vec());
    }
    Err(StateDirError)
}

fn wide(value: &OsStr) -> Result<Vec<u16>, StateDirError> {
    if value.encode_wide().any(|unit| unit == 0) {
        return Err(StateDirError);
    }
    Ok(value.encode_wide().chain([0]).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_path_removes_extended_dos_and_unc_prefixes() {
        assert_eq!(
            external_path(r"\\?\C:\state".encode_utf16().collect()).unwrap(),
            r"C:\state".encode_utf16().collect::<Vec<_>>(),
        );
        assert_eq!(
            external_path(r"\\?\UNC\server\share\state".encode_utf16().collect()).unwrap(),
            r"\\server\share\state".encode_utf16().collect::<Vec<_>>(),
        );
    }

    #[test]
    fn external_path_rejects_unknown_extended_prefixes() {
        assert_eq!(
            external_path(r"\\?\Volume{synthetic}\state".encode_utf16().collect()).unwrap_err(),
            StateDirError,
        );
    }
}
