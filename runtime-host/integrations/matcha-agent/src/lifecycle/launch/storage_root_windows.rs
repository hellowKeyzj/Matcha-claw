use std::{
    ffi::OsStr,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Component, Path, PathBuf},
    ptr::{null, null_mut},
};

use windows_sys::Win32::{Foundation as F, Storage::FileSystem as FS};

pub(super) fn provision(storage_root: &Path) -> Result<(), ()> {
    let mut path = PathBuf::new();
    let mut components = storage_root.components();
    let Some(first) = components.next() else {
        return Err(());
    };

    match first {
        Component::Prefix(prefix) => path.push(prefix.as_os_str()),
        _ => return Err(()),
    }
    match components.next() {
        Some(Component::RootDir) => path.push(r"\"),
        _ => return Err(()),
    }

    let names = components
        .map(|component| match component {
            Component::Normal(name) => Ok(name),
            Component::CurDir
            | Component::ParentDir
            | Component::Prefix(_)
            | Component::RootDir => Err(()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Err(());
    }
    for name in names {
        path.push(name);
        create_directory(&path)?;
        verify_directory(&path)?;
    }

    Ok(())
}

fn create_directory(path: &Path) -> Result<(), ()> {
    let name = wide(path)?;
    if unsafe { FS::CreateDirectoryW(name.as_ptr(), null()) } != 0 {
        return Ok(());
    }
    if io::Error::last_os_error().raw_os_error() == Some(F::ERROR_ALREADY_EXISTS as i32) {
        Ok(())
    } else {
        Err(())
    }
}

fn verify_directory(path: &Path) -> Result<(), ()> {
    let name = wide(path)?;
    let directory = open_directory(&name)?;
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            directory.as_raw_handle() as F::HANDLE,
            FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(());
    }
    Ok(())
}

fn open_directory(name: &[u16]) -> Result<OwnedHandle, ()> {
    let raw = unsafe {
        FS::CreateFileW(
            name.as_ptr(),
            FS::FILE_READ_ATTRIBUTES | FS::READ_CONTROL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
            null(),
            FS::OPEN_EXISTING,
            FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == F::INVALID_HANDLE_VALUE {
        return Err(());
    }
    // SAFETY: CreateFileW returned a new owned directory handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) })
}

fn wide(value: impl AsRef<OsStr>) -> Result<Vec<u16>, ()> {
    let value = value.as_ref();
    if value.encode_wide().any(|unit| unit == 0) {
        return Err(());
    }
    Ok(value.encode_wide().chain([0]).collect())
}
