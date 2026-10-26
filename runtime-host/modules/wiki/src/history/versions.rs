use std::path::Path;

use platform::state_dir::CanonicalStateDir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{
    WikiFailure, normalize_relative_path, safe_relative_path, stable_content_hash,
};

const DIRECTORY: &str = ".llm-wiki/versions";
const MAX_BYTES: usize = 100 * 1024 * 1024;

/// Explicit selection only; neither an omitted version nor `latest` selects current file bytes.
#[derive(Clone, Debug)]
pub struct WikiVersionInput {
    pub project_id: String,
    pub relative_path: String,
    pub version: String,
}

pub enum WikiVersionExport {
    Available(WikiVersionContent),
    VersionContentUnavailable,
}

pub struct WikiVersionContent {
    pub relative_path: String,
    pub version: String,
    pub digest: String,
    pub captured_at_ms: u64,
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Version {
    relative_path: String,
    version: String,
    digest: String,
    size: usize,
    captured_at_ms: u64,
}

fn relative(path: &str) -> Result<String, WikiFailure> {
    let path = normalize_relative_path(&safe_relative_path(path)?);
    if !(path.starts_with("raw/sources/") || (path.starts_with("wiki/") && path.ends_with(".md")))
        || path.split('/').any(|part| part.starts_with('.'))
        || path.starts_with("wiki/media/")
    {
        return Err(WikiFailure::invalid_path(path));
    }
    Ok(path)
}

fn key(path: &str, version: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(path.as_bytes());
    hash.update([0]);
    hash.update(version.as_bytes());
    format!("{:x}.json", hash.finalize())
}

fn unavailable() -> WikiFailure {
    WikiFailure::state("Wiki immutable version custody unavailable")
}

/// Called with the same bytes used by the Wiki revision producer, never a later path reread.
pub(crate) fn capture(root: &Path, path: &str, bytes: &[u8]) -> Result<(), WikiFailure> {
    // Non-material Wiki files keep their existing lifecycle and history semantics.
    if !(path.starts_with("raw/sources/") || (path.starts_with("wiki/") && path.ends_with(".md")))
        || path.starts_with("wiki/media/")
    {
        return Ok(());
    }
    let path = relative(path)?;
    // Existing watcher discovery still skips oversized material instead of failing the whole scan.
    if bytes.len() > MAX_BYTES {
        return Ok(());
    }
    let root = root.canonicalize().map_err(|_| unavailable())?;
    let directory =
        CanonicalStateDir::provision_private(root.join(DIRECTORY)).map_err(|_| unavailable())?;
    let handle = directory.open().map_err(|_| unavailable())?;
    let _lock = handle
        .lock_regular_file("custody.lock")
        .map_err(|_| unavailable())?;
    let version = stable_content_hash(bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let blob_name = format!("{digest}.blob");
    let name = key(&path, &version);
    if let Some(previous) = handle
        .read_regular_file_bounded(&name, 8192)
        .map_err(|_| unavailable())?
    {
        let previous: Version = serde_json::from_slice(&previous).map_err(|_| unavailable())?;
        if previous.relative_path != path
            || previous.version != version
            || previous.digest != digest
            || previous.size != bytes.len()
        {
            return Err(WikiFailure::state("Wiki version identity collision"));
        }
        let stored = handle
            .read_regular_file_bounded(&blob_name, MAX_BYTES)
            .map_err(|_| unavailable())?
            .ok_or_else(unavailable)?;
        if stored != bytes {
            return Err(unavailable());
        }
        return Ok(());
    }
    match handle
        .read_regular_file_bounded(&blob_name, MAX_BYTES)
        .map_err(|_| unavailable())?
    {
        Some(previous) if previous != bytes => return Err(unavailable()),
        Some(_) => {}
        None => handle
            .replace_regular_file_bounded(&blob_name, bytes, MAX_BYTES)
            .map_err(|_| unavailable())?,
    }
    let metadata = Version {
        relative_path: path,
        version,
        digest,
        size: bytes.len(),
        captured_at_ms: crate::domain::now_ms(),
    };
    let metadata = serde_json::to_vec(&metadata).map_err(|_| unavailable())?;
    handle
        .replace_regular_file_bounded(&name, &metadata, 8192)
        .map_err(|_| unavailable())
}

/// Reads only immutable custody or an actual retained legacy text-history entry.
/// A missing binary snapshot is unavailable even when today's source file still exists.
pub(crate) fn export(
    root: &Path,
    input: &WikiVersionInput,
) -> Result<WikiVersionExport, WikiFailure> {
    let path = relative(&input.relative_path)?;
    if input.version.is_empty()
        || input.version.len() > 256
        || input.version.chars().any(char::is_control)
    {
        return Err(WikiFailure::invalid_input(
            "version",
            "Explicit Wiki version is required",
        ));
    }
    let root = root.canonicalize().map_err(|_| unavailable())?;
    let directory = root.join(DIRECTORY);
    match std::fs::symlink_metadata(&directory) {
        Ok(_) => {
            let directory =
                CanonicalStateDir::open_existing(&directory).map_err(|_| unavailable())?;
            if let Some(raw) = directory
                .read_regular_file_bounded(&key(&path, &input.version), 8192)
                .map_err(|_| unavailable())?
            {
                let version: Version = serde_json::from_slice(&raw).map_err(|_| unavailable())?;
                if version.relative_path != path
                    || version.version != input.version
                    || version.size > MAX_BYTES
                    || version.digest.len() != 64
                    || !version
                        .digest
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(unavailable());
                }
                let Some(bytes) = directory
                    .read_regular_file_bounded(&format!("{}.blob", version.digest), MAX_BYTES)
                    .map_err(|_| unavailable())?
                else {
                    return Ok(WikiVersionExport::VersionContentUnavailable);
                };
                if bytes.len() != version.size
                    || format!("{:x}", Sha256::digest(&bytes)) != version.digest
                    || stable_content_hash(&bytes) != version.version
                {
                    return Err(unavailable());
                }
                return Ok(WikiVersionExport::Available(WikiVersionContent {
                    relative_path: path,
                    version: version.version,
                    digest: version.digest,
                    captured_at_ms: version.captured_at_ms,
                    bytes,
                }));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(unavailable()),
    }
    // Legacy history is a real UTF-8 snapshot, not the current file or its modification time.
    let lock = super::project_lock(&root)?;
    let _guard = lock.lock().map_err(|_| unavailable())?;
    super::store::directory(&root, false)?;
    let file = root.join(&path);
    let entries = super::store::read_entries(&super::store::history_path(&root, &file)?)?;
    if let Some(entry) = entries.into_iter().find(|entry| {
        entry.path == path
            && (entry.id == input.version
                || stable_content_hash(entry.content.as_bytes()) == input.version)
    }) {
        let bytes = entry.content.into_bytes();
        return Ok(WikiVersionExport::Available(WikiVersionContent {
            relative_path: path,
            version: input.version.clone(),
            digest: format!("{:x}", Sha256::digest(&bytes)),
            captured_at_ms: entry.timestamp.max(0) as u64,
            bytes,
        }));
    }
    Ok(WikiVersionExport::VersionContentUnavailable)
}
