use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    fs::{File, OpenOptions},
    io,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    api::{
        SealedAgentTarget, SealedCloudPackageEntry, SealedCloudPackageMetadata,
        SealedCloudPackageType, SealedPackageAuthorizationKey, SealedPackageAuthorizationKeyring,
        SealedResourceError, SealedResourceMeteringBinding, SealedResourceMeteringKind,
        SealedResourceMeteringUse, SealedResourceRead,
    },
    domain::{AgentKey, PackageRelativePath},
    package::{
        agent::{SealAgentPackageReceipt, SealedAgentFileRequest, SealedAgentPackage},
        common::hex_digest,
    },
};

const SEALED_AGENT_PACKAGE_EXTENSION: &str = "matcha-agentpkg";
const AUTHORIZATION_KEY_EXTENSION: &str = "authorization-key";
const CLOUD_METADATA_EXTENSION: &str = "cloud-metadata.json";
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
}

pub trait SealedAgentRuntimeProjection: Send + Sync {
    fn workspace_directory(&self, session_key: &str) -> Result<PathBuf, SealedResourceError>;

    fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError>;
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
    package_sha256: String,
    package_bytes: Arc<[u8]>,
    exported_at_ms: u64,
}

impl SealedAgentPackageExport {
    pub fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub fn package_bytes(&self) -> &[u8] {
        &self.package_bytes
    }

    pub fn into_package_bytes(self) -> Arc<[u8]> {
        self.package_bytes
    }

    pub fn size(&self) -> u64 {
        self.package_bytes.len() as u64
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
            .field("package_sha256", &self.package_sha256)
            .field(
                "package_bytes",
                &format_args!("[REDACTED:{} bytes]", self.package_bytes.len()),
            )
            .field("exported_at_ms", &self.exported_at_ms)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedAgentInstallPlan {
    agent_key: AgentKey,
    workspace: PathBuf,
    workspace_preexisted: bool,
}

impl SealedAgentInstallPlan {
    pub fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn workspace_preexisted(&self) -> bool {
        self.workspace_preexisted
    }
}

impl fmt::Debug for SealedAgentInstallPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentInstallPlan")
            .field("agent_key", &self.agent_key)
            .field("workspace", &"[REDACTED]")
            .finish()
    }
}

pub(crate) enum SealedAgentInstallError {
    NotCommitted(SealedResourceError),
    Committed {
        entry: SealedAgentCatalogEntry,
        error: SealedResourceError,
    },
}

impl From<SealedResourceError> for SealedAgentInstallError {
    fn from(error: SealedResourceError) -> Self {
        Self::NotCommitted(error)
    }
}

impl SealedAgentInstallError {
    pub(crate) fn into_resource_error(self) -> SealedResourceError {
        match self {
            Self::NotCommitted(error) | Self::Committed { error, .. } => error,
        }
    }
}

pub(crate) struct SealedAgentRemoval {
    agent_key: AgentKey,
    workspace: Option<PathBuf>,
    package: Option<(PathBuf, String)>,
}

pub struct SealedAgentStore {
    root: SealedAgentRoot,
    private_directory: PathBuf,
    authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    workspace_operations: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>,
    // Lock order: workspace, then publication. Catalog takes only publication.
    operation_lock: Mutex<()>,
}

struct WorkspaceOperation<'a> {
    operations: &'a Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>,
    source: PathBuf,
    workspace: PathBuf,
    operation: Option<Arc<Mutex<()>>>,
}

impl WorkspaceOperation<'_> {
    fn lock(&self) -> Result<MutexGuard<'_, ()>, SealedResourceError> {
        let guard = self
            .operation
            .as_ref()
            .expect("workspace operation is retained until drop")
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        if workspace_operation_path(&self.source)? != self.workspace {
            return Err(SealedResourceError::Rejected);
        }
        Ok(guard)
    }
}

impl Drop for WorkspaceOperation<'_> {
    fn drop(&mut self) {
        let Ok(mut operations) = self.operations.lock() else {
            return;
        };
        // Release this user under the registry lock, including when the last users drop together.
        drop(self.operation.take());
        if operations
            .get(&self.workspace)
            .is_some_and(|operation| Arc::strong_count(operation) == 1)
        {
            operations.remove(&self.workspace);
        }
    }
}

impl SealedAgentStore {
    fn new(
        root: SealedAgentRoot,
        private_directory: PathBuf,
        authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Result<Self, SealedResourceError> {
        if !private_directory.is_absolute() {
            return Err(SealedResourceError::Rejected);
        }
        fs::create_dir_all(&private_directory).map_err(|_| SealedResourceError::Unknown)?;
        set_private_mode(&private_directory, true)?;
        Ok(Self {
            private_directory,
            root,
            authorization_keyring,
            workspace_operations: Mutex::new(BTreeMap::new()),
            operation_lock: Mutex::new(()),
        })
    }

    pub fn openclaw(
        runtime: Arc<dyn SealedAgentRuntimeProjection>,
        private_root: PathBuf,
    ) -> Result<Self, SealedResourceError> {
        Self::openclaw_with_keyring(
            runtime,
            private_root,
            Arc::new(SealedPackageAuthorizationKeyring::new()),
        )
    }

    pub(crate) fn openclaw_with_keyring(
        runtime: Arc<dyn SealedAgentRuntimeProjection>,
        private_root: PathBuf,
        authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Result<Self, SealedResourceError> {
        Self::new(
            SealedAgentRoot::openclaw(runtime),
            private_root,
            authorization_keyring,
        )
    }

    fn workspace_operation(
        &self,
        workspace: &Path,
    ) -> Result<WorkspaceOperation<'_>, SealedResourceError> {
        let source = workspace.to_owned();
        let workspace = workspace_operation_path(workspace)?;
        let mut operations = self
            .workspace_operations
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let operation = Arc::clone(
            operations
                .entry(workspace.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        );
        Ok(WorkspaceOperation {
            operations: &self.workspace_operations,
            source,
            workspace,
            operation: Some(operation),
        })
    }

    fn install_workspace(&self, bytes: &[u8]) -> Result<PathBuf, SealedResourceError> {
        // Manifest identity selects the lock, never authorizes the payload.
        let manifest = SealedAgentPackage::open_manifest(bytes)?;
        self.root.workspace_directory(manifest.agent_key())
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

    pub(crate) fn cloud_packages(
        &self,
    ) -> Result<Vec<SealedCloudPackageEntry>, SealedResourceError> {
        let started = platform::trace::enabled().then(Instant::now);
        if started.is_some() {
            eprintln!(
                "[startup-trace] source=sealed-resource phase=cloud-package-scan stage=start kind=agent"
            );
        }
        let mut lock_wait_ms = 0;
        let mut package_count = 0usize;
        let mut total_bytes = 0u64;
        let result = (|| {
            let lock_started = started.map(|_| Instant::now());
            let guard = self.operation_lock.lock();
            if let Some(lock_started) = lock_started {
                lock_wait_ms = lock_started.elapsed().as_millis();
            }
            let _guard = guard.map_err(|_| SealedResourceError::Unknown)?;
            let mut packages = Vec::new();
            for directory in self.root.maintenance_workspace_directories()? {
                let Some(directory) = existing_workspace_directory(&directory)? else {
                    continue;
                };
                for entry in fs::read_dir(directory).map_err(|_| SealedResourceError::Unknown)? {
                    let path = entry.map_err(|_| SealedResourceError::Unknown)?.path();
                    if !is_sealed_package_path(&path) {
                        continue;
                    }
                    let bytes = read_package_file(&path, SealedResourceError::Unknown)?;
                    if started.is_some() {
                        package_count += 1;
                        total_bytes += bytes.len() as u64;
                    }
                    let package_sha256 = hex_digest(&bytes);
                    let Some(metadata) = self.cloud_metadata(&package_sha256)? else {
                        continue;
                    };
                    metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
                    if SealedAgentPackage::open_manifest(&bytes)?.target() == self.root.target() {
                        packages.push(metadata.into());
                    }
                }
            }
            Ok(packages)
        })();
        if let Some(started) = started {
            eprintln!(
                "[startup-trace] source=sealed-resource phase=cloud-package-scan stage=end kind=agent duration_ms={} lock_wait_ms={lock_wait_ms} package_count={package_count} total_bytes={total_bytes} outcome={}",
                started.elapsed().as_millis(),
                if result.is_ok() { "success" } else { "failed" }
            );
        }
        result
    }

    pub fn is_using_sealed_source(&self, agent_key: &AgentKey) -> Result<bool, SealedResourceError> {
        let workspace = self.root.workspace_directory(agent_key)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let Some(workspace) = existing_workspace_directory(&operation.workspace)? else {
            return Ok(false);
        };
        if has_plain_agent_source(&workspace)? {
            return Ok(false);
        }
        self.find_sealed_package_in_workspace_locked(agent_key, &workspace)
            .map(|entry| entry.is_some())
    }

    pub fn agents_using_sealed_source(
        &self,
        agent_keys: &[AgentKey],
    ) -> Result<BTreeSet<AgentKey>, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let mut workspaces = BTreeMap::<PathBuf, BTreeSet<&AgentKey>>::new();
        for agent_key in agent_keys {
            let workspace = self.root.workspace_directory(agent_key)?;
            let Some(workspace) = existing_workspace_directory(&workspace)? else {
                continue;
            };
            workspaces.entry(workspace).or_default().insert(agent_key);
        }
        let mut sealed = BTreeSet::new();
        for (workspace, requested) in workspaces {
            if has_plain_agent_source(&workspace)? {
                continue;
            }
            let mut matching = BTreeSet::new();
            self.collect_matching_agents_locked(&workspace, &requested, &mut matching)?;
            sealed.extend(matching);
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
        let workspace = self.root.workspace_directory(&agent_key)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let workspace =
            existing_workspace_directory(&operation.workspace)?.ok_or(SealedResourceError::NotFound)?;
        if has_plain_agent_source(&workspace)? {
            return Err(SealedResourceError::NotFound);
        }
        let package = self.open_sealed_agent_locked(&agent_key, &workspace)?;
        let file = package.file(&path).ok_or(SealedResourceError::NotFound)?;
        Ok(SealedResourceRead::new(
            file.content().to_vec(),
            Some(SealedResourceMeteringBinding::openclaw(
                SealedResourceMeteringKind::Agent,
                agent_key.as_str(),
                package.package_sha256(),
                SealedResourceMeteringUse::Session,
            )?),
            package.package_sha256().to_owned(),
        ))
    }

    pub fn export_plain_workspace_package(
        &self,
        agent_key: AgentKey,
        agent_name: &str,
    ) -> Result<SealedAgentPackageExport, SealedResourceError> {
        self.export_workspace_package(agent_key, agent_name, None, None)
    }

    pub fn export_cloud_workspace_package(
        &self,
        agent_key: AgentKey,
        agent_name: &str,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<SealedAgentPackageExport, SealedResourceError> {
        self.export_workspace_package(
            agent_key,
            agent_name,
            Some(cloud_public_key.as_str()),
            Some(cloud_key_id.as_str()),
        )
    }

    fn export_workspace_package(
        &self,
        agent_key: AgentKey,
        agent_name: &str,
        cloud_public_key: Option<&str>,
        cloud_key_id: Option<&str>,
    ) -> Result<SealedAgentPackageExport, SealedResourceError> {
        let workspace = self.root.workspace_directory(&agent_key)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let workspace =
            existing_workspace_directory(&operation.workspace)?.ok_or(SealedResourceError::NotFound)?;
        let files = collect_agent_files(&workspace)?;
        let receipt = SealedAgentPackage::seal_with_cloud_key(
            agent_key.clone(),
            self.root.target(),
            files,
            cloud_public_key,
            cloud_key_id,
        )?;
        if receipt.package_size() > MAX_PACKAGE_FILE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        let package =
            SealedAgentPackage::open(receipt.package_bytes(), receipt.authorization_key())?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let file_name = super::export::package_file_name(
            &workspace,
            agent_name,
            SEALED_AGENT_PACKAGE_EXTENSION,
        )?;
        let installed_path = self.install_receipt_locked(&workspace, &receipt, &file_name)?;
        self.remove_other_packages_locked(package.agent_key(), &workspace, &installed_path)?;
        Ok(SealedAgentPackageExport {
            agent_key,
            file_name,
            package_sha256: receipt.package_sha256().to_owned(),
            package_bytes: receipt.into_package_bytes().into(),
            exported_at_ms: now_millis(),
        })
    }

    pub fn prepare_install(
        &self,
        package_path: PathBuf,
    ) -> Result<SealedAgentInstallPlan, SealedResourceError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let authorization_key = self.read_authorization_key_for_package_bytes(&bytes)?;
        let package = self.open_install_package_bytes_locked(&bytes, &authorization_key)?;
        self.prepare_install_package_locked(&package, workspace)
    }

    pub fn prepare_install_with_authorization_key(
        &self,
        package_path: PathBuf,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Result<SealedAgentInstallPlan, SealedResourceError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let package = self.open_install_package_bytes_locked(&bytes, &authorization_key)?;
        self.prepare_install_package_locked(&package, workspace)
    }

    pub fn prepare_install_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedAgentInstallPlan, SealedResourceError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
        let authorization_key = self.cloud_authorization_key(&package_sha256)?;
        let package = self.open_install_package_bytes_locked(&bytes, &authorization_key)?;
        self.prepare_install_package_locked(&package, workspace)
    }

    pub fn install_package_path(
        &self,
        package_path: PathBuf,
    ) -> Result<SealedAgentCatalogEntry, SealedResourceError> {
        self.install_package_path_outcome(package_path)
            .map_err(SealedAgentInstallError::into_resource_error)
    }

    pub(crate) fn install_package_path_outcome(
        &self,
        package_path: PathBuf,
    ) -> Result<SealedAgentCatalogEntry, SealedAgentInstallError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let authorization_key = self.read_authorization_key_for_package_bytes(&bytes)?;
        self.install_package_bytes_locked(bytes, authorization_key, &operation.workspace)
    }

    pub fn install_package_path_with_authorization_key(
        &self,
        package_path: PathBuf,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Result<SealedAgentCatalogEntry, SealedResourceError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.install_package_bytes_locked(bytes, authorization_key, &operation.workspace)
            .map_err(SealedAgentInstallError::into_resource_error)
    }

    pub fn install_package_path_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedAgentCatalogEntry, SealedResourceError> {
        self.install_package_path_with_cloud_metadata_outcome(package_path, metadata)
            .map_err(SealedAgentInstallError::into_resource_error)
    }

    pub(crate) fn install_package_path_with_cloud_metadata_outcome(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedAgentCatalogEntry, SealedAgentInstallError> {
        let bytes = read_install_package(&package_path)?;
        let workspace = self.install_workspace(&bytes)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
        let authorization_key = self.cloud_authorization_key(&package_sha256)?;
        self.install_cloud_package_bytes_locked(
            bytes,
            authorization_key,
            metadata,
            &operation.workspace,
        )
    }

    pub fn remove_package(&self, agent_key: AgentKey) -> Result<bool, SealedResourceError> {
        let workspace = self.root.workspace_directory(&agent_key)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let removal = self.prepare_remove_package_locked(agent_key, &operation.workspace)?;
        self.remove_prepared_package_locked(removal)
    }

    pub(crate) fn prepare_remove_package(
        &self,
        agent_key: AgentKey,
    ) -> Result<SealedAgentRemoval, SealedResourceError> {
        let workspace = self.root.workspace_directory(&agent_key)?;
        let operation = self.workspace_operation(&workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.prepare_remove_package_locked(agent_key, &operation.workspace)
    }

    pub(crate) fn remove_prepared_package(
        &self,
        removal: SealedAgentRemoval,
    ) -> Result<bool, SealedResourceError> {
        let Some(workspace) = removal.workspace.as_ref() else {
            return Ok(false);
        };
        let operation = self.workspace_operation(workspace)?;
        let _workspace_guard = operation.lock()?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.remove_prepared_package_locked(removal)
    }

    fn prepare_remove_package_locked(
        &self,
        agent_key: AgentKey,
        workspace: &Path,
    ) -> Result<SealedAgentRemoval, SealedResourceError> {
        let workspace = existing_workspace_directory(workspace)?;
        let package = match workspace.as_ref() {
            Some(workspace) => self.find_sealed_package_in_workspace_locked(&agent_key, workspace)?,
            None => None,
        };
        Ok(SealedAgentRemoval {
            agent_key,
            workspace,
            package,
        })
    }

    fn remove_prepared_package_locked(
        &self,
        removal: SealedAgentRemoval,
    ) -> Result<bool, SealedResourceError> {
        let Some(workspace) = removal.workspace else {
            return Ok(false);
        };
        match existing_workspace_directory(&workspace)? {
            Some(current) if current == workspace => {}
            None => {
                let Some((_, digest)) = removal.package else {
                    return Ok(false);
                };
                self.remove_package_binding_locked(&digest)?;
                return Ok(true);
            }
            _ => return Err(SealedResourceError::Rejected),
        }
        let current = self.find_sealed_package_in_workspace_locked(&removal.agent_key, &workspace)?;
        match (removal.package, current) {
            (None, None) => Ok(false),
            (Some((path, digest)), Some((current_path, current_digest)))
                if path == current_path && digest == current_digest => {
                    self.remove_package_path_locked(&path, &digest)?;
                    Ok(true)
                }
            (Some((path, digest)), None) => {
                ensure_missing(&path)?;
                self.remove_package_binding_locked(&digest)?;
                Ok(true)
            }
            _ => Err(SealedResourceError::Rejected),
        }
    }

    fn prepare_install_package_locked(
        &self,
        package: &SealedAgentPackage,
        workspace: PathBuf,
    ) -> Result<SealedAgentInstallPlan, SealedResourceError> {
        let workspace_preexisted = existing_workspace_directory(&workspace)?.is_some();
        Ok(SealedAgentInstallPlan {
            agent_key: package.agent_key().clone(),
            workspace,
            workspace_preexisted,
        })
    }

    fn install_package_bytes_locked(
        &self,
        bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
        workspace: &Path,
    ) -> Result<SealedAgentCatalogEntry, SealedAgentInstallError> {
        let receipt = SealAgentPackageReceipt::from_package_bytes(bytes, authorization_key);
        self.install_package_receipt_locked(receipt, None, workspace)
    }

    fn install_cloud_package_bytes_locked(
        &self,
        bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
        metadata: SealedCloudPackageMetadata,
        workspace: &Path,
    ) -> Result<SealedAgentCatalogEntry, SealedAgentInstallError> {
        let receipt = SealAgentPackageReceipt::from_package_bytes(bytes, authorization_key);
        self.install_package_receipt_locked(receipt, Some(metadata), workspace)
    }

    fn install_package_receipt_locked(
        &self,
        receipt: SealAgentPackageReceipt,
        metadata: Option<SealedCloudPackageMetadata>,
        workspace: &Path,
    ) -> Result<SealedAgentCatalogEntry, SealedAgentInstallError> {
        let package = self.open_install_package_bytes_locked(
            receipt.package_bytes(),
            receipt.authorization_key(),
        )?;
        match metadata.as_ref() {
            Some(metadata) => {
                metadata.ensure_matches(SealedCloudPackageType::Agent, receipt.package_sha256())?
            }
            None => {}
        }
        let workspace_preexisted = existing_workspace_directory(workspace)?.is_some();
        let workspace = ensure_workspace_directory(workspace)?;
        let mut files = AgentInstallFiles::default();
        let result = (|| {
            for name in AGENT_BOOTSTRAP_FILES {
                files.remove(&workspace.join(name))?;
            }
            let install_result = match metadata.as_ref() {
                Some(metadata) => {
                    self.install_cloud_receipt_locked(&workspace, &receipt, metadata, &mut files)
                }
                None => self.write_receipt_locked(
                    &workspace,
                    &receipt,
                    receipt.package_file_name(),
                    &mut files,
                ),
            };
            match install_result {
                Ok(_) => {}
                Err(SealedResourceError::AlreadyExists) => {
                    let expected_path = workspace.join(receipt.package_file_name());
                    match self
                        .find_sealed_package_in_workspace_locked(package.agent_key(), &workspace)?
                    {
                        Some((path, _)) if path == expected_path => {}
                        _ => return Err(SealedResourceError::AlreadyExists),
                    }
                }
                Err(error) => return Err(error),
            }
            Ok(())
        })();
        let result = files.finish(result);
        if result.is_err() && !workspace_preexisted {
            let _ = fs::remove_dir(&workspace);
        }
        result?;
        let entry = SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            target: package.target(),
        };
        self.remove_other_packages_locked(
            package.agent_key(),
            &workspace,
            &workspace.join(receipt.package_file_name()),
        )
        .map_err(|error| SealedAgentInstallError::Committed {
            entry: entry.clone(),
            error,
        })?;
        Ok(entry)
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
            let Some(package) = self.catalog_package_manifest_path_locked(&path)? else {
                continue;
            };
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
        workspace: &Path,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let (path, _) = self
            .find_sealed_package_in_workspace_locked(agent_key, workspace)?
            .ok_or(SealedResourceError::NotFound)?;
        self.open_package_path_locked(&path)
    }

    fn find_sealed_package_in_workspace_locked(
        &self,
        agent_key: &AgentKey,
        workspace: &Path,
    ) -> Result<Option<(PathBuf, String)>, SealedResourceError> {
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
            let (key, target, package_sha256) = self.package_identity_path_locked(&path)?;
            if target == self.root.target() && &key == agent_key {
                if found.is_some() {
                    return Err(SealedResourceError::Rejected);
                }
                found = Some((path, package_sha256));
            }
        }
        Ok(found)
    }

    fn catalog_sealed_package_locked(
        &self,
        path: &Path,
    ) -> Result<Option<SealedAgentCatalogEntry>, SealedResourceError> {
        let Some(package) = self.catalog_package_manifest_path_locked(path)? else {
            return Ok(None);
        };
        if package.target() != self.root.target() {
            return Ok(None);
        }
        Ok(Some(SealedAgentCatalogEntry {
            agent_key: package.agent_key().clone(),
            target: package.target(),
        }))
    }

    fn catalog_package_manifest_path_locked(
        &self,
        path: &Path,
    ) -> Result<Option<crate::package::agent::SealedAgentPackageManifest>, SealedResourceError>
    {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        if let Some(metadata) = self.cloud_metadata(&package_sha256)? {
            metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
            return SealedAgentPackage::open_manifest(&bytes).map(Some);
        }
        let Some(authorization_key) = self.catalog_local_authorization_key(&package_sha256)? else {
            return Ok(None);
        };
        SealedAgentPackage::open(&bytes, &authorization_key).map(|package| {
            Some(crate::package::agent::SealedAgentPackageManifest::new(
                package.agent_key().clone(),
                package.target(),
            ))
        })
    }

    fn package_identity_path_locked(
        &self,
        path: &Path,
    ) -> Result<(AgentKey, SealedAgentTarget, String), SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        if let Some(metadata) = self.cloud_metadata(&package_sha256)? {
            metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
            let manifest = SealedAgentPackage::open_manifest(&bytes)?;
            return Ok((
                manifest.agent_key().clone(),
                manifest.target(),
                package_sha256,
            ));
        }
        let package = self.open_package_bytes_locked(&bytes)?;
        Ok((
            package.agent_key().clone(),
            package.target(),
            package_sha256,
        ))
    }

    fn remove_package_path_locked(
        &self,
        path: &Path,
        package_sha256: &str,
    ) -> Result<(), SealedResourceError> {
        fs::remove_file(path).map_err(|_| SealedResourceError::Unknown)?;
        self.remove_package_binding_locked(package_sha256)
    }

    fn remove_package_binding_locked(
        &self,
        package_sha256: &str,
    ) -> Result<(), SealedResourceError> {
        remove_authorization_key_file(&self.authorization_key_path(package_sha256))?;
        remove_authorization_key_file(&self.cloud_metadata_path(package_sha256))?;
        self.authorization_keyring.remove(package_sha256)
    }

    fn open_package_path_locked(
        &self,
        path: &Path,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        self.open_package_bytes_locked(&bytes)
    }

    fn open_install_package_bytes_locked(
        &self,
        bytes: &[u8],
        authorization_key: &SealedPackageAuthorizationKey,
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let package = SealedAgentPackage::open(bytes, authorization_key)?;
        if package.target() != self.root.target() {
            return Err(SealedResourceError::Rejected);
        }
        Ok(package)
    }

    fn open_package_bytes_locked(
        &self,
        bytes: &[u8],
    ) -> Result<SealedAgentPackage, SealedResourceError> {
        let authorization_key = self.read_authorization_key_for_package_bytes(bytes)?;
        SealedAgentPackage::open(bytes, &authorization_key)
    }

    fn install_receipt_locked(
        &self,
        workspace: &Path,
        package: &SealAgentPackageReceipt,
        file_name: &str,
    ) -> Result<PathBuf, SealedResourceError> {
        let mut files = AgentInstallFiles::default();
        let result = self.write_receipt_locked(workspace, package, file_name, &mut files);
        files.finish(result)
    }

    fn write_receipt_locked(
        &self,
        workspace: &Path,
        package: &SealAgentPackageReceipt,
        file_name: &str,
        files: &mut AgentInstallFiles,
    ) -> Result<PathBuf, SealedResourceError> {
        let workspace = ensure_workspace_directory(workspace)?;
        let path = workspace.join(file_name);
        ensure_missing(&path)?;
        let key_path = self.authorization_key_path(package.package_sha256());
        let key_staging = files.stage(&key_path, package.authorization_key().as_bytes(), None)?;
        let package_staging = files.stage(&path, package.package_bytes(), None)?;
        files.remove(&key_path)?;
        files.publish_staged(&key_path, key_staging)?;
        files.publish_staged(&path, package_staging)?;
        Ok(path)
    }

    fn install_cloud_receipt_locked(
        &self,
        workspace: &Path,
        package: &SealAgentPackageReceipt,
        metadata: &SealedCloudPackageMetadata,
        files: &mut AgentInstallFiles,
    ) -> Result<PathBuf, SealedResourceError> {
        let workspace = ensure_workspace_directory(workspace)?;
        let path = workspace.join(package.package_file_name());
        ensure_missing(&path)?;
        let metadata_path = self.cloud_metadata_path(package.package_sha256());
        let bytes = serde_json::to_vec(metadata).map_err(|_| SealedResourceError::Unknown)?;
        let metadata_staging = files.stage(&metadata_path, &bytes, None)?;
        let package_staging = files.stage(&path, package.package_bytes(), None)?;
        files.remove(&metadata_path)?;
        files.publish_staged(&metadata_path, metadata_staging)?;
        files.remove(&self.authorization_key_path(package.package_sha256()))?;
        files.publish_staged(&path, package_staging)?;
        Ok(path)
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
            let (key, target, package_sha256) = self.package_identity_path_locked(&path)?;
            if target == self.root.target() && &key == agent_key {
                self.remove_package_path_locked(&path, &package_sha256)?;
            }
        }
        Ok(())
    }

    fn read_authorization_key_for_package_bytes(
        &self,
        package_bytes: &[u8],
    ) -> Result<SealedPackageAuthorizationKey, SealedResourceError> {
        let package_sha256 = hex_digest(package_bytes);
        if let Some(metadata) = self.cloud_metadata(&package_sha256)? {
            metadata.ensure_matches(SealedCloudPackageType::Agent, &package_sha256)?;
            return self.cloud_authorization_key(&package_sha256);
        }
        read_authorization_key_file(&self.authorization_key_path(&package_sha256))
    }

    fn cloud_authorization_key(
        &self,
        package_sha256: &str,
    ) -> Result<SealedPackageAuthorizationKey, SealedResourceError> {
        self.authorization_keyring.authorization_key(package_sha256)
    }

    fn catalog_local_authorization_key(
        &self,
        package_sha256: &str,
    ) -> Result<Option<SealedPackageAuthorizationKey>, SealedResourceError> {
        match read_authorization_key_file(&self.authorization_key_path(package_sha256)) {
            Ok(authorization_key) => Ok(Some(authorization_key)),
            Err(SealedResourceError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn cloud_metadata(
        &self,
        package_sha256: &str,
    ) -> Result<Option<SealedCloudPackageMetadata>, SealedResourceError> {
        read_cloud_metadata_file(&self.cloud_metadata_path(package_sha256))
    }

    fn authorization_key_path(&self, package_sha256: &str) -> PathBuf {
        self.private_directory
            .join(format!("{package_sha256}.{AUTHORIZATION_KEY_EXTENSION}"))
    }

    fn cloud_metadata_path(&self, package_sha256: &str) -> PathBuf {
        self.private_directory
            .join(format!("{package_sha256}.{CLOUD_METADATA_EXTENSION}"))
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

fn has_plain_agent_source(workspace: &Path) -> Result<bool, SealedResourceError> {
    let metadata = match fs::symlink_metadata(workspace.join(REQUIRED_AGENT_BOOTSTRAP_FILE)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(SealedResourceError::Unknown),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SealedResourceError::Rejected);
    }
    Ok(true)
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

#[derive(Default)]
struct AgentInstallFiles {
    writes: Vec<AgentInstallWrite>,
    removed: Vec<(PathBuf, usize)>,
}

struct AgentInstallWrite {
    path: PathBuf,
    contents: Vec<u8>,
    temporary: bool,
    retained: bool,
}

impl AgentInstallFiles {
    fn stage(
        &mut self,
        path: &Path,
        contents: &[u8],
        permissions: Option<fs::Permissions>,
    ) -> Result<usize, SealedResourceError> {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| SealedResourceError::Unknown)?;
        let temporary = path
            .parent()
            .ok_or(SealedResourceError::Rejected)?
            .join(format!(".agent-install-{}.tmp", hex_digest(&nonce)));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| SealedResourceError::Unknown)?;
        let index = self.writes.len();
        self.writes.push(AgentInstallWrite {
            path: temporary.clone(),
            contents: Vec::new(),
            temporary: true,
            retained: false,
        });
        set_private_mode(&temporary, false)?;
        while self.writes[index].contents.len() < contents.len() {
            let offset = self.writes[index].contents.len();
            let written = file
                .write(&contents[offset..])
                .map_err(|_| SealedResourceError::Unknown)?;
            if written == 0 {
                return Err(SealedResourceError::Unknown);
            }
            self.writes[index].contents.extend_from_slice(&contents[offset..offset + written]);
        }
        if let Some(permissions) = permissions {
            file.set_permissions(permissions).map_err(|_| SealedResourceError::Unknown)?;
        }
        file.sync_all().map_err(|_| SealedResourceError::Unknown)?;
        Ok(index)
    }

    fn publish_staged(&mut self, path: &Path, index: usize) -> Result<(), SealedResourceError> {
        if !install_file_matches(&self.writes[index].path, &self.writes[index].contents)? {
            return Err(SealedResourceError::Unknown);
        }
        fs::hard_link(&self.writes[index].path, path).map_err(|_| SealedResourceError::Unknown)?;
        let contents = self.writes[index].contents.clone();
        self.writes.push(AgentInstallWrite {
            path: path.to_owned(),
            contents,
            temporary: false,
            retained: false,
        });
        Ok(())
    }

    fn remove(&mut self, path: &Path) -> Result<(), SealedResourceError> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(SealedResourceError::Unknown),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SealedResourceError::Rejected);
        }
        let contents = fs::read(path).map_err(|_| SealedResourceError::Unknown)?;
        let index = self.stage(path, &contents, Some(metadata.permissions()))?;
        if !install_file_matches(path, &contents)? {
            return Err(SealedResourceError::Unknown);
        }
        fs::remove_file(path).map_err(|_| SealedResourceError::Unknown)?;
        self.removed.push((path.to_owned(), index));
        Ok(())
    }

    fn finish<T>(mut self, result: Result<T, SealedResourceError>) -> Result<T, SealedResourceError> {
        // Package publication commits the install; later temp cleanup cannot roll it back.
        let committed = result.is_ok();
        let mut failed = false;
        if !committed {
            for write in self.writes.iter().rev().filter(|write| !write.temporary) {
                failed |= remove_install_write(write).is_err();
            }
            for (path, index) in self.removed.iter().rev() {
                let preimage = &mut self.writes[*index];
                let restored = (|| {
                    if install_file_matches(path, &preimage.contents)? {
                        return Ok(());
                    }
                    ensure_missing(path)?;
                    if !install_file_matches(&preimage.path, &preimage.contents)? {
                        return Err(SealedResourceError::Unknown);
                    }
                    fs::hard_link(&preimage.path, path).map_err(|_| SealedResourceError::Unknown)
                })();
                if restored.is_err() {
                    preimage.retained = true;
                    failed = true;
                }
            }
        }
        for write in self.writes.iter().filter(|write| write.temporary && !write.retained) {
            failed |= remove_install_write(write).is_err();
        }
        if failed && !committed {
            Err(SealedResourceError::Unknown)
        } else {
            result
        }
    }
}

fn install_file_matches(path: &Path, contents: &[u8]) -> Result<bool, SealedResourceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(SealedResourceError::Unknown),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != contents.len() as u64 {
        return Ok(false);
    }
    fs::read(path).map(|current| current == contents).map_err(|_| SealedResourceError::Unknown)
}

fn remove_install_write(write: &AgentInstallWrite) -> Result<(), SealedResourceError> {
    match fs::symlink_metadata(&write.path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(SealedResourceError::Unknown),
        Ok(_) => {}
    }
    if !install_file_matches(&write.path, &write.contents)? {
        return Err(SealedResourceError::Unknown);
    }
    fs::remove_file(&write.path).map_err(|_| SealedResourceError::Unknown)
}

fn workspace_operation_path(path: &Path) -> Result<PathBuf, SealedResourceError> {
    if let Some(workspace) = existing_workspace_directory(path)? {
        return Ok(workspace);
    }
    // Prepare/install may target an absent workspace; canonicalize its nearest existing parent.
    let parent = path.parent().ok_or(SealedResourceError::Rejected)?;
    let name = path.file_name().ok_or(SealedResourceError::Rejected)?;
    let parent = match fs::canonicalize(parent) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => workspace_operation_path(parent)?,
        Err(_) => return Err(SealedResourceError::Unknown),
    };
    Ok(parent.join(name))
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

fn read_install_package(package_path: &Path) -> Result<Vec<u8>, SealedResourceError> {
    if !package_path.is_absolute() || !is_sealed_package_path(package_path) {
        return Err(SealedResourceError::Rejected);
    }
    read_package_file(package_path, SealedResourceError::NotFound)
}

fn read_authorization_key_file(
    path: &Path,
) -> Result<SealedPackageAuthorizationKey, SealedResourceError> {
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            SealedResourceError::NotFound
        } else {
            SealedResourceError::Unknown
        }
    })?;
    SealedPackageAuthorizationKey::try_from_slice(&bytes)
}

fn read_cloud_metadata_file(
    path: &Path,
) -> Result<Option<SealedCloudPackageMetadata>, SealedResourceError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SealedResourceError::Unknown),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| SealedResourceError::Rejected)
}

#[cfg(test)]
fn write_cloud_metadata_file(
    path: &Path,
    metadata: &SealedCloudPackageMetadata,
) -> Result<(), SealedResourceError> {
    let bytes = serde_json::to_vec(metadata).map_err(|_| SealedResourceError::Unknown)?;
    write_private_file(path, &bytes)
}

fn ensure_missing(path: &Path) -> Result<(), SealedResourceError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(SealedResourceError::AlreadyExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SealedResourceError::Unknown),
    }
}

#[cfg(test)]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), SealedResourceError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| SealedResourceError::Unknown)?;
    set_private_mode(path, false)?;
    file.write_all(bytes)
        .map_err(|_| SealedResourceError::Unknown)?;
    file.sync_all().map_err(|_| SealedResourceError::Unknown)
}

fn remove_authorization_key_file(path: &Path) -> Result<(), SealedResourceError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SealedResourceError::Unknown),
    }
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
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    use super::*;

    struct FakeAgentRuntime {
        workspaces: Mutex<BTreeMap<String, PathBuf>>,
        maintenance_workspaces: Mutex<Vec<PathBuf>>,
    }

    impl FakeAgentRuntime {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                workspaces: Mutex::new(BTreeMap::new()),
                maintenance_workspaces: Mutex::new(Vec::new()),
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
    }

    #[test]
    fn read_file_returns_session_metering_binding() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("reviewer-workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("AGENTS.md"), "agent instructions").unwrap();
        runtime.add_agent_workspace("reviewer", workspace);
        let private = root.path().join("private");
        let source = SealedAgentStore::openclaw(runtime, private.clone()).unwrap();
        let agent_key = AgentKey::parse("reviewer").unwrap();
        let package = source
            .export_plain_workspace_package(agent_key.clone(), agent_key.as_str())
            .unwrap();
        let package_path = root.path().join("input.matcha-agentpkg");
        fs::write(&package_path, package.package_bytes()).unwrap();
        let target_runtime = FakeAgentRuntime::new();
        target_runtime.add_agent_workspace("reviewer", root.path().join("target-workspace"));
        let store = SealedAgentStore::openclaw(target_runtime, private).unwrap();
        store.install_package_path(package_path).unwrap();

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
    fn install_package_path_removes_plaintext_bootstrap_files() {
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
            .export_plain_workspace_package(agent_key.clone(), agent_key.as_str())
            .unwrap();

        let package_path = root.path().join("input.matcha-agentpkg");
        fs::write(&package_path, package.package_bytes()).unwrap();
        let target_runtime = FakeAgentRuntime::new();
        let target_workspace = root.path().join("target-workspace");
        target_runtime.add_agent_workspace("writer", target_workspace.clone());
        let target = SealedAgentStore::openclaw(target_runtime, private).unwrap();
        let entry = target.install_package_path(package_path.clone()).unwrap();

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
    fn agents_using_sealed_source_respects_workspace_source() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let writer_workspace = root.path().join("writer-workspace");
        let reviewer_workspace = root.path().join("reviewer-workspace");
        fs::create_dir(&writer_workspace).unwrap();
        fs::create_dir(&reviewer_workspace).unwrap();
        fs::write(writer_workspace.join("AGENTS.md"), "writer instructions").unwrap();
        fs::write(writer_workspace.join("SOUL.md"), "old soul instructions").unwrap();
        fs::write(
            reviewer_workspace.join("AGENTS.md"),
            "reviewer instructions",
        )
        .unwrap();
        runtime.add_agent_workspace("writer", writer_workspace.clone());
        runtime.add_agent_workspace("reviewer", reviewer_workspace.clone());
        runtime.add_maintenance_workspace(writer_workspace.clone());
        runtime.add_maintenance_workspace(reviewer_workspace.clone());
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        let writer = AgentKey::parse("writer").unwrap();
        let reviewer = AgentKey::parse("reviewer").unwrap();
        let agent_keys = [writer.clone(), reviewer.clone()];
        let package = store
            .export_plain_workspace_package(writer.clone(), "writer")
            .unwrap();
        fs::remove_file(writer_workspace.join("SOUL.md")).unwrap();
        let package_path = writer_workspace.join(package.file_name());
        let misplaced_path = reviewer_workspace.join(package.file_name());
        fs::rename(&package_path, &misplaced_path).unwrap();
        fs::remove_file(reviewer_workspace.join("AGENTS.md")).unwrap();
        assert!(store.agents_using_sealed_source(&agent_keys).unwrap().is_empty());
        assert!(!store.is_using_sealed_source(&writer).unwrap());
        fs::rename(misplaced_path, package_path).unwrap();
        fs::write(reviewer_workspace.join("AGENTS.md"), "reviewer instructions").unwrap();

        assert!(store.agents_using_sealed_source(&agent_keys).unwrap().is_empty());
        assert!(!store.is_using_sealed_source(&writer).unwrap());
        assert_eq!(store.catalog().unwrap().entries().len(), 1);
        for name in ["AGENTS.md", "SOUL.md"] {
            assert_eq!(
                store
                    .read_file(writer.clone(), PackageRelativePath::parse(name).unwrap())
                    .unwrap_err(),
                SealedResourceError::NotFound
            );
        }

        fs::write(writer_workspace.join("AGENTS.md"), "updated writer instructions").unwrap();
        store
            .export_plain_workspace_package(writer.clone(), "writer")
            .unwrap();
        assert_eq!(sealed_packages(&writer_workspace).len(), 1);
        assert!(store.agents_using_sealed_source(&agent_keys).unwrap().is_empty());
        fs::remove_file(writer_workspace.join("AGENTS.md")).unwrap();

        let sealed = store.agents_using_sealed_source(&agent_keys).unwrap();
        assert!(sealed.contains(&writer));
        assert!(!sealed.contains(&reviewer));
        assert!(store.is_using_sealed_source(&writer).unwrap());
        assert_eq!(
            store
                .read_file(writer.clone(), PackageRelativePath::parse("AGENTS.md").unwrap())
                .unwrap()
                .content(),
            b"updated writer instructions"
        );
        assert_eq!(
            store
                .read_file(writer, PackageRelativePath::parse("SOUL.md").unwrap())
                .unwrap_err(),
            SealedResourceError::NotFound
        );

        fs::write(
            reviewer_workspace.join("AGENTS.md"),
            vec![b'x'; (MAX_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(has_plain_agent_source(&reviewer_workspace).unwrap());
        assert!(!store.is_using_sealed_source(&reviewer).unwrap());
        assert_eq!(
            store
                .export_plain_workspace_package(reviewer.clone(), "reviewer")
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        fs::remove_file(reviewer_workspace.join("AGENTS.md")).unwrap();
        fs::create_dir(reviewer_workspace.join("AGENTS.md")).unwrap();
        assert_eq!(
            store.agents_using_sealed_source(&agent_keys).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert_eq!(
            store.is_using_sealed_source(&reviewer).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert_eq!(
            store
                .read_file(reviewer, PackageRelativePath::parse("AGENTS.md").unwrap())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
    }

    #[test]
    fn agents_using_sealed_source_reads_cloud_package_manifest_without_authorization_key() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("writer-workspace");
        fs::create_dir(&workspace).unwrap();
        runtime.add_agent_workspace("writer", workspace.clone());
        runtime.add_maintenance_workspace(workspace.clone());
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        let receipt = SealedAgentPackage::seal(
            AgentKey::parse("writer").unwrap(),
            SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", "writer instructions").unwrap()],
        )
        .unwrap();
        fs::write(
            workspace.join(receipt.package_file_name()),
            receipt.package_bytes(),
        )
        .unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "package-version".to_owned(),
            SealedCloudPackageType::Agent,
            receipt.package_sha256().to_owned(),
            receipt.package_file_name().to_owned(),
            1,
        )
        .unwrap();
        write_cloud_metadata_file(
            &store.cloud_metadata_path(receipt.package_sha256()),
            &metadata,
        )
        .unwrap();

        let sealed = store
            .agents_using_sealed_source(&[AgentKey::parse("writer").unwrap()])
            .unwrap();

        assert!(sealed.contains(&AgentKey::parse("writer").unwrap()));
    }

    #[test]
    fn expired_cloud_agent_can_be_located_replaced_and_removed_without_persisting_keys() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("writer-workspace");
        runtime.add_agent_workspace("writer", workspace.clone());
        runtime.add_maintenance_workspace(workspace.clone());
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        let key = AgentKey::parse("writer").unwrap();
        let receipt = SealedAgentPackage::seal(
            key.clone(),
            SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", "old cloud instructions").unwrap()],
        )
        .unwrap();
        let path = root.path().join(receipt.package_file_name());
        fs::write(&path, receipt.package_bytes()).unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "version-1".into(),
            SealedCloudPackageType::Agent,
            receipt.package_sha256().into(),
            receipt.package_file_name().into(),
            1,
        )
        .unwrap();
        let expires = crate::api::now_millis() + 1_000;
        store
            .authorization_keyring
            .register_authorization_key(
                receipt.package_sha256().into(),
                receipt.authorization_key().clone(),
                expires,
            )
            .unwrap();
        store
            .prepare_install_with_cloud_metadata(path.clone(), metadata.clone())
            .unwrap();
        store
            .install_package_path_with_cloud_metadata(path, metadata.clone())
            .unwrap();
        assert!(
            !store
                .authorization_key_path(receipt.package_sha256())
                .exists()
        );
        let read_path = PackageRelativePath::parse("AGENTS.md").unwrap();
        assert!(store.read_file(key.clone(), read_path.clone()).is_ok());
        std::thread::sleep(std::time::Duration::from_millis(
            expires.saturating_sub(crate::api::now_millis()) + 1,
        ));
        assert_eq!(
            store.read_file(key.clone(), read_path.clone()).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(store.is_using_sealed_source(&key).unwrap());
        assert!(
            store
                .agents_using_sealed_source(&[key.clone()])
                .unwrap()
                .contains(&key)
        );
        assert_eq!(store.catalog().unwrap().entries().len(), 1);
        assert_eq!(store.cloud_packages().unwrap(), vec![metadata.into()]);

        let replacement = SealedAgentPackage::seal(
            key.clone(),
            SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", "new cloud instructions").unwrap()],
        )
        .unwrap();
        let path = root.path().join(replacement.package_file_name());
        fs::write(&path, replacement.package_bytes()).unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "version-2".into(),
            SealedCloudPackageType::Agent,
            replacement.package_sha256().into(),
            replacement.package_file_name().into(),
            2,
        )
        .unwrap();
        store
            .authorization_keyring
            .register_authorization_key(
                replacement.package_sha256().into(),
                replacement.authorization_key().clone(),
                crate::api::now_millis() + 60_000,
            )
            .unwrap();
        store
            .install_package_path_with_cloud_metadata(path, metadata.clone())
            .unwrap();
        assert_eq!(sealed_packages(&workspace).len(), 1);
        assert!(!store.cloud_metadata_path(receipt.package_sha256()).exists());
        assert!(
            !store
                .authorization_key_path(replacement.package_sha256())
                .exists()
        );
        assert_eq!(
            store
                .read_file(key.clone(), read_path.clone())
                .unwrap()
                .content(),
            b"new cloud instructions"
        );
        store.authorization_keyring.clear().unwrap();
        assert_eq!(
            store.read_file(key.clone(), read_path).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(store.remove_package(key).unwrap());
        assert!(
            !store
                .cloud_metadata_path(replacement.package_sha256())
                .exists()
        );
        assert!(store.cloud_packages().unwrap().is_empty());
    }

    #[test]
    fn local_agent_removal_still_requires_payload_validation() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("writer-workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("AGENTS.md"), "local instructions").unwrap();
        runtime.add_agent_workspace("writer", workspace.clone());
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        let key = AgentKey::parse("writer").unwrap();
        let export = store
            .export_plain_workspace_package(key.clone(), key.as_str())
            .unwrap();
        let package_path = workspace.join(export.file_name());
        let hash = hex_digest(export.package_bytes());
        fs::write(store.authorization_key_path(&hash), [0_u8; 32]).unwrap();
        assert_eq!(
            store.remove_package(key).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(package_path.exists());
    }

    #[test]
    fn agents_using_sealed_source_skips_package_without_local_or_cloud_authorization() {
        let root = tempfile::tempdir().unwrap();
        let runtime = FakeAgentRuntime::new();
        let workspace = root.path().join("writer-workspace");
        fs::create_dir(&workspace).unwrap();
        runtime.add_agent_workspace("writer", workspace.clone());
        runtime.add_maintenance_workspace(workspace.clone());
        let store = SealedAgentStore::openclaw(runtime, root.path().join("private")).unwrap();
        let receipt = SealedAgentPackage::seal(
            AgentKey::parse("writer").unwrap(),
            SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", "writer instructions").unwrap()],
        )
        .unwrap();
        fs::write(
            workspace.join(receipt.package_file_name()),
            receipt.package_bytes(),
        )
        .unwrap();

        let sealed = store
            .agents_using_sealed_source(&[AgentKey::parse("writer").unwrap()])
            .unwrap();

        assert!(!sealed.contains(&AgentKey::parse("writer").unwrap()));
    }

    #[test]
    fn install_package_path_accepts_matching_existing_package() {
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
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap(), "writer")
            .unwrap();

        let package_path = root.path().join("input.matcha-agentpkg");
        fs::write(&package_path, package.package_bytes()).unwrap();
        let target_runtime = FakeAgentRuntime::new();
        let target_workspace = root.path().join("target-workspace");
        target_runtime.add_agent_workspace("writer", target_workspace.clone());
        let target = SealedAgentStore::openclaw(target_runtime, private).unwrap();
        target.install_package_path(package_path.clone()).unwrap();

        target.install_package_path(package_path.clone()).unwrap();

        let workspace = fs::canonicalize(target_workspace).unwrap();
        assert_eq!(sealed_packages(&workspace).len(), 1);
    }

    #[test]
    fn package_export_debug_redacts_package_bytes() {
        let export = SealedAgentPackageExport {
            agent_key: AgentKey::parse("writer").unwrap(),
            file_name: "sealed.matcha-agentpkg".to_owned(),
            package_sha256: "hash".to_owned(),
            package_bytes: Arc::from(&b"private bytes"[..]),
            exported_at_ms: 11,
        };

        let debug = format!("{export:?}");

        assert!(debug.contains("[REDACTED:13 bytes]"));
        assert!(!debug.contains("private bytes"));
    }

    #[test]
    fn install_package_path_preserves_existing_workspace_material() {
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
            .export_plain_workspace_package(AgentKey::parse("writer").unwrap(), "writer")
            .unwrap();

        let package_path = root.path().join("input.matcha-agentpkg");
        fs::write(&package_path, package.package_bytes()).unwrap();
        let target_runtime = FakeAgentRuntime::new();
        let target_workspace = root.path().join("target-workspace");
        fs::create_dir(&target_workspace).unwrap();
        fs::write(target_workspace.join("keep.txt"), "keep").unwrap();
        target_runtime.add_agent_workspace("writer", target_workspace.clone());
        let target = SealedAgentStore::openclaw(target_runtime, private).unwrap();

        target.install_package_path(package_path.clone()).unwrap();

        let workspace = fs::canonicalize(target_workspace).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("keep.txt")).unwrap(),
            "keep"
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
