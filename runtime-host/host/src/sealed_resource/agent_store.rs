use std::{
    collections::BTreeSet,
    fmt, fs,
    fs::OpenOptions,
    io,
    io::Write as _,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use getrandom::fill as random_fill;
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use zeroize::Zeroize;

use super::{
    AgentKey, PackageRelativePath, RuntimeAgentTarget, SealAgentPackageReceipt,
    SealedAgentFileRequest, SealedAgentPackage, SealedResourceError, SealedResourceMeteringBinding,
    SealedResourceMeteringKind, SealedResourceMeteringUse, SealedResourceRead,
};

const SEALED_AGENT_PACKAGE_EXTENSION: &str = "matcha-agentpkg";
const KEY_BYTES: usize = 32;
const KEY_FILE: &str = "sealed-agent.key";
const MAX_FILE_BYTES: u64 = 48 * 1024;
const AGENT_BOOTSTRAP_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"];
const REQUIRED_AGENT_BOOTSTRAP_FILE: &str = "AGENTS.md";

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeLocalAgentRoot {
    runtime_target: RuntimeAgentTarget,
    state_dir: CanonicalStateDir,
}

impl RuntimeLocalAgentRoot {
    pub fn openclaw(state_dir: CanonicalStateDir) -> Self {
        Self {
            runtime_target: RuntimeAgentTarget::OpenClaw,
            state_dir,
        }
    }

    pub fn runtime_target(&self) -> RuntimeAgentTarget {
        self.runtime_target
    }

    fn workspace_directory(&self, agent_key: &AgentKey) -> Result<PathBuf, SealedResourceError> {
        let session_key = openclaw_agent_session_key(agent_key)?;
        let directory = openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone())
            .trusted_workspace_directory(&session_key)
            .map_err(|_| SealedResourceError::Unknown)?;
        let path = PathBuf::from(directory.as_str());
        path.is_absolute()
            .then_some(path)
            .ok_or(SealedResourceError::Rejected)
    }

    fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError> {
        openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone())
            .maintenance_workspace_directories()
            .map(|directories| {
                directories
                    .into_iter()
                    .map(|directory| PathBuf::from(directory.as_str()))
                    .collect()
            })
            .map_err(|_| SealedResourceError::Unknown)
    }

    fn ensure_agent_config(
        &self,
        agent_key: &AgentKey,
        workspace: &Path,
    ) -> Result<(), SealedResourceError> {
        match self.runtime_target {
            RuntimeAgentTarget::OpenClaw => {
                openclaw::projection::sealed_agent_config::ensure_sealed_agent_config(
                    self.state_dir.clone(),
                    agent_key.as_str(),
                    workspace,
                )
                .map_err(sealed_agent_config_error)
            }
        }
    }
}

fn sealed_agent_config_error(
    error: openclaw::projection::sealed_agent_config::SealedAgentConfigError,
) -> SealedResourceError {
    match error {
        openclaw::projection::sealed_agent_config::SealedAgentConfigError::Rejected => {
            SealedResourceError::Rejected
        }
        openclaw::projection::sealed_agent_config::SealedAgentConfigError::Unavailable => {
            SealedResourceError::Unknown
        }
    }
}

impl fmt::Debug for RuntimeLocalAgentRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeLocalAgentRoot")
            .field("runtime_target", &self.runtime_target)
            .field("state_dir", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedAgentCatalog {
    entries: Vec<SealedAgentCatalogEntry>,
}

impl SealedAgentCatalog {
    pub fn entries(&self) -> &[SealedAgentCatalogEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedAgentCatalogEntry {
    agent_key: AgentKey,
    runtime_target: RuntimeAgentTarget,
}

impl SealedAgentCatalogEntry {
    pub fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub fn runtime_target(&self) -> RuntimeAgentTarget {
        self.runtime_target
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedAgentPackageExport {
    agent_key: AgentKey,
    file_name: String,
    package_path: PathBuf,
    size: u64,
    exported_at_ms: u64,
}

impl SealedAgentPackageExport {
    pub fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn package_path(&self) -> &Path {
        &self.package_path
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn exported_at_ms(&self) -> u64 {
        self.exported_at_ms
    }
}

pub struct SealedAgentStore {
    root: RuntimeLocalAgentRoot,
    private_directory: PathBuf,
    key_path: PathBuf,
    operation_lock: Mutex<()>,
}

impl SealedAgentStore {
    pub fn new(
        root: RuntimeLocalAgentRoot,
        private_directory: PathBuf,
    ) -> Result<Self, SealedResourceError> {
        if !private_directory.is_absolute() {
            return Err(SealedResourceError::Rejected);
        }
        fs::create_dir_all(&private_directory).map_err(|_| SealedResourceError::Unknown)?;
        set_private_mode(&private_directory, true)?;
        Ok(Self {
            key_path: private_directory.join(KEY_FILE),
            private_directory,
            root,
            operation_lock: Mutex::new(()),
        })
    }

    pub fn openclaw(
        state_dir: CanonicalStateDir,
        private_root: PathBuf,
    ) -> Result<Self, SealedResourceError> {
        Self::new(RuntimeLocalAgentRoot::openclaw(state_dir), private_root)
    }

    pub fn catalog(&self) -> Result<SealedAgentCatalog, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let mut entries = Vec::new();
        for directory in self.root.maintenance_workspace_directories()? {
            let Some(directory) = existing_workspace_directory(&directory)? else {
                continue;
            };
            self.catalog_directory_locked(&directory, &mut entries)?;
        }
        entries.sort_by(|left, right| left.agent_key.cmp(&right.agent_key));
        let mut keys = BTreeSet::new();
        if entries
            .iter()
            .any(|entry| !keys.insert(entry.agent_key.as_str().to_owned()))
        {
            return Err(SealedResourceError::Rejected);
        }
        Ok(SealedAgentCatalog { entries })
    }

    pub fn contains_agent(&self, agent_key: &AgentKey) -> Result<bool, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.find_sealed_package_locked(agent_key)
            .map(|entry| entry.is_some())
    }

    pub fn read_file(
        &self,
        agent_key: AgentKey,
        path: PackageRelativePath,
    ) -> Result<SealedResourceRead, SealedResourceError> {
        if !AGENT_BOOTSTRAP_FILES.contains(&path.as_str()) {
            return Err(SealedResourceError::Rejected);
        }
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let package = self.open_sealed_agent_locked(&agent_key)?;
        let file = package.file(&path).ok_or(SealedResourceError::NotFound)?;
        Ok(SealedResourceRead::new(
            file.content().to_vec(),
            Some(SealedResourceMeteringBinding::openclaw(
                SealedResourceMeteringKind::Agent,
                agent_key.as_str(),
                package.package_sha256(),
                SealedResourceMeteringUse::Session,
            )?),
        ))
    }

    pub fn export_plain_workspace_package(
        &self,
        agent_key: AgentKey,
    ) -> Result<SealedAgentPackageExport, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let workspace = self.root.workspace_directory(&agent_key)?;
        let workspace =
            existing_workspace_directory(&workspace)?.ok_or(SealedResourceError::NotFound)?;
        let files = collect_agent_files(&workspace)?;
        let mut key = self.read_or_create_key()?;
        let receipt =
            SealedAgentPackage::seal(agent_key.clone(), self.root.runtime_target(), files, &key)?;
        let package = SealedAgentPackage::open(receipt.package_bytes(), &key);
        key.zeroize();
        let package = package?;
        let installed_path = self.install_receipt_locked(&workspace, &receipt)?;
        self.remove_other_packages_locked(package.agent_key(), &workspace, &installed_path)?;
        Ok(SealedAgentPackageExport {
            agent_key,
            file_name: receipt.package_file_name().to_owned(),
            package_path: installed_path,
            size: receipt.package_size(),
            exported_at_ms: now_millis(),
        })
    }

    pub fn install_package_path(
        &self,
        package_path: PathBuf,
    ) -> Result<SealedAgentCatalogEntry, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        if !package_path.is_absolute() || !is_sealed_package_path(&package_path) {
            return Err(SealedResourceError::Rejected);
        }
        let metadata =
            fs::symlink_metadata(&package_path).map_err(|_| SealedResourceError::NotFound)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SealedResourceError::Rejected);
        }
        let bytes = fs::read(&package_path).map_err(|_| SealedResourceError::Unknown)?;
        let mut key = self.read_key()?;
        let package = SealedAgentPackage::open(&bytes, &key);
        key.zeroize();
        let package = package?;
        if package.runtime_target() != self.root.runtime_target() {
            return Err(SealedResourceError::Rejected);
        }
        if self
            .find_sealed_package_locked(package.agent_key())?
            .is_some()
        {
            return Err(SealedResourceError::AlreadyExists);
        }
        let workspace = self.root.workspace_directory(package.agent_key())?;
        let workspace = ensure_workspace_directory(&workspace)?;
        self.root
            .ensure_agent_config(package.agent_key(), &workspace)?;
        let receipt = SealAgentPackageReceipt::from_package_bytes(bytes);
        self.install_receipt_locked(&workspace, &receipt)?;
        Ok(SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            runtime_target: package.runtime_target(),
        })
    }

    pub fn remove_package(&self, agent_key: AgentKey) -> Result<bool, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let Some((path, _)) = self.find_sealed_package_locked(&agent_key)? else {
            return Ok(false);
        };
        fs::remove_file(path).map_err(|_| SealedResourceError::Unknown)?;
        Ok(true)
    }

    fn catalog_directory_locked(
        &self,
        directory: &Path,
        entries: &mut Vec<SealedAgentCatalogEntry>,
    ) -> Result<(), SealedResourceError> {
        for entry in fs::read_dir(directory).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if metadata.is_file()
                && is_sealed_package_path(&path)
                && let Some(entry) = self.catalog_sealed_package_locked(&path)?
            {
                entries.push(entry);
            }
        }
        Ok(())
    }

    fn open_sealed_agent_locked(
        &self,
        agent_key: &AgentKey,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        self.find_sealed_package_locked(agent_key)?
            .map(|(_, package)| package)
            .ok_or(SealedResourceError::NotFound)
    }

    fn find_sealed_package_locked(
        &self,
        agent_key: &AgentKey,
    ) -> Result<Option<(PathBuf, SealedAgentPackage)>, SealedResourceError> {
        let workspace = self.root.workspace_directory(agent_key)?;
        let Some(workspace) = existing_workspace_directory(&workspace)? else {
            return Ok(None);
        };
        let mut found = None;
        for entry in fs::read_dir(workspace).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if !metadata.is_file() || !is_sealed_package_path(&path) {
                continue;
            }
            let package = self.open_package_path_locked(&path)?;
            if package.runtime_target() == self.root.runtime_target()
                && package.agent_key() == agent_key
            {
                if found.is_some() {
                    return Err(SealedResourceError::Rejected);
                }
                found = Some((path, package));
            }
        }
        Ok(found)
    }

    fn catalog_sealed_package_locked(
        &self,
        path: &Path,
    ) -> Result<Option<SealedAgentCatalogEntry>, SealedResourceError> {
        let package = self.open_package_path_locked(path)?;
        if package.runtime_target() != self.root.runtime_target() {
            return Ok(None);
        }
        Ok(Some(SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            runtime_target: package.runtime_target(),
        }))
    }

    fn open_package_path_locked(
        &self,
        path: &Path,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let bytes = fs::read(path).map_err(|_| SealedResourceError::Unknown)?;
        let mut key = self.read_key()?;
        let package = SealedAgentPackage::open(&bytes, &key);
        key.zeroize();
        package
    }

    fn install_receipt_locked(
        &self,
        workspace: &Path,
        package: &SealAgentPackageReceipt,
    ) -> Result<PathBuf, SealedResourceError> {
        let workspace = ensure_workspace_directory(workspace)?;
        let path = workspace.join(package.package_file_name());
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(SealedResourceError::AlreadyExists),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(SealedResourceError::Unknown),
        }
        let staging = workspace.join(format!(".{}.tmp", package.package_file_name()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)
                .map_err(|_| SealedResourceError::Unknown)?;
            set_private_mode(&staging, false)?;
            file.write_all(package.package_bytes())
                .map_err(|_| SealedResourceError::Unknown)?;
            file.sync_all().map_err(|_| SealedResourceError::Unknown)?;
            fs::rename(&staging, &path).map_err(|_| SealedResourceError::Unknown)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
        }
        result.map(|_| path)
    }

    fn remove_other_packages_locked(
        &self,
        agent_key: &AgentKey,
        workspace: &Path,
        keep_path: &Path,
    ) -> Result<(), SealedResourceError> {
        for entry in fs::read_dir(workspace).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            if path == keep_path {
                continue;
            }
            let metadata = entry.metadata().map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if !metadata.is_file() || !is_sealed_package_path(&path) {
                continue;
            }
            let package = self.open_package_path_locked(&path)?;
            if package.runtime_target() == self.root.runtime_target()
                && package.agent_key() == agent_key
            {
                fs::remove_file(path).map_err(|_| SealedResourceError::Unknown)?;
            }
        }
        Ok(())
    }

    fn read_key(&self) -> Result<[u8; KEY_BYTES], SealedResourceError> {
        fs::read(&self.key_path)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    SealedResourceError::NotFound
                } else {
                    SealedResourceError::Unknown
                }
            })
            .and_then(|bytes| decode_fixed::<KEY_BYTES>(&bytes))
    }

    fn read_or_create_key(&self) -> Result<[u8; KEY_BYTES], SealedResourceError> {
        match fs::read(&self.key_path) {
            Ok(bytes) => decode_fixed::<KEY_BYTES>(&bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut key = [0_u8; KEY_BYTES];
                random_fill(&mut key).map_err(|_| SealedResourceError::Unknown)?;
                match OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&self.key_path)
                {
                    Ok(mut file) => {
                        set_private_mode(&self.key_path, false)?;
                        file.write_all(&key)
                            .map_err(|_| SealedResourceError::Unknown)?;
                        file.sync_all().map_err(|_| SealedResourceError::Unknown)?;
                        Ok(key)
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        decode_fixed::<KEY_BYTES>(
                            &fs::read(&self.key_path).map_err(|_| SealedResourceError::Unknown)?,
                        )
                    }
                    Err(_) => {
                        key.zeroize();
                        Err(SealedResourceError::Unknown)
                    }
                }
            }
            Err(_) => Err(SealedResourceError::Unknown),
        }
    }
}

impl fmt::Debug for SealedAgentStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentStore")
            .field("root", &self.root)
            .field("private_directory", &"[REDACTED]")
            .finish()
    }
}

fn collect_agent_files(
    workspace: &Path,
) -> Result<Vec<SealedAgentFileRequest>, SealedResourceError> {
    let mut files = Vec::new();
    let mut found_required = false;
    for name in AGENT_BOOTSTRAP_FILES {
        let path = workspace.join(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(SealedResourceError::Unknown),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_FILE_BYTES
        {
            return Err(SealedResourceError::Rejected);
        }
        let content = fs::read(&path).map_err(|_| SealedResourceError::Unknown)?;
        if *name == REQUIRED_AGENT_BOOTSTRAP_FILE {
            found_required = true;
        }
        files.push(SealedAgentFileRequest::try_new(*name, content)?);
    }
    if !found_required {
        return Err(SealedResourceError::NotFound);
    }
    Ok(files)
}

fn existing_workspace_directory(path: &Path) -> Result<Option<PathBuf>, SealedResourceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::canonicalize(path)
                .map(Some)
                .map_err(|_| SealedResourceError::Unknown)
        }
        Ok(_) => Err(SealedResourceError::Rejected),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SealedResourceError::Unknown),
    }
}

fn ensure_workspace_directory(path: &Path) -> Result<PathBuf, SealedResourceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(SealedResourceError::Rejected),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| SealedResourceError::Unknown)?;
        }
        Err(_) => return Err(SealedResourceError::Unknown),
    }
    fs::canonicalize(path).map_err(|_| SealedResourceError::Unknown)
}

fn is_sealed_package_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension == SEALED_AGENT_PACKAGE_EXTENSION)
}

fn openclaw_agent_session_key(agent_key: &AgentKey) -> Result<String, SealedResourceError> {
    let value = agent_key.as_str();
    if value.len() > 256 || value.contains(':') {
        return Err(SealedResourceError::Rejected);
    }
    Ok(format!("agent:{value}:sealed-agent"))
}

fn decode_fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N], SealedResourceError> {
    bytes.try_into().map_err(|_| SealedResourceError::Rejected)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(unix)]
fn set_private_mode(path: &Path, directory: bool) -> Result<(), SealedResourceError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if directory { 0o700 } else { 0o600 };
    let mut permissions = fs::metadata(path)
        .map_err(|_| SealedResourceError::Unknown)?
        .permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).map_err(|_| SealedResourceError::Unknown)
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _directory: bool) -> Result<(), SealedResourceError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn read_file_returns_session_metering_binding() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = CanonicalStateDir::provision(root.path().join("state")).unwrap();
        let workspace = root.path().join("reviewer-workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("AGENTS.md"), "agent instructions").unwrap();
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": {"list": [{"id": "reviewer", "workspace": workspace}]}
            }))
            .unwrap(),
        )
        .unwrap();
        let store = SealedAgentStore::openclaw(state_dir, root.path().join("private")).unwrap();
        let agent_key = AgentKey::parse("reviewer").unwrap();
        store
            .export_plain_workspace_package(agent_key.clone())
            .unwrap();

        let read = store
            .read_file(agent_key, PackageRelativePath::parse("AGENTS.md").unwrap())
            .unwrap();
        let binding = decode_binding(read.metering_binding().unwrap().as_str());

        assert_eq!(read.content(), b"agent instructions");
        assert_eq!(binding["kind"], "agent");
        assert_eq!(binding["runtime"], "openclaw");
        assert_eq!(binding["key"], "reviewer");
        assert_eq!(binding["use"], "session");
        assert_eq!(binding["packageSha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn install_package_path_creates_openclaw_agent_config_without_plaintext_bootstrap_files() {
        let root = tempfile::tempdir().unwrap();
        let source_state = CanonicalStateDir::provision(root.path().join("source-state")).unwrap();
        let source_workspace = root.path().join("source-workspace");
        fs::create_dir(&source_workspace).unwrap();
        fs::write(
            source_workspace.join("AGENTS.md"),
            "source agent instructions",
        )
        .unwrap();
        fs::write(
            source_state.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": { "entries": { "writer": { "workspace": source_workspace } } }
            }))
            .unwrap(),
        )
        .unwrap();
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(source_state, private.clone()).unwrap();
        let agent_key = AgentKey::parse("writer").unwrap();
        let package = source
            .export_plain_workspace_package(agent_key.clone())
            .unwrap();

        let target_state = CanonicalStateDir::provision(root.path().join("target-state")).unwrap();
        let target = SealedAgentStore::openclaw(target_state.clone(), private).unwrap();
        let entry = target
            .install_package_path(package.package_path().to_owned())
            .unwrap();

        assert_eq!(entry.agent_key(), &agent_key);
        assert_eq!(entry.runtime_target(), RuntimeAgentTarget::OpenClaw);
        assert_eq!(
            target
                .read_file(
                    agent_key.clone(),
                    PackageRelativePath::parse("AGENTS.md").unwrap()
                )
                .unwrap()
                .content(),
            b"source agent instructions"
        );
        let config = read_config(target_state.as_path());
        let workspace = PathBuf::from(
            config["agents"]["entries"]["writer"]["workspace"]
                .as_str()
                .unwrap(),
        );
        assert!(workspace.is_absolute());
        assert_eq!(
            openclaw::workspace::OpenClawWorkspaceAccess::new(target_state)
                .trusted_workspace_directory("agent:writer:sealed-agent")
                .unwrap()
                .as_str(),
            workspace.to_str().unwrap()
        );
        assert_eq!(config["agents"]["entries"]["writer"]["skipBootstrap"], true);
        assert_plaintext_bootstrap_absent(&workspace);
        assert_eq!(sealed_packages(&workspace).len(), 1);
    }

    #[test]
    fn install_package_path_preserves_existing_openclaw_config_when_ensuring_agent() {
        let root = tempfile::tempdir().unwrap();
        let source_state = CanonicalStateDir::provision(root.path().join("source-state")).unwrap();
        let source_workspace = root.path().join("source-workspace");
        fs::create_dir(&source_workspace).unwrap();
        fs::write(
            source_workspace.join("AGENTS.md"),
            "source agent instructions",
        )
        .unwrap();
        fs::write(
            source_state.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": { "entries": { "writer": { "workspace": source_workspace } } }
            }))
            .unwrap(),
        )
        .unwrap();
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(source_state, private.clone()).unwrap();
        let package = source
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap())
            .unwrap();

        let target_state = CanonicalStateDir::provision(root.path().join("target-state")).unwrap();
        let main_workspace = root.path().join("main-workspace");
        fs::create_dir(&main_workspace).unwrap();
        fs::write(
            target_state.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": {
                    "defaults": { "skipBootstrap": true },
                    "entries": { "main": { "workspace": main_workspace, "default": true } }
                },
                "messages": { "locale": "zh" }
            }))
            .unwrap(),
        )
        .unwrap();
        let target = SealedAgentStore::openclaw(target_state.clone(), private).unwrap();

        target
            .install_package_path(package.package_path().to_owned())
            .unwrap();

        let config = read_config(target_state.as_path());
        assert_eq!(config["messages"]["locale"], "zh");
        assert_eq!(config["agents"]["defaults"]["skipBootstrap"], true);
        assert_eq!(
            config["agents"]["entries"]["main"]["workspace"],
            main_workspace.to_str().unwrap()
        );
        assert_eq!(config["agents"]["entries"]["main"]["default"], true);
        let writer_workspace = PathBuf::from(
            config["agents"]["entries"]["writer"]["workspace"]
                .as_str()
                .unwrap(),
        );
        assert!(writer_workspace.is_absolute());
        assert_eq!(config["agents"]["entries"].as_object().unwrap().len(), 2);
        assert_plaintext_bootstrap_absent(&writer_workspace);
    }

    fn assert_plaintext_bootstrap_absent(workspace: &Path) {
        for name in ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"] {
            assert!(
                !workspace.join(name).exists(),
                "{name} must not be plaintext"
            );
        }
    }

    fn sealed_packages(workspace: &Path) -> Vec<PathBuf> {
        fs::read_dir(workspace)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| is_sealed_package_path(path))
            .collect()
    }

    fn read_config(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path.join("openclaw.json")).unwrap()).unwrap()
    }

    fn decode_binding(binding: &str) -> serde_json::Value {
        let payload = binding.strip_prefix("m1.").unwrap();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}
