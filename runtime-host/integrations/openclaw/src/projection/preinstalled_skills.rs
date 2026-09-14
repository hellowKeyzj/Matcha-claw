use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Deserialize;
use serde_json::{Map, Value};

use super::config_store::{OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError};
use crate::lifecycle::state_dir::CanonicalStateDir;

const MANIFEST_PATH: &[&str] = &["resources", "skills", "preinstalled-manifest.json"];
const PACKAGED_SOURCE_ROOT: &[&str] = &["resources", "preinstalled-skills"];
const DEVELOPMENT_SOURCE_ROOT: &[&str] = &["build", "preinstalled-skills"];
const LOCK_FILE: &str = ".preinstalled-lock.json";
const SKILL_FILE: &str = "SKILL.md";
const MARKER_FILE: &str = ".matchaclaw-preinstalled.json";
const MARKER_OWNER: &str = "matchaclaw";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_LOCK_BYTES: u64 = 512 * 1024;
const MAX_MARKER_BYTES: u64 = 16 * 1024;
const MAX_SKILL_FILES: usize = 2048;
const MAX_SKILL_BYTES: u64 = 64 * 1024 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct PreinstalledSkillReconcile {
    pub(crate) installed_slugs: Vec<String>,
    pub(crate) unchanged_slugs: Vec<String>,
    pub(crate) preserved_slugs: Vec<String>,
    pub(crate) auto_enabled_slugs: Vec<String>,
}

impl PreinstalledSkillReconcile {
    fn sort(&mut self) {
        self.installed_slugs.sort();
        self.unchanged_slugs.sort();
        self.preserved_slugs.sort();
        self.auto_enabled_slugs.sort();
    }
}

pub(crate) fn reconcile(
    state_dir: &CanonicalStateDir,
    working_directory: &Path,
) -> Result<PreinstalledSkillReconcile, PreinstalledSkillError> {
    let Some(source_root) = preinstalled_source_root(working_directory)? else {
        return Ok(PreinstalledSkillReconcile::default());
    };
    let manifest = read_manifest(&join_all(working_directory, MANIFEST_PATH))?;
    let lock = read_lock(&source_root.join(LOCK_FILE))?;
    let skills_root = state_dir.as_path().join("skills");
    fs::create_dir_all(&skills_root).map_err(PreinstalledSkillError::io)?;

    let mut seen = BTreeSet::new();
    let mut result = PreinstalledSkillReconcile::default();
    let mut auto_enable = Vec::new();

    for entry in manifest.skills {
        let slug = valid_slug(&entry.slug)
            .then(|| entry.slug.trim().to_owned())
            .ok_or(PreinstalledSkillError::ManifestRejected)?;
        if !seen.insert(slug.clone()) {
            return Err(PreinstalledSkillError::ManifestRejected);
        }
        let version = lock
            .skills
            .get(&slug)
            .filter(|version| valid_version(version))
            .ok_or(PreinstalledSkillError::LockRejected)?;
        match install_one(&skills_root, &source_root, &slug, version)? {
            SkillInstallState::Installed => {
                if entry.auto_enable {
                    auto_enable.push(slug.clone());
                }
                result.installed_slugs.push(slug);
            }
            SkillInstallState::Unchanged => result.unchanged_slugs.push(slug),
            SkillInstallState::Preserved => result.preserved_slugs.push(slug),
        }
    }

    if !auto_enable.is_empty() {
        apply_auto_enable(state_dir, &auto_enable)?;
        result.auto_enabled_slugs = auto_enable;
    }
    result.sort();
    Ok(result)
}

fn preinstalled_source_root(
    working_directory: &Path,
) -> Result<Option<PathBuf>, PreinstalledSkillError> {
    if !working_directory.is_absolute() || !safe_path(working_directory) {
        return Err(PreinstalledSkillError::SourceRejected);
    }
    for relative in [PACKAGED_SOURCE_ROOT, DEVELOPMENT_SOURCE_ROOT] {
        let candidate = join_all(working_directory, relative);
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(PreinstalledSkillError::Io(error)),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PreinstalledSkillError::SourceRejected);
        }
        return candidate
            .canonicalize()
            .map(Some)
            .map_err(PreinstalledSkillError::io);
    }
    Ok(None)
}

fn install_one(
    skills_root: &Path,
    source_root: &Path,
    slug: &str,
    version: &str,
) -> Result<SkillInstallState, PreinstalledSkillError> {
    let source = source_root.join(slug);
    validate_source(&source, source_root)?;
    let target = skills_root.join(slug);
    match target_state(&target, slug, version)? {
        TargetState::Missing => {
            install_missing_target(skills_root, &source, &target, slug, version)
        }
        TargetState::Current => Ok(SkillInstallState::Unchanged),
        TargetState::Preserve => Ok(SkillInstallState::Preserved),
    }
}

fn validate_source(source: &Path, source_root: &Path) -> Result<(), PreinstalledSkillError> {
    let metadata = fs::symlink_metadata(source).map_err(PreinstalledSkillError::io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PreinstalledSkillError::SourceRejected);
    }
    let canonical = source.canonicalize().map_err(PreinstalledSkillError::io)?;
    if !canonical.starts_with(source_root) {
        return Err(PreinstalledSkillError::SourceRejected);
    }
    let skill = source.join(SKILL_FILE);
    let skill_metadata = fs::symlink_metadata(&skill).map_err(PreinstalledSkillError::io)?;
    if !skill_metadata.is_file() || skill_metadata.file_type().is_symlink() {
        return Err(PreinstalledSkillError::SourceRejected);
    }
    Ok(())
}

fn install_missing_target(
    skills_root: &Path,
    source: &Path,
    target: &Path,
    slug: &str,
    version: &str,
) -> Result<SkillInstallState, PreinstalledSkillError> {
    let staging = skills_root.join(format!(
        ".{slug}.preinstalled-{}-{}",
        std::process::id(),
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let _cleanup = StagingCleanup(staging.clone());
    fs::create_dir(&staging).map_err(PreinstalledSkillError::io)?;
    let mut counts = CopyCounts::default();
    copy_directory(source, &staging, source, &mut counts)?;
    write_marker(&staging, slug, version)?;
    match fs::rename(&staging, target) {
        Ok(()) => Ok(SkillInstallState::Installed),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Ok(SkillInstallState::Preserved)
        }
        Err(error) if target.exists() => {
            let _ = error;
            Ok(SkillInstallState::Preserved)
        }
        Err(error) => Err(PreinstalledSkillError::Io(error)),
    }
}

fn target_state(
    target: &Path,
    slug: &str,
    version: &str,
) -> Result<TargetState, PreinstalledSkillError> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(TargetState::Missing),
        Err(error) => return Err(PreinstalledSkillError::Io(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(TargetState::Preserve);
    }
    let Some(marker) = read_marker(target)? else {
        return Ok(TargetState::Preserve);
    };
    if marker.slug == slug && marker.version == version {
        Ok(TargetState::Current)
    } else {
        Ok(TargetState::Preserve)
    }
}

fn write_marker(target: &Path, slug: &str, version: &str) -> Result<(), PreinstalledSkillError> {
    let bytes = serde_json::to_vec_pretty(&PreinstalledSkillMarker {
        owner: MARKER_OWNER,
        slug,
        version,
    })
    .map_err(|_| PreinstalledSkillError::MarkerRejected)?;
    fs::write(target.join(MARKER_FILE), bytes).map_err(PreinstalledSkillError::io)
}

fn read_marker(
    target: &Path,
) -> Result<Option<PreinstalledSkillMarkerOwned>, PreinstalledSkillError> {
    let path = target.join(MARKER_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PreinstalledSkillError::Io(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_MARKER_BYTES
    {
        return Ok(None);
    }
    let marker: PreinstalledSkillMarkerOwned =
        match serde_json::from_slice(&fs::read(path).map_err(PreinstalledSkillError::io)?) {
            Ok(marker) => marker,
            Err(_) => return Ok(None),
        };
    if marker.owner != MARKER_OWNER || !valid_slug(&marker.slug) || !valid_version(&marker.version)
    {
        return Ok(None);
    }
    Ok(Some(marker))
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    root: &Path,
    counts: &mut CopyCounts,
) -> Result<(), PreinstalledSkillError> {
    let mut entries = fs::read_dir(source)
        .map_err(PreinstalledSkillError::io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(PreinstalledSkillError::io)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PreinstalledSkillError::SourceRejected)?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(PreinstalledSkillError::SourceRejected);
        }
        let metadata = fs::symlink_metadata(&path).map_err(PreinstalledSkillError::io)?;
        if metadata.file_type().is_symlink() {
            return Err(PreinstalledSkillError::SourceRejected);
        }
        let target = destination.join(relative);
        if metadata.is_dir() {
            fs::create_dir(&target).map_err(PreinstalledSkillError::io)?;
            copy_directory(&path, destination, root, counts)?;
        } else if metadata.is_file() {
            counts.files += 1;
            counts.bytes = counts
                .bytes
                .checked_add(metadata.len())
                .ok_or(PreinstalledSkillError::SourceRejected)?;
            if counts.files > MAX_SKILL_FILES || counts.bytes > MAX_SKILL_BYTES {
                return Err(PreinstalledSkillError::SourceRejected);
            }
            fs::copy(&path, &target).map_err(PreinstalledSkillError::io)?;
        } else {
            return Err(PreinstalledSkillError::SourceRejected);
        }
    }
    Ok(())
}

fn apply_auto_enable(
    state_dir: &CanonicalStateDir,
    slugs: &[String],
) -> Result<(), PreinstalledSkillError> {
    OpenClawConfigStore::new(state_dir.clone())
        .update_private_document(|document| {
            if apply_skill_entries(document, slugs) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map(|_| ())
        .map_err(PreinstalledSkillError::Config)
}

fn apply_skill_entries(
    document: &mut super::config_store::OpenClawConfigDocument,
    slugs: &[String],
) -> bool {
    let mut skills = object(document.get("skills"));
    let mut entries = object(skills.get("entries"));
    let mut changed = false;
    for slug in slugs {
        let mut entry = object(entries.get(slug));
        let prior = entry.insert("enabled".into(), Value::Bool(true));
        changed |= prior != Some(Value::Bool(true));
        entries.insert(slug.clone(), Value::Object(entry));
    }
    if changed {
        skills.insert("entries".into(), Value::Object(entries));
        document.insert("skills".into(), Value::Object(skills));
    }
    changed
}

fn read_manifest(path: &Path) -> Result<PreinstalledManifest, PreinstalledSkillError> {
    read_json_file(path, MAX_MANIFEST_BYTES).map_err(|error| match error {
        JsonFileError::Io(error) => PreinstalledSkillError::Io(error),
        JsonFileError::Rejected => PreinstalledSkillError::ManifestRejected,
    })
}

fn read_lock(path: &Path) -> Result<PreinstalledLock, PreinstalledSkillError> {
    let raw: PreinstalledLockWire =
        read_json_file(path, MAX_LOCK_BYTES).map_err(|error| match error {
            JsonFileError::Io(error) => PreinstalledSkillError::Io(error),
            JsonFileError::Rejected => PreinstalledSkillError::LockRejected,
        })?;
    let mut skills = BTreeMap::new();
    for entry in raw.skills {
        let slug = valid_slug(&entry.slug)
            .then(|| entry.slug.trim().to_owned())
            .ok_or(PreinstalledSkillError::LockRejected)?;
        if !valid_version(&entry.version) || skills.insert(slug, entry.version).is_some() {
            return Err(PreinstalledSkillError::LockRejected);
        }
    }
    Ok(PreinstalledLock { skills })
}

fn read_json_file<T>(path: &Path, max_bytes: u64) -> Result<T, JsonFileError>
where
    T: for<'de> Deserialize<'de>,
{
    let metadata = fs::symlink_metadata(path).map_err(JsonFileError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err(JsonFileError::Rejected);
    }
    serde_json::from_slice(&fs::read(path).map_err(JsonFileError::Io)?)
        .map_err(|_| JsonFileError::Rejected)
}

fn join_all(root: &Path, segments: &[&str]) -> PathBuf {
    let mut path = root.to_owned();
    for segment in segments {
        path.push(segment);
    }
    path
}

fn valid_slug(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && !value.contains(['/', '\\'])
        && !value.chars().any(char::is_whitespace)
        && Path::new(value).components().count() == 1
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn valid_version(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn safe_path(path: &Path) -> bool {
    path.components()
        .all(|component| !matches!(component, Component::CurDir | Component::ParentDir))
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SkillInstallState {
    Installed,
    Unchanged,
    Preserved,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TargetState {
    Missing,
    Current,
    Preserve,
}

#[derive(Default)]
struct CopyCounts {
    files: usize,
    bytes: u64,
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Deserialize)]
struct PreinstalledManifest {
    skills: Vec<PreinstalledManifestEntry>,
}

#[derive(Deserialize)]
struct PreinstalledManifestEntry {
    slug: String,
    #[serde(rename = "autoEnable", default)]
    auto_enable: bool,
}

struct PreinstalledLock {
    skills: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct PreinstalledLockWire {
    skills: Vec<PreinstalledLockEntry>,
}

#[derive(Deserialize)]
struct PreinstalledLockEntry {
    slug: String,
    version: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreinstalledSkillMarker<'a> {
    owner: &'a str,
    slug: &'a str,
    version: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreinstalledSkillMarkerOwned {
    owner: String,
    slug: String,
    version: String,
}

enum JsonFileError {
    Io(io::Error),
    Rejected,
}

#[derive(Debug)]
pub(crate) enum PreinstalledSkillError {
    Io(io::Error),
    SourceRejected,
    ManifestRejected,
    LockRejected,
    MarkerRejected,
    Config(OpenClawConfigStoreError),
}

impl PreinstalledSkillError {
    fn io(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for PreinstalledSkillError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Io(_) => "OpenClaw preinstalled skill I/O failed",
            Self::SourceRejected => "OpenClaw preinstalled skill source was rejected",
            Self::ManifestRejected => "OpenClaw preinstalled skill manifest was rejected",
            Self::LockRejected => "OpenClaw preinstalled skill lock was rejected",
            Self::MarkerRejected => "OpenClaw preinstalled skill marker was rejected",
            Self::Config(_) => "OpenClaw preinstalled skill config update failed",
        })
    }
}

impl std::error::Error for PreinstalledSkillError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Config(error) => Some(error),
            Self::SourceRejected
            | Self::ManifestRejected
            | Self::LockRejected
            | Self::MarkerRejected => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct SkillFixture<'a> {
        slug: &'a str,
        version: &'a str,
        auto_enable: bool,
        skill_md: &'a str,
    }

    struct TestRoot {
        path: PathBuf,
        working_directory: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "openclaw-preinstalled-skills-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test root");
            let working_directory = path.join("work");
            fs::create_dir_all(
                join_all(&working_directory, MANIFEST_PATH)
                    .parent()
                    .unwrap(),
            )
            .expect("create manifest parent");
            fs::create_dir_all(join_all(&working_directory, PACKAGED_SOURCE_ROOT))
                .expect("create source root");
            let state_dir =
                CanonicalStateDir::provision(path.join("state")).expect("provision state");
            Self {
                path,
                working_directory,
                state_dir,
            }
        }

        fn source_root(&self) -> PathBuf {
            join_all(&self.working_directory, PACKAGED_SOURCE_ROOT)
        }

        fn skill_target(&self, slug: &str) -> PathBuf {
            self.state_dir.as_path().join("skills").join(slug)
        }

        fn config_path(&self) -> PathBuf {
            self.state_dir.as_path().join("openclaw.json")
        }

        fn seed_packaged_skills(&self, entries: &[SkillFixture<'_>]) {
            fs::write(
                join_all(&self.working_directory, MANIFEST_PATH),
                serde_json::to_vec(&json!({
                    "skills": entries.iter().map(|entry| json!({
                        "slug": entry.slug,
                        "autoEnable": entry.auto_enable,
                    })).collect::<Vec<_>>()
                }))
                .unwrap(),
            )
            .expect("write manifest");
            fs::write(
                self.source_root().join(LOCK_FILE),
                serde_json::to_vec(&json!({
                    "skills": entries.iter().map(|entry| json!({
                        "slug": entry.slug,
                        "version": entry.version,
                    })).collect::<Vec<_>>()
                }))
                .unwrap(),
            )
            .expect("write lock");
            for entry in entries {
                self.write_packaged_skill(entry.slug, entry.skill_md);
            }
        }

        fn write_packaged_skill(&self, slug: &str, skill_md: &str) {
            let skill_directory = self.source_root().join(slug);
            fs::create_dir_all(&skill_directory).expect("create packaged skill");
            fs::write(skill_directory.join(SKILL_FILE), skill_md).expect("write packaged skill");
        }

        fn reconcile(&self) -> PreinstalledSkillReconcile {
            super::reconcile(&self.state_dir, &self.working_directory)
                .expect("reconcile preinstalled skills")
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn repeated_reconcile_checks_current_marker_without_recopied_files_or_config_write() {
        let root = TestRoot::new();
        root.seed_packaged_skills(&[SkillFixture {
            slug: "graphify",
            version: "1.0.0",
            auto_enable: true,
            skill_md: "packaged v1",
        }]);

        let first = root.reconcile();

        assert_eq!(first.installed_slugs, vec![String::from("graphify")]);
        assert!(first.unchanged_slugs.is_empty());
        assert!(first.preserved_slugs.is_empty());
        assert_eq!(first.auto_enabled_slugs, vec![String::from("graphify")]);
        assert_skill_enabled(&root, "graphify");

        let target_skill = root.skill_target("graphify").join(SKILL_FILE);
        fs::write(&target_skill, "local edit after install").expect("edit installed skill");
        root.write_packaged_skill("graphify", "packaged v1 rewritten");
        let config_before_second_reconcile = fs::read(root.config_path()).expect("read config");

        let second = root.reconcile();

        assert!(second.installed_slugs.is_empty());
        assert_eq!(second.unchanged_slugs, vec![String::from("graphify")]);
        assert!(second.preserved_slugs.is_empty());
        assert!(second.auto_enabled_slugs.is_empty());
        assert_eq!(
            fs::read_to_string(target_skill).expect("read installed skill"),
            "local edit after install"
        );
        assert_eq!(
            fs::read(root.config_path()).expect("read config after unchanged reconcile"),
            config_before_second_reconcile
        );
    }

    #[test]
    fn current_marker_is_unchanged_without_auto_enable_config_write() {
        let root = TestRoot::new();
        root.seed_packaged_skills(&[SkillFixture {
            slug: "graphify",
            version: "1.0.0",
            auto_enable: true,
            skill_md: "packaged v1",
        }]);
        let target = root.skill_target("graphify");
        fs::create_dir_all(&target).expect("create current skill");
        fs::write(target.join(SKILL_FILE), "already installed edit").expect("write current skill");
        write_marker(&target, "graphify", "1.0.0").expect("write current marker");

        let result = root.reconcile();

        assert!(result.installed_slugs.is_empty());
        assert_eq!(result.unchanged_slugs, vec![String::from("graphify")]);
        assert!(result.preserved_slugs.is_empty());
        assert!(result.auto_enabled_slugs.is_empty());
        assert_eq!(
            fs::read_to_string(target.join(SKILL_FILE)).expect("read current skill"),
            "already installed edit"
        );
        assert!(!root.config_path().exists());
    }

    #[test]
    fn reconcile_preserves_existing_user_directory_without_marker() {
        let root = TestRoot::new();
        root.seed_packaged_skills(&[SkillFixture {
            slug: "graphify",
            version: "1.0.0",
            auto_enable: true,
            skill_md: "packaged v1",
        }]);
        let target = root.skill_target("graphify");
        fs::create_dir_all(&target).expect("create user skill");
        fs::write(target.join(SKILL_FILE), "user skill").expect("write user skill");

        let result = root.reconcile();

        assert!(result.installed_slugs.is_empty());
        assert!(result.unchanged_slugs.is_empty());
        assert_eq!(result.preserved_slugs, vec![String::from("graphify")]);
        assert!(result.auto_enabled_slugs.is_empty());
        assert_eq!(
            fs::read_to_string(target.join(SKILL_FILE)).expect("read user skill"),
            "user skill"
        );
        assert!(!root.config_path().exists());
    }

    #[test]
    fn reconcile_preserves_existing_directory_with_different_marker_version() {
        let root = TestRoot::new();
        root.seed_packaged_skills(&[SkillFixture {
            slug: "graphify",
            version: "1.0.0",
            auto_enable: true,
            skill_md: "packaged v1",
        }]);
        let target = root.skill_target("graphify");
        fs::create_dir_all(&target).expect("create prior skill");
        fs::write(target.join(SKILL_FILE), "edited prior skill").expect("write prior skill");
        write_marker(&target, "graphify", "0.9.0").expect("write prior marker");

        let result = root.reconcile();

        assert!(result.installed_slugs.is_empty());
        assert!(result.unchanged_slugs.is_empty());
        assert_eq!(result.preserved_slugs, vec![String::from("graphify")]);
        assert!(result.auto_enabled_slugs.is_empty());
        assert_eq!(
            fs::read_to_string(target.join(SKILL_FILE)).expect("read prior skill"),
            "edited prior skill"
        );
        assert_eq!(
            read_marker(&target)
                .expect("read prior marker")
                .expect("prior marker")
                .version,
            "0.9.0"
        );
        assert!(!root.config_path().exists());
    }

    #[test]
    fn auto_enable_does_not_rewrite_private_config_when_skill_is_already_enabled() {
        let root = TestRoot::new();
        root.seed_packaged_skills(&[SkillFixture {
            slug: "graphify",
            version: "1.0.0",
            auto_enable: true,
            skill_md: "packaged v1",
        }]);
        let original_config = br#"{ "skills": { "entries": { "graphify": { "enabled": true, "note": "keep bytes" } } } }"#;
        fs::write(root.config_path(), original_config).expect("seed enabled config");

        let result = root.reconcile();

        assert_eq!(result.installed_slugs, vec![String::from("graphify")]);
        assert_eq!(result.auto_enabled_slugs, vec![String::from("graphify")]);
        assert_eq!(
            fs::read(root.config_path()).expect("read config after auto enable"),
            original_config
        );
    }

    fn assert_skill_enabled(root: &TestRoot, slug: &str) {
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(root.config_path()).expect("read config"))
                .expect("parse config");
        assert_eq!(document["skills"]["entries"][slug]["enabled"], json!(true));
    }
}
