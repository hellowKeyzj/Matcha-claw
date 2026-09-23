use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value};

use super::config_store::{
    OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError,
};
use platform::state_dir::CanonicalStateDir;

const BROWSER_RELAY_PLUGIN: &str = "browser-relay";
const BROWSER_RELAY_SKILL: &str = "browser-relay-skill";
const MEMORY_LANCEDB_PLUGIN: &str = "memory-lancedb-pro";
const MEMORY_LANCEDB_SKILL: &str = "memory-lancedb-pro-skill";
const SKILL_MARKER: &str = ".matcha-companion-installed";
const OPENCLAW_PLUGIN_MANIFEST: &str = "openclaw.plugin.json";
const MAX_OPENCLAW_PLUGIN_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_COMPANION_FILES: usize = 512;
const MAX_COMPANION_BYTES: u64 = 16 * 1024 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompanionSkillDefinition {
    plugin_id: &'static str,
    slug: &'static str,
    auto_enable: bool,
}

impl CompanionSkillDefinition {
    pub fn plugin_id(self) -> &'static str {
        self.plugin_id
    }

    pub fn slug(self) -> &'static str {
        self.slug
    }

    pub fn auto_enable(self) -> bool {
        self.auto_enable
    }
}

const BROWSER_RELAY_DEFINITIONS: [CompanionSkillDefinition; 1] = [CompanionSkillDefinition {
    plugin_id: BROWSER_RELAY_PLUGIN,
    slug: BROWSER_RELAY_SKILL,
    auto_enable: true,
}];
const MEMORY_LANCEDB_DEFINITIONS: [CompanionSkillDefinition; 1] = [CompanionSkillDefinition {
    plugin_id: MEMORY_LANCEDB_PLUGIN,
    slug: MEMORY_LANCEDB_SKILL,
    auto_enable: true,
}];
const NO_COMPANION_DEFINITIONS: [CompanionSkillDefinition; 0] = [];

pub fn companion_skill_definitions(plugin_id: &str) -> &'static [CompanionSkillDefinition] {
    match plugin_id.trim() {
        BROWSER_RELAY_PLUGIN => &BROWSER_RELAY_DEFINITIONS,
        MEMORY_LANCEDB_PLUGIN => &MEMORY_LANCEDB_DEFINITIONS,
        _ => &NO_COMPANION_DEFINITIONS,
    }
}

pub fn companion_skill_slugs(plugin_id: &str) -> Vec<&'static str> {
    companion_skill_definitions(plugin_id)
        .iter()
        .map(|definition| definition.slug)
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanionSkillIntent {
    plugin_id: String,
    enabled: bool,
    slugs: Vec<String>,
}

impl CompanionSkillIntent {
    pub fn resolve(plugin_id: &str, enabled: bool) -> Result<Self, CompanionSkillIntentError> {
        let plugin_id = plugin_id.trim();
        if plugin_id.is_empty()
            || plugin_id.len() > 128
            || plugin_id.chars().any(char::is_whitespace)
        {
            return Err(CompanionSkillIntentError::InvalidPluginId);
        }
        let definitions = companion_skill_definitions(plugin_id);
        if definitions.is_empty() {
            return Err(CompanionSkillIntentError::UnknownPlugin);
        }
        Ok(Self {
            plugin_id: plugin_id.to_owned(),
            enabled,
            slugs: definitions
                .iter()
                .filter(|definition| definition.auto_enable)
                .map(|definition| definition.slug.to_owned())
                .collect(),
        })
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn slugs(&self) -> &[String] {
        &self.slugs
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionSkillIntentError {
    InvalidPluginId,
    UnknownPlugin,
}

impl fmt::Display for CompanionSkillIntentError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::InvalidPluginId => "OpenClaw companion plugin id is invalid",
            Self::UnknownPlugin => "OpenClaw plugin has no bundled companion skill",
        })
    }
}

impl std::error::Error for CompanionSkillIntentError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManifestSkillIntent {
    plugin_id: String,
    enabled: bool,
    slugs: Vec<String>,
}

impl ManifestSkillIntent {
    pub(crate) fn resolve(
        plugin_id: &str,
        enabled: bool,
        source_root: &Path,
    ) -> Result<Self, ManifestSkillError> {
        validate_plugin_id(plugin_id).map_err(|_| ManifestSkillError::InvalidPluginId)?;
        let slugs = read_manifest_skill_slugs(source_root)?;
        Ok(Self {
            plugin_id: plugin_id.trim().to_owned(),
            enabled,
            slugs,
        })
    }

    #[cfg(test)]
    pub(crate) fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    #[cfg(test)]
    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    #[cfg(test)]
    pub(crate) fn slugs(&self) -> &[String] {
        &self.slugs
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManifestSkillError {
    InvalidPluginId,
    SourceRootRejected,
    ManifestMissing,
    ManifestRejected,
    ManifestMalformed,
    SkillDeclarationRejected,
    SkillSourceRejected,
}

impl fmt::Display for ManifestSkillError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::InvalidPluginId => "OpenClaw manifest plugin id is invalid",
            Self::SourceRootRejected => "OpenClaw manifest source root was rejected",
            Self::ManifestMissing => "OpenClaw plugin manifest is missing",
            Self::ManifestRejected => "OpenClaw plugin manifest was rejected",
            Self::ManifestMalformed => "OpenClaw plugin manifest is malformed",
            Self::SkillDeclarationRejected => "OpenClaw plugin skill declaration was rejected",
            Self::SkillSourceRejected => "OpenClaw plugin skill source was rejected",
        })
    }
}

impl std::error::Error for ManifestSkillError {}

/// A manifest skill effect only projects native skill entries into config. Unlike
/// `CompanionSkillEffect`, it never copies generic manifest skills into state/skills.
pub(crate) struct ManifestSkillEffect {
    state_dir: CanonicalStateDir,
    intent: ManifestSkillIntent,
}

impl ManifestSkillEffect {
    pub(crate) fn new(state_dir: CanonicalStateDir, intent: ManifestSkillIntent) -> Self {
        Self { state_dir, intent }
    }

    pub(crate) fn apply(self) -> Result<(), ManifestSkillError> {
        apply_manifest_config_state(&self.state_dir, &self.intent)
            .map(|_| ())
            .map_err(|_| ManifestSkillError::ManifestRejected)
    }
}

/// A private OpenClaw effect. The source root is supplied only to `apply` and is
/// never retained in or exposed by the public effect/result types.
pub struct CompanionSkillEffect {
    state_dir: CanonicalStateDir,
    intent: CompanionSkillIntent,
}

impl CompanionSkillEffect {
    pub fn new(state_dir: CanonicalStateDir, intent: CompanionSkillIntent) -> Self {
        Self { state_dir, intent }
    }

    pub fn apply(self, source_root: &Path) -> Result<CompanionSkillOutcome, CompanionSkillError> {
        install_companion_skills(&self.state_dir, &self.intent, source_root)?;
        let config_changed = apply_config_state(&self.state_dir, &self.intent)?;
        Ok(CompanionSkillOutcome {
            plugin_id: self.intent.plugin_id,
            slugs: self.intent.slugs,
            enabled: self.intent.enabled,
            config_changed,
        })
    }
}

impl fmt::Debug for CompanionSkillEffect {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("CompanionSkillEffect([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanionSkillOutcome {
    plugin_id: String,
    slugs: Vec<String>,
    enabled: bool,
    config_changed: bool,
}

impl CompanionSkillOutcome {
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn slugs(&self) -> &[String] {
        &self.slugs
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn config_changed(&self) -> bool {
        self.config_changed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionSkillError {
    SourceRootRejected,
    SourceMissing,
    SourceUnsafe,
    TargetOccupied,
    InstallationFailed,
    ConfigStore,
    ConfigNotDurable,
}

impl fmt::Display for CompanionSkillError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::SourceRootRejected => "OpenClaw companion source root was rejected",
            Self::SourceMissing => "OpenClaw companion skill source is missing",
            Self::SourceUnsafe => "OpenClaw companion skill source is unsafe",
            Self::TargetOccupied => "OpenClaw companion skill target is occupied",
            Self::InstallationFailed => "OpenClaw companion skill installation failed",
            Self::ConfigStore => "OpenClaw companion skill config update failed",
            Self::ConfigNotDurable => "OpenClaw companion skill config update is not durable",
        })
    }
}

impl std::error::Error for CompanionSkillError {}

fn apply_manifest_config_state(
    state_dir: &CanonicalStateDir,
    intent: &ManifestSkillIntent,
) -> Result<bool, OpenClawConfigStoreError> {
    let update = OpenClawConfigStore::new(state_dir.clone()).update(|document| {
        if apply_skill_entries(document, &intent.slugs, intent.enabled) {
            OpenClawConfigMutation::changed()
        } else {
            OpenClawConfigMutation::unchanged()
        }
    })?;
    Ok(update.changed)
}

fn apply_config_state(
    state_dir: &CanonicalStateDir,
    intent: &CompanionSkillIntent,
) -> Result<bool, CompanionSkillError> {
    let update = OpenClawConfigStore::new(state_dir.clone())
        .update(|document| {
            if apply_config_state_to_document(document, intent) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map_err(|error| match error {
            OpenClawConfigStoreError::CommittedButNotDurable => {
                CompanionSkillError::ConfigNotDurable
            }
            _ => CompanionSkillError::ConfigStore,
        })?;
    Ok(update.changed)
}

fn apply_config_state_to_document(
    document: &mut OpenClawConfigDocument,
    intent: &CompanionSkillIntent,
) -> bool {
    apply_skill_entries(document, &intent.slugs, intent.enabled)
}

fn apply_skill_entries(
    document: &mut OpenClawConfigDocument,
    slugs: &[String],
    enabled: bool,
) -> bool {
    let mut skills = object(document.get("skills"));
    let mut entries = object(skills.get("entries"));
    let mut changed = false;
    for slug in slugs {
        let mut entry = object(entries.get(slug));
        let prior = entry.insert("enabled".into(), Value::Bool(enabled));
        changed |= prior != Some(Value::Bool(enabled));
        entries.insert(slug.clone(), Value::Object(entry));
    }
    if changed {
        skills.insert("entries".into(), Value::Object(entries));
        document.insert("skills".into(), Value::Object(skills));
    }
    changed
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), CompanionSkillIntentError> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() || plugin_id.len() > 128 || plugin_id.chars().any(char::is_whitespace) {
        return Err(CompanionSkillIntentError::InvalidPluginId);
    }
    Ok(())
}

fn read_manifest_skill_slugs(source_root: &Path) -> Result<Vec<String>, ManifestSkillError> {
    if !source_root.is_absolute() || !is_safe_path(source_root) {
        return Err(ManifestSkillError::SourceRootRejected);
    }
    let root_metadata =
        fs::symlink_metadata(source_root).map_err(|_| ManifestSkillError::SourceRootRejected)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(ManifestSkillError::SourceRootRejected);
    }
    let manifest = source_root.join(OPENCLAW_PLUGIN_MANIFEST);
    let metadata =
        fs::symlink_metadata(&manifest).map_err(|_| ManifestSkillError::ManifestMissing)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ManifestSkillError::ManifestRejected);
    }
    if metadata.len() > MAX_OPENCLAW_PLUGIN_MANIFEST_BYTES {
        return Err(ManifestSkillError::ManifestRejected);
    }
    let bytes = fs::read(&manifest).map_err(|_| ManifestSkillError::ManifestRejected)?;
    let document: Value =
        serde_json::from_slice(&bytes).map_err(|_| ManifestSkillError::ManifestMalformed)?;
    let Some(skills) = document.get("skills") else {
        return Ok(Vec::new());
    };
    let declarations = skills
        .as_array()
        .ok_or(ManifestSkillError::ManifestMalformed)?;
    let mut slugs = Vec::new();
    for declaration in declarations {
        let declaration = declaration
            .as_str()
            .ok_or(ManifestSkillError::SkillDeclarationRejected)?;
        let relative = parse_manifest_relative_path(declaration)?;
        let candidate = source_root.join(&relative);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| ManifestSkillError::SkillSourceRejected)?;
        if metadata.file_type().is_symlink() {
            return Err(ManifestSkillError::SkillSourceRejected);
        }
        let mut discovered = Vec::new();
        if metadata.is_file() {
            if candidate.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
                return Err(ManifestSkillError::SkillSourceRejected);
            }
            discovered.push(
                candidate
                    .parent()
                    .ok_or(ManifestSkillError::SkillSourceRejected)?
                    .to_owned(),
            );
        } else if metadata.is_dir() {
            if has_regular_skill_file(&candidate)? {
                discovered.push(candidate.clone());
            } else {
                for entry in
                    fs::read_dir(&candidate).map_err(|_| ManifestSkillError::SkillSourceRejected)?
                {
                    let entry = entry.map_err(|_| ManifestSkillError::SkillSourceRejected)?;
                    let child = entry.path();
                    let child_metadata = fs::symlink_metadata(&child)
                        .map_err(|_| ManifestSkillError::SkillSourceRejected)?;
                    if child_metadata.file_type().is_symlink() {
                        return Err(ManifestSkillError::SkillSourceRejected);
                    }
                    if child_metadata.is_dir() && has_regular_skill_file(&child)? {
                        discovered.push(child);
                    }
                }
            }
        } else {
            return Err(ManifestSkillError::SkillSourceRejected);
        }
        for skill_dir in discovered {
            let slug = skill_dir
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .ok_or(ManifestSkillError::SkillSourceRejected)?;
            if !slugs.iter().any(|existing| existing == slug) {
                slugs.push(slug.to_owned());
            }
        }
    }
    Ok(slugs)
}

fn parse_manifest_relative_path(value: &str) -> Result<PathBuf, ManifestSkillError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ManifestSkillError::SkillDeclarationRejected);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(ManifestSkillError::SkillDeclarationRejected);
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value),
            std::path::Component::CurDir => None,
            _ => None,
        })
        .collect::<PathBuf>();
    if normalized.as_os_str().is_empty() {
        return Err(ManifestSkillError::SkillDeclarationRejected);
    }
    Ok(normalized)
}

fn has_regular_skill_file(directory: &Path) -> Result<bool, ManifestSkillError> {
    let path = directory.join("SKILL.md");
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(ManifestSkillError::SkillSourceRejected),
    };
    if metadata.file_type().is_symlink() {
        return Err(ManifestSkillError::SkillSourceRejected);
    }
    Ok(metadata.is_file())
}

fn install_companion_skills(
    state_dir: &CanonicalStateDir,
    intent: &CompanionSkillIntent,
    source_root: &Path,
) -> Result<(), CompanionSkillError> {
    if !source_root.is_absolute() || !is_safe_path(source_root) {
        return Err(CompanionSkillError::SourceRootRejected);
    }
    let skills_root = state_dir.as_path().join("skills");
    fs::create_dir_all(&skills_root).map_err(|_| CompanionSkillError::InstallationFailed)?;
    for slug in &intent.slugs {
        install_one_skill(&skills_root, source_root, slug)?;
    }
    Ok(())
}

fn install_one_skill(
    skills_root: &Path,
    source_root: &Path,
    slug: &str,
) -> Result<(), CompanionSkillError> {
    let source = source_root.join(slug);
    let target = skills_root.join(slug);
    let source_meta =
        fs::symlink_metadata(&source).map_err(|_| CompanionSkillError::SourceMissing)?;
    if !source_meta.is_dir() || source_meta.file_type().is_symlink() {
        return Err(CompanionSkillError::SourceUnsafe);
    }
    let skill_file = source.join("SKILL.md");
    let skill_meta =
        fs::symlink_metadata(&skill_file).map_err(|_| CompanionSkillError::SourceMissing)?;
    if !skill_meta.is_file() || skill_meta.file_type().is_symlink() {
        return Err(CompanionSkillError::SourceUnsafe);
    }
    if let Ok(target_meta) = fs::symlink_metadata(&target) {
        if target_meta.file_type().is_symlink() {
            return Err(CompanionSkillError::TargetOccupied);
        }
        if target_meta.is_dir() {
            if target.join(SKILL_MARKER).is_file() || target.join("SKILL.md").is_file() {
                return Ok(());
            }
        }
        return Err(CompanionSkillError::TargetOccupied);
    }

    let staging = skills_root.join(format!(".{slug}.staging-{}", next_staging_id()));
    fs::create_dir(&staging).map_err(|_| CompanionSkillError::InstallationFailed)?;
    let result = copy_bounded(&source, &staging)
        .and_then(|_| {
            fs::write(staging.join(SKILL_MARKER), b"matcha-companion-v1\n")
                .map_err(|_| CompanionSkillError::InstallationFailed)
        })
        .and_then(|_| {
            fs::rename(&staging, &target).map_err(|_| CompanionSkillError::InstallationFailed)
        });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn copy_bounded(source: &Path, destination: &Path) -> Result<(), CompanionSkillError> {
    let mut counts = CopyCounts::default();
    copy_directory(source, destination, &mut counts)
}

#[derive(Default)]
struct CopyCounts {
    files: usize,
    bytes: u64,
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    counts: &mut CopyCounts,
) -> Result<(), CompanionSkillError> {
    for entry in fs::read_dir(source).map_err(|_| CompanionSkillError::InstallationFailed)? {
        let entry = entry.map_err(|_| CompanionSkillError::InstallationFailed)?;
        let path = entry.path();
        let relative = path
            .strip_prefix(source)
            .map_err(|_| CompanionSkillError::SourceUnsafe)?;
        if relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(CompanionSkillError::SourceUnsafe);
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| CompanionSkillError::SourceUnsafe)?;
        let target = destination.join(relative);
        if metadata.file_type().is_symlink() {
            return Err(CompanionSkillError::SourceUnsafe);
        }
        if metadata.is_dir() {
            fs::create_dir(&target).map_err(|_| CompanionSkillError::InstallationFailed)?;
            copy_directory(&path, &target, counts)?;
        } else if metadata.is_file() {
            counts.files += 1;
            counts.bytes = counts
                .bytes
                .checked_add(metadata.len())
                .ok_or(CompanionSkillError::SourceUnsafe)?;
            if counts.files > MAX_COMPANION_FILES || counts.bytes > MAX_COMPANION_BYTES {
                return Err(CompanionSkillError::SourceUnsafe);
            }
            fs::copy(&path, &target).map_err(|_| CompanionSkillError::InstallationFailed)?;
        } else {
            return Err(CompanionSkillError::SourceUnsafe);
        }
    }
    Ok(())
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn is_safe_path(path: &Path) -> bool {
    path.components().all(|component| {
        !matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    })
}

fn next_staging_id() -> u64 {
    NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        root: PathBuf,
        state_dir: CanonicalStateDir,
        source_root: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let id = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("openclaw-companion-{stamp}-{id}"));
            fs::create_dir(&root).unwrap();
            let state_dir = CanonicalStateDir::provision(root.join("state")).unwrap();
            let source_root = root.join("sources");
            fs::create_dir_all(source_root.join(BROWSER_RELAY_SKILL)).unwrap();
            fs::write(
                source_root.join(BROWSER_RELAY_SKILL).join("SKILL.md"),
                b"browser",
            )
            .unwrap();
            Self {
                root,
                state_dir,
                source_root,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn manifest_skills_project_enabled_entries_without_installing_generic_skills() {
        let root = TestRoot::new();
        fs::write(
            root.source_root.join(OPENCLAW_PLUGIN_MANIFEST),
            r#"{"id":"openclaw-qqbot","skills":["./skills"]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.source_root.join("skills/lesson")).unwrap();
        fs::write(root.source_root.join("skills/lesson/SKILL.md"), b"lesson").unwrap();

        let intent =
            ManifestSkillIntent::resolve("openclaw-qqbot", true, &root.source_root).unwrap();
        assert_eq!(intent.plugin_id(), "openclaw-qqbot");
        assert_eq!(intent.slugs(), &["lesson"]);
        ManifestSkillEffect::new(root.state_dir.clone(), intent)
            .apply()
            .unwrap();

        let document = OpenClawConfigStore::new(root.state_dir.clone())
            .read()
            .unwrap();
        assert_eq!(
            document.as_value()["skills"]["entries"]["lesson"]["enabled"],
            true
        );
        assert!(!root.state_dir.as_path().join("skills/lesson").exists());
    }

    #[test]
    fn manifest_skill_file_declaration_discovers_parent_slug_and_deduplicates() {
        let root = TestRoot::new();
        fs::write(
            root.source_root.join(OPENCLAW_PLUGIN_MANIFEST),
            r#"{"id":"openclaw-qqbot","skills":["./skills/lesson/SKILL.md","./skills"]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.source_root.join("skills/lesson")).unwrap();
        fs::write(root.source_root.join("skills/lesson/SKILL.md"), b"lesson").unwrap();

        let intent =
            ManifestSkillIntent::resolve("openclaw-qqbot", false, &root.source_root).unwrap();
        assert_eq!(intent.slugs(), &["lesson"]);
        assert!(!intent.enabled());
    }

    #[test]
    fn manifest_skill_declarations_reject_malformed_and_escaping_paths() {
        let root = TestRoot::new();
        fs::write(
            root.source_root.join(OPENCLAW_PLUGIN_MANIFEST),
            r#"{"id":"openclaw-qqbot","skills":["../outside"]}"#,
        )
        .unwrap();
        assert_eq!(
            ManifestSkillIntent::resolve("openclaw-qqbot", true, &root.source_root),
            Err(ManifestSkillError::SkillDeclarationRejected)
        );

        fs::write(
            root.source_root.join(OPENCLAW_PLUGIN_MANIFEST),
            b"{\"id\":\"openclaw-qqbot\",\"skills\":\"bad\"}",
        )
        .unwrap();
        assert_eq!(
            ManifestSkillIntent::resolve("openclaw-qqbot", true, &root.source_root),
            Err(ManifestSkillError::ManifestMalformed)
        );
    }

    #[test]
    fn resolves_historical_plugin_companions_and_auto_enable() {
        let intent = CompanionSkillIntent::resolve(BROWSER_RELAY_PLUGIN, true).unwrap();
        assert_eq!(intent.slugs(), &[BROWSER_RELAY_SKILL]);
        assert!(intent.enabled());
        assert_eq!(
            companion_skill_slugs(MEMORY_LANCEDB_PLUGIN),
            vec![MEMORY_LANCEDB_SKILL]
        );
        assert!(companion_skill_definitions(BROWSER_RELAY_PLUGIN)[0].auto_enable());
    }

    #[test]
    fn config_transition_preserves_existing_skill_entries() {
        let root = TestRoot::new();
        let store = OpenClawConfigStore::new(root.state_dir.clone());
        store
            .update(|document| {
                document.insert(
                    "skills".into(),
                    serde_json::json!({
                        "entries": {
                            BROWSER_RELAY_SKILL: { "enabled": false, "custom": "kept" },
                            "unrelated": { "enabled": true }
                        }
                    }),
                );
                OpenClawConfigMutation::changed()
            })
            .unwrap();
        let intent = CompanionSkillIntent::resolve(BROWSER_RELAY_PLUGIN, true).unwrap();
        let outcome = CompanionSkillEffect::new(root.state_dir.clone(), intent)
            .apply(&root.source_root)
            .unwrap();
        assert!(outcome.config_changed());
        assert_eq!(
            store.read().unwrap().get("skills"),
            Some(&serde_json::json!({
                "entries": {
                    BROWSER_RELAY_SKILL: { "enabled": true, "custom": "kept" },
                    "unrelated": { "enabled": true }
                }
            }))
        );
    }

    #[test]
    fn installation_is_staged_and_idempotent_without_exposing_paths() {
        let root = TestRoot::new();
        let intent = CompanionSkillIntent::resolve(BROWSER_RELAY_PLUGIN, true).unwrap();
        let effect = CompanionSkillEffect::new(root.state_dir.clone(), intent.clone());
        let first = effect.apply(&root.source_root).unwrap();
        assert_eq!(first.slugs(), &[BROWSER_RELAY_SKILL.to_owned()]);
        assert!(
            root.state_dir
                .as_path()
                .join("skills")
                .join(BROWSER_RELAY_SKILL)
                .join(SKILL_MARKER)
                .is_file()
        );
        let second = CompanionSkillEffect::new(root.state_dir.clone(), intent)
            .apply(&root.source_root)
            .unwrap();
        assert!(!second.config_changed());
        assert!(
            !format!(
                "{:?}",
                CompanionSkillEffect::new(
                    root.state_dir.clone(),
                    CompanionSkillIntent::resolve(BROWSER_RELAY_PLUGIN, true).unwrap(),
                )
            )
            .contains(root.source_root.to_string_lossy().as_ref())
        );
    }
}
