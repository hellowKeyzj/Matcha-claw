use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::de::DeserializeOwned;

use crate::domain::{
    WikiFailure, normalize_relative_path, resolve_project_path, stable_content_hash,
};

use super::{WikiFileHistoryEntry, WikiFileHistorySettings};

pub(super) const MAX_CONTENT_BYTES: u64 = 512 * 1024;
const MAX_STORE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STORE_FILES: usize = 2_048;
const METADATA_DIR: &str = ".llm-wiki";
const HISTORY_DIR: &str = ".llm-wiki/history";
const SETTINGS_FILE: &str = ".llm-wiki/history-settings.json";
static VERSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn checked_root(root: &Path) -> Result<PathBuf, WikiFailure> {
    let root = root.canonicalize().map_err(|error| io(root, error))?;
    check_directory(&root.join(METADATA_DIR))?;
    Ok(root)
}

pub(super) fn checked_file(root: &Path, relative_path: &str) -> Result<PathBuf, WikiFailure> {
    let path = resolve_project_path(root, relative_path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| io(&path, error))?;
    if metadata.file_type().is_symlink() {
        return Err(WikiFailure::invalid_path(relative_path));
    }
    if !metadata.is_file() {
        return Err(WikiFailure::IsDirectory {
            path: relative_path.to_owned(),
        });
    }
    let canonical = path.canonicalize().map_err(|error| io(&path, error))?;
    if !canonical.starts_with(root) || canonical.starts_with(root.join(METADATA_DIR)) {
        return Err(WikiFailure::PathOutsideProject {
            path: relative_path.to_owned(),
        });
    }
    Ok(canonical)
}

pub(super) fn relative_path(root: &Path, file: &Path) -> String {
    normalize_relative_path(file.strip_prefix(root).expect("checked project file"))
}

pub(super) fn directory(root: &Path, create: bool) -> Result<PathBuf, WikiFailure> {
    let dir = root.join(HISTORY_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(_) => check_directory(&dir)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if create {
                fs::create_dir(&dir).map_err(|error| io(&dir, error))?;
            }
        }
        Err(error) => return Err(io(&dir, error)),
    }
    Ok(dir)
}

fn check_directory(path: &Path) -> Result<(), WikiFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io(path, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(WikiFailure::invalid_input(
            "path",
            "History directory must be a real project directory, not a symlink",
        ));
    }
    Ok(())
}

pub(super) fn check_optional_file(path: &Path) -> Result<(), WikiFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(WikiFailure::invalid_input(
            "path",
            "History store must be a regular file, not a symlink",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(path, error)),
    }
}

pub(super) fn history_path(root: &Path, file: &Path) -> Result<PathBuf, WikiFailure> {
    let relative = file
        .strip_prefix(root)
        .expect("checked project file")
        .to_string_lossy();
    let key = stable_content_hash(relative.as_bytes());
    let path = root.join(HISTORY_DIR).join(format!("{key}.json"));
    check_optional_file(&path)?;
    Ok(path)
}

pub(super) fn read_entries(path: &Path) -> Result<Vec<WikiFileHistoryEntry>, WikiFailure> {
    Ok(read_optional_json(path)?.unwrap_or_default())
}

pub(super) fn read_settings(root: &Path) -> Result<Option<WikiFileHistorySettings>, WikiFailure> {
    read_optional_json(&root.join(SETTINGS_FILE)).map(
        |settings: Option<WikiFileHistorySettings>| {
            settings.map(WikiFileHistorySettings::normalized)
        },
    )
}

fn read_optional_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, WikiFailure> {
    check_optional_file(path)?;
    match fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|_| WikiFailure::state("Invalid file history store")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(path, error)),
    }
}

pub(super) fn write_settings(
    root: &Path,
    settings: &WikiFileHistorySettings,
) -> Result<(), WikiFailure> {
    let path = root.join(SETTINGS_FILE);
    check_optional_file(&path)?;
    let raw = serde_json::to_vec_pretty(settings)
        .map_err(|error| WikiFailure::state(error.to_string()))?;
    write_store(&path, &raw)
}

pub(super) fn write_entries(
    path: &Path,
    entries: &[WikiFileHistoryEntry],
) -> Result<(), WikiFailure> {
    check_optional_file(path)?;
    let raw = serde_json::to_vec(entries).map_err(|error| WikiFailure::state(error.to_string()))?;
    write_store(path, &raw)
}

fn write_store(path: &Path, raw: &[u8]) -> Result<(), WikiFailure> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", version_id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| io(&temporary, error))?;
        file.write_all(raw).map_err(|error| io(&temporary, error))?;
        file.sync_all().map_err(|error| io(&temporary, error))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| io(path, error))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn entry(
    path: String,
    author: &str,
    tool: &str,
    content: String,
) -> WikiFileHistoryEntry {
    WikiFileHistoryEntry {
        id: version_id(),
        path,
        timestamp: chrono::Utc::now().timestamp_millis(),
        author: author.to_owned(),
        tool: tool.to_owned(),
        content,
    }
}

fn version_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = VERSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp:x}-{:x}-{sequence:x}", std::process::id())
}

pub(super) fn retain(entries: &mut Vec<WikiFileHistoryEntry>, limit: usize) {
    if entries.len() > limit {
        entries.drain(..entries.len() - limit);
    }
}

pub(super) fn files(root: &Path) -> Result<Vec<(PathBuf, u64, SystemTime)>, WikiFailure> {
    let dir = directory(root, false)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io(&dir, error)),
    };
    let mut files = Vec::new();
    for item in entries {
        let item = item.map_err(|error| io(&dir, error))?;
        let path = item.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        check_optional_file(&path)?;
        let metadata = item.metadata().map_err(|error| io(&path, error))?;
        files.push((
            path,
            metadata.len(),
            metadata.modified().map_err(|error| io(&dir, error))?,
        ));
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    Ok(files)
}

pub(super) fn prune_store(root: &Path, protected: &Path) -> Result<(), WikiFailure> {
    let files = files(root)?;
    let mut bytes: u64 = files.iter().map(|(_, bytes, _)| *bytes).sum();
    let mut count = files.len();
    for (path, size, _) in files {
        if bytes <= MAX_STORE_BYTES && count <= MAX_STORE_FILES {
            break;
        }
        if path == protected {
            continue;
        }
        fs::remove_file(&path).map_err(|error| io(&path, error))?;
        bytes = bytes.saturating_sub(size);
        count -= 1;
    }
    Ok(())
}

pub(super) fn prune_entries(root: &Path, limit: usize) -> Result<(), WikiFailure> {
    if limit == 0 {
        return clear(root);
    }
    for (path, _, _) in files(root)? {
        let mut entries = read_entries(&path)?;
        if entries.len() > limit {
            retain(&mut entries, limit);
            write_entries(&path, &entries)?;
        }
    }
    Ok(())
}

pub(super) fn clear(root: &Path) -> Result<(), WikiFailure> {
    let dir = directory(root, false)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(&dir, error)),
    }
}

pub(super) fn io(_path: &Path, error: std::io::Error) -> WikiFailure {
    WikiFailure::io(HISTORY_DIR, error)
}
