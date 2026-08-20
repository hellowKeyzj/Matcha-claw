use std::{
    collections::BTreeSet,
    fs, io,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::text;
use crate::lifecycle::state_dir::CanonicalStateDir;

const MANIFEST: &str = "openclaw.plugin.json";
const PACKAGE: &str = "package.json";
const MANAGED_MARKER: &str = ".matchaclaw-managed";
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(1);

const MANAGED_CAPABILITY_IDS: &[&str] = &[
    "task-manager",
    "security-core",
    "browser-relay",
    "memory-lancedb-pro",
    "matchaclaw-media",
];

const MANAGED_CHANNEL_IDS: &[&str] = &[
    "dingtalk",
    "openclaw-lark",
    "wecom",
    "openclaw-qqbot",
    "openclaw-weixin",
    "discord",
    "whatsapp",
];

const MANAGED_SOURCES: &[(&str, &[&str])] = &[
    ("dingtalk", &["dingtalk"]),
    (
        "openclaw-lark",
        &["openclaw-lark", "feishu-openclaw-plugin"],
    ),
    ("wecom", &["wecom", "wecom-openclaw-plugin"]),
    ("openclaw-qqbot", &["openclaw-qqbot", "qqbot"]),
    ("openclaw-weixin", &["openclaw-weixin"]),
    ("discord", &["discord"]),
    ("whatsapp", &["whatsapp"]),
    ("task-manager", &["task-manager"]),
    ("security-core", &["security-core"]),
    ("browser-relay", &["browser-relay"]),
    ("memory-lancedb-pro", &["memory-lancedb-pro"]),
    ("matchaclaw-media", &["matchaclaw-media"]),
];

pub(crate) fn reconcile(
    state_dir: &CanonicalStateDir,
    managed_plugin_root: &Path,
) -> Result<ManagedPluginReconcile, PluginReconcileError> {
    reconcile_bundles(state_dir, managed_plugin_root, None)
}

pub(crate) fn reconcile_selected(
    state_dir: &CanonicalStateDir,
    managed_plugin_root: &Path,
    plugin_ids: &[String],
) -> Result<ManagedPluginReconcile, PluginReconcileError> {
    reconcile_selected_ids(
        state_dir,
        managed_plugin_root,
        plugin_ids,
        MANAGED_CAPABILITY_IDS,
    )
}

pub(crate) fn reconcile_selected_channels(
    state_dir: &CanonicalStateDir,
    managed_plugin_root: &Path,
    plugin_ids: &[String],
) -> Result<ManagedPluginReconcile, PluginReconcileError> {
    reconcile_selected_ids(
        state_dir,
        managed_plugin_root,
        plugin_ids,
        MANAGED_CHANNEL_IDS,
    )
}

fn reconcile_selected_ids(
    state_dir: &CanonicalStateDir,
    managed_plugin_root: &Path,
    plugin_ids: &[String],
    allowed_ids: &[&str],
) -> Result<ManagedPluginReconcile, PluginReconcileError> {
    let selected_ids = plugin_ids
        .iter()
        .filter(|id| allowed_ids.contains(&id.as_str()))
        .cloned()
        .collect::<BTreeSet<_>>();
    reconcile_bundles(state_dir, managed_plugin_root, Some(&selected_ids))
}

fn reconcile_bundles(
    state_dir: &CanonicalStateDir,
    managed_plugin_root: &Path,
    selected_ids: Option<&BTreeSet<String>>,
) -> Result<ManagedPluginReconcile, PluginReconcileError> {
    let bundles = discover_managed_bundles(managed_plugin_root, selected_ids)?;
    let extensions = state_dir.as_path().join("extensions");
    ensure_directory(&extensions)?;

    let mut result = ManagedPluginReconcile::default();
    for bundle in &bundles {
        let target = extensions.join(&bundle.id);
        match target_state(&target, &bundle.id)? {
            TargetState::Missing => {
                install_bundle(bundle, &target, &extensions)?;
                result.installed_ids.push(bundle.id.clone());
            }
            TargetState::Managed {
                version,
                content_signature,
            } if version == bundle.version && content_signature == bundle.content_signature => {
                result.unchanged_ids.push(bundle.id.clone());
            }
            TargetState::Managed { .. } => {
                install_bundle(bundle, &target, &extensions)?;
                result.updated_ids.push(bundle.id.clone());
            }
            TargetState::Unmanaged => {
                return Err(PluginReconcileError::TargetConflict {
                    id: bundle.id.clone(),
                });
            }
        }
    }

    result.removed_ids = remove_stale_managed_builtin_targets(&extensions)?;

    // A missing source is not an uninstall request. Cleanup is limited to
    // obsolete builtin alias targets with a valid MatchaClaw managed marker.
    result.sort_ids();
    Ok(result)
}

fn remove_stale_managed_builtin_targets(
    extensions: &Path,
) -> Result<Vec<String>, PluginReconcileError> {
    let extensions = extensions
        .canonicalize()
        .map_err(PluginReconcileError::io)?;
    let mut removed_ids = Vec::new();
    for entry in fs::read_dir(&extensions).map_err(PluginReconcileError::io)? {
        let entry = entry.map_err(PluginReconcileError::io)?;
        let target = entry.path();
        let target_name = entry.file_name();
        let Some(target_id) = target_name
            .to_str()
            .filter(|id| is_obsolete_managed_builtin_target(id))
        else {
            continue;
        };
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(PluginReconcileError::Io(error)),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(canonical_target) = target.canonicalize() else {
            continue;
        };
        if !canonical_target.starts_with(&extensions) {
            continue;
        }
        let Some(_) = read_managed_marker(&target, target_id).map_err(PluginReconcileError::io)?
        else {
            continue;
        };
        fs::remove_dir_all(&target).map_err(PluginReconcileError::io)?;
        removed_ids.push(target_id.to_owned());
    }
    Ok(removed_ids)
}

fn is_obsolete_managed_builtin_target(id: &str) -> bool {
    MANAGED_SOURCES
        .iter()
        .any(|(canonical_id, aliases)| *canonical_id != id && aliases.contains(&id))
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ManagedPluginReconcile {
    pub installed_ids: Vec<String>,
    pub updated_ids: Vec<String>,
    pub unchanged_ids: Vec<String>,
    pub removed_ids: Vec<String>,
}

impl ManagedPluginReconcile {
    fn sort_ids(&mut self) {
        self.installed_ids.sort();
        self.updated_ids.sort();
        self.unchanged_ids.sort();
        self.removed_ids.sort();
    }
}

#[derive(Debug)]
pub enum PluginReconcileError {
    Io(io::Error),
    InvalidSource { path: PathBuf, reason: &'static str },
    TargetConflict { id: String },
}

impl PluginReconcileError {
    fn io(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for PluginReconcileError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(output, "managed OpenClaw plugin I/O failed: {error}"),
            Self::InvalidSource { path, reason } => {
                write!(
                    output,
                    "managed OpenClaw plugin source rejected ({reason}): {}",
                    path.display()
                )
            }
            Self::TargetConflict { id } => {
                write!(output, "OpenClaw plugin target is not Matcha-managed: {id}")
            }
        }
    }
}

impl std::error::Error for PluginReconcileError {}

#[derive(Clone, Debug)]
struct ManagedBundle {
    id: String,
    source_id: String,
    version: String,
    content_signature: String,
    source: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ManagedMarker {
    pub(super) version: String,
    pub(super) content_signature: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TargetState {
    Missing,
    Managed {
        version: String,
        content_signature: String,
    },
    Unmanaged,
}

fn discover_managed_bundles(
    root: &Path,
    selected_ids: Option<&BTreeSet<String>>,
) -> Result<Vec<ManagedBundle>, PluginReconcileError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(PluginReconcileError::io(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PluginReconcileError::InvalidSource {
            path: root.to_owned(),
            reason: "managed plugin root is not a directory",
        });
    }
    let root = root.canonicalize().map_err(PluginReconcileError::io)?;
    let mut bundles = Vec::new();
    for &(canonical_id, aliases) in MANAGED_SOURCES {
        if selected_ids.is_some_and(|ids| !ids.contains(canonical_id)) {
            continue;
        }
        let mut selected = None;
        for &alias in aliases {
            let candidate = root.join(alias);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(PluginReconcileError::Io(error)),
            };
            if metadata.file_type().is_symlink() {
                return Err(PluginReconcileError::InvalidSource {
                    path: candidate,
                    reason: "symlink",
                });
            }
            if !metadata.is_dir() {
                continue;
            }
            let source = candidate.canonicalize().map_err(PluginReconcileError::io)?;
            if !source.starts_with(&root) {
                return Err(PluginReconcileError::InvalidSource {
                    path: source,
                    reason: "path escape",
                });
            }
            match validate_bundle_metadata(&source) {
                Ok((source_id, version)) => {
                    selected = Some(ManagedBundle {
                        id: canonical_id.to_owned(),
                        source_id,
                        version,
                        content_signature: bundle_content_signature(&source)?,
                        source,
                    });
                    break;
                }
                Err(_) => continue,
            }
        }
        if let Some(bundle) = selected {
            bundles.push(bundle);
        }
    }
    Ok(bundles)
}

fn validate_bundle_metadata(path: &Path) -> Result<(String, String), PluginReconcileError> {
    reject_symlinks(path, path)?;
    let manifest = read_metadata_file(&path.join(MANIFEST))?;
    let package = read_metadata_file(&path.join(PACKAGE))?;
    let id = text(manifest.get("id")).ok_or_else(|| PluginReconcileError::InvalidSource {
        path: path.join(MANIFEST),
        reason: "manifest id missing",
    })?;
    let manifest_version = text(manifest.get("version"));
    let package_version =
        text(package.get("version")).ok_or_else(|| PluginReconcileError::InvalidSource {
            path: path.join(PACKAGE),
            reason: "package version missing",
        })?;
    if manifest_version
        .as_deref()
        .is_some_and(|version| version != package_version)
        || !valid_plugin_id(&id)
    {
        return Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "manifest/package metadata mismatch",
        });
    }
    let version = manifest_version.unwrap_or(package_version);
    Ok((id, version))
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\'])
        && id.chars().all(|character| !character.is_whitespace())
        && Path::new(id).components().count() == 1
        && Path::new(id)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn read_metadata_file(path: &Path) -> Result<Map<String, Value>, PluginReconcileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            PluginReconcileError::InvalidSource {
                path: path.to_owned(),
                reason: "metadata file missing",
            }
        } else {
            PluginReconcileError::Io(error)
        }
    })?;
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES {
        return Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "metadata file is not a bounded regular file",
        });
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(PluginReconcileError::io)?)
        .map_err(|_| PluginReconcileError::InvalidSource {
        path: path.to_owned(),
        reason: "metadata is not valid JSON",
    })?;
    value
        .as_object()
        .cloned()
        .ok_or(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "metadata is not an object",
        })
}

fn reject_symlinks(path: &Path, root: &Path) -> Result<(), PluginReconcileError> {
    let metadata = fs::symlink_metadata(path).map_err(PluginReconcileError::io)?;
    if metadata.file_type().is_symlink() {
        return Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "symlink",
        });
    }
    let canonical = path.canonicalize().map_err(PluginReconcileError::io)?;
    if !canonical.starts_with(root) {
        return Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "path escape",
        });
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(PluginReconcileError::io)? {
            reject_symlinks(&entry.map_err(PluginReconcileError::io)?.path(), root)?;
        }
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), PluginReconcileError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "extensions is not a directory",
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(PluginReconcileError::io)
        }
        Err(error) => Err(PluginReconcileError::Io(error)),
    }
}

fn bundle_content_signature(path: &Path) -> Result<String, PluginReconcileError> {
    let mut hasher = Sha256::new();
    hash_tree(path, path, &mut hasher)?;
    let digest = hasher.finalize();
    let signature = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("sha256:{signature}"))
}

fn hash_tree(path: &Path, root: &Path, hasher: &mut Sha256) -> Result<(), PluginReconcileError> {
    let metadata = fs::symlink_metadata(path).map_err(PluginReconcileError::io)?;
    if metadata.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(PluginReconcileError::io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(PluginReconcileError::io)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            hash_tree(&entry.path(), root, hasher)?;
        }
        return Ok(());
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "unsupported filesystem entry",
        });
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| PluginReconcileError::InvalidSource {
            path: path.to_owned(),
            reason: "path escape",
        })?;
    hasher.update(relative.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(fs::read(path).map_err(PluginReconcileError::io)?);
    hasher.update([0]);
    Ok(())
}

fn target_state(path: &Path, id: &str) -> Result<TargetState, PluginReconcileError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(TargetState::Missing),
        Err(error) => return Err(PluginReconcileError::Io(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(TargetState::Unmanaged);
    }
    let Some(marker) = read_managed_marker(path, id).map_err(PluginReconcileError::io)? else {
        return Ok(TargetState::Unmanaged);
    };
    Ok(TargetState::Managed {
        version: marker.version,
        content_signature: marker.content_signature,
    })
}

pub(super) fn read_managed_marker(
    path: &Path,
    id: &str,
) -> Result<Option<ManagedMarker>, io::Error> {
    let marker = path.join(MANAGED_MARKER);
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let contents = fs::read_to_string(marker)?;
    let mut lines = contents.lines();
    let marker_id = lines.next().unwrap_or_default();
    let version = lines.next().unwrap_or_default().trim();
    let content_signature = lines.next().unwrap_or_default().trim();
    if marker_id != id
        || version.is_empty()
        || !valid_content_signature(content_signature)
        || lines.next().is_some()
    {
        return Ok(None);
    }
    Ok(Some(ManagedMarker {
        version: version.to_owned(),
        content_signature: content_signature.to_owned(),
    }))
}

fn valid_content_signature(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn install_bundle(
    bundle: &ManagedBundle,
    target: &Path,
    extensions: &Path,
) -> Result<(), PluginReconcileError> {
    let staging = extensions.join(format!(
        ".{}.staging-{}-{}",
        bundle.id,
        std::process::id(),
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let _cleanup = StagingCleanup(staging.clone());
    copy_tree(&bundle.source, &staging, &bundle.source)?;
    patch_staged_bundle(bundle, &staging)?;
    fs::write(
        staging.join(MANAGED_MARKER),
        format!(
            "{}\n{}\n{}\n",
            bundle.id, bundle.version, bundle.content_signature
        ),
    )
    .map_err(PluginReconcileError::io)?;
    if target.exists() {
        let backup = extensions.join(format!(
            ".{}.previous-{}",
            bundle.id,
            NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(target, &backup).map_err(PluginReconcileError::io)?;
        if let Err(error) = fs::rename(&staging, target) {
            let _ = fs::rename(&backup, target);
            return Err(PluginReconcileError::Io(error));
        }
        fs::remove_dir_all(backup).map_err(PluginReconcileError::io)?;
    } else {
        fs::rename(&staging, target).map_err(PluginReconcileError::io)?;
    }
    Ok(())
}

fn patch_staged_bundle(bundle: &ManagedBundle, staging: &Path) -> Result<(), PluginReconcileError> {
    if bundle.source_id != bundle.id {
        let manifest_path = staging.join(MANIFEST);
        let mut manifest = read_metadata_file(&manifest_path)?;
        manifest.insert("id".to_owned(), Value::String(bundle.id.clone()));
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| {
            PluginReconcileError::InvalidSource {
                path: manifest_path.clone(),
                reason: "manifest cannot be serialized",
            }
        })?;
        fs::write(manifest_path, bytes).map_err(PluginReconcileError::io)?;
    }

    let package = read_metadata_file(&staging.join(PACKAGE))?;
    for key in ["main", "module"] {
        let Some(entry) = text(package.get(key)) else {
            continue;
        };
        let entry_path = staging.join(&entry);
        let metadata = fs::symlink_metadata(&entry_path).map_err(PluginReconcileError::io)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_ENTRY_BYTES
        {
            return Err(PluginReconcileError::InvalidSource {
                path: entry_path,
                reason: "package entry is not a bounded regular file",
            });
        }
        let content = String::from_utf8(fs::read(&entry_path).map_err(PluginReconcileError::io)?)
            .map_err(|_| PluginReconcileError::InvalidSource {
            path: entry_path.clone(),
            reason: "package entry is not UTF-8",
        })?;
        let replacement = replace_plugin_id(&content, &bundle.source_id, &bundle.id);
        if replacement != content {
            fs::write(entry_path, replacement).map_err(PluginReconcileError::io)?;
        }
    }
    Ok(())
}

fn replace_plugin_id(content: &str, source_id: &str, canonical_id: &str) -> String {
    if source_id == canonical_id {
        return content.to_owned();
    }
    let mut output = String::with_capacity(content.len());
    let mut cursor = 0;
    while let Some(relative) = content[cursor..].find("id") {
        let start = cursor + relative;
        let before = content[..start].chars().next_back();
        let after = content[start + 2..].chars().next();
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
            || after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        {
            output.push_str(&content[cursor..start + 2]);
            cursor = start + 2;
            continue;
        }
        let rest = &content[start + 2..];
        let whitespace = rest.len() - rest.trim_start().len();
        let rest = &rest[whitespace..];
        if !rest.starts_with(':') {
            output.push_str(&content[cursor..start + 2]);
            cursor = start + 2;
            continue;
        }
        let rest = &rest[1..];
        let whitespace = rest.len() - rest.trim_start().len();
        let rest = &rest[whitespace..];
        let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else {
            output.push_str(&content[cursor..start + 2]);
            cursor = start + 2;
            continue;
        };
        let value_start = 1;
        let Some(end) = rest[value_start..].find(quote) else {
            output.push_str(&content[cursor..]);
            return output;
        };
        let value = &rest[value_start..value_start + end];
        output.push_str(&content[cursor..start]);
        output.push_str(
            &content[start..start + 2 + whitespace + 1 + (rest.len() - rest[value_start..].len())],
        );
        output.push(quote);
        if value == source_id {
            output.push_str(canonical_id);
        } else {
            output.push_str(value);
        }
        output.push(quote);
        cursor =
            start + 2 + whitespace + 1 + (rest.len() - rest[value_start..].len()) + 1 + end + 1;
    }
    output.push_str(&content[cursor..]);
    output
}

fn copy_tree(source: &Path, target: &Path, root: &Path) -> Result<(), PluginReconcileError> {
    reject_symlinks(source, root)?;
    let metadata = fs::symlink_metadata(source).map_err(PluginReconcileError::io)?;
    if metadata.is_dir() {
        fs::create_dir_all(target).map_err(PluginReconcileError::io)?;
        for entry in fs::read_dir(source).map_err(PluginReconcileError::io)? {
            let entry = entry.map_err(PluginReconcileError::io)?;
            copy_tree(&entry.path(), &target.join(entry.file_name()), root)?;
        }
    } else if metadata.is_file() {
        fs::copy(source, target).map_err(PluginReconcileError::io)?;
    } else {
        return Err(PluginReconcileError::InvalidSource {
            path: source.to_owned(),
            reason: "unsupported filesystem entry",
        });
    }
    Ok(())
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use crate::lifecycle::state_dir::CanonicalStateDir;

    use super::super::PluginProjection;
    use super::{MANAGED_MARKER, MANIFEST, PACKAGE, PluginReconcileError, reconcile_selected};

    struct TestRoot {
        path: PathBuf,
        state_dir: CanonicalStateDir,
        source: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "openclaw-plugin-reconcile-{}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create test root");
            let state_dir = CanonicalStateDir::provision(path.join("state")).expect("state dir");
            let source = path.join("managed");
            fs::create_dir_all(&source).expect("managed root");
            Self {
                path,
                state_dir,
                source,
            }
        }

        fn projection(&self) -> PluginProjection {
            PluginProjection::new(
                self.state_dir.clone(),
                self.source.join("companion-skills"),
                self.source.clone(),
            )
        }

        fn write_bundle(&self, id: &str, version: &str) {
            let bundle = self.source.join(id);
            fs::create_dir_all(bundle.join("dist")).expect("bundle dir");
            fs::write(
                bundle.join(MANIFEST),
                serde_json::json!({ "id": id, "name": id }).to_string(),
            )
            .expect("manifest");
            fs::write(
                bundle.join(PACKAGE),
                serde_json::json!({ "name": format!("@matchaclaw/{id}"), "version": version })
                    .to_string(),
            )
            .expect("package");
            fs::write(
                bundle.join("dist/index.js"),
                format!("export const version = '{version}';"),
            )
            .expect("entry");
        }

        fn target(&self, id: &str) -> PathBuf {
            self.state_dir.as_path().join("extensions").join(id)
        }

        fn reconcile_selected(&self, plugin_ids: &[&str]) -> super::ManagedPluginReconcile {
            let ids = plugin_ids
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<Vec<_>>();
            reconcile_selected(&self.state_dir, &self.source, &ids).expect("selected reconcile")
        }

        fn reconcile_selected_channels(
            &self,
            plugin_ids: &[&str],
        ) -> super::ManagedPluginReconcile {
            let ids = plugin_ids
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<Vec<_>>();
            super::reconcile_selected_channels(&self.state_dir, &self.source, &ids)
                .expect("channel reconcile")
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn missing_managed_source_root_is_empty_but_invalid_root_is_rejected() {
        let root = TestRoot::new();
        fs::remove_dir_all(&root.source).expect("remove managed root");

        let result = root
            .projection()
            .reconcile_managed_plugins()
            .expect("missing source is empty");
        assert!(result.installed_ids.is_empty());
        assert!(result.updated_ids.is_empty());
        assert!(result.unchanged_ids.is_empty());

        fs::write(&root.source, b"not a directory").expect("write invalid root");
        let error = root
            .projection()
            .reconcile_managed_plugins()
            .expect_err("file source must be rejected");
        assert!(matches!(
            error,
            PluginReconcileError::InvalidSource {
                reason: "managed plugin root is not a directory",
                ..
            }
        ));
    }

    #[test]
    fn reconcile_copies_bundle_and_is_idempotent() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");

        let first = root
            .projection()
            .reconcile_managed_plugins()
            .expect("install");
        assert_eq!(first.installed_ids, vec!["browser-relay"]);
        assert_eq!(
            fs::read_to_string(root.target("browser-relay").join("dist/index.js")).unwrap(),
            "export const version = '1.0.0';"
        );

        let second = root
            .projection()
            .reconcile_managed_plugins()
            .expect("reconcile");
        assert_eq!(second.unchanged_ids, vec!["browser-relay"]);
        assert!(second.installed_ids.is_empty());
    }

    #[test]
    fn reconcile_updates_managed_target_by_version() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        root.projection()
            .reconcile_managed_plugins()
            .expect("install");
        root.write_bundle("browser-relay", "2.0.0");

        let result = root
            .projection()
            .reconcile_managed_plugins()
            .expect("update");
        assert_eq!(result.updated_ids, vec!["browser-relay"]);
        assert!(
            fs::read_to_string(root.target("browser-relay").join(MANAGED_MARKER))
                .unwrap()
                .contains("2.0.0")
        );
    }

    #[test]
    fn reconcile_removes_only_marked_obsolete_builtin_alias_targets() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        root.projection()
            .reconcile_managed_plugins()
            .expect("install");
        fs::create_dir_all(root.target("feishu-openclaw-plugin")).expect("obsolete alias target");
        fs::write(
            root.target("feishu-openclaw-plugin").join(MANAGED_MARKER),
            "feishu-openclaw-plugin\n1.0.0\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .expect("managed marker");
        fs::create_dir_all(root.target("dingtalk")).expect("canonical target");
        fs::write(
            root.target("dingtalk").join(MANAGED_MARKER),
            "dingtalk\n1.0.0\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .expect("managed marker");
        fs::create_dir_all(root.target("wecom-openclaw-plugin")).expect("unmanaged alias target");
        fs::write(
            root.target("wecom-openclaw-plugin").join(MANAGED_MARKER),
            "wecom\n1.0.0\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .expect("wrong marker id");
        fs::create_dir_all(root.target("user-plugin")).expect("user target");
        fs::write(root.target("user-plugin").join("package.json"), "{}").expect("user package");

        let result = root
            .projection()
            .reconcile_managed_plugins()
            .expect("remove");
        assert_eq!(result.removed_ids, vec!["feishu-openclaw-plugin"]);
        assert!(!root.target("feishu-openclaw-plugin").exists());
        assert!(root.target("browser-relay").exists());
        assert!(root.target("dingtalk").exists());
        assert!(root.target("wecom-openclaw-plugin").exists());
        assert!(root.target("user-plugin").exists());
    }

    #[test]
    fn selected_reconcile_only_installs_requested_capabilities() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        root.write_bundle("task-manager", "1.0.0");
        root.write_bundle("dingtalk", "1.0.0");

        let result = root.reconcile_selected(&["browser-relay"]);

        assert_eq!(result.installed_ids, vec!["browser-relay"]);
        assert!(root.target("browser-relay").exists());
        assert!(!root.target("task-manager").exists());
        assert!(!root.target("dingtalk").exists());
    }

    #[test]
    fn selected_channel_reconcile_installs_only_configured_channel_plugins() {
        let root = TestRoot::new();
        root.write_bundle("dingtalk", "1.0.0");
        root.write_bundle("discord", "1.0.0");
        root.write_bundle("browser-relay", "1.0.0");

        let result = root.reconcile_selected_channels(&["dingtalk"]);

        assert_eq!(result.installed_ids, vec!["dingtalk"]);
        assert!(root.target("dingtalk").exists());
        assert!(!root.target("discord").exists());
        assert!(!root.target("browser-relay").exists());
    }

    #[test]
    fn selected_reconcile_leaves_target_when_source_alias_is_missing() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        root.reconcile_selected(&["browser-relay"]);
        fs::remove_dir_all(root.source.join("browser-relay")).expect("remove source");

        let result = root.reconcile_selected(&["browser-relay"]);

        assert!(result.installed_ids.is_empty());
        assert!(result.updated_ids.is_empty());
        assert!(root.target("browser-relay").exists());
    }

    #[test]
    fn selected_reconcile_cleans_obsolete_alias_without_source_bundle() {
        let root = TestRoot::new();
        fs::create_dir_all(root.target("feishu-openclaw-plugin")).expect("obsolete alias target");
        fs::write(
            root.target("feishu-openclaw-plugin").join(MANAGED_MARKER),
            "feishu-openclaw-plugin\n1.0.0\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .expect("managed marker");

        let result = root.reconcile_selected_channels(&["openclaw-lark"]);

        assert_eq!(result.removed_ids, vec!["feishu-openclaw-plugin"]);
        assert!(!root.target("feishu-openclaw-plugin").exists());
    }

    #[test]
    fn stale_alias_cleanup_skips_symlink_target() {
        let root = TestRoot::new();
        let outside = root.path.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.target("feishu-openclaw-plugin"))
            .expect("symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, root.target("feishu-openclaw-plugin"))
            .is_err()
        {
            return;
        }

        let result = root.reconcile_selected_channels(&["openclaw-lark"]);

        assert!(result.removed_ids.is_empty());
        assert!(root.target("feishu-openclaw-plugin").exists());
        assert!(outside.exists());
    }

    #[test]
    fn reconcile_updates_managed_target_when_source_content_changes_at_same_version() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        root.reconcile_selected(&["browser-relay"]);
        fs::write(
            root.source.join("browser-relay/dist/index.js"),
            "export const changed = true;",
        )
        .expect("change source");

        let result = root.reconcile_selected(&["browser-relay"]);

        assert_eq!(result.updated_ids, vec!["browser-relay"]);
        assert_eq!(
            fs::read_to_string(root.target("browser-relay").join("dist/index.js")).unwrap(),
            "export const changed = true;"
        );
    }

    #[test]
    fn reconcile_rejects_symlinked_bundle_content() {
        let root = TestRoot::new();
        root.write_bundle("browser-relay", "1.0.0");
        let outside = root.path.join("outside.js");
        fs::write(&outside, "outside").expect("outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.source.join("browser-relay/dist/escape.js"))
            .expect("symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(
            &outside,
            root.source.join("browser-relay/dist/escape.js"),
        )
        .is_err()
        {
            return;
        }

        let error = root
            .projection()
            .reconcile_managed_plugins()
            .expect_err("reject escape");
        assert!(matches!(
            error,
            PluginReconcileError::InvalidSource {
                reason: "symlink",
                ..
            }
        ));
        assert!(!root.target("browser-relay").exists());
    }
}
