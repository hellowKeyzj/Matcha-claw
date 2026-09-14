use super::CanonicalStateDir;
use serde_json::{Map, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

mod removal;

pub(super) struct Cleanup {
    directories: Vec<PathBuf>,
    legacy_files: Vec<PathBuf>,
}

pub(super) fn plan(
    state_dir: &CanonicalStateDir,
    document: &Value,
    account: Option<&str>,
    working_directory: Option<&Path>,
) -> Result<Cleanup, ()> {
    state_dir.open().map_err(|_| ())?;
    let oauth = match environment_path("OPENCLAW_OAUTH_DIR") {
        Some(path) => resolve_user_path(&path, working_directory)?,
        None => state_dir.as_path().join("credentials"),
    };
    let oauth = normalize_path(&oauth)?;
    if oauth != normalize_path(&state_dir.as_path().join("credentials"))? {
        // An inherited OAuth override does not grant this operation ownership of another root.
        return Err(());
    }
    let base = normalize_path(&oauth.join("whatsapp"))?;
    let section = document
        .pointer("/channels/whatsapp")
        .and_then(Value::as_object);
    let accounts = section
        .and_then(|section| section.get("accounts"))
        .and_then(Value::as_object);
    let mut ids: BTreeSet<String> = accounts.into_iter().flat_map(Map::keys).cloned().collect();
    if ids.is_empty()
        || section
            .and_then(|section| section.get("authDir"))
            .is_some_and(|value| match value {
                Value::String(value) => !value.trim().is_empty(),
                Value::Null => false,
                _ => true,
            })
    {
        ids.insert("default".into());
    }
    let removes_channel = account.is_none()
        || account.is_some_and(|account| {
            super::super::account_config_delete_plan(document, "whatsapp", account)
                .and_then(|plan| plan.readback)
                .is_some_and(|target| {
                    matches!(target.channel, super::super::ExpectedConfigValue::Absent)
                })
        });
    let mut targets = BTreeSet::new();
    let mut retained = Vec::new();
    for id in &ids {
        let path = resolve_auth_dir(section, id, &oauth, working_directory)?;
        if account.is_none_or(|account| account == id) {
            targets.insert(path);
        } else if !removes_channel {
            retained.push(path);
        }
    }
    if let Some(account) = account {
        targets.insert(resolve_auth_dir(
            section,
            account,
            &oauth,
            working_directory,
        )?);
    } else {
        // Channel deletion includes orphaned native account directories, as ClawX does.
        if directory_exists(&base)? {
            for entry in fs::read_dir(&base).map_err(|_| ())? {
                let entry = entry.map_err(|_| ())?;
                if entry.file_type().map_err(|_| ())?.is_dir() {
                    targets.insert(normalize_path(&entry.path())?);
                } else if entry.file_type().map_err(|_| ())?.is_symlink() {
                    return Err(());
                }
            }
        }
        if regular_file(&oauth.join("creds.json"))? {
            targets.insert(oauth.clone());
        }
    }
    let mut cleanup = Cleanup {
        directories: Vec::new(),
        legacy_files: Vec::new(),
    };
    for target in targets {
        if retained.iter().any(|path| {
            path == &target
                || (target != oauth
                    && path != &oauth
                    && (path.starts_with(&target) || target.starts_with(path)))
        }) {
            return Err(());
        }
        if target == oauth {
            // The OAuth root is shared with other providers; never recursively remove it.
            if directory_exists(&target)? {
                for entry in fs::read_dir(&target).map_err(|_| ())? {
                    let entry = entry.map_err(|_| ())?;
                    if is_baileys_file(&entry.file_name().to_string_lossy()) {
                        if !regular_file(&entry.path())? {
                            return Err(());
                        }
                        cleanup.legacy_files.push(entry.path());
                    }
                }
            }
        } else {
            if target == base || !target.starts_with(&base) {
                return Err(());
            }
            if directory_exists(&target)? {
                removal::preflight(&target)?;
                cleanup.directories.push(target);
            }
        }
    }
    // A configured custom directory can contain another deleted account's directory.
    cleanup.directories.sort();
    let mut directories: Vec<PathBuf> = Vec::new();
    for directory in cleanup.directories {
        if !directories
            .iter()
            .any(|parent| directory.starts_with(parent))
        {
            directories.push(directory);
        }
    }
    cleanup.directories = directories;
    Ok(cleanup)
}

impl Cleanup {
    pub(super) fn execute(self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        state_dir.open().map_err(|_| ())?;
        for directory in &self.directories {
            removal::preflight(directory)?;
        }
        for file in &self.legacy_files {
            regular_file(file)?;
        }
        for directory in self.directories {
            removal::remove(&directory, true)?;
        }
        for file in self.legacy_files {
            removal::remove(&file, false)?;
        }
        Ok(())
    }
}

fn resolve_auth_dir(
    section: Option<&Map<String, Value>>,
    id: &str,
    oauth: &Path,
    working_directory: Option<&Path>,
) -> Result<PathBuf, ()> {
    let id = if id.trim().is_empty() {
        "default"
    } else {
        id.trim()
    };
    let accounts = section
        .and_then(|section| section.get("accounts"))
        .and_then(Value::as_object);
    let account = accounts.and_then(|accounts| {
        accounts.get(id).or_else(|| {
            accounts
                .iter()
                .find(|(key, _)| key.trim().eq_ignore_ascii_case(id))
                .map(|(_, value)| value)
        })
    });
    let auth = account
        .and_then(|account| account.get("authDir"))
        .or_else(|| section.and_then(|section| section.get("authDir")));
    match auth {
        Some(Value::String(path)) if !path.trim().is_empty() => {
            let path = resolve_user_path(path, working_directory)?;
            if path == oauth {
                return Err(());
            }
            return Ok(path);
        }
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        Some(_) => return Err(()),
    }
    let default = oauth.join("whatsapp").join(normalize_account_id(id));
    if id == "default"
        && regular_file(&oauth.join("creds.json"))?
        && !regular_file(&default.join("creds.json"))?
    {
        return Ok(oauth.to_path_buf());
    }
    normalize_path(&default)
}

fn normalize_account_id(id: &str) -> String {
    let id = id.trim();
    if id.len() <= 64
        && id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        && !matches!(
            id.to_ascii_lowercase().as_str(),
            "prototype" | "constructor"
        )
    {
        return id.to_ascii_lowercase();
    }
    let mut normalized = String::new();
    let mut replacing_invalid_run = false;
    for character in id.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            normalized.push(character);
            replacing_invalid_run = false;
        } else if !replacing_invalid_run {
            normalized.push('-');
            replacing_invalid_run = true;
        }
    }
    let normalized: String = normalized.trim_matches('-').chars().take(64).collect();
    if normalized.is_empty()
        || matches!(
            normalized.as_str(),
            "__proto__" | "prototype" | "constructor"
        )
    {
        "default".into()
    } else {
        normalized
    }
}

fn environment_path(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn resolve_user_path(value: &str, working_directory: Option<&Path>) -> Result<PathBuf, ()> {
    let value = value.trim();
    let path = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        let os_home = ["HOME", "USERPROFILE"]
            .into_iter()
            .filter_map(environment_path)
            .find(|value| !matches!(value.as_str(), "undefined" | "null"))
            .map(PathBuf::from)
            .or_else(std::env::home_dir);
        let home = environment_path("OPENCLAW_HOME")
            .filter(|value| !matches!(value.as_str(), "undefined" | "null"));
        let home = match home {
            Some(home) if home == "~" || home.starts_with("~/") || home.starts_with("~\\") => {
                os_home
                    .ok_or(())?
                    .join(&home[1..].trim_start_matches(['/', '\\']))
            }
            Some(home) => PathBuf::from(home),
            None => os_home
                .or_else(|| working_directory.map(Path::to_path_buf))
                .ok_or(())?,
        };
        home.join(value[1..].trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(value)
    };
    if path.is_absolute() {
        normalize_path(&path)
    } else {
        // Gateway runs from the native package directory, not the Host process cwd.
        normalize_path(&working_directory.ok_or(())?.join(path))
    }
}

fn normalize_path(path: &Path) -> Result<PathBuf, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    directory_exists(path)?;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(());
                }
            }
            Component::CurDir => {}
            Component::Normal(name) => {
                #[cfg(windows)]
                if name.to_string_lossy().contains(':')
                    || name.to_string_lossy().ends_with(['.', ' '])
                {
                    return Err(());
                }
                normalized.push(name);
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    let mut existing = normalized.as_path();
    while !directory_exists(existing)? {
        existing = existing.parent().ok_or(())?;
    }
    let suffix = normalized.strip_prefix(existing).map_err(|_| ())?;
    let canonical = fs::canonicalize(existing).map_err(|_| ())?;
    #[cfg(windows)]
    let canonical = {
        let text = canonical.to_str().ok_or(())?;
        let text = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
        };
        PathBuf::from(text)
    };
    let normalized = canonical.join(suffix);
    #[cfg(windows)]
    let normalized = PathBuf::from(normalized.to_str().ok_or(())?.to_lowercase());
    Ok(normalized)
}

fn directory_exists(path: &Path) -> Result<bool, ()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !current.is_absolute() {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
            Ok(_) => return Err(()),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(()),
        }
    }
    Ok(true)
}

fn regular_file(path: &Path) -> Result<bool, ()> {
    if !directory_exists(path.parent().ok_or(())?)? {
        return Ok(false);
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => Ok(true),
        Ok(_) => Err(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
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

fn is_baileys_file(name: &str) -> bool {
    matches!(name, "creds.json" | "creds.json.bak")
        || (name.ends_with(".json")
            && [
                "app-state-sync-key-",
                "app-state-sync-version-",
                "device-list-",
                "identity-key-",
                "lid-mapping-",
                "pre-key-",
                "sender-key-",
                "sender-key-memory-",
                "session-",
                "tctoken-",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix)))
}
