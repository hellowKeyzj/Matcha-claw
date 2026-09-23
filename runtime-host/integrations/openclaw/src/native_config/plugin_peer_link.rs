use std::{fs, io, path::Path};

use super::{
    PluginReconcileError, is_reparse_point, managed_target_exists, read_metadata_file, remove_link,
    safe_remove_tree,
};

pub(crate) fn repair_channel_peer_link(
    extensions: &Path,
    plugin_id: &str,
    openclaw_root: &Path,
) -> Result<bool, PluginReconcileError> {
    if !managed_target_exists(extensions, plugin_id)? {
        return Err(PluginReconcileError::TargetConflict {
            id: plugin_id.to_owned(),
        });
    }
    let target = extensions.join(plugin_id);
    let package = read_metadata_file(&target.join("package.json"))?;
    let declares_host = ["peerDependencies", "dependencies"].iter().any(|key| {
        package
            .get(*key)
            .and_then(|value| value.get("openclaw"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|spec| !spec.is_empty())
    });
    if !declares_host {
        return Ok(true);
    }
    // Installation and ownership failures above are fatal. Only host-link repair
    // is recoverable by the caller's running-Gateway activation workflow.
    let result = repair_host_link(&target, openclaw_root);
    if let Err(error) = &result {
        eprintln!(
            "[openclaw.plugins] channel peer link repair failed plugin={plugin_id} kind={:?}",
            error.kind()
        );
    }
    match result {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::PermissionDenied
                    | io::ErrorKind::AlreadyExists
                    | io::ErrorKind::InvalidData
                    | io::ErrorKind::NotADirectory
                    | io::ErrorKind::Unsupported
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(PluginReconcileError::Io(error)),
    }
}

fn link_error(error: PluginReconcileError) -> io::Error {
    match error {
        PluginReconcileError::Io(error) => error,
        PluginReconcileError::InvalidSource { .. } => io::ErrorKind::InvalidData.into(),
        PluginReconcileError::TargetConflict { .. } => io::ErrorKind::AlreadyExists.into(),
    }
}

fn repair_host_link(target: &Path, openclaw_root: &Path) -> io::Result<()> {
    let host = read_metadata_file(&openclaw_root.join("package.json")).map_err(link_error)?;
    if host.get("name").and_then(serde_json::Value::as_str) != Some("openclaw") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let root = openclaw_root.canonicalize()?;
    let node_modules = target.join("node_modules");
    match fs::symlink_metadata(&node_modules) {
        Ok(metadata)
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || is_reparse_point(&metadata) =>
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&node_modules)?;
        }
        Err(error) => return Err(error),
    }
    let link = node_modules.join("openclaw");
    if link.canonicalize().is_ok_and(|current| current == root) {
        return Ok(());
    }
    match fs::symlink_metadata(&link) {
        Ok(metadata) if metadata.file_type().is_symlink() || is_reparse_point(&metadata) => {
            remove_link(&link)?;
        }
        Ok(metadata) if metadata.is_dir() => {
            let package = read_metadata_file(&link.join("package.json")).map_err(link_error)?;
            if package.get("name").and_then(serde_json::Value::as_str) != Some("openclaw") {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            let deletion_root = link.canonicalize()?;
            let boundary = node_modules.canonicalize()?;
            safe_remove_tree(&boundary, &deletion_root, &link).map_err(link_error)?;
        }
        Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    create_host_link(&root, &link)?;
    if link.canonicalize()? != root {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(())
}

#[cfg(unix)]
fn create_host_link(root: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(root, link)
}

#[cfg(windows)]
fn create_host_link(root: &Path, link: &Path) -> io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT},
        System::IO::DeviceIoControl,
    };

    // Match Node's junction semantics: directory symlinks require privileges
    // that ordinary Windows installations do not have.
    let canonical = root.as_os_str().encode_wide().collect::<Vec<_>>();
    let mut substitute = "\\??\\".encode_utf16().collect::<Vec<_>>();
    let prefix = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
    substitute.extend_from_slice(
        canonical
            .strip_prefix(prefix.as_slice())
            .unwrap_or(&canonical),
    );
    let name_bytes = substitute.len() * 2;
    let data_len = 8 + name_bytes + 4;
    let data_len =
        u16::try_from(data_len).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut buffer = Vec::with_capacity(8 + usize::from(data_len));
    buffer.extend_from_slice(&0xa0000003_u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
    for value in [
        data_len,
        0,
        0,
        name_bytes as u16,
        (name_bytes + 2) as u16,
        0,
    ] {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    for character in substitute.into_iter().chain([0, 0]) {
        buffer.extend_from_slice(&character.to_le_bytes());
    }
    fs::create_dir(link)?;
    let result = (|| {
        let directory = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(link)?;
        let mut returned = 0;
        // The buffer is a bounded REPARSE_DATA_BUFFER mount-point payload;
        // directory owns the handle for the duration of this synchronous call.
        let success = unsafe {
            DeviceIoControl(
                directory.as_raw_handle(),
                0x000900a4, // FSCTL_SET_REPARSE_POINT
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir(link);
    }
    result
}
