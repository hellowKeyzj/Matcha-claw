use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::{Map, Value};

use super::config_store::{OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore};
use platform::state_dir::CanonicalStateDir;

use super::plugin_companion::{CompanionSkillEffect, CompanionSkillIntent, companion_skill_slugs};

#[path = "managed_reconcile.rs"]
mod managed_reconcile;
pub use managed_reconcile::{ManagedPluginReconcile, PluginReconcileError};

const MANIFEST: &str = "openclaw.plugin.json";
const PACKAGE: &str = "package.json";
const MAX_METADATA_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub runtime: &'static str,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub companion_skill_slugs: Option<Vec<String>>,
    pub enabled: bool,
    pub installed: bool,
    pub update_available: bool,
    pub companion_skill_ready: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEntry {
    pub id: String,
    pub status: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub success: bool,
    pub execution: Execution,
    pub plugins: Vec<CatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub enabled_plugin_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub success: bool,
    pub lifecycle: &'static str,
    pub state: &'static str,
    pub health: &'static str,
    pub execution: Execution,
    pub plugins: Vec<RuntimeEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPluginPreparation {
    pub is_external_managed_channel: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub artifact_changed: bool,
    pub peer_link_ok: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetEnabledOutcome {
    Configured,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginOperation {
    Install,
    Update,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginOperationOutcome {
    Configured,
    Rejected,
    Unknown,
}

const MANAGED_PLUGIN_IDS: &[&str] = &[
    "qianfan",
    "stepfun",
    "tencent",
    "xiaomi",
    "qwen",
    "kimi",
    "volcengine",
    "opencode",
    "opencode-go",
    "dingtalk",
    "openclaw-lark",
    "wecom",
    "openclaw-qqbot",
    "openclaw-weixin",
    "task-manager",
    "security-core",
    "browser-relay",
    "memory-lancedb-pro",
    "matchaclaw-media",
];

const MANUALLY_CONFIGURABLE_PLUGIN_IDS: &[&str] = &[
    "task-manager",
    "security-core",
    "browser-relay",
    "memory-lancedb-pro",
    "matchaclaw-media",
];

pub struct PluginProjection {
    state_dir: CanonicalStateDir,
    companion_skill_source_root: PathBuf,
    managed_plugin_root: PathBuf,
    working_directory: PathBuf,
}

impl PluginProjection {
    pub fn new(
        state_dir: CanonicalStateDir,
        companion_skill_source_root: impl Into<PathBuf>,
        managed_plugin_root: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            state_dir,
            companion_skill_source_root: companion_skill_source_root.into(),
            managed_plugin_root: managed_plugin_root.into(),
            working_directory: working_directory.into(),
        }
    }

    pub fn configured_channel_plugin_ids(&self) -> Result<Vec<String>, PluginError> {
        let document = OpenClawConfigStore::new(self.state_dir.clone())
            .read_private()
            .map_err(|_| PluginError::Config)?;
        Ok(super::channel::configured_plugin_ids(&document))
    }

    pub fn prepare_configured_channel_plugin(
        &self,
        channel_type: &str,
        openclaw_root: &Path,
    ) -> Result<ChannelPluginPreparation, PluginError> {
        let Some(plugin_id) = configured_channel_plugin_id(channel_type) else {
            return Ok(ChannelPluginPreparation {
                is_external_managed_channel: false,
                plugin_id: None,
                artifact_changed: false,
                peer_link_ok: true,
            });
        };
        let mut configured_plugin_ids = self.configured_channel_plugin_ids()?;
        if !configured_plugin_ids.iter().any(|id| id == &plugin_id) {
            configured_plugin_ids.push(plugin_id.clone());
        }
        let reconcile = self
            .reconcile_configured_channel_plugins(&configured_plugin_ids)
            .map_err(|_| PluginError::Config)?;
        let peer_link_ok = managed_reconcile::repair_channel_peer_link(
            &self.state_dir.as_path().join("extensions"),
            &plugin_id,
            openclaw_root,
        )
        .map_err(|_| PluginError::Config)?;
        self.reconcile_installed_records()?;
        Ok(ChannelPluginPreparation {
            is_external_managed_channel: true,
            artifact_changed: reconcile.installed_ids.contains(&plugin_id)
                || reconcile.updated_ids.contains(&plugin_id)
                || !reconcile.removed_ids.is_empty(),
            plugin_id: Some(plugin_id),
            peer_link_ok,
        })
    }

    pub fn catalog(&self) -> Result<Catalog, PluginError> {
        let store = OpenClawConfigStore::new(self.state_dir.clone());
        let document = store.read_private().map_err(|_| PluginError::Config)?;
        let mut entries = self.discover();
        for entry in &mut entries {
            let canonical_id = canonical_plugin_id(&entry.id).unwrap_or(&entry.id);
            let target = self
                .state_dir
                .as_path()
                .join("extensions")
                .join(canonical_id);
            let target_version = managed_target_version(&target, canonical_id);
            entry.installed = target_version.is_some();
            entry.update_available = target_version
                .as_deref()
                .and_then(parse_version)
                .zip(parse_version(&entry.version))
                .is_some_and(|(target, source)| source > target);
            entry.companion_skill_ready =
                companion_skills_ready(self.state_dir.as_path(), canonical_id);
        }
        let known_ids = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<BTreeSet<_>>();
        let enabled = enabled_ids(&document, &known_ids);
        for entry in &mut entries {
            entry.enabled = enabled.contains(&entry.id);
        }
        entries.retain(|entry| is_manually_configurable_plugin(&entry.id));
        entries.sort_by(|a, b| (&a.platform, &a.kind, &a.id).cmp(&(&b.platform, &b.kind, &b.id)));
        Ok(Catalog {
            success: true,
            execution: Execution {
                enabled_plugin_ids: enabled.into_iter().collect(),
            },
            plugins: entries,
        })
    }

    pub fn runtime(&self, running: bool) -> Result<Runtime, PluginError> {
        let catalog = self.catalog()?;
        let status = if running { "running" } else { "stopped" };
        Ok(Runtime {
            success: true,
            lifecycle: status,
            state: status,
            health: if running { "unknown" } else { "stopped" },
            execution: catalog.execution,
            plugins: catalog
                .plugins
                .into_iter()
                .map(|p| RuntimeEntry { id: p.id, status })
                .collect(),
        })
    }

    pub fn reconcile_managed_plugins(
        &self,
    ) -> Result<ManagedPluginReconcile, PluginReconcileError> {
        managed_reconcile::reconcile(&self.state_dir, &self.managed_plugin_root)
    }

    pub fn reconcile_enabled_managed_plugins(
        &self,
        enabled_ids: &[String],
    ) -> Result<ManagedPluginReconcile, PluginReconcileError> {
        managed_reconcile::reconcile_selected(
            &self.state_dir,
            &self.managed_plugin_root,
            enabled_ids,
        )
    }

    pub fn reconcile_configured_channel_plugins(
        &self,
        configured_channel_plugin_ids: &[String],
    ) -> Result<ManagedPluginReconcile, PluginReconcileError> {
        managed_reconcile::reconcile_selected_channels(
            &self.state_dir,
            &self.managed_plugin_root,
            configured_channel_plugin_ids,
        )
    }

    pub fn apply_configured_channel_startup_config(
        &self,
        configured_channel_plugin_ids: &[String],
    ) -> Result<(), PluginError> {
        OpenClawConfigStore::new(self.state_dir.clone())
            .update_private_document(|document| {
                let changed = configured_channel_plugin_ids
                    .iter()
                    .fold(false, |changed, id| {
                        changed | set_plugin_enabled_config(document, id, true)
                    });
                if changed {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map(|_| ())
            .map_err(|_| PluginError::Config)
    }

    pub fn reconcile_preinstalled_skills(&self) -> Result<(), PluginError> {
        super::preinstalled_skills::reconcile(&self.state_dir, &self.working_directory)
            .map(|_| ())
            .map_err(|_| PluginError::Config)
    }

    pub fn reconcile_installed_records(&self) -> Result<(), PluginError> {
        match super::installed_records::reconcile(&self.state_dir).status {
            super::installed_records::InstalledRecordsReconcileStatus::Skipped(
                super::installed_records::InstalledRecordsSkipReason::InvalidInstalledIndex
                | super::installed_records::InstalledRecordsSkipReason::InvalidInstallRecords,
            ) => Err(PluginError::Config),
            super::installed_records::InstalledRecordsReconcileStatus::Changed
            | super::installed_records::InstalledRecordsReconcileStatus::Unchanged
            | super::installed_records::InstalledRecordsReconcileStatus::Skipped(_) => Ok(()),
        }
    }

    pub fn apply_startup_lifecycle(&self, enabled_ids: &[String]) -> Result<(), PluginError> {
        let store = OpenClawConfigStore::new(self.state_dir.clone());
        super::plugin_lifecycle::apply_startup_config(&store, enabled_ids)
            .map_err(|_| PluginError::Config)?;
        for plugin_id in enabled_ids {
            self.apply_companion(plugin_id, true)?;
            self.apply_manifest_skills(plugin_id, true)?;
        }
        Ok(())
    }

    pub fn apply_transition_lifecycle(
        &self,
        previous: &[String],
        next: &[String],
    ) -> Result<(), PluginError> {
        let transition = super::plugin_lifecycle::PluginLifecycleTransitionState::new(
            previous.iter().cloned(),
            next.iter().cloned(),
        );
        let store = OpenClawConfigStore::new(self.state_dir.clone());
        super::plugin_lifecycle::apply_transition_config(
            &store,
            &transition,
            set_plugin_enabled_config,
        )
        .map_err(|_| PluginError::Config)?;
        for plugin_id in &transition.newly_disabled_plugin_ids {
            self.apply_companion(plugin_id, false)?;
            self.apply_manifest_skills(plugin_id, false)?;
        }
        for plugin_id in &transition.newly_enabled_plugin_ids {
            self.apply_companion(plugin_id, true)?;
            self.apply_manifest_skills(plugin_id, true)?;
        }
        Ok(())
    }

    fn apply_manifest_skills(&self, plugin_id: &str, enabled: bool) -> Result<(), PluginError> {
        let canonical_id = canonical_plugin_id(plugin_id).ok_or(PluginError::Config)?;
        if !is_safe_plugin_target_id(canonical_id) {
            return Err(PluginError::Config);
        }
        let target = self
            .state_dir
            .as_path()
            .join("extensions")
            .join(canonical_id);
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(PluginError::Config),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PluginError::Config);
        }
        let intent = match super::plugin_companion::ManifestSkillIntent::resolve(
            canonical_id,
            enabled,
            &target,
        ) {
            Ok(intent) => intent,
            Err(super::plugin_companion::ManifestSkillError::ManifestMissing) => return Ok(()),
            Err(_) => return Err(PluginError::Config),
        };
        super::plugin_companion::ManifestSkillEffect::new(self.state_dir.clone(), intent)
            .apply()
            .map_err(|_| PluginError::Config)
    }

    fn apply_companion(&self, plugin_id: &str, enabled: bool) -> Result<(), PluginError> {
        let Ok(intent) = CompanionSkillIntent::resolve(plugin_id, enabled) else {
            return Ok(());
        };
        CompanionSkillEffect::new(self.state_dir.clone(), intent)
            .apply(&self.companion_skill_source_root)
            .map(|_| ())
            .map_err(|_| PluginError::Config)
    }

    pub fn set_enabled(&self, plugin_id: &str, enabled: bool) -> SetEnabledOutcome {
        let Some(plugin_id) = canonical_plugin_id(plugin_id.trim()) else {
            return SetEnabledOutcome::Rejected;
        };
        let catalog = match self.catalog() {
            Ok(catalog) => catalog,
            Err(_) => return SetEnabledOutcome::Unknown,
        };
        let known = MANAGED_PLUGIN_IDS.contains(&plugin_id)
            || catalog.plugins.iter().any(|entry| {
                entry.id == plugin_id && entry.platform == "openclaw" && entry.kind == "builtin"
            });
        if !known {
            return SetEnabledOutcome::Rejected;
        }
        let previous = catalog.execution.enabled_plugin_ids;
        let mut next = previous.clone();
        if enabled {
            if !next.iter().any(|id| id == plugin_id) {
                next.push(plugin_id.to_owned());
            }
        } else {
            next.retain(|id| id != plugin_id);
        }
        match self.apply_transition_lifecycle(&previous, &next) {
            Ok(()) => SetEnabledOutcome::Configured,
            Err(PluginError::Config) => SetEnabledOutcome::Unknown,
        }
    }

    pub fn operation(&self, operation: PluginOperation, plugin_id: &str) -> PluginOperationOutcome {
        let Some(plugin_id) = canonical_plugin_id(plugin_id.trim()) else {
            return PluginOperationOutcome::Rejected;
        };
        if !MANUALLY_CONFIGURABLE_PLUGIN_IDS.contains(&plugin_id) {
            return PluginOperationOutcome::Rejected;
        }
        let extensions = self.state_dir.as_path().join("extensions");
        match operation {
            PluginOperation::Install | PluginOperation::Update => {
                let selected = [plugin_id.to_owned()];
                match self.reconcile_enabled_managed_plugins(&selected) {
                    Ok(result)
                        if result.installed_ids.iter().any(|id| id == plugin_id)
                            || result.updated_ids.iter().any(|id| id == plugin_id)
                            || result.unchanged_ids.iter().any(|id| id == plugin_id) =>
                    {
                        self.set_enabled(plugin_id, true).into_operation_outcome()
                    }
                    Ok(_) => PluginOperationOutcome::Rejected,
                    Err(managed_reconcile::PluginReconcileError::TargetConflict { .. }) => {
                        PluginOperationOutcome::Rejected
                    }
                    Err(_) => PluginOperationOutcome::Unknown,
                }
            }
            PluginOperation::Uninstall => {
                match managed_reconcile::managed_target_exists(&extensions, plugin_id) {
                    Ok(true) => match self.apply_transition_lifecycle(&[plugin_id.to_owned()], &[])
                    {
                        Ok(()) => PluginOperationOutcome::Configured,
                        Err(_) => PluginOperationOutcome::Unknown,
                    },
                    Ok(false) => PluginOperationOutcome::Rejected,
                    Err(_) => PluginOperationOutcome::Unknown,
                }
            }
        }
    }

    pub fn finalize_uninstall(&self, plugin_id: &str) -> PluginOperationOutcome {
        let Some(plugin_id) = canonical_plugin_id(plugin_id.trim()) else {
            return PluginOperationOutcome::Rejected;
        };
        if !MANUALLY_CONFIGURABLE_PLUGIN_IDS.contains(&plugin_id) {
            return PluginOperationOutcome::Rejected;
        }
        let extensions = self.state_dir.as_path().join("extensions");
        match managed_reconcile::remove_managed_target(&extensions, plugin_id) {
            Ok(true) => PluginOperationOutcome::Configured,
            Ok(false) | Err(_) => PluginOperationOutcome::Unknown,
        }
    }

    fn discover(&self) -> Vec<CatalogEntry> {
        let mut by_id = BTreeMap::new();
        discover_root(&self.managed_plugin_root, &mut by_id);
        by_id.into_values().collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginError {
    Config,
}

fn discover_root(root: &Path, output: &mut BTreeMap<String, CatalogEntry>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for item in entries.flatten() {
        let path = item.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = if path.join(MANIFEST).is_file() {
            path.join(MANIFEST)
        } else if path.join(PACKAGE).is_file() {
            path.join(PACKAGE)
        } else {
            continue;
        };
        let package_path = path.join(PACKAGE);
        let Ok(metadata) = fs::metadata(&manifest_path) else {
            continue;
        };
        if metadata.len() > MAX_METADATA_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(package) = read_package_metadata(&package_path) {
            if let Some(object) = value.as_object_mut() {
                if !object.contains_key("version")
                    || text(object.get("version")).as_deref() == Some("0.0.0")
                {
                    if let Some(version) = package.get("version") {
                        object.insert("version".into(), version.clone());
                    }
                }
                if !object.contains_key("description") {
                    if let Some(description) = package.get("description") {
                        object.insert("description".into(), description.clone());
                    }
                }
            }
        }
        let Some(source_id) = text(value.get("id")).or_else(|| text(value.get("name"))) else {
            continue;
        };
        let Some(id) = canonical_plugin_id(&source_id).map(ToOwned::to_owned) else {
            continue;
        };
        let description = text(value.get("description"));
        let entry = CatalogEntry {
            runtime: "openclaw",
            id: id.clone(),
            name: text(value.get("name")).unwrap_or_else(|| id.clone()),
            version: text(value.get("version")).unwrap_or_else(|| "0.0.0".into()),
            kind: if value
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.starts_with("@matchaclaw/"))
                || MANAGED_PLUGIN_IDS.contains(&id.as_str())
            {
                "builtin"
            } else {
                "third-party"
            }
            .into(),
            platform: "openclaw".into(),
            description,
            companion_skill_slugs: match companion_skill_slugs(&id) {
                slugs if slugs.is_empty() => None,
                slugs => Some(slugs.into_iter().map(ToOwned::to_owned).collect()),
            },
            enabled: false,
            installed: false,
            update_available: false,
            companion_skill_ready: false,
        };
        if source_id == id || !output.contains_key(&id) {
            output.insert(id, entry);
        }
    }
}

fn read_package_metadata(path: &Path) -> Option<Map<String, Value>> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_METADATA_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn managed_target_version(path: &Path, id: &str) -> Option<String> {
    let target = fs::symlink_metadata(path).ok()?;
    if !target.is_dir() || target.file_type().is_symlink() {
        return None;
    }
    let marker = managed_reconcile::read_managed_marker(path, id).ok()??;
    parse_version(&marker.version).map(|_| marker.version)
}

fn companion_skills_ready(state_dir: &Path, plugin_id: &str) -> bool {
    let slugs = companion_skill_slugs(plugin_id);
    !slugs.is_empty()
        && slugs.into_iter().all(|slug| {
            let target = state_dir.join("skills").join(slug);
            let target_metadata = match fs::symlink_metadata(&target) {
                Ok(metadata) => metadata,
                Err(_) => return false,
            };
            if !target_metadata.is_dir() || target_metadata.file_type().is_symlink() {
                return false;
            }
            let marker_path = target.join(".matcha-companion-installed");
            let marker_metadata = match fs::symlink_metadata(&marker_path) {
                Ok(metadata) => metadata,
                Err(_) => return false,
            };
            if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
                return false;
            }
            let Ok(marker) = fs::read_to_string(marker_path) else {
                return false;
            };
            if !matches!(
                marker.as_str(),
                "matcha-companion-v1" | "matcha-companion-v1\n" | "matcha-companion-v1\r\n"
            ) {
                return false;
            }
            let skill_path = target.join("SKILL.md");
            let Ok(skill_metadata) = fs::symlink_metadata(skill_path) else {
                return false;
            };
            skill_metadata.is_file() && !skill_metadata.file_type().is_symlink()
        })
}

fn parse_version(version: &str) -> Option<SemanticVersion> {
    let version = version.trim();
    let (core_and_pre, build) = version.split_once('+').unwrap_or((version, ""));
    if version.matches('+').count() > 1
        || (!build.is_empty()
            && !build.split('.').all(|identifier| {
                !identifier.is_empty()
                    && identifier
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            }))
    {
        return None;
    }
    let (core, prerelease) = core_and_pre
        .split_once('-')
        .map_or((core_and_pre, None), |(core, prerelease)| {
            (core, Some(prerelease))
        });
    let mut components = core.split('.');
    let major = parse_numeric_component(components.next()?)?;
    let minor = parse_numeric_component(components.next()?)?;
    let patch = parse_numeric_component(components.next()?)?;
    if components.next().is_some() || prerelease.is_some_and(str::is_empty) {
        return None;
    }
    let prerelease = match prerelease {
        None => None,
        Some(value) => Some(
            value
                .split('.')
                .map(|identifier| {
                    if identifier.is_empty()
                        || !identifier
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric() || character == '-')
                        || (identifier.len() > 1
                            && identifier.starts_with('0')
                            && identifier
                                .chars()
                                .all(|character| character.is_ascii_digit()))
                    {
                        return None;
                    }
                    Some(identifier.to_owned())
                })
                .collect::<Option<Vec<_>>>()?,
        ),
    };
    Some(SemanticVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn parse_numeric_component(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SemanticVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<Vec<String>>,
}

impl Ord for SemanticVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.prerelease, &other.prerelease) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(left), Some(right)) => compare_prerelease(left, right),
            })
    }
}

impl PartialOrd for SemanticVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(left: &[String], right: &[String]) -> Ordering {
    for (left, right) in left.iter().zip(right) {
        let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn is_safe_plugin_target_id(id: &str) -> bool {
    let mut components = Path::new(id).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

fn canonical_plugin_id(id: &str) -> Option<&str> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_whitespace) {
        return None;
    }
    Some(match id {
        "feishu-openclaw-plugin" => "openclaw-lark",
        "wecom-openclaw-plugin" => "wecom",
        "qqbot" => "openclaw-qqbot",
        id => id,
    })
}

fn is_manually_configurable_plugin(id: &str) -> bool {
    MANUALLY_CONFIGURABLE_PLUGIN_IDS.contains(&id)
}

fn configured_channel_plugin_id(channel_type: &str) -> Option<String> {
    let mut document = OpenClawConfigDocument::empty();
    let mut channel = Map::new();
    channel.insert("appId".into(), Value::String("configured".into()));
    channel.insert("accounts".into(), serde_json::json!({"selected": {}}));
    let mut channels = Map::new();
    channels.insert(channel_type.to_owned(), Value::Object(channel));
    document.insert("channels".into(), Value::Object(channels));
    super::channel::configured_plugin_ids(&document)
        .into_iter()
        .next()
}

fn set_plugin_enabled_config(
    document: &mut OpenClawConfigDocument,
    plugin_id: &str,
    enabled: bool,
) -> bool {
    let Some(plugin_id) = canonical_plugin_id(plugin_id) else {
        return false;
    };
    let mut plugins = object(document.get("plugins"));
    let allow = canonicalize_ids(strings(plugins.get("allow")));
    let mut deny = canonicalize_ids(strings(plugins.get("deny")));
    let legacy_entries = object(plugins.get("entries"));
    let mut entries = canonicalize_entries(legacy_entries.clone());
    let mut next_allow = allow;
    if enabled {
        next_allow.insert(plugin_id.to_owned());
        deny.remove(plugin_id);
    } else {
        next_allow.remove(plugin_id);
    }
    let mut entry = object(entries.get(plugin_id));
    entry.insert("enabled".into(), Value::Bool(enabled));
    entries.insert(plugin_id.to_owned(), Value::Object(entry));
    if enabled && plugin_id == "openclaw-lark" {
        let mut legacy_entry = object(legacy_entries.get("feishu-openclaw-plugin"));
        legacy_entry.insert("enabled".into(), Value::Bool(false));
        entries.insert("feishu-openclaw-plugin".into(), Value::Object(legacy_entry));
    }
    let allow_value = Value::Array(next_allow.into_iter().map(Value::String).collect());
    let deny_value = Value::Array(deny.into_iter().map(Value::String).collect());
    let entries_value = Value::Object(entries);
    let changed = plugins.get("allow") != Some(&allow_value)
        || plugins.get("deny") != Some(&deny_value)
        || plugins.get("entries") != Some(&entries_value);
    if !changed {
        return false;
    }
    plugins.insert("allow".into(), allow_value);
    plugins.insert("deny".into(), deny_value);
    plugins.insert("entries".into(), entries_value);
    document.insert("plugins".into(), Value::Object(plugins));
    true
}

fn canonicalize_ids(ids: BTreeSet<String>) -> BTreeSet<String> {
    ids.into_iter()
        .filter_map(|id| canonical_plugin_id(&id).map(ToOwned::to_owned))
        .collect()
}

fn canonicalize_entries(entries: Map<String, Value>) -> Map<String, Value> {
    let mut result = Map::new();
    for (id, value) in entries {
        let canonical = canonical_plugin_id(&id).unwrap_or(&id).to_owned();
        if canonical == id || !result.contains_key(&canonical) {
            result.insert(canonical, value);
        }
    }
    result
}

#[cfg(test)]
fn remove_owned_target(path: &Path, id: &str) -> Result<bool, PluginReconcileError> {
    let Some(extensions) = path.parent() else {
        return Ok(false);
    };
    managed_reconcile::remove_managed_target(extensions, id)
}

impl SetEnabledOutcome {
    fn into_operation_outcome(self) -> PluginOperationOutcome {
        match self {
            Self::Configured => PluginOperationOutcome::Configured,
            Self::Rejected => PluginOperationOutcome::Rejected,
            Self::Unknown => PluginOperationOutcome::Unknown,
        }
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}
fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn strings(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| text(Some(v))).collect())
        .unwrap_or_default()
}
fn enabled_ids(document: &OpenClawConfigDocument, known_ids: &BTreeSet<&str>) -> BTreeSet<String> {
    let plugins = object(document.get("plugins"));
    if plugins.get("enabled").and_then(Value::as_bool) == Some(false) {
        return BTreeSet::new();
    }
    let denied = canonicalize_ids(strings(plugins.get("deny")));
    let allowed = canonicalize_ids(strings(plugins.get("allow")));
    let entries = canonicalize_entries(object(plugins.get("entries")));
    let mut ids = allowed
        .into_iter()
        .filter(|id| known_ids.contains(id.as_str()))
        .collect::<BTreeSet<_>>();
    for (id, value) in &entries {
        if !known_ids.contains(id.as_str()) {
            continue;
        }
        match value.get("enabled").and_then(Value::as_bool) {
            Some(true) => {
                ids.insert(id.clone());
            }
            Some(false) => {
                ids.remove(id);
            }
            None => {}
        }
    }
    ids.retain(|id| !denied.contains(id));
    ids
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use rusqlite::Connection;
    use serde_json::{Map, Value};

    use super::{
        ChannelPluginPreparation, MANAGED_PLUGIN_IDS, PluginOperation, PluginOperationOutcome,
        PluginProjection, SetEnabledOutcome, canonicalize_entries, canonicalize_ids,
        companion_skills_ready, enabled_ids, managed_target_version, parse_version,
    };

    const MANAGED_MARKER: &str = ".matchaclaw-managed";
    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "matcha-openclaw-plugin-projection-{}-{}",
                std::process::id(),
                NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn projection(
            &self,
            state_dir: platform::state_dir::CanonicalStateDir,
            companion_source: impl Into<PathBuf>,
            plugin_root: impl Into<PathBuf>,
        ) -> PluginProjection {
            PluginProjection::new(state_dir, companion_source, plugin_root, self.0.clone())
        }

        fn write_bundle(&self, plugin_root: &std::path::Path, id: &str, version: &str) {
            fs::create_dir_all(plugin_root.join(id).join("dist")).unwrap();
            fs::write(
                plugin_root.join(id).join("openclaw.plugin.json"),
                serde_json::json!({"id": id, "name": id}).to_string(),
            )
            .unwrap();
            fs::write(
                plugin_root.join(id).join("package.json"),
                serde_json::json!({"name": format!("@matchaclaw/{id}"), "version": version})
                    .to_string(),
            )
            .unwrap();
            fs::write(plugin_root.join(id).join("dist/index.js"), version).unwrap();
        }

        fn create_openclaw_database(&self, state_dir: &platform::state_dir::CanonicalStateDir) {
            let database_path = state_dir.as_path().join("state").join("openclaw.sqlite");
            fs::create_dir_all(database_path.parent().unwrap()).unwrap();
            Connection::open(database_path)
                .unwrap()
                .execute(
                    "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
                    [],
                )
                .unwrap();
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn managed_plugin_definition_ids_are_unique() {
        let mut ids = MANAGED_PLUGIN_IDS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MANAGED_PLUGIN_IDS.len());
    }

    #[test]
    fn managed_marker_reports_install_and_version_update() {
        let root = TestRoot::new();
        let target = root.0.join("extensions").join("browser-relay");
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join(MANAGED_MARKER),
            "browser-relay\n1.2.3\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        assert_eq!(
            managed_target_version(&target, "browser-relay"),
            Some("1.2.3".into())
        );
        assert!(parse_version("1.2.4").unwrap() > parse_version("1.2.3").unwrap());
        assert!(parse_version("not-a-version").is_none());
        fs::write(target.join(MANAGED_MARKER), "other\n1.2.3\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n").unwrap();
        assert!(managed_target_version(&target, "browser-relay").is_none());
    }

    #[test]
    fn remove_owned_target_requires_the_canonical_managed_marker() {
        let root = TestRoot::new();
        let target = root.0.join("extensions/browser-relay");
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join(MANAGED_MARKER),
            "browser-relay\n1.2.3\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        assert!(super::remove_owned_target(&target, "browser-relay").unwrap());
        assert!(!target.exists());

        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(MANAGED_MARKER), "browser-relay\n1.2.3\n").unwrap();
        assert!(!super::remove_owned_target(&target, "browser-relay").unwrap());
        assert!(target.exists());
    }

    #[test]
    fn companion_skill_ready_requires_safe_complete_target() {
        let root = TestRoot::new();
        let target = root.0.join("skills").join("browser-relay-skill");
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join(".matcha-companion-installed"),
            "matcha-companion-v1\n",
        )
        .unwrap();
        fs::write(target.join("SKILL.md"), "# Browser Relay\n").unwrap();
        assert!(companion_skills_ready(&root.0, "browser-relay"));
        fs::write(target.join(".matcha-companion-installed"), "unknown\n").unwrap();
        assert!(!companion_skills_ready(&root.0, "browser-relay"));
        assert!(!companion_skills_ready(&root.0, "unknown-plugin"));
    }

    #[test]
    fn prepare_configured_channel_plugin_maps_feishu_to_lark() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        root.write_bundle(&plugin_root, "openclaw-lark", "1.0.0");
        fs::write(
            plugin_root.join("openclaw-lark/package.json"),
            r#"{"name":"@matchaclaw/openclaw-lark","version":"1.0.0","peerDependencies":{"openclaw":"*"}}"#,
        )
        .unwrap();
        let openclaw_root = root.0.join("openclaw");
        fs::create_dir(&openclaw_root).unwrap();
        fs::write(
            openclaw_root.join("package.json"),
            r#"{"name":"openclaw","version":"2026.9.3"}"#,
        )
        .unwrap();
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();
        root.create_openclaw_database(&state_dir);
        let projection = root.projection(
            state_dir.clone(),
            root.0.join("companion-source"),
            plugin_root,
        );

        assert_eq!(
            projection
                .prepare_configured_channel_plugin("feishu", &root.0.join("openclaw"))
                .unwrap(),
            ChannelPluginPreparation {
                is_external_managed_channel: true,
                plugin_id: Some("openclaw-lark".into()),
                artifact_changed: true,
                peer_link_ok: true,
            }
        );
        assert!(
            state_dir
                .as_path()
                .join("extensions/openclaw-lark/.matchaclaw-managed")
                .is_file()
        );
        let peer_link = state_dir
            .as_path()
            .join("extensions/openclaw-lark/node_modules/openclaw");
        assert_eq!(
            peer_link.canonicalize().unwrap(),
            openclaw_root.canonicalize().unwrap()
        );
        let unchanged = projection
            .prepare_configured_channel_plugin("feishu", &openclaw_root)
            .unwrap();
        assert!(unchanged.peer_link_ok);
        assert!(!unchanged.artifact_changed);
        let failed = projection
            .prepare_configured_channel_plugin("feishu", &root.0.join("missing-runtime"))
            .unwrap();
        assert!(!failed.peer_link_ok);
        assert!(!failed.artifact_changed);
        fs::write(
            state_dir
                .as_path()
                .join("extensions/openclaw-lark/package.json"),
            b"invalid",
        )
        .unwrap();
        assert!(
            projection
                .prepare_configured_channel_plugin("feishu", &openclaw_root)
                .is_err()
        );
        let document = super::OpenClawConfigStore::new(state_dir).read().unwrap();
        assert!(document.as_value().get("plugins").is_none());
    }

    #[test]
    fn prepare_configured_channel_plugin_ignores_non_external_channels() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();
        let projection = root.projection(
            state_dir,
            root.0.join("companion-source"),
            root.0.join("plugins"),
        );

        assert_eq!(
            projection
                .prepare_configured_channel_plugin("telegram", &root.0.join("openclaw"))
                .unwrap(),
            ChannelPluginPreparation {
                is_external_managed_channel: false,
                plugin_id: None,
                artifact_changed: false,
                peer_link_ok: true,
            }
        );
    }

    #[test]
    fn prepare_configured_channel_plugin_keeps_other_configured_channel_targets() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        root.write_bundle(&plugin_root, "openclaw-lark", "1.0.0");
        root.write_bundle(&plugin_root, "wecom", "1.0.0");
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            r#"{"channels":{"feishu":{"appId":"configured"}}}"#,
        )
        .unwrap();
        root.create_openclaw_database(&state_dir);
        let projection = root.projection(
            state_dir.clone(),
            root.0.join("companion-source"),
            plugin_root,
        );

        projection
            .prepare_configured_channel_plugin("wecom", &root.0.join("openclaw"))
            .unwrap();

        assert!(
            state_dir
                .as_path()
                .join("extensions/openclaw-lark/.matchaclaw-managed")
                .is_file()
        );
        assert!(
            state_dir
                .as_path()
                .join("extensions/wecom/.matchaclaw-managed")
                .is_file()
        );
    }

    #[test]
    fn prepare_configured_channel_plugin_reports_artifact_update_and_no_change() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        root.write_bundle(&plugin_root, "wecom", "1.0.0");
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();
        root.create_openclaw_database(&state_dir);
        let projection = root.projection(
            state_dir,
            root.0.join("companion-source"),
            plugin_root.clone(),
        );

        assert!(
            projection
                .prepare_configured_channel_plugin("wecom", &root.0.join("openclaw"))
                .unwrap()
                .artifact_changed
        );
        assert!(
            !projection
                .prepare_configured_channel_plugin("wecom", &root.0.join("openclaw"))
                .unwrap()
                .artifact_changed
        );
        root.write_bundle(&plugin_root, "wecom", "2.0.0");
        assert!(
            projection
                .prepare_configured_channel_plugin("wecom", &root.0.join("openclaw"))
                .unwrap()
                .artifact_changed
        );
    }

    #[test]
    fn plugin_operations_install_with_companion_and_reject_unmanaged_targets() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        fs::create_dir_all(plugin_root.join("browser-relay")).unwrap();
        fs::write(
            plugin_root.join("browser-relay/openclaw.plugin.json"),
            r#"{"id":"browser-relay","name":"Browser Relay","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            plugin_root.join("browser-relay/package.json"),
            r#"{"version":"1.0.0"}"#,
        )
        .unwrap();
        let companion_source = root.0.join("companion-source");
        fs::create_dir_all(companion_source.join("browser-relay-skill")).unwrap();
        fs::write(
            companion_source.join("browser-relay-skill/SKILL.md"),
            b"# Browser Relay\n",
        )
        .unwrap();
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();
        let projection = root.projection(state_dir.clone(), companion_source, plugin_root);

        assert_eq!(
            projection.operation(PluginOperation::Uninstall, "browser-relay"),
            PluginOperationOutcome::Rejected
        );
        assert_eq!(
            projection.operation(PluginOperation::Install, "browser-relay"),
            PluginOperationOutcome::Configured
        );
        assert_eq!(
            projection.operation(PluginOperation::Update, "browser-relay"),
            PluginOperationOutcome::Configured
        );

        let target = state_dir.as_path().join("extensions/browser-relay");
        fs::remove_dir_all(&target).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("package.json"), b"{}").unwrap();
        assert_eq!(
            projection.operation(PluginOperation::Update, "browser-relay"),
            PluginOperationOutcome::Rejected
        );
        assert_eq!(
            projection.operation(PluginOperation::Uninstall, "browser-relay"),
            PluginOperationOutcome::Rejected
        );
    }

    #[test]
    fn catalog_and_startup_lifecycle_accept_legacy_secret_bearing_config() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        fs::create_dir_all(plugin_root.join("browser-relay")).unwrap();
        fs::write(
            plugin_root.join("browser-relay/openclaw.plugin.json"),
            r#"{"id":"browser-relay","name":"Browser Relay","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            r#"{
              "gateway":{"auth":{"token":"legacy-token"}},
              "agents":{"list":[{"id":"default","model":{"apiKey":"legacy-key"}}]},
              "channels":{"feishu":{"appId":"app-id"}},
              "plugins":{"entries":{"browser-relay":{"enabled":true}}}
            }"#,
        )
        .unwrap();
        let projection = root.projection(
            state_dir.clone(),
            root.0.join("companion-source"),
            plugin_root,
        );

        let catalog = projection.catalog().unwrap();
        assert_eq!(catalog.execution.enabled_plugin_ids, vec!["browser-relay"]);
        assert_eq!(
            projection.configured_channel_plugin_ids().unwrap(),
            vec!["openclaw-lark"]
        );
        crate::native_config::plugin_lifecycle::apply_startup_config(
            &super::OpenClawConfigStore::new(state_dir.clone()),
            ["memory-lancedb-pro"],
        )
        .unwrap();
        assert!(
            super::OpenClawConfigStore::new(state_dir)
                .read_private()
                .unwrap()
                .get("gateway")
                .is_some()
        );
    }

    #[test]
    fn catalog_lists_only_manually_configurable_plugins_but_keeps_execution_state() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        for plugin_id in [
            "browser-relay",
            "matchaclaw-media",
            "memory-lancedb-pro",
            "openclaw-weixin",
            "qwen",
            "security-core",
            "task-manager",
        ] {
            root.write_bundle(&plugin_root, plugin_id, "1.0.0");
        }
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            r#"{"plugins":{"allow":["browser-relay","matchaclaw-media","memory-lancedb-pro","openclaw-weixin","qwen","security-core","task-manager"]}}"#,
        )
        .unwrap();
        let projection = root.projection(state_dir, root.0.join("companion-source"), plugin_root);

        let catalog = projection.catalog().unwrap();
        let visible_ids = catalog
            .plugins
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            visible_ids,
            vec![
                "browser-relay",
                "matchaclaw-media",
                "memory-lancedb-pro",
                "security-core",
                "task-manager",
            ]
        );
        assert_eq!(
            catalog.execution.enabled_plugin_ids,
            vec![
                "browser-relay",
                "matchaclaw-media",
                "memory-lancedb-pro",
                "openclaw-weixin",
                "qwen",
                "security-core",
                "task-manager",
            ]
        );
    }

    #[test]
    fn allowed_managed_channel_is_reconciled_as_matcha_extension() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        root.write_bundle(&plugin_root, "openclaw-weixin", "2.4.8");
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            r#"{"plugins":{"allow":["openclaw-weixin"]}}"#,
        )
        .unwrap();
        let projection = root.projection(
            state_dir.clone(),
            root.0.join("companion-source"),
            plugin_root,
        );
        let catalog = projection.catalog().unwrap();

        projection
            .reconcile_enabled_managed_plugins(&catalog.execution.enabled_plugin_ids)
            .unwrap();

        assert!(
            state_dir
                .as_path()
                .join("extensions/openclaw-weixin/.matchaclaw-managed")
                .is_file()
        );
    }

    #[test]
    fn set_enabled_applies_transition_once_without_separate_config_owner() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let plugin_root = root.0.join("plugins");
        fs::create_dir_all(plugin_root.join("browser-relay")).unwrap();
        fs::write(
            plugin_root.join("browser-relay/openclaw.plugin.json"),
            r#"{"id":"browser-relay","name":"Browser Relay","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();
        let companion_source = root.0.join("companion-source");
        fs::create_dir_all(companion_source.join("browser-relay-skill")).unwrap();
        fs::write(
            companion_source.join("browser-relay-skill/SKILL.md"),
            b"# Browser Relay\n",
        )
        .unwrap();
        let projection = root.projection(state_dir.clone(), companion_source, plugin_root);

        assert_eq!(
            projection.set_enabled("browser-relay", true),
            SetEnabledOutcome::Configured
        );
        let document = super::OpenClawConfigStore::new(state_dir.clone())
            .read()
            .unwrap();
        assert_eq!(
            document.as_value()["plugins"]["entries"]["browser-relay"]["enabled"],
            true
        );
        assert_eq!(
            projection.set_enabled("browser-relay", false),
            SetEnabledOutcome::Configured
        );
        let document = super::OpenClawConfigStore::new(state_dir).read().unwrap();
        assert_eq!(
            document.as_value()["plugins"]["entries"]["browser-relay"]["enabled"],
            false
        );
    }

    #[test]
    fn qqbot_manifest_skills_follow_startup_and_transition_without_copying_skills() {
        let root = TestRoot::new();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.0.join("state")).unwrap();
        let target = state_dir.as_path().join("extensions/openclaw-qqbot");
        fs::create_dir_all(target.join("skills/lesson")).unwrap();
        fs::write(
            target.join("openclaw.plugin.json"),
            r#"{"id":"openclaw-qqbot","skills":["./skills"]}"#,
        )
        .unwrap();
        fs::write(target.join("skills/lesson/SKILL.md"), b"lesson").unwrap();
        fs::write(state_dir.as_path().join("openclaw.json"), r#"{}"#).unwrap();

        let projection = root.projection(
            state_dir.clone(),
            root.0.join("companion-source"),
            root.0.join("managed-plugins"),
        );
        projection
            .apply_startup_lifecycle(&["openclaw-qqbot".into()])
            .unwrap();
        let store = super::OpenClawConfigStore::new(state_dir.clone());
        assert_eq!(
            store.read().unwrap().as_value()["skills"]["entries"]["lesson"]["enabled"],
            true
        );
        assert!(!state_dir.as_path().join("skills/lesson").exists());

        projection
            .apply_transition_lifecycle(&["openclaw-qqbot".into()], &[])
            .unwrap();
        assert_eq!(
            store.read().unwrap().as_value()["skills"]["entries"]["lesson"]["enabled"],
            false
        );
        assert!(!state_dir.as_path().join("skills/lesson").exists());
    }

    #[test]
    fn legacy_plugin_ids_canonicalize_without_losing_unowned_entries() {
        let ids = canonicalize_ids(
            [
                "feishu-openclaw-plugin",
                "openclaw-lark",
                "wecom-openclaw-plugin",
                "qqbot",
                "openclaw-qqbot",
                "custom-plugin",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        assert_eq!(
            ids,
            ["custom-plugin", "openclaw-lark", "openclaw-qqbot", "wecom"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );

        let entries = canonicalize_entries(Map::from_iter([
            ("openclaw-lark".into(), Value::String("canonical".into())),
            (
                "feishu-openclaw-plugin".into(),
                Value::String("legacy".into()),
            ),
            ("custom-plugin".into(), Value::String("preserved".into())),
        ]));
        assert_eq!(
            entries.get("openclaw-lark"),
            Some(&Value::String("canonical".into()))
        );
        assert_eq!(
            entries.get("custom-plugin"),
            Some(&Value::String("preserved".into()))
        );
        assert!(!entries.contains_key("feishu-openclaw-plugin"));
    }

    #[test]
    fn enabled_ids_union_allow_and_true_entries_with_false_and_deny_precedence() {
        let document = super::OpenClawConfigDocument::empty();
        let mut document = document;
        document.insert(
            "plugins".into(),
            serde_json::json!({
                "allow": ["feishu-openclaw-plugin", "openclaw-lark", "custom-plugin"],
                "deny": ["wecom-openclaw-plugin", "wecom"],
                "entries": {
                    "openclaw-lark": {"enabled": false},
                    "wecom": {"enabled": true},
                    "openclaw-qqbot": {"enabled": true},
                    "custom-plugin": {"enabled": false}
                }
            }),
        );
        let known = ["openclaw-lark", "wecom", "openclaw-qqbot", "custom-plugin"]
            .into_iter()
            .collect();
        assert_eq!(
            enabled_ids(&document, &known),
            ["openclaw-qqbot"].into_iter().map(str::to_owned).collect()
        );
    }

    #[test]
    fn set_enabled_normalizes_owned_config_and_preserves_non_owned_metadata() {
        let mut document = super::OpenClawConfigDocument::empty();
        document.insert(
            "plugins".into(),
            serde_json::json!({
                "customSetting": {"keep": true},
                "allow": ["feishu-openclaw-plugin", "openclaw-lark", "custom-plugin"],
                "deny": ["wecom-openclaw-plugin", "wecom"],
                "entries": {
                    "feishu-openclaw-plugin": {"config": {"legacy": true}, "enabled": true},
                    "openclaw-lark": {"config": {"canonical": true}},
                    "custom-plugin": {"config": {"keep": "yes"}}
                }
            }),
        );
        assert!(super::set_plugin_enabled_config(
            &mut document,
            "openclaw-lark",
            true
        ));
        let value = document.as_value();
        assert_eq!(value["plugins"]["customSetting"]["keep"], true);
        assert_eq!(
            value["plugins"]["entries"]["openclaw-lark"]["config"]["canonical"],
            true
        );
        assert_eq!(
            value["plugins"]["entries"]["feishu-openclaw-plugin"]["enabled"],
            false
        );
        assert_eq!(
            value["plugins"]["entries"]["custom-plugin"]["config"]["keep"],
            "yes"
        );
        assert_eq!(
            value["plugins"]["allow"],
            serde_json::json!(["custom-plugin", "openclaw-lark"])
        );
        assert_eq!(value["plugins"]["deny"], serde_json::json!(["wecom"]));

        assert!(super::set_plugin_enabled_config(
            &mut document,
            "openclaw-lark",
            false
        ));
        assert_eq!(
            document.as_value()["plugins"]["entries"]["openclaw-lark"]["enabled"],
            false
        );
    }
}
