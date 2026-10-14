use std::{io, path::Path};

#[derive(Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Identity {
    volume: u64,
    file: u128,
}

#[cfg(unix)]
pub(super) fn read_identity(path: &Path) -> io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::ErrorKind::NotADirectory.into());
    }
    Ok(Identity {
        volume: metadata.dev(),
        file: u128::from(metadata.ino()),
    })
}

#[cfg(windows)]
pub(super) fn read_identity(path: &Path) -> io::Result<Identity> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem as FS;

    let directory = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FS::FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(io::ErrorKind::NotADirectory.into());
    }
    let mut identity = FS::FILE_ID_INFO::default();
    // SAFETY: the directory handle and correctly sized output live through this call.
    if unsafe {
        FS::GetFileInformationByHandleEx(
            directory.as_raw_handle(),
            FS::FileIdInfo,
            (&mut identity as *mut FS::FILE_ID_INFO).cast(),
            std::mem::size_of::<FS::FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Identity {
        volume: identity.VolumeSerialNumber,
        file: u128::from_le_bytes(identity.FileId.Identifier),
    })
}
