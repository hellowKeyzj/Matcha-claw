use std::{
    ffi::OsStr,
    fmt,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
};

pub(in crate::surfaces::workspace) struct DirectoryHandle {
    handle: OwnedHandle,
}

impl DirectoryHandle {
    pub(in crate::surfaces::workspace) fn as_raw_handle(&self) -> F::HANDLE {
        self.handle.as_raw_handle() as F::HANDLE
    }
}

impl fmt::Debug for DirectoryHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DirectoryHandle")
    }
}

pub(in crate::surfaces::workspace) struct OpenedDirectory {
    handle: DirectoryHandle,
}

impl OpenedDirectory {
    pub(in crate::surfaces::workspace) fn into_handle(self) -> DirectoryHandle {
        self.handle
    }
}

pub(in crate::surfaces::workspace) fn open(path: &Path) -> Result<OpenedDirectory, DirectoryError> {
    let components = components(path)?;
    let directory = open_chain(path, &components)?;
    Ok(OpenedDirectory {
        handle: DirectoryHandle { handle: directory },
    })
}

fn components(path: &Path) -> Result<Vec<&OsStr>, DirectoryError> {
    if !path.is_absolute() {
        return Err(DirectoryError);
    }
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix)
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(_, _)) => {}
            Component::RootDir => {}
            Component::Normal(name) => names.push(name),
            _ => return Err(DirectoryError),
        }
    }
    (!names.is_empty()).then_some(names).ok_or(DirectoryError)
}

fn open_chain(path: &Path, components: &[&OsStr]) -> Result<OwnedHandle, DirectoryError> {
    let prefix = absolute_root(path)?;
    let mut custody = Vec::with_capacity(components.len() + 1);
    custody.push(open_absolute(&prefix)?);
    for component in components {
        let parent = custody.last().ok_or(DirectoryError)?.as_raw_handle() as F::HANDLE;
        custody.push(open_relative(parent, component)?);
    }
    custody.pop().ok_or(DirectoryError)
}

fn absolute_root(path: &Path) -> Result<PathBuf, DirectoryError> {
    let mut components = path.components();
    let prefix = match components.next() {
        Some(Component::Prefix(prefix)) => prefix,
        _ => return Err(DirectoryError),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(DirectoryError);
    }
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::UNC(_, _) => {}
        _ => return Err(DirectoryError),
    }
    let mut root = PathBuf::new();
    root.push(prefix.as_os_str());
    root.push(Path::new(r"\"));
    Ok(root)
}

fn open_absolute(path: &Path) -> Result<OwnedHandle, DirectoryError> {
    let path = wide(path.as_os_str())?;
    let raw = unsafe {
        FS::CreateFileW(
            path.as_ptr(),
            FS::FILE_LIST_DIRECTORY | FS::FILE_READ_ATTRIBUTES,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            null_mut(),
            FS::OPEN_EXISTING,
            FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == F::INVALID_HANDLE_VALUE {
        return Err(DirectoryError);
    }
    // SAFETY: CreateFileW returned a new directory handle.
    let directory = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    verify_directory(directory.as_raw_handle() as F::HANDLE)?;
    Ok(directory)
}

fn open_relative(parent: F::HANDLE, name: &OsStr) -> Result<OwnedHandle, DirectoryError> {
    let name = wide_component(name)?;
    let mut object_name = F::UNICODE_STRING {
        Length: (name.len() * size_of::<u16>()) as u16,
        MaximumLength: (name.len() * size_of::<u16>()) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
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
    if unsafe {
        NFS::NtCreateFile(
            &mut raw,
            FS::FILE_LIST_DIRECTORY | FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
            &attributes,
            &mut status,
            null(),
            FS::FILE_ATTRIBUTE_DIRECTORY,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_OPEN,
            NFS::FILE_DIRECTORY_FILE
                | NFS::FILE_OPEN_REPARSE_POINT
                | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    } < 0
    {
        return Err(DirectoryError);
    }
    // SAFETY: NtCreateFile returned a new directory handle.
    let directory = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    verify_directory(directory.as_raw_handle() as F::HANDLE)?;
    Ok(directory)
}

fn verify_directory(handle: F::HANDLE) -> Result<(), DirectoryError> {
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
        return Err(DirectoryError);
    }
    Ok(())
}

fn wide(value: &OsStr) -> Result<Vec<u16>, DirectoryError> {
    let mut encoded = wide_component(value)?;
    encoded.push(0);
    Ok(encoded)
}

fn wide_component(value: &OsStr) -> Result<Vec<u16>, DirectoryError> {
    let encoded: Vec<u16> = value.encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2) && !encoded.contains(&0))
        .then_some(encoded)
        .ok_or(DirectoryError)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::surfaces::workspace) struct DirectoryError;

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{absolute_root, components};

    #[test]
    fn accepts_only_disk_and_unc_share_roots() {
        assert!(absolute_root(Path::new(r"C:\workspace")).is_ok());
        assert!(absolute_root(Path::new(r"\\server\share\workspace")).is_ok());
        assert!(absolute_root(Path::new(r"\workspace")).is_err());
        assert!(absolute_root(Path::new(r"\\?\C:\workspace")).is_err());
    }

    #[test]
    fn rejects_unmodeled_prefixes_during_component_validation() {
        assert!(components(Path::new(r"\\?\C:\workspace")).is_err());
        assert!(components(Path::new(r"\\.\C:\workspace")).is_err());
    }
}
