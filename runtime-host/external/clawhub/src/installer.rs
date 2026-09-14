use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const MANAGED_MARKER: &str = ".matchaclaw-managed";
const CLAWHUB_METADATA_DIRS: [&str; 2] = [".clawhub", ".clawdhub"];

#[derive(Clone, Eq, PartialEq)]
pub struct ClawHubInstallRequest {
    slug: String,
    version: Option<String>,
    force: bool,
}

impl ClawHubInstallRequest {
    pub fn try_new(slug: String, version: Option<String>, force: bool) -> Result<Self, ()> {
        let slug = slug.trim().to_owned();
        if !is_slug(&slug) {
            return Err(());
        }
        let version = version.map(|version| version.trim().to_owned());
        if version.as_deref().is_some_and(str::is_empty) {
            return Err(());
        }
        Ok(Self {
            slug,
            version,
            force,
        })
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }

    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    fn args(&self) -> Vec<String> {
        let mut args = vec!["install".to_owned(), self.slug.clone()];
        if let Some(version) = &self.version {
            args.push("--version".to_owned());
            args.push(version.clone());
        }
        if self.force {
            args.push("--force".to_owned());
        }
        args
    }
}

impl std::fmt::Debug for ClawHubInstallRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ClawHubInstallRequest([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ClawHubUninstallRequest {
    slug: String,
}

impl ClawHubUninstallRequest {
    pub fn try_new(slug: String) -> Result<Self, ()> {
        let slug = slug.trim().to_owned();
        if !is_slug(&slug) {
            return Err(());
        }
        Ok(Self { slug })
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }
}

impl std::fmt::Debug for ClawHubUninstallRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ClawHubUninstallRequest([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClawHubUninstallOutcome {
    Removed,
    NotFound,
    Rejected,
    Unknown,
}

#[derive(Clone)]
pub struct ClawHubCliInstaller {
    electron_image: PathBuf,
    work_dir: PathBuf,
    cli_entries: Vec<PathBuf>,
    registries: Vec<String>,
}

impl ClawHubCliInstaller {
    pub fn new(
        electron_image: PathBuf,
        work_dir: PathBuf,
        cli_entries: Vec<PathBuf>,
        registries: Vec<String>,
    ) -> Self {
        Self {
            electron_image,
            work_dir,
            cli_entries,
            registries,
        }
    }

    pub async fn install(&self, request: ClawHubInstallRequest) -> Result<(), ()> {
        let installer = self.clone();
        tokio::task::spawn_blocking(move || installer.install_blocking(request))
            .await
            .map_err(|_| ())?
    }

    pub async fn uninstall(&self, request: ClawHubUninstallRequest) -> ClawHubUninstallOutcome {
        let installer = self.clone();
        tokio::task::spawn_blocking(move || installer.uninstall_blocking(request))
            .await
            .unwrap_or(ClawHubUninstallOutcome::Unknown)
    }

    fn install_blocking(self, request: ClawHubInstallRequest) -> Result<(), ()> {
        let Some(entry) = self.cli_entries.iter().find(|entry| entry.is_file()) else {
            return Err(());
        };
        let args = request.args();
        for registry in &self.registries {
            if self.run(entry, &args, registry).is_ok() {
                return Ok(());
            }
        }
        Err(())
    }

    fn uninstall_blocking(self, request: ClawHubUninstallRequest) -> ClawHubUninstallOutcome {
        let slug = request.slug();
        let target = self.work_dir.join("skills").join(slug);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if is_managed_bundle(&target) || !is_clawhub_skill(&self.work_dir, &target, slug) {
                    return ClawHubUninstallOutcome::Rejected;
                }
                match fs::remove_dir_all(&target) {
                    Ok(()) => {
                        remove_lock_entry(&self.work_dir, slug);
                        ClawHubUninstallOutcome::Removed
                    }
                    Err(_) => ClawHubUninstallOutcome::Unknown,
                }
            }
            Ok(_) => ClawHubUninstallOutcome::Rejected,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ClawHubUninstallOutcome::NotFound
            }
            Err(_) => ClawHubUninstallOutcome::Unknown,
        }
    }

    fn run(&self, entry: &PathBuf, args: &[String], registry: &str) -> Result<(), ()> {
        let mut command = Command::new(&self.electron_image);
        command.arg(entry);
        command.args(args);
        command.current_dir(&self.work_dir);
        command.envs(std::env::vars_os());
        command.env("ELECTRON_RUN_AS_NODE", "1");
        command.env("CI", "true");
        command.env("FORCE_COLOR", "0");
        command.env("CLAWHUB_WORKDIR", &self.work_dir);
        command.env("CLAWHUB_REGISTRY", registry);
        let output = command.output().map_err(|_| ())?;
        output.status.success().then_some(()).ok_or(())
    }
}

fn is_clawhub_skill(work_dir: &Path, target: &Path, slug: &str) -> bool {
    skill_origin_matches(target, slug) || lock_contains_skill(work_dir, slug)
}

fn skill_origin_matches(target: &Path, slug: &str) -> bool {
    CLAWHUB_METADATA_DIRS.iter().any(|metadata_dir| {
        let origin = target.join(metadata_dir).join("origin.json");
        let Ok(metadata) = fs::symlink_metadata(&origin) else {
            return false;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return false;
        }
        fs::read_to_string(origin)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get("slug")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|origin_slug| origin_slug == slug)
    })
}

fn lock_contains_skill(work_dir: &Path, slug: &str) -> bool {
    lock_paths(work_dir).iter().any(|lock_path| {
        read_lock(lock_path)
            .and_then(|value| {
                value
                    .get("skills")
                    .and_then(serde_json::Value::as_object)
                    .map(|skills| skills.contains_key(slug))
            })
            .unwrap_or(false)
    })
}

fn remove_lock_entry(work_dir: &Path, slug: &str) {
    for lock_path in lock_paths(work_dir) {
        let Some(mut value) = read_lock(&lock_path) else {
            continue;
        };
        let Some(skills) = value
            .get_mut("skills")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        if skills.remove(slug).is_none() {
            continue;
        }
        if let Ok(mut body) = serde_json::to_string_pretty(&value) {
            body.push('\n');
            let _ = fs::write(lock_path, body);
        }
    }
}

fn read_lock(path: &Path) -> Option<serde_json::Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn lock_paths(work_dir: &Path) -> [PathBuf; 2] {
    [
        work_dir.join(".clawhub").join("lock.json"),
        work_dir.join(".clawdhub").join("lock.json"),
    ]
}

fn is_managed_bundle(path: &Path) -> bool {
    let marker = path.join(MANAGED_MARKER);
    fs::symlink_metadata(marker)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn is_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let Some((&first, rest)) = bytes.split_first() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let Some(&last) = rest.last() else {
        return true;
    };
    last.is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn uninstall_removes_clawhub_skill_and_lock_entry() {
        let root = temp_root("remove");
        let skill = root.join("skills").join("weather");
        fs::create_dir_all(skill.join(".clawhub")).unwrap();
        fs::create_dir_all(root.join(".clawhub")).unwrap();
        fs::write(skill.join("SKILL.md"), "# Weather\n").unwrap();
        fs::write(
            skill.join(".clawhub").join("origin.json"),
            r#"{"version":1,"registry":"https://example.test","slug":"weather","installedVersion":"1.0.0","installedAt":1}"#,
        )
        .unwrap();
        fs::write(
            root.join(".clawhub").join("lock.json"),
            r#"{"version":1,"skills":{"weather":{"version":"1.0.0"},"other":{"version":"2.0.0"}}}"#,
        )
        .unwrap();

        let outcome = installer(&root)
            .uninstall_blocking(ClawHubUninstallRequest::try_new(" weather ".to_owned()).unwrap());

        assert_eq!(outcome, ClawHubUninstallOutcome::Removed);
        assert!(!skill.exists());
        let lock = read_lock(&root.join(".clawhub").join("lock.json")).unwrap();
        let skills = lock
            .get("skills")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert!(!skills.contains_key("weather"));
        assert!(skills.contains_key("other"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uninstall_rejects_non_clawhub_and_managed_directories() {
        let root = temp_root("reject");
        let plain = root.join("skills").join("plain");
        let managed = root.join("skills").join("managed");
        fs::create_dir_all(&plain).unwrap();
        fs::create_dir_all(&managed).unwrap();
        fs::write(managed.join(MANAGED_MARKER), "managed\n").unwrap();

        assert_eq!(
            installer(&root)
                .uninstall_blocking(ClawHubUninstallRequest::try_new("plain".to_owned()).unwrap(),),
            ClawHubUninstallOutcome::Rejected
        );
        assert_eq!(
            installer(&root).uninstall_blocking(
                ClawHubUninstallRequest::try_new("managed".to_owned()).unwrap(),
            ),
            ClawHubUninstallOutcome::Rejected
        );
        assert!(plain.exists());
        assert!(managed.exists());
        let _ = fs::remove_dir_all(root);
    }

    fn installer(root: &Path) -> ClawHubCliInstaller {
        ClawHubCliInstaller::new(PathBuf::new(), root.to_owned(), Vec::new(), Vec::new())
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "matcha-clawhub-{label}-{}-{nanos}",
            std::process::id()
        ))
    }
}
