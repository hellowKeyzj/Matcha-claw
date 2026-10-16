mod archive;
mod install;
mod upload;

use crate::{
    config::{ConfigStore, validate_id},
    persistence::atomic_write,
    rpc::{self, Error},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    path::{Component, Path, PathBuf},
};
use tokio::{fs, sync::Mutex};
use uuid::Uuid;

// ponytail: serialize skill mutations; use per-agent locks if write contention is measured.
static MUTATIONS: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    scope: String,
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Named {
    scope: String,
    agent_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remove {
    scope: String,
    agent_id: String,
    name: String,
    expected_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Install {
    scope: String,
    agent_id: String,
    name: String,
    trust: bool,
    #[serde(default)]
    replace: bool,
    source: Source,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Source {
    #[serde(rename_all = "camelCase")]
    Content {
        skill_md: String,
        #[serde(default)]
        resources: Vec<Resource>,
    },
    Local {
        path: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    path: String,
    bytes: Vec<u8>,
}

struct Bundle {
    skill_md: String,
    resources: Vec<Resource>,
}

pub async fn dispatch(method: &str, params: Value, config: &ConfigStore) -> rpc::Result<Value> {
    match method {
        "skills.list" => {
            let target: Target = rpc::params(params)?;
            let mut skills = Vec::new();
            if let Some(root) = skills_root(config, &target.scope, &target.agent_id, false).await? {
                let mut entries = fs::read_dir(&root).await.map_err(|e| storage("list", e))?;
                while let Some(entry) =
                    entries.next_entry().await.map_err(|e| storage("list", e))?
                {
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path)
                        .await
                        .map_err(|e| storage("inspect", e))?;
                    if is_link(&metadata) {
                        return Err(unsafe_link());
                    }
                    if !metadata.is_dir() {
                        continue;
                    }
                    checked_existing(&root, &path).await?;
                    let manifest = path.join("SKILL.md");
                    if metadata_optional(&manifest).await?.is_none() {
                        continue;
                    }
                    checked_file(&root, &manifest).await?;
                    let name = entry.file_name().into_string().map_err(|_| {
                        Error::invalid("Skill names must be valid UTF-8 path components")
                    })?;
                    validate_name(&name)?;
                    skills.push(description(&target.agent_id, &name));
                }
            }
            skills.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
            Ok(json!({
                "scope": "agent", "agentId": target.agent_id,
                "skills": skills, "application": application()
            }))
        }
        "skills.get" => {
            let target: Named = rpc::params(params)?;
            validate_name(&target.name)?;
            let _mutation = MUTATIONS.lock().await;
            let root = skills_root(config, &target.scope, &target.agent_id, false)
                .await?
                .ok_or_else(|| Error::not_found("Skill"))?;
            let directory = skill_directory(&root, &target.name).await?;
            let bundle = read_bundle(&directory).await?;
            Ok(json!({
                "skill": description(&target.agent_id, &target.name),
                "bundleSha256": bundle_sha256(&bundle),
                "skillMd": bundle.skill_md, "resources": bundle.resources,
                "application": application()
            }))
        }
        "skills.install" => install::dispatch(rpc::params(params)?, config).await,
        "skills.upload.begin" | "skills.upload.chunk" | "skills.upload.commit" => {
            upload::dispatch(method, params, config).await
        }
        "skills.remove" => {
            let request: Remove = rpc::params(params)?;
            validate_name(&request.name)?;
            if request.expected_sha256.as_ref().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }) {
                return Err(Error::invalid(
                    "expectedSha256 must be a lowercase SHA-256 digest",
                ));
            }
            let _mutation = MUTATIONS.lock().await;
            let root = skills_root(config, &request.scope, &request.agent_id, false)
                .await?
                .ok_or_else(|| Error::not_found("Skill"))?;
            let directory = skill_directory(&root, &request.name).await?;
            if let Some(expected) = &request.expected_sha256 {
                if &bundle_sha256(&read_bundle(&directory).await?) != expected {
                    return Err(Error::conflict(
                        "skill_source_changed",
                        "Skill content changed; source was not removed",
                    )
                    .with_data(json!({"sourceNotRemoved":true})));
                }
            } else {
                walk_files(&directory).await?;
            }
            let runtime = root
                .parent()
                .ok_or_else(|| Error::internal("skill_runtime_missing"))?;
            let retired = runtime.join(format!(".skill-remove-{}", Uuid::new_v4()));
            fs::rename(&directory, &retired)
                .await
                .map_err(|e| storage("retire", e))?;
            remove_tree(runtime, &retired).await.map_err(|error| {
                error.with_data(json!({
                    "nativeDirectoryRemoved": true, "cleanup": "failed",
                    "currentSessions": "notVerified"
                }))
            })?;
            Ok(json!({
                "skill": description(&request.agent_id, &request.name),
                "removed": true, "application": application()
            }))
        }
        _ => Err(Error::method(method)),
    }
}

fn bundle_sha256(bundle: &Bundle) -> String {
    let mut files = BTreeMap::from([("SKILL.md", bundle.skill_md.as_bytes())]);
    for resource in &bundle.resources {
        files.insert(resource.path.as_str(), resource.bytes.as_slice());
    }
    let mut hash = Sha256::new();
    hash.update(b"matcha-team-skill-directory-v1");
    for (path, bytes) in files {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}

fn description(agent_id: &str, name: &str) -> Value {
    json!({
        "scope": "agent", "agentId": agent_id, "name": name,
        "source": "userSettings", "loadedFrom": "skills",
        "path": format!("skills/{name}/SKILL.md")
    })
}

fn application() -> Value {
    // loadSkillsDir.ts:638; print.ts:1859 has asynchronous reload, not an application ACK.
    json!({
        "target": "newSessions", "currentSessions": "notVerified",
        "nativePolicy": "enforcedByCli",
        "conditions": ["userSettingsAllowed", "notBareMode", "notPluginOnlyPolicy"],
        "runtimeVerification": "notPerformed"
    })
}

fn validate_scope(scope: &str) -> rpc::Result<()> {
    match scope {
        "agent" => Ok(()),
        "plugin" => Err(Error::unavailable(
            "plugin_skills_owned_by_plugins",
            "Plugin skills are managed through plugins methods, not copied into user skills",
        )),
        "library" => Err(Error::unavailable(
            "shared_skill_library_not_supported",
            "Shared library storage and Agent bindings are not supported; install explicit content or a local source into an Agent",
        )),
        _ => Err(Error::invalid("Skill scope must be agent")),
    }
}

fn validate_name(name: &str) -> rpc::Result<()> {
    validate_component(name)
}

fn validate_component(component: &str) -> rpc::Result<()> {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if component.is_empty()
        || matches!(component, "." | "..")
        || component.ends_with(['.', ' '])
        || component.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
        || reserved
    {
        return Err(Error::invalid(
            "Skill paths must contain portable relative file names without traversal or device names",
        ));
    }
    Ok(())
}

fn resource_path(path: &str) -> rpc::Result<PathBuf> {
    for component in path.split('/') {
        validate_component(component)?;
    }
    Ok(path.split('/').collect())
}

fn validate_bundle(bundle: &Bundle) -> rpc::Result<()> {
    // Keep SKILL.md byte-for-byte: native frontmatter is optional, name is only a display name,
    // and hooks/allowed-tools/shell remain subject to the caller's explicit content trust.
    let mut files = BTreeSet::from(["skill.md".to_owned()]);
    let mut spellings = BTreeMap::new();
    for resource in &bundle.resources {
        resource_path(&resource.path)?;
        for (end, _) in resource
            .path
            .match_indices('/')
            .chain(std::iter::once((resource.path.len(), "/")))
        {
            let spelling = &resource.path[..end];
            if spellings
                .insert(spelling.to_lowercase(), spelling)
                .is_some_and(|previous| previous != spelling)
            {
                return Err(Error::invalid(
                    "Skill paths must use consistent casing on case-insensitive filesystems",
                ));
            }
        }
        if !files.insert(resource.path.to_lowercase()) {
            return Err(Error::invalid(
                "Skill resource paths must be unique, including on case-insensitive filesystems",
            ));
        }
    }
    for path in &files {
        for (index, _) in path.match_indices('/') {
            if files.contains(&path[..index]) {
                return Err(Error::invalid(
                    "A skill resource cannot be both a file and a directory",
                ));
            }
        }
    }
    Ok(())
}

async fn skills_root(
    config: &ConfigStore,
    scope: &str,
    agent_id: &str,
    create: bool,
) -> rpc::Result<Option<PathBuf>> {
    validate_scope(scope)?;
    validate_id(agent_id)?;
    let snapshot = config.snapshot().await;
    if !snapshot.agents.contains_key(agent_id) {
        return Err(Error::not_found("Agent"));
    }
    let simple_source = snapshot
        .cli
        .env
        .get("CLAUDE_CODE_SIMPLE")
        .map(String::as_str)
        .unwrap_or("CLAUDE_CODE_SIMPLE");
    let simple = std::env::var(simple_source).ok().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().trim(),
            "1" | "true" | "yes" | "on"
        )
    });
    if create && (simple || snapshot.cli.args.iter().any(|arg| arg == "--bare")) {
        return Err(Error::unavailable(
            "skill_discovery_disabled",
            "Native bare/simple mode does not discover user skills",
        ));
    }
    if create {
        for (index, arg) in snapshot.cli.args.iter().enumerate() {
            let sources = arg.strip_prefix("--setting-sources=").or_else(|| {
                (arg == "--setting-sources")
                    .then(|| snapshot.cli.args.get(index + 1).map(String::as_str))
                    .flatten()
            });
            if sources
                .is_some_and(|sources| !sources.split(',').any(|source| source.trim() == "user"))
            {
                return Err(Error::unavailable(
                    "skill_user_settings_disabled",
                    "Native setting sources exclude user skills",
                ));
            }
        }
    }
    let runtime = config.paths().runtime(agent_id)?;
    let relative = runtime
        .strip_prefix(config.paths().root())
        .map_err(|_| Error::internal("skill_runtime_boundary"))?
        .join("skills");
    let root = fs::canonicalize(config.paths().root())
        .await
        .map_err(|e| storage("root_resolve", e))?;
    directory_under(&root, &relative, create).await
}

async fn directory_under(
    root: &Path,
    relative: &Path,
    create: bool,
) -> rpc::Result<Option<PathBuf>> {
    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(Error::invalid(
                "Skill directory must remain inside its root",
            ));
        };
        directory.push(component);
        if create {
            match fs::create_dir(&directory).await {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(storage("directory_create", error)),
            }
        }
        let Some(metadata) = metadata_optional(&directory).await? else {
            return Ok(None);
        };
        if is_link(&metadata) {
            return Err(unsafe_link());
        }
        if !metadata.is_dir() {
            return Err(Error::conflict(
                "skill_directory_expected",
                "A skill directory path is occupied by a non-directory",
            ));
        }
        directory = checked_existing(root, &directory).await?;
    }
    Ok(Some(directory))
}

async fn metadata_optional(path: &Path) -> rpc::Result<Option<std::fs::Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(storage("inspect", error)),
    }
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn unsafe_link() -> Error {
    Error::new(
        -32007,
        "skill_link_rejected",
        "Skill operations do not follow symbolic links or reparse points",
    )
}

async fn checked_existing(root: &Path, path: &Path) -> rpc::Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .await
        .map_err(|e| storage("inspect", e))?;
    if is_link(&metadata) {
        return Err(unsafe_link());
    }
    let canonical = fs::canonicalize(path)
        .await
        .map_err(|e| storage("resolve", e))?;
    if !canonical.starts_with(root) {
        return Err(Error::new(
            -32007,
            "skill_path_escape",
            "Skill path resolves outside its authorized root",
        ));
    }
    Ok(canonical)
}

async fn checked_file(root: &Path, path: &Path) -> rpc::Result<()> {
    checked_existing(root, path).await?;
    if !fs::symlink_metadata(path)
        .await
        .map_err(|e| storage("inspect", e))?
        .is_file()
    {
        return Err(Error::invalid(
            "Skill content must consist of regular files",
        ));
    }
    Ok(())
}

async fn skill_directory(root: &Path, name: &str) -> rpc::Result<PathBuf> {
    let path = root.join(name);
    if metadata_optional(&path).await?.is_none() {
        return Err(Error::not_found("Skill"));
    }
    let path = checked_existing(root, &path).await?;
    if metadata_optional(&path.join("SKILL.md")).await?.is_none() {
        return Err(Error::not_found("Skill manifest"));
    }
    checked_file(&path, &path.join("SKILL.md")).await?;
    Ok(path)
}

async fn walk_files(root: &Path) -> rpc::Result<BTreeMap<String, PathBuf>> {
    checked_existing(root, root).await?;
    let mut directories = vec![root.to_path_buf()];
    let mut files = BTreeMap::new();
    while let Some(directory) = directories.pop() {
        let mut entries = fs::read_dir(&directory)
            .await
            .map_err(|e| storage("read_directory", e))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| storage("read_directory", e))?
        {
            let path = entry.path();
            checked_existing(root, &path).await?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::internal("skill_resource_boundary"))?;
            let name = relative
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or_else(|| Error::invalid("Skill resources must have UTF-8 paths"))
                })
                .collect::<rpc::Result<Vec<_>>>()?
                .join("/");
            resource_path(&name)?;
            let metadata = fs::symlink_metadata(&path)
                .await
                .map_err(|e| storage("inspect", e))?;
            if metadata.is_dir() {
                directories.push(path);
            } else if metadata.is_file() {
                files.insert(name, path);
            } else {
                return Err(Error::invalid(
                    "Skill content must consist of regular files and directories",
                ));
            }
        }
    }
    Ok(files)
}

async fn read_bundle(root: &Path) -> rpc::Result<Bundle> {
    let manifest = root.join("SKILL.md");
    if metadata_optional(&manifest).await?.is_none() {
        return Err(Error::not_found("Skill manifest"));
    }
    checked_file(root, &manifest).await?;
    let mut files = walk_files(root).await?;
    files.remove("SKILL.md");
    let bytes = fs::read(manifest)
        .await
        .map_err(|e| storage("read_manifest", e))?;
    let skill_md =
        String::from_utf8(bytes).map_err(|_| Error::invalid("SKILL.md must contain UTF-8 text"))?;
    let mut resources = Vec::new();
    for (path, file) in files {
        checked_file(root, &file).await?;
        let bytes = fs::read(file)
            .await
            .map_err(|e| storage("read_resource", e))?;
        resources.push(Resource { path, bytes });
    }
    let bundle = Bundle {
        skill_md,
        resources,
    };
    validate_bundle(&bundle)?;
    Ok(bundle)
}

async fn write_bundle(staging: &Path, bundle: &Bundle) -> rpc::Result<()> {
    let root = fs::canonicalize(staging)
        .await
        .map_err(|e| storage("stage_resolve", e))?;
    for resource in &bundle.resources {
        let path = resource_path(&resource.path)?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid("Skill resource requires a file name"))?;
        directory_under(&root, parent, true).await?;
        atomic_write(&root.join(&path), &resource.bytes).await?;
    }
    atomic_write(&root.join("SKILL.md"), bundle.skill_md.as_bytes()).await
}

async fn remove_tree(root: &Path, directory: &Path) -> rpc::Result<()> {
    checked_existing(root, directory).await?;
    walk_files(directory).await?;
    fs::remove_dir_all(directory)
        .await
        .map_err(|e| storage("cleanup", e))
}

fn storage(operation: &'static str, error: io::Error) -> Error {
    Error::new(-32005, "skill_storage", "Skill filesystem operation failed")
        .with_data(json!({ "operation": operation, "ioKind": format!("{:?}", error.kind()) }))
}
