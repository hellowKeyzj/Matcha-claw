use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read},
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    },
    path::{Path, PathBuf},
    ptr::null_mut,
};

use windows_sys::Win32::{Foundation as F, Storage::FileSystem as Fs};

use crate::{persistence, rpc};

use super::{
    Entry, Kind,
    access::{absolute_components, denied, entry, io_error, metadata_kind, name_string},
};

pub(super) struct Directory {
    path: PathBuf,
    // No write/delete sharing: ancestors cannot be swapped or changed into junctions during I/O.
    custody: Vec<File>,
}

impl Directory {
    pub fn open(path: &Path) -> rpc::Result<Self> {
        let (root, names) = absolute_components(path)?;
        let file = open_directory(&root)?;
        let mut directory = Self {
            path: root,
            custody: vec![file],
        };
        for name in names {
            directory.descend(name)?;
        }
        Ok(directory)
    }

    pub fn descend(&mut self, name: &OsStr) -> rpc::Result<()> {
        let path = self.path.join(name);
        let file = open_directory(&path)?;
        self.custody.push(file);
        self.path = path;
        Ok(())
    }

    pub fn verify_canonical(&self, path: &Path) -> rpc::Result<()> {
        let observed = open_directory(path)?;
        let held = self.custody.last().ok_or_else(denied)?;
        if identity(held)? != identity(&observed)? {
            return Err(denied());
        }
        Ok(())
    }

    pub fn read(&self, name: &OsStr) -> rpc::Result<Vec<u8>> {
        let mut file = open_file(
            &self.path.join(name),
            Fs::FILE_GENERIC_READ,
            Fs::FILE_SHARE_READ,
        )?;
        let kind = file_kind(&file)?;
        if kind != Kind::File {
            return if kind == Kind::Symlink {
                Err(denied())
            } else {
                Err(rpc::Error::conflict(
                    "workspace_not_file",
                    "Only regular workspace files may be read",
                ))
            };
        }
        let mut standard = Fs::FILE_STANDARD_INFO::default();
        // SAFETY: file is owned and standard is a correctly-sized output structure.
        if unsafe {
            Fs::GetFileInformationByHandleEx(
                file.as_raw_handle(),
                Fs::FileStandardInfo,
                (&mut standard as *mut Fs::FILE_STANDARD_INFO).cast(),
                size_of::<Fs::FILE_STANDARD_INFO>() as u32,
            )
        } == 0
        {
            return Err(io_error("read_links", io::Error::last_os_error()));
        }
        if standard.NumberOfLinks != 1 {
            return Err(rpc::Error::new(
                -32007,
                "workspace_hardlink_forbidden",
                "Files with multiple hard links cannot be read through the workspace API",
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| io_error("read", error))?;
        Ok(bytes)
    }

    pub fn stat_entry(&self, name: Option<&OsStr>) -> rpc::Result<super::Stat> {
        let file = match name {
            Some(name) => open_file(
                &self.path.join(name),
                Fs::FILE_READ_ATTRIBUTES,
                Fs::FILE_SHARE_READ,
            )?,
            None => self
                .custody
                .last()
                .ok_or_else(denied)?
                .try_clone()
                .map_err(|error| io_error("stat_clone", error))?,
        };
        let kind = file_kind(&file)?;
        let metadata = file.metadata().map_err(|error| io_error("stat", error))?;
        super::stat_metadata(
            name.map(name_string).transpose()?.unwrap_or_default(),
            kind,
            metadata,
        )
    }

    pub fn kind(&self, name: &OsStr) -> rpc::Result<Option<Kind>> {
        match fs::symlink_metadata(self.path.join(name)) {
            Ok(metadata) => Ok(Some(metadata_kind(&metadata))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_error("stat", error)),
        }
    }

    pub fn list(&self) -> rpc::Result<Vec<Entry>> {
        fs::read_dir(&self.path)
            .map_err(|error| io_error("list_open", error))?
            .map(|item| {
                let item = item.map_err(|error| io_error("list_next", error))?;
                let metadata = fs::symlink_metadata(item.path())
                    .map_err(|error| io_error("list_stat", error))?;
                Ok(entry(name_string(&item.file_name())?, &metadata))
            })
            .collect()
    }

    pub async fn write(&self, name: &OsStr, bytes: &[u8]) -> rpc::Result<()> {
        persistence::atomic_write(&self.path.join(name), bytes).await
    }

    pub fn mkdir(&self, name: &OsStr) -> rpc::Result<()> {
        fs::create_dir(self.path.join(name)).map_err(|error| io_error("mkdir", error))
    }

    pub fn remove(&self, name: &OsStr, expected: Kind) -> rpc::Result<()> {
        // Delete the observed handle itself, never a newly-resolved symlink target.
        let file = open_file(
            &self.path.join(name),
            Fs::DELETE | Fs::FILE_READ_ATTRIBUTES,
            Fs::FILE_SHARE_NONE,
        )?;
        let observed = file_kind(&file)?;
        if observed == Kind::Symlink {
            return Err(denied());
        }
        if observed != expected {
            return Err(rpc::Error::conflict(
                "workspace_entry_changed",
                "The entry type changed before removal; inspect it again",
            ));
        }
        let disposition = Fs::FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: file is owned with DELETE access and disposition has the documented layout.
        if unsafe {
            Fs::SetFileInformationByHandle(
                file.as_raw_handle(),
                Fs::FileDispositionInfo,
                (&disposition as *const Fs::FILE_DISPOSITION_INFO).cast(),
                size_of::<Fs::FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(io_error("remove", io::Error::last_os_error()));
        }
        // Confirm handle close instead of claiming deletion while this handle is still open.
        let raw = file.into_raw_handle();
        // SAFETY: ownership was transferred from file; CloseHandle is invoked exactly once.
        if unsafe { F::CloseHandle(raw) } == 0 {
            return Err(rpc::Error::new(
                -32006,
                "workspace_remove_close_unknown",
                "Removal was requested but closing the removal handle could not be confirmed",
            ));
        }
        Ok(())
    }
}

fn identity(file: &File) -> rpc::Result<(u64, [u8; 16])> {
    let mut identity = Fs::FILE_ID_INFO::default();
    // SAFETY: file is owned and identity is a correctly-sized output structure.
    if unsafe {
        Fs::GetFileInformationByHandleEx(
            file.as_raw_handle(),
            Fs::FileIdInfo,
            (&mut identity as *mut Fs::FILE_ID_INFO).cast(),
            size_of::<Fs::FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error("root_identity", io::Error::last_os_error()));
    }
    Ok((identity.VolumeSerialNumber, identity.FileId.Identifier))
}

fn open_directory(path: &Path) -> rpc::Result<File> {
    let file = open_file(path, Fs::FILE_READ_ATTRIBUTES, Fs::FILE_SHARE_READ)?;
    match file_kind(&file)? {
        Kind::Directory => Ok(file),
        Kind::Symlink => Err(denied()),
        _ => Err(rpc::Error::conflict(
            "workspace_not_directory",
            "A path component is not a directory",
        )),
    }
}

fn open_file(path: &Path, access: u32, sharing: u32) -> rpc::Result<File> {
    let encoded: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    if encoded[..encoded.len() - 1].contains(&0) {
        return Err(rpc::Error::invalid("Path contains a NUL byte"));
    }
    // SAFETY: encoded is NUL-terminated; returned handles are adopted only after success.
    let raw = unsafe {
        Fs::CreateFileW(
            encoded.as_ptr(),
            access,
            sharing,
            null_mut(),
            Fs::OPEN_EXISTING,
            Fs::FILE_FLAG_BACKUP_SEMANTICS | Fs::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == F::INVALID_HANDLE_VALUE {
        return Err(io_error("open", io::Error::last_os_error()));
    }
    // SAFETY: CreateFileW returned a new owned filesystem handle.
    Ok(unsafe { File::from_raw_handle(raw) })
}

fn file_kind(file: &File) -> rpc::Result<Kind> {
    let mut attributes = Fs::FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: file is owned and attributes is a correctly-sized output structure.
    if unsafe {
        Fs::GetFileInformationByHandleEx(
            file.as_raw_handle(),
            Fs::FileAttributeTagInfo,
            (&mut attributes as *mut Fs::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<Fs::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error("attributes", io::Error::last_os_error()));
    }
    if attributes.FileAttributes & Fs::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Ok(Kind::Symlink)
    } else if attributes.FileAttributes & Fs::FILE_ATTRIBUTE_DIRECTORY != 0 {
        Ok(Kind::Directory)
    } else {
        // SAFETY: file owns a live handle.
        Ok(
            if unsafe { Fs::GetFileType(file.as_raw_handle()) } == Fs::FILE_TYPE_DISK {
                Kind::File
            } else {
                Kind::Other
            },
        )
    }
}
