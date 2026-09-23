use std::{
    collections::BTreeSet,
    fmt, fs,
    fs::{File, OpenOptions},
    io,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use getrandom::fill as random_fill;
use zeroize::Zeroize;

use crate::{
    api::{
        SealedAgentTarget, SealedResourceError, SealedResourceMeteringBinding,
        SealedResourceMeteringKind, SealedResourceMeteringUse, SealedResourceRead,
    },
    domain::{AgentKey, PackageRelativePath},
    package::agent::{SealAgentPackageReceipt, SealedAgentFileRequest, SealedAgentPackage},
};

const SEALED_AGENT_PACKAGE_EXTENSION: &str = "matcha-agentpkg";
const KEY_BYTES: usize = 32;
const KEY_FILE: &str = "sealed-agent.key";
const MAX_FILE_BYTES: u64 = 48 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 256 * 1024;
const AGENT_BOOTSTRAP_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"];
const REQUIRED_AGENT_BOOTSTRAP_FILE: &str = "AGENTS.md";

#[derive(Clone)]
struct SealedAgentRoot {
    target: SealedAgentTarget,
    runtime: Arc<dyn SealedAgentRuntimeProjection>,
}

impl SealedAgentRoot {
    fn openclaw(runtime: Arc<dyn SealedAgentRuntimeProjection>) -> Self {
        Self {
            target: SealedAgentTarget::OpenClaw,
            runtime,
        }
    }

    fn target(&self) -> SealedAgentTarget {
        self.target
    }

    fn workspace_directory(&self, agent_key: &AgentKey) -> Result<PathBuf, SealedResourceError> {
        let session_key = openclaw_agent_session_key(agent_key)?;
        self.runtime.workspace_directory(&session_key)
    }

    fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError> {
        self.runtime.maintenance_workspace_directories()
    }

    fn ensure_agent_entry(
        &self,
        agent_key: &AgentKey,
        workspace: &Path,
    ) -> Result<(), SealedResourceError> {
        self.runtime
            .ensure_agent_entry(agent_key.as_str(), workspace)
    }
}

pub trait SealedAgentRuntimeProjection: Send + Sync {
    fn workspace_directory(&self, session_key: &str) -> Result<PathBuf, SealedResourceError>;

    fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError>;

    fn ensure_agent_entry(
        &self,
        agent_key: &str,
        workspace: &Path,
    ) -> Result<(), SealedResourceError>;
}

impl fmt::Debug for SealedAgentRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentRoot")
            .field("target", &self.target)
            .field("runtime", &"[REDACTED]")
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
    target: SealedAgentTarget,
}

impl SealedAgentCatalogEntry {
    pub fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub fn runtime_target(&self) -> SealedAgentTarget {
        self.target
    }
}

#[derive(Clone, Eq, PartialEq)]
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

impl fmt::Debug for SealedAgentPackageExport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentPackageExport")
            .field("agent_key", &self.agent_key)
            .field("file_name", &self.file_name)
            .field("package_path", &"[REDACTED]")
            .field("size", &self.size)
            .field("exported_at_ms", &self.exported_at_ms)
            .finish()
    }
}

pub struct SealedAgentStore {
    root: SealedAgentRoot,
    private_directory: PathBuf,
    key_path: PathBuf,
    operation_lock: Mutex<()>,
}

impl SealedAgentStore {
    fn new(root: SealedAgentRoot, private_directory: PathBuf) -> Result<Self, SealedResourceError> {
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
        runtime: Arc<dyn SealedAgentRuntimeProjection>,
        private_root: PathBuf,
    ) -> Result<Self, SealedResourceError> {
        Self::new(SealedAgentRoot::openclaw(runtime), private_root)
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

    pub fn contains_agents(
        &self,
        agent_keys: &[AgentKey],
    ) -> Result<BTreeSet<AgentKey>, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let requested = agent_keys.iter().collect::<BTreeSet<_>>();
        let mut sealed = BTreeSet::new();
        for directory in self.root.maintenance_workspace_directories()? {
            let Some(directory) = existing_workspace_directory(&directory)? else {
                continue;
            };
            self.collect_matching_agents_locked(&directory, &requested, &mut sealed)?;
        }
        Ok(sealed)
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
        let receipt = SealedAgentPackage::seal(agent_key.clone(), self.root.target(), files, &key)?;
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
        let bytes = read_package_file(&package_path, SealedResourceError::NotFound)?;
        let mut key = self.read_key()?;
        let package = SealedAgentPackage::open(&bytes, &key);
        key.zeroize();
        let package = package?;
        if package.target() != self.root.target() {
            return Err(SealedResourceError::Rejected);
        }
        if self
            .find_sealed_package_locked(package.agent_key())?
            .is_some()
        {
            return Err(SealedResourceError::AlreadyExists);
        }
        let workspace = self.root.workspace_directory(package.agent_key())?;
        let workspace_preexisted = existing_workspace_directory(&workspace)?.is_some();
        let workspace = ensure_workspace_directory(&workspace)?;
        let receipt = SealAgentPackageReceipt::from_package_bytes(bytes);
        let installed_path = match self.install_receipt_locked(&workspace, &receipt) {
            Ok(path) => path,
            Err(error) => {
                if !workspace_preexisted {
                    let _ = fs::remove_dir(&workspace);
                }
                return Err(error);
            }
        };
        if let Err(error) = self
            .root
            .ensure_agent_entry(package.agent_key(), &workspace)
        {
            let _ = fs::remove_file(installed_path);
            if !workspace_preexisted {
                let _ = fs::remove_dir(&workspace);
            }
            return Err(error);
        }
        Ok(SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            target: package.target(),
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
            let metadata = fs::symlink_metadata(&path).map_err(|_| SealedResourceError::Unknown)?;
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

    fn collect_matching_agents_locked(
        &self,
        directory: &Path,
        requested: &BTreeSet<&AgentKey>,
        sealed: &mut BTreeSet<AgentKey>,
    ) -> Result<(), SealedResourceError> {
        if requested.is_empty() || sealed.len() == requested.len() {
            return Ok(());
        }
        for entry in fs::read_dir(directory).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if !metadata.is_file() || !is_sealed_package_path(&path) {
                continue;
            }
            let package = self.open_package_path_locked(&path)?;
            if package.target() == self.root.target() && requested.contains(package.agent_key()) {
                if !sealed.insert(package.agent_key().clone()) {
                    return Err(SealedResourceError::Rejected);
                }
                if sealed.len() == requested.len() {
                    return Ok(());
                }
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
            let metadata = fs::symlink_metadata(&path).map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if !metadata.is_file() || !is_sealed_package_path(&path) {
                continue;
            }
            let package = self.open_package_path_locked(&path)?;
            if package.target() == self.root.target() && package.agent_key() == agent_key {
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
        if package.target() != self.root.target() {
            return Ok(None);
        }
        Ok(Some(SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            target: package.target(),
        }))
    }

    fn open_package_path_locked(
        &self,
        path: &Path,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
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
            let metadata = fs::symlink_metadata(&path).map_err(|_| SealedResourceError::Unknown)?;
            if metadata.file_type().is_symlink() {
                return Err(SealedResourceError::Rejected);
            }
            if !metadata.is_file() || !is_sealed_package_path(&path) {
                continue;
            }
            let package = self.open_package_path_locked(&path)?;
            if package.target() == self.root.target() && package.agent_key() == agent_key {
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
        let content = read_limited_file(&path, metadata.len(), MAX_FILE_BYTES)?;
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

fn read_package_file(
    path: &Path,
    missing_error: SealedResourceError,
) -> Result<Vec<u8>, SealedResourceError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            missing_error
        } else {
            SealedResourceError::Unknown
        }
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PACKAGE_FILE_BYTES
    {
        return Err(SealedResourceError::Rejected);
    }
    read_limited_file(path, metadata.len(), MAX_PACKAGE_FILE_BYTES)
}

fn read_limited_file(
    path: &Path,
    metadata_len: u64,
    max_bytes: u64,
) -> Result<Vec<u8>, SealedResourceError> {
    if metadata_len > max_bytes {
        return Err(SealedResourceError::Rejected);
    }
    let mut file = File::open(path).map_err(|_| SealedResourceError::Unknown)?;
    let mut bytes = Vec::with_capacity(metadata_len as usize);
    std::io::Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SealedResourceError::Unknown)?;
    if bytes.len() as u64 > max_bytes {
        return Err(SealedResourceError::Rejected);
    }
    Ok(bytes)
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
    use std::{
        collections::BTreeMap,
        fs, io,
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
    };

    use super::*;

    struct FakeAgentRuntime {
        workspaces: Mutex<BTreeMap<String, PathBuf>>,
        maintenance_workspaces: Mutex<Vec<PathBuf>>,
        reject_ensure: Mutex<bool>,
        ensured_entries: Mutex<Vec<(String, PathBuf)>>,
    }

    impl FakeAgentRuntime {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                workspaces: Mutex::new(BTreeMap::new()),
                maintenance_workspaces: Mutex::new(Vec::new()),
                reject_ensure: Mutex::new(false),
                ensured_entries: Mutex::new(Vec::new()),
            })
        }

        fn add_agent_workspace(&self, agent_key: &str, workspace: PathBuf) {
            self.workspaces
                .lock()
                .unwrap()
                .insert(format!("agent:{agent_key}:sealed-agent"), workspace);
        }

        fn add_maintenance_workspace(&self, workspace: PathBuf) {
            self.maintenance_workspaces.lock().unwrap().push(workspace);
        }

        fn reject_ensure(&self) {
            *self.reject_ensure.lock().unwrap() = true;
        }

        fn ensured_entries(&self) -> Vec<(String, PathBuf)> {
            self.ensured_entries.lock().unwrap().clone()
        }
    }

    impl SealedAgentRuntimeProjection for FakeAgentRuntime {
        fn workspace_directory(&self, session_key: &str) -> Result<PathBuf, SealedResourceError> {
            self.workspaces
                .lock()
                .unwrap()
                .get(session_key)
                .cloned()
                .ok_or(SealedResourceError::NotFound)
        }

        fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError> {
            Ok(self.maintenance_workspaces.lock().unwrap().clone())
        }

        fn ensure_agent_entry(
            &self,
            agent_key: &str,
            workspace: &Path,
        ) -> Result<(), SealedResourceError> {
            if *self.reject_ensure.lock().unwrap() {
                return Err(SealedResourceError::Rejected);
            }
            self.ensured_entries
                .lock()
                .unwrap()
                .push((agent_key.to_owned(), workspace.to_path_buf()));
            Ok(())
        }
    }

    #[test]
    fn read_file_returns_session_metering_binding() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("reviewer-workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("AGENTS.md"), "agent instructions").unwrap();
        runtime.add_agent_workspace("reviewer", workspace);
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
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
    fn install_package_path_ensures_runtime_entry_without_plaintext_bootstrap_files() {
        let root = tempfile::tempdir().unwrap();
        let source_runtime = FakeAgentRuntime::new();
        let source_workspace = root.path().join("source-workspace");
        fs::create_dir(&source_workspace).unwrap();
        fs::write(
            source_workspace.join("AGENTS.md"),
            "source agent instructions",
        )
        .unwrap();
        source_runtime.add_agent_workspace("writer", source_workspace);
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(source_runtime, private.clone()).unwrap();
        let agent_key = AgentKey::parse("writer").unwrap();
        let package = source
            .export_plain_workspace_package(agent_key.clone())
            .unwrap();

        let target_runtime = FakeAgentRuntime::new();
        let target_workspace = root.path().join("target-workspace");
        target_runtime.add_agent_workspace("writer", target_workspace.clone());
        let target = SealedAgentStore::openclaw(target_runtime.clone(), private).unwrap();
        let entry = target
            .install_package_path(package.package_path().to_owned())
            .unwrap();

        assert_eq!(entry.agent_key(), &agent_key);
        assert_eq!(entry.runtime_target(), SealedAgentTarget::OpenClaw);
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
        let workspace = fs::canonicalize(target_workspace).unwrap();
        assert_eq!(
            target_runtime.ensured_entries(),
            vec![("writer".to_owned(), workspace.clone())]
        );
        assert_plaintext_bootstrap_absent(&workspace);
        assert_eq!(sealed_packages(&workspace).len(), 1);
    }

    #[test]
    fn catalog_rejects_sealed_agent_package_file_links() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("writer-workspace");
        let target = root.path().join("target.matcha-agentpkg");
        fs::create_dir(&workspace).unwrap();
        fs::write(&target, b"not a package").unwrap();
        if !create_file_link(&target, &workspace.join("linked.matcha-agentpkg")).unwrap() {
            return;
        }
        runtime.add_maintenance_workspace(workspace);
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();

        assert_eq!(store.catalog().unwrap_err(), SealedResourceError::Rejected);
    }

    #[test]
    fn install_package_path_rejects_oversized_package_before_reading() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let package_path = root.path().join("oversized.matcha-agentpkg");
        fs::write(
            &package_path,
            vec![0_u8; (MAX_PACKAGE_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();

        assert_eq!(
            store.install_package_path(package_path).unwrap_err(),
            SealedResourceError::Rejected
        );
    }

    #[test]
    fn contains_agents_reads_sealed_state_in_one_catalog_pass() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let writer_workspace = root.path().join("writer-workspace");
        let reviewer_workspace = root.path().join("reviewer-workspace");
        fs::create_dir(&writer_workspace).unwrap();
        fs::create_dir(&reviewer_workspace).unwrap();
        fs::write(writer_workspace.join("AGENTS.md"), "writer instructions").unwrap();
        fs::write(
            reviewer_workspace.join("AGENTS.md"),
            "reviewer instructions",
        )
        .unwrap();
        runtime.add_agent_workspace("writer", writer_workspace.clone());
        runtime.add_agent_workspace("reviewer", reviewer_workspace.clone());
        runtime.add_maintenance_workspace(writer_workspace);
        runtime.add_maintenance_workspace(reviewer_workspace);
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        store
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap())
            .unwrap();

        let sealed = store
            .contains_agents(&[
                AgentKey::parse("writer").unwrap(),
                AgentKey::parse("reviewer").unwrap(),
            ])
            .unwrap();

        assert!(sealed.contains(&AgentKey::parse("writer").unwrap()));
        assert!(!sealed.contains(&AgentKey::parse("reviewer").unwrap()));
    }

    #[test]
    fn package_export_debug_redacts_package_path() {
        let export = SealedAgentPackageExport {
            agent_key: AgentKey::parse("writer").unwrap(),
            file_name: "sealed.matcha-agentpkg".to_owned(),
            package_path: PathBuf::from("C:/secret/sealed.matcha-agentpkg"),
            size: 7,
            exported_at_ms: 11,
        };

        let debug = format!("{export:?}");

        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("C:/secret"));
    }

    #[test]
    fn install_package_path_removes_installed_package_when_runtime_projection_update_fails() {
        let root = tempfile::tempdir().unwrap();
        let source_runtime = FakeAgentRuntime::new();
        let source_workspace = root.path().join("source-workspace");
        fs::create_dir(&source_workspace).unwrap();
        fs::write(
            source_workspace.join("AGENTS.md"),
            "source agent instructions",
        )
        .unwrap();
        source_runtime.add_agent_workspace("writer", source_workspace);
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(source_runtime, private.clone()).unwrap();
        let package = source
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap())
            .unwrap();

        let target_runtime = FakeAgentRuntime::new();
        let writer_workspace = root
            .path()
            .join("target-state")
            .join("workspace-subagents")
            .join("writer");
        target_runtime.add_agent_workspace("writer", writer_workspace.clone());
        target_runtime.reject_ensure();
        let target = SealedAgentStore::openclaw(target_runtime, private).unwrap();

        assert_eq!(
            target
                .install_package_path(package.package_path().to_owned())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(sealed_packages(&writer_workspace).is_empty());
        assert!(!writer_workspace.exists());
    }

    #[test]
    fn install_package_path_preserves_existing_workspace_material_when_ensuring_agent() {
        let root = tempfile::tempdir().unwrap();
        let source_runtime = FakeAgentRuntime::new();
        let source_workspace = root.path().join("source-workspace");
        fs::create_dir(&source_workspace).unwrap();
        fs::write(
            source_workspace.join("AGENTS.md"),
            "source agent instructions",
        )
        .unwrap();
        source_runtime.add_agent_workspace("writer", source_workspace);
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(source_runtime, private.clone()).unwrap();
        let package = source
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap())
            .unwrap();

        let target_runtime = FakeAgentRuntime::new();
        let target_workspace = root.path().join("target-workspace");
        fs::create_dir(&target_workspace).unwrap();
        fs::write(target_workspace.join("keep.txt"), "keep").unwrap();
        target_runtime.add_agent_workspace("writer", target_workspace.clone());
        let target = SealedAgentStore::openclaw(target_runtime.clone(), private).unwrap();

        target
            .install_package_path(package.package_path().to_owned())
            .unwrap();

        let workspace = fs::canonicalize(target_workspace).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("keep.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            target_runtime.ensured_entries(),
            vec![("writer".to_owned(), workspace.clone())]
        );
        assert_plaintext_bootstrap_absent(&workspace);
        assert_eq!(sealed_packages(&workspace).len(), 1);
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
        let Ok(entries) = fs::read_dir(workspace) else {
            return Vec::new();
        };
        entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| is_sealed_package_path(path))
            .collect()
    }

    #[cfg(unix)]
    fn create_file_link(target: &Path, link: &Path) -> io::Result<bool> {
        std::os::unix::fs::symlink(target, link)?;
        Ok(true)
    }

    #[cfg(windows)]
    fn create_file_link(target: &Path, link: &Path) -> io::Result<bool> {
        Ok(std::os::windows::fs::symlink_file(target, link).is_ok())
    }

    fn decode_binding(binding: &str) -> serde_json::Value {
        let payload = binding.strip_prefix("m1.").unwrap();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}
