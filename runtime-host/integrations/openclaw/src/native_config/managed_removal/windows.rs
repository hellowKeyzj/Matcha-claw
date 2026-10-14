use std::{
    ffi::OsStr,
    fs::File,
    io,
    mem::{offset_of, size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
};

use super::marker_changed;

pub(super) struct DirectoryCustody {
    extensions: OwnedHandle,
    target: OwnedHandle,
    retained_name: String,
}

impl DirectoryCustody {
    pub(super) fn open(extensions: &Path, id: &str, removing: bool) -> io::Result<Option<Self>> {
        let name: Vec<u16> = extensions.as_os_str().encode_wide().chain([0]).collect();
        let raw = unsafe {
            FS::CreateFileW(
                name.as_ptr(), FS::FILE_READ_ATTRIBUTES,
                FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
                null(), FS::OPEN_EXISTING,
                FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw == F::INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateFileW returned a new owned directory handle, without delete sharing.
        let extensions = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
        verify_attributes(raw, true)?;
        let access = FS::FILE_READ_ATTRIBUTES | if removing { FS::DELETE } else { 0 };
        let Some(target) = open_relative(raw, id, access, true, false)? else {
            return Ok(None);
        };
        let identity = identity(target.as_raw_handle() as F::HANDLE)?;
        let file = identity.FileId.Identifier.iter()
            .map(|byte| format!("{byte:02x}")).collect::<String>();
        let retained_name = format!(".{id}.removing-{:x}-{file}", identity.VolumeSerialNumber);
        Ok(Some(Self { extensions, target, retained_name }))
    }

    pub(super) fn open_marker(&self) -> io::Result<Option<File>> {
        open_file(self.target.as_raw_handle() as F::HANDLE, ".matchaclaw-managed", false)
    }

    pub(super) fn open_retained(&self) -> io::Result<Option<File>> {
        open_file(self.extensions.as_raw_handle() as F::HANDLE, &self.retained_name, false)
    }

    pub(super) fn retain_marker(&self, marker: &File) -> io::Result<()> {
        let source = self.marker_for_change(
            self.target.as_raw_handle() as F::HANDLE, ".matchaclaw-managed", marker,
        )?;
        link(&source, self.extensions.as_raw_handle() as F::HANDLE, &self.retained_name)
    }

    pub(super) fn restore_marker(&self, retained: &File) -> io::Result<()> {
        let source = self.marker_for_change(
            self.extensions.as_raw_handle() as F::HANDLE, &self.retained_name, retained,
        )?;
        match link(&source, self.target.as_raw_handle() as F::HANDLE, ".matchaclaw-managed") {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let marker = self.open_marker()?.ok_or_else(marker_changed)?;
                if same_file(&marker, retained)? { Ok(()) } else { Err(marker_changed()) }
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn remove_marker(&self, marker: &File) -> io::Result<()> {
        let file = self.marker_for_change(
            self.target.as_raw_handle() as F::HANDLE, ".matchaclaw-managed", marker,
        )?;
        remove_link(&file)
    }

    pub(super) fn remove_target(&self, _target: &Path) -> io::Result<()> {
        let disposition = FS::FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            FS::SetFileInformationByHandle(
                self.target.as_raw_handle() as F::HANDLE,
                FS::FileDispositionInfo,
                (&disposition as *const FS::FILE_DISPOSITION_INFO).cast(),
                size_of::<FS::FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(super) fn remove_retained(&self, retained: &File) -> io::Result<()> {
        let file = self.marker_for_change(
            self.extensions.as_raw_handle() as F::HANDLE, &self.retained_name, retained,
        )?;
        remove_link(&file)
    }

    fn marker_for_change(&self, directory: F::HANDLE, name: &str, expected: &File) -> io::Result<File> {
        let file = open_file(directory, name, true)?.ok_or_else(marker_changed)?;
        if same_file(&file, expected)? { Ok(file) } else { Err(marker_changed()) }
    }
}

pub(super) fn same_file(left: &File, right: &File) -> io::Result<bool> {
    let left = identity(left.as_raw_handle() as F::HANDLE)?;
    let right = identity(right.as_raw_handle() as F::HANDLE)?;
    Ok(left.VolumeSerialNumber == right.VolumeSerialNumber
        && left.FileId.Identifier == right.FileId.Identifier)
}

fn open_file(parent: F::HANDLE, name: &str, changing: bool) -> io::Result<Option<File>> {
    let access = FS::FILE_GENERIC_READ | if changing { FS::DELETE } else { 0 };
    Ok(open_relative(parent, name, access, false, true)?.map(File::from))
}

fn open_relative(
    parent: F::HANDLE,
    name: &str,
    access: u32,
    directory: bool,
    share_delete: bool,
) -> io::Result<Option<OwnedHandle>> {
    let name = wide_component(name)?;
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name.as_slice()) as u16,
        MaximumLength: size_of_val(name.as_slice()) as u16,
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
    let result = unsafe {
        NFS::NtCreateFile(
            &mut raw, access | FS::SYNCHRONIZE, &attributes, &mut status, null(), 0,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE
                | if share_delete { FS::FILE_SHARE_DELETE } else { 0 },
            NFS::FILE_OPEN,
            NFS::FILE_OPEN_REPARSE_POINT | NFS::FILE_SYNCHRONOUS_IO_NONALERT
                | if directory { NFS::FILE_DIRECTORY_FILE } else { NFS::FILE_NON_DIRECTORY_FILE },
            null(), 0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_NOT_FOUND || result == F::STATUS_OBJECT_PATH_NOT_FOUND {
        return Ok(None);
    }
    if result < 0 {
        return Err(nt_error(result));
    }
    // SAFETY: NtCreateFile returned a new owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    verify_attributes(raw, directory)?;
    Ok(Some(handle))
}

fn link(source: &File, directory: F::HANDLE, name: &str) -> io::Result<()> {
    let name = wide_component(name)?;
    let header_length = offset_of!(NFS::FILE_LINK_INFORMATION, FileName);
    let total_length = header_length + size_of_val(name.as_slice());
    let mut information = vec![0_u64; total_length.div_ceil(size_of::<u64>())];
    let bytes = information.as_mut_ptr().cast::<u8>();
    // SAFETY: u64 storage aligns the header and contains the complete trailing UTF-16 name.
    unsafe {
        let header = bytes.cast::<NFS::FILE_LINK_INFORMATION>();
        (*header).Anonymous.ReplaceIfExists = false;
        (*header).RootDirectory = directory;
        (*header).FileNameLength = size_of_val(name.as_slice()) as u32;
        bytes.add(header_length).cast::<u16>()
            .copy_from_nonoverlapping(name.as_ptr(), name.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    let result = unsafe {
        NFS::NtSetInformationFile(
            source.as_raw_handle() as F::HANDLE, &mut status,
            bytes.cast(), total_length as u32, NFS::FileLinkInformation,
        )
    };
    if result < 0 { Err(nt_error(result)) } else { Ok(()) }
}

fn remove_link(file: &File) -> io::Result<()> {
    let disposition = FS::FILE_DISPOSITION_INFO_EX {
        Flags: FS::FILE_DISPOSITION_FLAG_DELETE | FS::FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    if unsafe {
        FS::SetFileInformationByHandle(
            file.as_raw_handle() as F::HANDLE, FS::FileDispositionInfoEx,
            (&disposition as *const FS::FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FS::FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn verify_attributes(handle: F::HANDLE, directory: bool) -> io::Result<()> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle, FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0 {
        return Err(io::Error::last_os_error());
    }
    if attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(marker_changed());
    }
    Ok(())
}

fn identity(handle: F::HANDLE) -> io::Result<FS::FILE_ID_INFO> {
    let mut identity = FS::FILE_ID_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle, FS::FileIdInfo, (&mut identity as *mut FS::FILE_ID_INFO).cast(),
            size_of::<FS::FILE_ID_INFO>() as u32,
        )
    } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(identity)
    }
}

fn wide_component(name: &str) -> io::Result<Vec<u16>> {
    if name.is_empty() || name.contains(['\\', '/']) || name == "." || name == ".." {
        return Err(marker_changed());
    }
    let name: Vec<u16> = OsStr::new(name).encode_wide().collect();
    if name.len() > usize::from(u16::MAX / 2) || name.contains(&0) {
        return Err(marker_changed());
    }
    Ok(name)
}

fn nt_error(status: F::NTSTATUS) -> io::Error {
    io::Error::from_raw_os_error(unsafe { F::RtlNtStatusToDosError(status) } as i32)
}
