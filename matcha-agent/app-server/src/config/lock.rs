use crate::rpc;
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub(super) fn acquire(root: &Path) -> rpc::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(root.join("matcha-agent.lock"))
        .map_err(storage)?;
    let metadata = file.metadata().map_err(storage)?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if !metadata.is_file() || linked {
        return Err(rpc::Error::new(
            -32007,
            "config_lock_rejected",
            "The configuration lock must be a regular file",
        ));
    }
    file.try_lock().map_err(|error| {
        rpc::Error::conflict("config_locked", "Another owner is using this server home")
            .with_source(error)
    })?;
    // Never unlink: every launcher/server must lock the same file identity.
    Ok(file)
}

fn storage(error: io::Error) -> rpc::Error {
    rpc::Error::new(
        -32005,
        "config_lock_open",
        "The configuration lock could not be opened",
    )
    .with_source(error)
}
