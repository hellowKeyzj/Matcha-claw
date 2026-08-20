use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use super::SkillInputError;
use crate::lifecycle::state_dir::CanonicalStateDir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

const SKILL_MANIFEST: &str = "SKILL.md";
const MANAGED_MARKER: &str = ".matchaclaw-managed";
const MAX_BUNDLES: usize = 32;
const MAX_FILES_PER_BUNDLE: usize = 64;
// This owner shares the provider-model loopback listener, whose request ceiling is
// 64 KiB. Leave room for JSON structure and file paths.
const MAX_FILE_BYTES: usize = 48 * 1024;
const MAX_BUNDLE_BYTES: usize = 48 * 1024;
const MAX_TOTAL_BYTES: usize = 48 * 1024;
const MAX_PATH_BYTES: usize = 240;
const MAX_SKILL_KEY_BYTES: usize = 96;
const MAX_EXPORT_DEPTH: usize = 8;
const MAX_EXPORT_FILES: usize = 64;
const MAX_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 256;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_UPLOAD_SESSIONS: usize = 8;
const UPLOAD_TTL_MILLIS: u64 = 15 * 60 * 1_000;
const UPLOAD_DIR: &str = ".uploads";
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(1);

/// Sealed export DTO containing only validated bundle content.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundle {
    skill_key: String,
    files: Vec<SkillBundleFile>,
}

impl SkillBundle {
    pub fn try_new(skill_key: String, files: Vec<SkillBundleFile>) -> Result<Self, BundleError> {
        let mut bundles = normalize_bundles(vec![Self { skill_key, files }])?;
        bundles.pop().ok_or(BundleError::Rejected)
    }

    /// Converts a standalone `SKILL.md` document into the same contained bundle
    /// DTO used for directory imports. The manifest owns the normalized key.
    pub fn from_markdown(content: String) -> Result<Self, BundleError> {
        let skill_key = manifest_name(&content).ok_or(BundleError::Rejected)?;
        Self::try_new(
            skill_key,
            vec![SkillBundleFile::try_new(SKILL_MANIFEST.into(), content)?],
        )
    }

    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub fn files(&self) -> &[SkillBundleFile] {
        &self.files
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SkillBundleFile {
    path: String,
    content: String,
}

impl SkillBundleFile {
    pub fn try_new(path: String, content: String) -> Result<Self, BundleError> {
        let path = normalize_file_path(path)?;
        if content.len() > MAX_FILE_BYTES {
            return Err(BundleError::Rejected);
        }
        Ok(Self { path, content })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn content(&self) -> &str {
        &self.content
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportOutcome {
    Accepted,
    Rejected,
    Unknown,
}

/// Owns shareable skill-bundle persistence under the configured OpenClaw
/// managed skills root. It never accepts or projects a filesystem path.
pub struct SkillBundleStore {
    state_dir: CanonicalStateDir,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveUploadBegin {
    pub total_bytes: u64,
    pub sha256: String,
    pub force: bool,
    pub now_millis: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveUploadChunk {
    pub upload_id: String,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub now_millis: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveUploadCommit {
    pub upload_id: String,
    pub sha256: Option<String>,
    pub now_millis: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveUploadReceipt {
    pub upload_id: String,
    pub received_bytes: u64,
    pub expires_at: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArchiveUploadOutcome {
    Accepted(ArchiveUploadReceipt),
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillRemoveOutcome {
    Removed,
    NotFound,
    Rejected,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct UploadMeta {
    total_bytes: u64,
    sha256: Option<String>,
    force: bool,
    received_bytes: u64,
    expires_at: u64,
}

impl SkillBundleStore {
    pub fn new(state_dir: CanonicalStateDir) -> Self {
        Self { state_dir }
    }

    pub fn export(&self, requested_keys: Vec<String>) -> Result<Vec<SkillBundle>, BundleError> {
        if self.state_dir.open().is_err() {
            return Err(BundleError::Unknown);
        }
        let requested_keys = normalize_requested_keys(requested_keys)?;
        let root = self.root();
        let root = match fs::symlink_metadata(&root) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => root,
            Ok(_) => return Err(BundleError::Rejected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(BundleError::Unknown),
        };
        let root = fs::canonicalize(root).map_err(|_| BundleError::Unknown)?;
        let mut bundles = Vec::new();
        let mut total_bytes = 0usize;
        for skill_key in requested_keys {
            let skill_dir = root.join(&skill_key);
            let metadata = match fs::symlink_metadata(&skill_dir) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(BundleError::Unknown),
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let skill_dir = fs::canonicalize(skill_dir).map_err(|_| BundleError::Unknown)?;
            if !contained(&root, &skill_dir) {
                continue;
            }
            let files = collect_files(&root, &skill_dir, &mut total_bytes)?;
            if !has_valid_manifest(&files) {
                continue;
            }
            bundles.push(SkillBundle { skill_key, files });
        }
        Ok(bundles)
    }

    pub fn import_markdown(&self, content: String) -> ImportOutcome {
        match SkillBundle::from_markdown(content) {
            Ok(bundle) => self.import(vec![bundle]),
            Err(_) => ImportOutcome::Rejected,
        }
    }

    pub fn import(&self, bundles: Vec<SkillBundle>) -> ImportOutcome {
        if self.state_dir.open().is_err() {
            return ImportOutcome::Unknown;
        }
        let bundles = match normalize_bundles(bundles) {
            Ok(bundles) => bundles,
            Err(_) => return ImportOutcome::Rejected,
        };
        if bundles.is_empty() {
            return ImportOutcome::Accepted;
        }
        let root = self.root();
        if ensure_root(&root).is_err() {
            return ImportOutcome::Unknown;
        }
        let root = match fs::canonicalize(&root) {
            Ok(root) => root,
            Err(_) => return ImportOutcome::Unknown,
        };
        let staging = root.join(format!(".matchaclaw-skill-bundle-{}", next_staging_id()));
        if fs::create_dir(&staging).is_err() {
            return ImportOutcome::Unknown;
        }
        let result = import_all(&root, &staging, bundles);
        let cleanup = fs::remove_dir_all(&staging);
        match (result, cleanup) {
            (Ok(()), Ok(())) => ImportOutcome::Accepted,
            (Err(BundleError::Rejected), Ok(())) => ImportOutcome::Rejected,
            _ => ImportOutcome::Unknown,
        }
    }

    pub fn begin_archive_upload(&self, request: ArchiveUploadBegin) -> ArchiveUploadOutcome {
        if self.state_dir.open().is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        if request.total_bytes == 0 || request.total_bytes > MAX_ARCHIVE_BYTES {
            return ArchiveUploadOutcome::Rejected;
        }
        if !valid_sha256(&request.sha256) {
            return ArchiveUploadOutcome::Rejected;
        }
        let root = self.root();
        if ensure_root(&root).is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        let uploads = root.join(UPLOAD_DIR);
        if fs::create_dir_all(&uploads).is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        cleanup_uploads(&uploads, request.now_millis);
        let count = fs::read_dir(&uploads)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "meta"))
                    .count()
            })
            .unwrap_or(MAX_UPLOAD_SESSIONS + 1);
        if count >= MAX_UPLOAD_SESSIONS {
            return ArchiveUploadOutcome::Rejected;
        }
        let upload_id = format!("upload-{}", next_staging_id());
        let meta = UploadMeta {
            total_bytes: request.total_bytes,
            sha256: Some(request.sha256.to_ascii_lowercase()),
            force: request.force,
            received_bytes: 0,
            expires_at: request.now_millis.saturating_add(UPLOAD_TTL_MILLIS),
        };
        if write_json_atomic(&uploads.join(format!("{upload_id}.meta")), &meta).is_err()
            || File::create(uploads.join(format!("{upload_id}.part"))).is_err()
        {
            return ArchiveUploadOutcome::Unknown;
        }
        ArchiveUploadOutcome::Accepted(receipt(&upload_id, &meta))
    }

    pub fn append_archive_upload(&self, request: ArchiveUploadChunk) -> ArchiveUploadOutcome {
        if self.state_dir.open().is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        if !valid_upload_id(&request.upload_id) {
            return ArchiveUploadOutcome::Rejected;
        }
        let uploads = self.root().join(UPLOAD_DIR);
        let meta_path = uploads.join(format!("{}.meta", request.upload_id));
        let part_path = uploads.join(format!("{}.part", request.upload_id));
        let mut meta = match read_meta(&meta_path) {
            Ok(meta) if request.now_millis <= meta.expires_at => meta,
            _ => return ArchiveUploadOutcome::Rejected,
        };
        if request.offset != meta.received_bytes
            || request.bytes.is_empty()
            || meta
                .received_bytes
                .saturating_add(request.bytes.len() as u64)
                > meta.total_bytes
        {
            return ArchiveUploadOutcome::Rejected;
        }
        let mut part = match OpenOptions::new().append(true).open(&part_path) {
            Ok(part) => part,
            Err(_) => return ArchiveUploadOutcome::Unknown,
        };
        if part.write_all(&request.bytes).is_err() || part.sync_data().is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        meta.received_bytes += request.bytes.len() as u64;
        if write_json_atomic(&meta_path, &meta).is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        ArchiveUploadOutcome::Accepted(receipt(&request.upload_id, &meta))
    }

    pub fn commit_archive_upload(&self, request: ArchiveUploadCommit) -> ArchiveUploadOutcome {
        if self.state_dir.open().is_err() {
            return ArchiveUploadOutcome::Unknown;
        }
        if !valid_upload_id(&request.upload_id) {
            return ArchiveUploadOutcome::Rejected;
        }
        let uploads = self.root().join(UPLOAD_DIR);
        let meta_path = uploads.join(format!("{}.meta", request.upload_id));
        let part_path = uploads.join(format!("{}.part", request.upload_id));
        let meta = match read_meta(&meta_path) {
            Ok(meta) if request.now_millis <= meta.expires_at => meta,
            _ => return ArchiveUploadOutcome::Rejected,
        };
        if meta.received_bytes != meta.total_bytes {
            return ArchiveUploadOutcome::Rejected;
        }
        let bytes = match fs::read(&part_path) {
            Ok(bytes) if bytes.len() as u64 == meta.total_bytes => bytes,
            _ => return ArchiveUploadOutcome::Unknown,
        };
        let digest = hex_digest(&bytes);
        let explicit_sha256 = request.sha256.as_deref().map(str::to_ascii_lowercase);
        let expected_sha256 = explicit_sha256.as_deref().or(meta.sha256.as_deref());
        if request
            .sha256
            .as_deref()
            .is_some_and(|sha256| !valid_sha256(sha256))
            || expected_sha256.is_some_and(|sha256| digest != sha256)
        {
            return ArchiveUploadOutcome::Rejected;
        }
        let bundles = match parse_archive(&bytes) {
            Ok(bundles) => bundles,
            Err(_) => return ArchiveUploadOutcome::Rejected,
        };
        let outcome = self.import_with_force(bundles, meta.force);
        let mut meta = meta;
        meta.sha256 = Some(explicit_sha256.unwrap_or(digest));
        match outcome {
            ImportOutcome::Accepted => {
                let _ = fs::remove_file(meta_path);
                let _ = fs::remove_file(part_path);
                ArchiveUploadOutcome::Accepted(receipt(&request.upload_id, &meta))
            }
            ImportOutcome::Rejected => ArchiveUploadOutcome::Rejected,
            ImportOutcome::Unknown => ArchiveUploadOutcome::Unknown,
        }
    }

    pub fn remove(&self, skill_key: String) -> SkillRemoveOutcome {
        if self.state_dir.open().is_err() {
            return SkillRemoveOutcome::Unknown;
        }
        let key = match normalize_skill_key(skill_key) {
            Ok(key) => key,
            Err(_) => return SkillRemoveOutcome::Rejected,
        };
        let root = self.root();
        let target = root.join(&key);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if !is_managed_skill(&target, &key) {
                    return SkillRemoveOutcome::Rejected;
                }
                fs::remove_dir_all(target)
                    .map(|_| SkillRemoveOutcome::Removed)
                    .unwrap_or(SkillRemoveOutcome::Unknown)
            }
            Ok(_) => SkillRemoveOutcome::Rejected,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                SkillRemoveOutcome::NotFound
            }
            Err(_) => SkillRemoveOutcome::Unknown,
        }
    }

    fn import_with_force(&self, bundles: Vec<SkillBundle>, force: bool) -> ImportOutcome {
        if !force {
            return self.import(bundles);
        }
        let bundles = match normalize_bundles(bundles) {
            Ok(bundles) => bundles,
            Err(_) => return ImportOutcome::Rejected,
        };
        let root = self.root();
        if ensure_root(&root).is_err() {
            return ImportOutcome::Unknown;
        }
        let staging = root.join(format!(".matchaclaw-skill-force-{}", next_staging_id()));
        if fs::create_dir(&staging).is_err() {
            return ImportOutcome::Unknown;
        }
        let result = stage_bundles(&staging, bundles.clone())
            .and_then(|_| publish_force(&root, &staging, &bundles));
        let _ = fs::remove_dir_all(&staging);
        result.unwrap_or(ImportOutcome::Unknown)
    }

    fn root(&self) -> PathBuf {
        self.state_dir.as_path().join("skills")
    }
}

impl fmt::Debug for SkillBundleStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillBundleStore([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BundleError {
    Rejected,
    Unknown,
}

impl From<SkillInputError> for BundleError {
    fn from(_: SkillInputError) -> Self {
        Self::Rejected
    }
}

fn is_managed_skill(path: &Path, skill_key: &str) -> bool {
    let marker = path.join(MANAGED_MARKER);
    let Ok(metadata) = fs::symlink_metadata(&marker) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(contents) = fs::read_to_string(marker) else {
        return false;
    };
    let mut lines = contents.lines();
    lines.next() == Some(skill_key) && lines.next() == Some("managed") && lines.next().is_none()
}

fn normalize_requested_keys(keys: Vec<String>) -> Result<Vec<String>, BundleError> {
    if keys.len() > MAX_BUNDLES {
        return Err(BundleError::Rejected);
    }
    let mut normalized = BTreeSet::new();
    for key in keys {
        normalized.insert(normalize_skill_key(key)?);
    }
    Ok(normalized.into_iter().collect())
}

fn normalize_bundles(bundles: Vec<SkillBundle>) -> Result<Vec<SkillBundle>, BundleError> {
    if bundles.len() > MAX_BUNDLES {
        return Err(BundleError::Rejected);
    }
    let mut normalized = BTreeMap::new();
    let mut total_bytes = 0usize;
    for bundle in bundles {
        let skill_key = normalize_skill_key(bundle.skill_key)?;
        if normalized.contains_key(&skill_key)
            || bundle.files.is_empty()
            || bundle.files.len() > MAX_FILES_PER_BUNDLE
        {
            return Err(BundleError::Rejected);
        }
        let mut files = BTreeMap::new();
        let mut bundle_bytes = 0usize;
        for file in bundle.files {
            let path = normalize_file_path(file.path)?;
            let bytes = file.content.len();
            if bytes > MAX_FILE_BYTES || files.insert(path, file.content).is_some() {
                return Err(BundleError::Rejected);
            }
            bundle_bytes = bundle_bytes
                .checked_add(bytes)
                .ok_or(BundleError::Rejected)?;
            total_bytes = total_bytes
                .checked_add(bytes)
                .ok_or(BundleError::Rejected)?;
        }
        if bundle_bytes > MAX_BUNDLE_BYTES || total_bytes > MAX_TOTAL_BYTES {
            return Err(BundleError::Rejected);
        }
        let files = files
            .into_iter()
            .map(|(path, content)| SkillBundleFile { path, content })
            .collect::<Vec<_>>();
        if files.iter().any(|file| file.path == MANAGED_MARKER) {
            return Err(BundleError::Rejected);
        }
        if !has_valid_manifest(&files) {
            return Err(BundleError::Rejected);
        }
        normalized.insert(skill_key, files);
    }
    Ok(normalized
        .into_iter()
        .map(|(skill_key, files)| SkillBundle { skill_key, files })
        .collect())
}

fn import_all(root: &Path, staging: &Path, bundles: Vec<SkillBundle>) -> Result<(), BundleError> {
    let mut staged = Vec::new();
    for bundle in &bundles {
        let target = root.join(bundle.skill_key());
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err(BundleError::Rejected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(BundleError::Unknown),
        }
        let directory = staging.join(bundle.skill_key());
        fs::create_dir(&directory).map_err(|_| BundleError::Unknown)?;
        fs::write(
            directory.join(MANAGED_MARKER),
            format!("{}\nmanaged\n", bundle.skill_key()),
        )
        .map_err(|_| BundleError::Unknown)?;
        for file in bundle.files() {
            let path = directory.join(file.path());
            let parent = path.parent().ok_or(BundleError::Unknown)?;
            fs::create_dir_all(parent).map_err(|_| BundleError::Unknown)?;
            fs::write(path, file.content()).map_err(|_| BundleError::Unknown)?;
        }
        staged.push((directory, target));
    }
    publish_staged(staged)
}

fn publish_staged(staged: Vec<(PathBuf, PathBuf)>) -> Result<(), BundleError> {
    for (_, target) in &staged {
        match fs::symlink_metadata(target) {
            Ok(_) => return Err(BundleError::Rejected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(BundleError::Unknown),
        }
    }
    let mut published = Vec::new();
    for (directory, target) in staged {
        match fs::rename(&directory, &target) {
            Ok(()) => published.push(target),
            Err(_) => {
                return match rollback_published(&published) {
                    Ok(()) => Err(BundleError::Unknown),
                    Err(()) => Err(BundleError::Unknown),
                };
            }
        }
    }
    Ok(())
}

fn rollback_published(published: &[PathBuf]) -> Result<(), ()> {
    for directory in published.iter().rev() {
        let metadata = fs::symlink_metadata(directory).map_err(|_| ())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(());
        }
        fs::remove_dir_all(directory).map_err(|_| ())?;
    }
    Ok(())
}

fn receipt(upload_id: &str, meta: &UploadMeta) -> ArchiveUploadReceipt {
    ArchiveUploadReceipt {
        upload_id: upload_id.to_owned(),
        received_bytes: meta.received_bytes,
        expires_at: meta.expires_at,
        sha256: meta.sha256.clone().unwrap_or_default(),
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_upload_id(value: &str) -> bool {
    value.starts_with("upload-")
        && value.len() <= 40
        && value[7..].bytes().all(|byte| byte.is_ascii_digit())
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_meta(path: &Path) -> Result<UploadMeta, BundleError> {
    let bytes = fs::read(path).map_err(|_| BundleError::Unknown)?;
    serde_json::from_slice(&bytes).map_err(|_| BundleError::Rejected)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), BundleError> {
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(|_| BundleError::Unknown)?;
    fs::write(&temp, bytes).map_err(|_| BundleError::Unknown)?;
    fs::rename(&temp, path).map_err(|_| BundleError::Unknown)
}

fn cleanup_uploads(root: &Path, now: u64) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "meta")
            && read_meta(&path)
                .map(|meta| meta.expires_at < now)
                .unwrap_or(true)
        {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("part"));
        }
    }
}

fn parse_archive(bytes: &[u8]) -> Result<Vec<SkillBundle>, BundleError> {
    let mut archive =
        ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| BundleError::Rejected)?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_FILES {
        return Err(BundleError::Rejected);
    }
    let mut files = Vec::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| BundleError::Rejected)?;
        if entry.is_dir() || entry.name().contains('\\') || entry.name().contains('\0') {
            return Err(BundleError::Rejected);
        }
        let path =
            normalize_file_path(entry.name().to_owned()).map_err(|_| BundleError::Rejected)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(BundleError::Rejected);
        }
        let size = entry.size();
        total = total.checked_add(size).ok_or(BundleError::Rejected)?;
        if size > MAX_FILE_BYTES as u64 || total > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(BundleError::Rejected);
        }
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|_| BundleError::Rejected)?;
        let content = String::from_utf8(content).map_err(|_| BundleError::Rejected)?;
        if files
            .iter()
            .any(|file: &SkillBundleFile| file.path() == path)
        {
            return Err(BundleError::Rejected);
        }
        files.push(SkillBundleFile::try_new(path, content).map_err(|_| BundleError::Rejected)?);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest_count = files
        .iter()
        .filter(|file| file.path == SKILL_MANIFEST)
        .count();
    if manifest_count != 1
        || files.iter().any(|file| file.path == MANAGED_MARKER)
        || !has_valid_manifest(&files)
    {
        return Err(BundleError::Rejected);
    }
    let manifest = files
        .iter()
        .find(|file| file.path == SKILL_MANIFEST)
        .ok_or(BundleError::Rejected)?;
    let skill_key = manifest_name(manifest.content()).ok_or(BundleError::Rejected)?;
    Ok(vec![SkillBundle { skill_key, files }])
}

fn manifest_name(content: &str) -> Option<String> {
    let frontmatter = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let frontmatter = frontmatter
        .split_once("\n---")
        .or_else(|| frontmatter.split_once("\r\n---"))?
        .0;
    let document: serde_yaml::Value = serde_yaml::from_str(frontmatter).ok()?;
    let name = document.get("name")?.as_str()?.trim();
    let normalized = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    normalize_skill_key(normalized).ok()
}

fn stage_bundles(staging: &Path, bundles: Vec<SkillBundle>) -> Result<(), BundleError> {
    for bundle in bundles {
        let directory = staging.join(bundle.skill_key());
        fs::create_dir(&directory).map_err(|_| BundleError::Unknown)?;
        fs::write(
            directory.join(MANAGED_MARKER),
            format!("{}\nmanaged\n", bundle.skill_key()),
        )
        .map_err(|_| BundleError::Unknown)?;
        for file in bundle.files() {
            let path = directory.join(file.path());
            fs::create_dir_all(path.parent().ok_or(BundleError::Unknown)?)
                .map_err(|_| BundleError::Unknown)?;
            fs::write(path, file.content()).map_err(|_| BundleError::Unknown)?;
        }
    }
    Ok(())
}

fn publish_force(
    root: &Path,
    staging: &Path,
    bundles: &[SkillBundle],
) -> Result<ImportOutcome, BundleError> {
    let backup = root.join(format!(".matchaclaw-skill-backup-{}", next_staging_id()));
    fs::create_dir(&backup).map_err(|_| BundleError::Unknown)?;

    let mut existing = Vec::new();
    for bundle in bundles {
        let target = root.join(bundle.skill_key());
        match fs::symlink_metadata(&target) {
            Ok(metadata)
                if metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && is_managed_skill(&target, bundle.skill_key()) =>
            {
                existing.push((bundle.skill_key().to_owned(), target));
            }
            Ok(_) => {
                let _ = fs::remove_dir_all(&backup);
                return Err(BundleError::Rejected);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                let _ = fs::remove_dir_all(&backup);
                return Err(BundleError::Unknown);
            }
        }
    }

    let mut moved = Vec::new();
    for (skill_key, target) in existing {
        let saved = backup.join(&skill_key);
        if fs::rename(&target, &saved).is_err() {
            rollback_force(&moved, &[], &backup);
            return Ok(ImportOutcome::Unknown);
        }
        moved.push((saved, target));
    }

    let mut published = Vec::new();
    for bundle in bundles {
        let target = root.join(bundle.skill_key());
        if fs::rename(staging.join(bundle.skill_key()), &target).is_err() {
            rollback_force(&moved, &published, &backup);
            return Ok(ImportOutcome::Unknown);
        }
        published.push(target);
    }

    if fs::remove_dir_all(&backup).is_err() {
        rollback_force(&moved, &published, &backup);
        return Ok(ImportOutcome::Unknown);
    }
    Ok(ImportOutcome::Accepted)
}

fn rollback_force(moved: &[(PathBuf, PathBuf)], published: &[PathBuf], backup: &Path) {
    for target in published.iter().rev() {
        let _ = fs::remove_dir_all(target);
    }
    for (saved, target) in moved.iter().rev() {
        let _ = fs::rename(saved, target);
    }
    let _ = fs::remove_dir_all(backup);
}

fn ensure_root(root: &Path) -> Result<(), BundleError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(BundleError::Unknown),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(root).map_err(|_| BundleError::Unknown)
        }
        Err(_) => Err(BundleError::Unknown),
    }
}

fn collect_files(
    root: &Path,
    directory: &Path,
    total_bytes: &mut usize,
) -> Result<Vec<SkillBundleFile>, BundleError> {
    collect_files_at(root, directory, directory, 0, total_bytes)
}

fn collect_files_at(
    root: &Path,
    directory: &Path,
    current: &Path,
    depth: usize,
    total_bytes: &mut usize,
) -> Result<Vec<SkillBundleFile>, BundleError> {
    if depth > MAX_EXPORT_DEPTH {
        return Err(BundleError::Rejected);
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(current).map_err(|_| BundleError::Unknown)? {
        let entry = entry.map_err(|_| BundleError::Unknown)?;
        if entry.file_name() == std::ffi::OsStr::new(MANAGED_MARKER) {
            continue;
        }
        let metadata = entry.metadata().map_err(|_| BundleError::Unknown)?;
        if metadata.file_type().is_symlink() {
            return Err(BundleError::Rejected);
        }
        let path = entry.path();
        let canonical = fs::canonicalize(&path).map_err(|_| BundleError::Unknown)?;
        if !contained(root, &canonical) || !contained(directory, &canonical) {
            return Err(BundleError::Rejected);
        }
        if metadata.is_dir() {
            files.extend(collect_files_at(
                root,
                directory,
                &canonical,
                depth + 1,
                total_bytes,
            )?);
            continue;
        }
        if !metadata.is_file()
            || files.len() >= MAX_EXPORT_FILES
            || metadata.len() > MAX_FILE_BYTES as u64
        {
            return Err(BundleError::Rejected);
        }
        let content = fs::read_to_string(&canonical).map_err(|_| BundleError::Rejected)?;
        let bytes = content.len();
        *total_bytes = total_bytes
            .checked_add(bytes)
            .ok_or(BundleError::Rejected)?;
        if *total_bytes > MAX_TOTAL_BYTES {
            return Err(BundleError::Rejected);
        }
        let path = canonical
            .strip_prefix(directory)
            .map_err(|_| BundleError::Rejected)?
            .to_string_lossy()
            .replace('\\', "/");
        files.push(SkillBundleFile::try_new(path, content)?);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn normalize_skill_key(value: String) -> Result<String, BundleError> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > MAX_SKILL_KEY_BYTES
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
        || value.ends_with('-')
    {
        return Err(BundleError::Rejected);
    }
    Ok(value)
}

fn normalize_file_path(value: String) -> Result<String, BundleError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains('\\')
        || value.starts_with('/')
    {
        return Err(BundleError::Rejected);
    }
    let path = Path::new(&value);
    let mut components = path.components();
    if components.any(|component| !matches!(component, Component::Normal(_))) {
        return Err(BundleError::Rejected);
    }
    if value.split('/').any(str::is_empty) {
        return Err(BundleError::Rejected);
    }
    Ok(value)
}

fn has_valid_manifest(files: &[SkillBundleFile]) -> bool {
    let Some(manifest) = files.iter().find(|file| file.path == SKILL_MANIFEST) else {
        return false;
    };
    let Some(frontmatter) = manifest
        .content
        .strip_prefix("---\n")
        .or_else(|| manifest.content.strip_prefix("---\r\n"))
        .and_then(|content| {
            content
                .split_once("\n---")
                .or_else(|| content.split_once("\r\n---"))
        })
        .map(|(frontmatter, _)| frontmatter)
    else {
        return false;
    };
    let has_name = frontmatter.lines().any(|line| nonempty_field(line, "name"));
    let has_description = frontmatter
        .lines()
        .any(|line| nonempty_field(line, "description"));
    has_name && has_description
}

fn nonempty_field(line: &str, field: &str) -> bool {
    line.strip_prefix(field)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|value| !value.trim().trim_matches(['\'', '"']).is_empty())
}

fn contained(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root) && candidate != root
}

fn next_staging_id() -> u64 {
    NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{Cursor, Write as _},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct Root(PathBuf);

    impl Root {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "matchaclaw-openclaw-skill-bundle-{}",
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in entries {
            archive
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn bundle() -> SkillBundle {
        SkillBundle::try_new(
            "web-search".into(),
            vec![
                SkillBundleFile::try_new(
                    "SKILL.md".into(),
                    "---\nname: web-search\ndescription: Search the web\n---\n".into(),
                )
                .unwrap(),
            ],
        )
        .unwrap()
    }

    #[test]
    fn imports_only_valid_contained_bundles_without_path_projection() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());

        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        let exported = store.export(vec!["web-search".into()]).unwrap();

        assert_eq!(exported, vec![bundle()]);
        assert!(!format!("{store:?}").contains(root.0.to_string_lossy().as_ref()));
        assert_eq!(
            serde_json::to_value(&exported).unwrap(),
            serde_json::json!([{
                "skillKey": "web-search",
                "files": [{
                    "path": "SKILL.md",
                    "content": "---\nname: web-search\ndescription: Search the web\n---\n",
                }],
            }])
        );
        assert!(
            !serde_json::to_string(&exported)
                .unwrap()
                .contains(root.0.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn rejects_paths_and_missing_manifests_before_writing() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        assert!(SkillBundleFile::try_new("../secret".into(), "x".into()).is_err());
        assert!(
            SkillBundle::try_new(
                "missing".into(),
                vec![SkillBundleFile::try_new("README.md".into(), "x".into()).unwrap()],
            )
            .is_err()
        );
        assert!(store.export(vec!["web-search".into()]).unwrap().is_empty());
    }

    #[test]
    fn rolls_back_already_published_bundles_when_a_later_publish_fails() {
        let root = Root::new();
        let staging = root.0.join("staging");
        let published = root.0.join("published");
        let missing = staging.join("missing");
        let first_staged = staging.join("first");
        let first_target = published.join("first");
        let second_target = published.join("second");
        fs::create_dir(&staging).unwrap();
        fs::create_dir(&published).unwrap();
        fs::create_dir(&first_staged).unwrap();
        fs::write(first_staged.join(SKILL_MANIFEST), "skill").unwrap();

        assert_eq!(
            publish_staged(vec![
                (first_staged, first_target.clone()),
                (missing, second_target)
            ]),
            Err(BundleError::Unknown),
        );
        assert!(!first_target.exists());
        assert!(staging.exists());
    }

    #[test]
    fn existing_skill_is_rejected_without_overwrite() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Rejected);
    }

    #[test]
    fn remove_rejects_unmanaged_skill_and_accepts_only_owned_marker() {
        let root = Root::new();
        let state_dir = root.state_dir();
        let store = SkillBundleStore::new(state_dir.clone());
        let target = state_dir.as_path().join("skills/web-search");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(SKILL_MANIFEST), bundle().files()[0].content()).unwrap();
        assert_eq!(
            store.remove("web-search".into()),
            SkillRemoveOutcome::Rejected
        );
        assert!(target.exists());

        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Rejected);
        fs::remove_dir_all(&target).unwrap();
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        assert_eq!(
            store.remove("web-search".into()),
            SkillRemoveOutcome::Removed
        );
    }

    #[test]
    fn export_excludes_internal_managed_marker() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        let target = root.0.join("state/skills/web-search");
        assert!(target.join(MANAGED_MARKER).exists());
        let exported = store.export(vec!["web-search".into()]).unwrap();
        assert_eq!(exported, vec![bundle()]);
        assert!(
            exported[0]
                .files()
                .iter()
                .all(|file| file.path() != MANAGED_MARKER)
        );
    }

    #[test]
    fn import_rejects_the_entire_batch_when_any_target_exists() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        let another = SkillBundle::try_new(
            "another-skill".into(),
            vec![
                SkillBundleFile::try_new(
                    "SKILL.md".into(),
                    "---\nname: another-skill\ndescription: Another skill\n---\n".into(),
                )
                .unwrap(),
            ],
        )
        .unwrap();

        assert_eq!(store.import(vec![another]), ImportOutcome::Accepted);
        assert_eq!(
            store.import(vec![
                bundle(),
                SkillBundle::try_new(
                    "third-skill".into(),
                    vec![
                        SkillBundleFile::try_new(
                            "SKILL.md".into(),
                            "---\nname: third-skill\ndescription: Third skill\n---\n".into(),
                        )
                        .unwrap()
                    ],
                )
                .unwrap()
            ]),
            ImportOutcome::Rejected,
        );
        assert!(store.export(vec!["third-skill".into()]).unwrap().is_empty());
    }

    #[test]
    fn archive_upload_persists_receipts_verifies_digest_and_removes_skill() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        let archive = archive(&[(
            "SKILL.md",
            "---\nname: web-search\ndescription: Search the web\n---\n",
        )]);
        let digest = hex_digest(&archive);
        let ArchiveUploadOutcome::Accepted(begin) =
            store.begin_archive_upload(ArchiveUploadBegin {
                total_bytes: archive.len() as u64,
                sha256: digest.clone(),
                force: false,
                now_millis: 10,
            })
        else {
            panic!("begin must succeed")
        };
        assert_eq!(begin.received_bytes, 0);
        let ArchiveUploadOutcome::Accepted(chunk) =
            store.append_archive_upload(ArchiveUploadChunk {
                upload_id: begin.upload_id.clone(),
                offset: 0,
                bytes: archive,
                now_millis: 11,
            })
        else {
            panic!("chunk must succeed")
        };
        assert!(chunk.received_bytes > 0);
        assert_eq!(chunk.sha256, digest);
        assert!(matches!(
            store.commit_archive_upload(ArchiveUploadCommit {
                upload_id: begin.upload_id,
                sha256: Some(digest.clone()),
                now_millis: 12,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        assert_eq!(
            store.remove("web-search".into()),
            SkillRemoveOutcome::Removed
        );
        assert_eq!(
            store.remove("web-search".into()),
            SkillRemoveOutcome::NotFound
        );
    }

    #[test]
    fn markdown_import_uses_manifest_name_and_preserves_bundle_content() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        let markdown = "---\nname: Web Search\ndescription: Search the web\n---\n# Search\n";
        assert_eq!(
            store.import_markdown(markdown.to_owned()),
            ImportOutcome::Accepted
        );
        let bundles = store.export(vec![" WEB-SEARCH ".into()]).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].skill_key(), "web-search");
        assert_eq!(bundles[0].files()[0].content(), markdown);
        assert!(!format!("{:?}", store).contains(root.0.to_string_lossy().as_ref()));
    }

    #[test]
    fn archive_upload_rejects_bad_commit_digest_without_losing_recoverable_upload() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        let archive = archive(&[(
            "SKILL.md",
            "---\nname: web-search\ndescription: Search the web\n---\n",
        )]);
        let digest = hex_digest(&archive);
        let ArchiveUploadOutcome::Accepted(begin) =
            store.begin_archive_upload(ArchiveUploadBegin {
                total_bytes: archive.len() as u64,
                sha256: digest.clone(),
                force: false,
                now_millis: 10,
            })
        else {
            panic!("begin must succeed")
        };
        assert!(matches!(
            store.append_archive_upload(ArchiveUploadChunk {
                upload_id: begin.upload_id.clone(),
                offset: 0,
                bytes: archive,
                now_millis: 11,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        assert_eq!(
            store.commit_archive_upload(ArchiveUploadCommit {
                upload_id: begin.upload_id.clone(),
                sha256: Some("0".repeat(64)),
                now_millis: 12,
            }),
            ArchiveUploadOutcome::Rejected
        );
        assert!(store.export(vec!["web-search".into()]).unwrap().is_empty());
        assert!(matches!(
            store.commit_archive_upload(ArchiveUploadCommit {
                upload_id: begin.upload_id,
                sha256: Some(digest),
                now_millis: 13,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        assert_eq!(
            store.export(vec!["web-search".into()]).unwrap(),
            vec![bundle()]
        );
    }

    #[test]
    fn archive_upload_rejects_traversal_digest_mismatch_and_conflict_without_force() {
        let root = Root::new();
        let store = SkillBundleStore::new(root.state_dir());
        let initial_archive = archive(&[(
            "../SKILL.md",
            "---\nname: web-search\ndescription: Search the web\n---\n",
        )]);
        let ArchiveUploadOutcome::Accepted(begin) =
            store.begin_archive_upload(ArchiveUploadBegin {
                total_bytes: initial_archive.len() as u64,
                sha256: hex_digest(&initial_archive),
                force: false,
                now_millis: 10,
            })
        else {
            panic!("begin must succeed")
        };
        assert!(matches!(
            store.append_archive_upload(ArchiveUploadChunk {
                upload_id: begin.upload_id.clone(),
                offset: 0,
                bytes: initial_archive,
                now_millis: 11,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        assert_eq!(
            store.commit_archive_upload(ArchiveUploadCommit {
                upload_id: begin.upload_id,
                sha256: None,
                now_millis: 12,
            }),
            ArchiveUploadOutcome::Rejected
        );
        assert_eq!(store.import(vec![bundle()]), ImportOutcome::Accepted);
        let updated_archive = archive(&[(
            "SKILL.md",
            "---\nname: web-search\ndescription: Updated\n---\n",
        )]);
        let ArchiveUploadOutcome::Accepted(begin) =
            store.begin_archive_upload(ArchiveUploadBegin {
                total_bytes: updated_archive.len() as u64,
                sha256: hex_digest(&updated_archive),
                force: true,
                now_millis: 20,
            })
        else {
            panic!("begin must succeed")
        };
        assert!(matches!(
            store.append_archive_upload(ArchiveUploadChunk {
                upload_id: begin.upload_id.clone(),
                offset: 0,
                bytes: updated_archive,
                now_millis: 21,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        assert!(matches!(
            store.commit_archive_upload(ArchiveUploadCommit {
                upload_id: begin.upload_id,
                sha256: None,
                now_millis: 22,
            }),
            ArchiveUploadOutcome::Accepted(_)
        ));
        let bundles = store.export(vec!["web-search".into()]).unwrap();
        assert_eq!(bundles.len(), 1);
        assert!(
            bundles[0].files()[0]
                .content()
                .contains("description: Updated")
        );
    }
}
