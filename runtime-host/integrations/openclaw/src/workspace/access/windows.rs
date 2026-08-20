use std::{
    io::Write,
    mem::{offset_of, size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    ptr::{null, null_mut},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{
        Foundation as F,
        Storage::FileSystem as FS,
        System::{IO::IO_STATUS_BLOCK, Threading::GetCurrentProcess},
    },
};

use super::{WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileError};

static NEXT_TEMPORARY_FILE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
use crate::workspace::directory::DirectoryHandle;

const QUERY_BUFFER_BYTES: usize = 64 * 1024;

pub(super) fn read_external_file(
    path: &std::path::Path,
    limit: usize,
) -> Result<(Vec<u8>, u64), WorkspaceFileError> {
    let parent = path.parent().ok_or(WorkspaceFileError::InvalidRelative)?;
    let directory = crate::workspace::directory::open(parent)
        .map_err(|_| WorkspaceFileError::Unavailable)?
        .into_handle();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    read_file(&directory, &[name.to_owned()], limit)
}

pub(super) fn read_file(
    directory: &DirectoryHandle,
    components: &[String],
    limit: usize,
) -> Result<(Vec<u8>, u64), WorkspaceFileError> {
    let file = open_leaf(directory, components, F::GENERIC_READ | FS::SYNCHRONIZE)?;
    let metadata = metadata(&file)?;
    if metadata.kind == WorkspaceEntryKind::Directory {
        return Err(WorkspaceFileError::NotFile);
    }
    if unsafe { FS::GetFileType(file.as_raw_handle() as F::HANDLE) } != FS::FILE_TYPE_DISK {
        return Err(WorkspaceFileError::Unavailable);
    }
    if metadata.size > limit as u64 {
        return Err(WorkspaceFileError::TooLarge);
    }
    let capacity = usize::try_from(metadata.size).map_err(|_| WorkspaceFileError::TooLarge)?;
    let file = std::fs::File::from(file);
    let mut content = Vec::with_capacity(capacity);
    use std::io::Read;
    file.take(limit as u64 + 1)
        .read_to_end(&mut content)
        .map_err(|_| WorkspaceFileError::Unavailable)?;
    if content.len() > limit {
        return Err(WorkspaceFileError::TooLarge);
    }
    let size = content.len() as u64;
    Ok((content, size))
}

pub(super) fn stat(
    directory: &DirectoryHandle,
    components: &[String],
) -> Result<WorkspaceEntry, WorkspaceFileError> {
    let file = open_leaf(
        directory,
        components,
        FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
    )?;
    let metadata = metadata(&file)?;
    Ok(WorkspaceEntry {
        name: String::new(),
        kind: metadata.kind,
        size: metadata.size,
        mtime_ms: metadata.mtime_ms,
    })
}

pub(super) fn list_dir(
    directory: &DirectoryHandle,
    components: &[String],
    include_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, WorkspaceFileError> {
    let folder = if components.is_empty() {
        duplicate(directory.as_raw_handle())?
    } else {
        open_leaf(
            directory,
            components,
            FS::FILE_LIST_DIRECTORY | FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
        )?
    };
    if metadata(&folder)?.kind != WorkspaceEntryKind::Directory {
        return Err(WorkspaceFileError::NotDirectory);
    }
    let mut buffer = vec![0_u8; QUERY_BUFFER_BYTES];
    let mut restart = true;
    let mut entries = Vec::new();
    loop {
        let mut status = IO_STATUS_BLOCK::default();
        let result = unsafe {
            NFS::NtQueryDirectoryFile(
                folder.as_raw_handle() as F::HANDLE,
                null_mut(),
                None,
                null(),
                &mut status,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                NFS::FileDirectoryInformation,
                false,
                null(),
                restart,
            )
        };
        restart = false;
        if result == F::STATUS_NO_MORE_FILES || result == F::STATUS_NO_SUCH_FILE {
            break;
        }
        if result < 0 || status.Information == 0 || status.Information > buffer.len() {
            return Err(WorkspaceFileError::Unavailable);
        }
        let mut offset = 0;
        while offset < status.Information {
            let entry = directory_entry(&buffer, offset, status.Information)?;
            if let Some(name) = entry
                .name
                .filter(|name| include_hidden || !name.starts_with('.'))
            {
                match open_entry_handle(
                    folder.as_raw_handle() as F::HANDLE,
                    &name,
                    FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
                ) {
                    Ok(file) => {
                        let metadata = metadata(&file)?;
                        if metadata.kind != WorkspaceEntryKind::Directory
                            || !excluded_directory(&name)
                        {
                            entries.push(WorkspaceEntry {
                                name,
                                kind: metadata.kind,
                                size: metadata.size,
                                mtime_ms: metadata.mtime_ms,
                            });
                        }
                    }
                    Err(WorkspaceFileError::Unavailable | WorkspaceFileError::NotFile)
                    | Err(WorkspaceFileError::NotDirectory) => {}
                    Err(error) => return Err(error),
                }
            }
            if entry.next_offset == 0 {
                break;
            }
            if (entry.next_offset as usize) < entry.minimum_length {
                return Err(WorkspaceFileError::Unavailable);
            }
            offset = offset
                .checked_add(entry.next_offset as usize)
                .filter(|offset| *offset <= status.Information)
                .ok_or(WorkspaceFileError::Unavailable)?;
        }
    }
    entries.sort_by(|left, right| {
        let kind = matches!(right.kind, WorkspaceEntryKind::Directory)
            .cmp(&matches!(left.kind, WorkspaceEntryKind::Directory));
        kind.then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

pub(super) fn write_file(
    directory: &DirectoryHandle,
    components: &[String],
    content: &[u8],
) -> Result<(), WorkspaceFileError> {
    let (leaf, parents) = components
        .split_last()
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    let mut parent = directory.as_raw_handle();
    let mut custody = Vec::with_capacity(parents.len());
    for segment in parents {
        let child = match open_directory_handle(parent, segment) {
            Ok(child) => child,
            Err(WorkspaceFileError::Unavailable) => create_directory_handle(parent, segment)?,
            Err(error) => return Err(error),
        };
        parent = child.as_raw_handle() as F::HANDLE;
        custody.push(child);
    }
    let temporary = temporary_name();
    let temporary_file = create_entry_handle(parent, &temporary)?;
    let mut temporary_file = std::fs::File::from(temporary_file);
    if temporary_file.write_all(content).is_err() || temporary_file.sync_all().is_err() {
        discard_temporary_file(temporary_file.as_raw_handle() as F::HANDLE);
        return Err(WorkspaceFileError::OutcomeUnknown);
    }
    let temporary_file: OwnedHandle = temporary_file.into();
    let leaf = wide_component(leaf)?;
    if !replace_entry(temporary_file.as_raw_handle() as F::HANDLE, parent, &leaf) {
        discard_temporary_file(temporary_file.as_raw_handle() as F::HANDLE);
        return Err(WorkspaceFileError::OutcomeUnknown);
    }
    Ok(())
}

struct EntryMetadata {
    kind: WorkspaceEntryKind,
    size: u64,
    mtime_ms: u64,
}

struct DirectoryEntry {
    name: Option<String>,
    next_offset: u32,
    minimum_length: usize,
}

fn duplicate(handle: F::HANDLE) -> Result<OwnedHandle, WorkspaceFileError> {
    let mut duplicate = null_mut();
    if unsafe {
        F::DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            0,
            F::DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: DuplicateHandle returned a new owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate as RawHandle) })
}

fn open_leaf(
    directory: &DirectoryHandle,
    components: &[String],
    access: u32,
) -> Result<OwnedHandle, WorkspaceFileError> {
    let (leaf, parents) = components
        .split_last()
        .ok_or(WorkspaceFileError::InvalidRelative)?;
    let mut parent = directory.as_raw_handle() as F::HANDLE;
    let mut custody = Vec::with_capacity(parents.len());
    for segment in parents {
        let child = open_directory_handle(parent, segment)?;
        parent = child.as_raw_handle() as F::HANDLE;
        custody.push(child);
    }
    open_entry_handle(parent, leaf, access)
}

fn open_directory_handle(
    directory: F::HANDLE,
    name: &str,
) -> Result<OwnedHandle, WorkspaceFileError> {
    let handle = open_entry_handle(
        directory,
        name,
        FS::FILE_LIST_DIRECTORY | FS::FILE_READ_ATTRIBUTES | FS::SYNCHRONIZE,
    )?;
    if metadata(&handle)?.kind != WorkspaceEntryKind::Directory {
        return Err(WorkspaceFileError::NotDirectory);
    }
    Ok(handle)
}

fn create_directory_handle(
    directory: F::HANDLE,
    name: &str,
) -> Result<OwnedHandle, WorkspaceFileError> {
    let name = wide_component(name)?;
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name.as_slice()) as u16,
        MaximumLength: size_of_val(name.as_slice()) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory,
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
            FS::FILE_ATTRIBUTE_NORMAL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_OPEN_IF,
            NFS::FILE_DIRECTORY_FILE | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    } < 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: NtCreateFile returned a new owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    verify_regular_or_directory(&handle)?;
    if metadata(&handle)?.kind != WorkspaceEntryKind::Directory {
        return Err(WorkspaceFileError::NotDirectory);
    }
    Ok(handle)
}

fn create_entry_handle(
    directory: F::HANDLE,
    name: &[u16],
) -> Result<OwnedHandle, WorkspaceFileError> {
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name) as u16,
        MaximumLength: size_of_val(name) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory,
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
            F::GENERIC_WRITE | FS::DELETE | FS::SYNCHRONIZE,
            &attributes,
            &mut status,
            null(),
            FS::FILE_ATTRIBUTE_NORMAL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_CREATE,
            NFS::FILE_NON_DIRECTORY_FILE | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    } < 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: NtCreateFile returned a new owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) })
}

fn discard_temporary_file(file: F::HANDLE) {
    let mut disposition = NFS::FILE_DISPOSITION_INFORMATION { DeleteFile: true };
    let mut status = IO_STATUS_BLOCK::default();
    unsafe {
        NFS::NtSetInformationFile(
            file,
            &mut status,
            (&mut disposition as *mut NFS::FILE_DISPOSITION_INFORMATION).cast(),
            size_of::<NFS::FILE_DISPOSITION_INFORMATION>() as u32,
            NFS::FileDispositionInformation,
        );
    }
}

fn replace_entry(file: F::HANDLE, directory: F::HANDLE, target: &[u16]) -> bool {
    let header = offset_of!(NFS::FILE_RENAME_INFORMATION, FileName);
    let Some(length) = header.checked_add(size_of_val(target)) else {
        return false;
    };
    let mut words = vec![0_u64; length.div_ceil(size_of::<u64>())];
    let buffer = words.as_mut_ptr().cast::<u8>();
    // SAFETY: the u64 allocation supplies adequate alignment for FILE_RENAME_INFORMATION, and
    // the trailing flexible array receives exactly target.len() UTF-16 code units.
    unsafe {
        let information = buffer.cast::<NFS::FILE_RENAME_INFORMATION>();
        (*information).Anonymous.ReplaceIfExists = true;
        (*information).RootDirectory = directory;
        (*information).FileNameLength = size_of_val(target) as u32;
        buffer
            .add(header)
            .cast::<u16>()
            .copy_from_nonoverlapping(target.as_ptr(), target.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    unsafe {
        NFS::NtSetInformationFile(
            file,
            &mut status,
            buffer.cast(),
            length as u32,
            NFS::FileRenameInformation,
        ) >= 0
    }
}

fn temporary_name() -> Vec<u16> {
    use std::sync::atomic::Ordering;

    format!(
        ".matcha-write-{}-{}",
        std::process::id(),
        NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed)
    )
    .encode_utf16()
    .collect()
}

fn open_entry_handle(
    directory: F::HANDLE,
    name: &str,
    access: u32,
) -> Result<OwnedHandle, WorkspaceFileError> {
    let name = wide_component(name)?;
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name.as_slice()) as u16,
        MaximumLength: size_of_val(name.as_slice()) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory,
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
            access,
            &attributes,
            &mut status,
            null(),
            FS::FILE_ATTRIBUTE_NORMAL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            NFS::FILE_OPEN,
            NFS::FILE_OPEN_REPARSE_POINT | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    } < 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    // SAFETY: NtCreateFile returned a new owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    verify_regular_or_directory(&handle)?;
    Ok(handle)
}

fn verify_regular_or_directory(handle: &OwnedHandle) -> Result<(), WorkspaceFileError> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle.as_raw_handle() as F::HANDLE,
            FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    Ok(())
}

fn metadata(handle: &OwnedHandle) -> Result<EntryMetadata, WorkspaceFileError> {
    let mut information = FS::FILE_STANDARD_INFO::default();
    let mut basic = FS::FILE_BASIC_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle.as_raw_handle() as F::HANDLE,
            FS::FileStandardInfo,
            (&mut information as *mut FS::FILE_STANDARD_INFO).cast(),
            size_of::<FS::FILE_STANDARD_INFO>() as u32,
        )
    } == 0
        || unsafe {
            FS::GetFileInformationByHandleEx(
                handle.as_raw_handle() as F::HANDLE,
                FS::FileBasicInfo,
                (&mut basic as *mut FS::FILE_BASIC_INFO).cast(),
                size_of::<FS::FILE_BASIC_INFO>() as u32,
            )
        } == 0
        || information.EndOfFile < 0
        || basic.LastWriteTime < 0
    {
        return Err(WorkspaceFileError::Unavailable);
    }
    Ok(EntryMetadata {
        kind: if information.Directory {
            WorkspaceEntryKind::Directory
        } else {
            WorkspaceEntryKind::File
        },
        size: if !information.Directory {
            information.EndOfFile as u64
        } else {
            0
        },
        mtime_ms: u64::try_from(basic.LastWriteTime / 10_000 - 11_644_473_600_000)
            .map_err(|_| WorkspaceFileError::Unavailable)?,
    })
}

fn directory_entry(
    buffer: &[u8],
    offset: usize,
    length: usize,
) -> Result<DirectoryEntry, WorkspaceFileError> {
    let header_length = offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileName);
    let header_end = offset
        .checked_add(header_length)
        .filter(|end| *end <= length)
        .ok_or(WorkspaceFileError::Unavailable)?;
    let next_offset = read_u32(buffer, offset, length)?;
    let record_end = if next_offset == 0 {
        length
    } else {
        offset
            .checked_add(next_offset as usize)
            .filter(|end| *end <= length)
            .ok_or(WorkspaceFileError::Unavailable)?
    };
    let file_name_length = read_u32(
        buffer,
        offset
            .checked_add(offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileNameLength))
            .ok_or(WorkspaceFileError::Unavailable)?,
        record_end,
    )? as usize;
    let minimum_length = header_length
        .checked_add(file_name_length)
        .ok_or(WorkspaceFileError::Unavailable)?;
    let name_end = header_end
        .checked_add(file_name_length)
        .filter(|end| *end <= record_end && file_name_length.is_multiple_of(size_of::<u16>()))
        .ok_or(WorkspaceFileError::Unavailable)?;
    let raw_name = buffer[header_end..name_end]
        .chunks_exact(size_of::<u16>())
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    let name = String::from_utf16(&raw_name).map_err(|_| WorkspaceFileError::Unavailable)?;
    Ok(DirectoryEntry {
        name: super::valid_component(&name).then_some(name),
        next_offset,
        minimum_length,
    })
}

fn read_u32(buffer: &[u8], offset: usize, length: usize) -> Result<u32, WorkspaceFileError> {
    let end = offset
        .checked_add(size_of::<u32>())
        .filter(|end| *end <= length)
        .ok_or(WorkspaceFileError::Unavailable)?;
    let mut bytes = [0_u8; size_of::<u32>()];
    bytes.copy_from_slice(&buffer[offset..end]);
    Ok(u32::from_le_bytes(bytes))
}

fn wide_component(value: &str) -> Result<Vec<u16>, WorkspaceFileError> {
    let encoded: Vec<u16> = std::ffi::OsStr::new(value).encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2) && !encoded.contains(&0))
        .then_some(encoded)
        .ok_or(WorkspaceFileError::InvalidRelative)
}

fn excluded_directory(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".venv"
            | "__pycache__"
            | ".git"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
    )
}

#[cfg(test)]
mod tests {
    use std::mem::offset_of;

    use windows_sys::Wdk::Storage::FileSystem as NFS;

    use super::{WorkspaceFileError, directory_entry};

    #[test]
    fn rejects_names_that_cross_the_current_directory_record() {
        let header = offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileName);
        let next_offset = header + 2;
        let mut buffer = vec![0_u8; next_offset + 2];
        buffer[..4].copy_from_slice(&(next_offset as u32).to_le_bytes());
        let length_offset = offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileNameLength);
        buffer[length_offset..length_offset + 4].copy_from_slice(&4_u32.to_le_bytes());
        buffer[header..header + 2].copy_from_slice(&(b'a' as u16).to_le_bytes());
        buffer[next_offset..next_offset + 2].copy_from_slice(&(b'b' as u16).to_le_bytes());

        assert!(matches!(
            directory_entry(&buffer, 0, buffer.len()),
            Err(WorkspaceFileError::Unavailable)
        ));
    }

    #[test]
    fn rejects_invalid_utf16_directory_names() {
        let header = offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileName);
        let mut buffer = vec![0_u8; header + 2];
        let length_offset = offset_of!(NFS::FILE_DIRECTORY_INFORMATION, FileNameLength);
        buffer[length_offset..length_offset + 4].copy_from_slice(&2_u32.to_le_bytes());
        buffer[header..header + 2].copy_from_slice(&0xd800_u16.to_le_bytes());

        assert!(matches!(
            directory_entry(&buffer, 0, buffer.len()),
            Err(WorkspaceFileError::Unavailable)
        ));
    }
}
