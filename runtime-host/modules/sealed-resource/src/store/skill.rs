use std::{
    collections::BTreeSet,
    fmt, fs,
    fs::{File, OpenOptions},
    io::{self, Read as _, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use platform::state_dir::CanonicalStateDir;

use crate::{
    api::{
        SealedCloudPackageEntry, SealedCloudPackageMetadata, SealedCloudPackageType,
        SealedPackageAuthorizationKey, SealedPackageAuthorizationKeyring, SealedResourceError,
        SealedResourceMeteringBinding, SealedResourceMeteringKind, SealedResourceMeteringUse,
        SealedResourceRead, SealedResourceRejectionDetail, SealedSkillTarget,
    },
    descriptor::SealedSkillDescriptor,
    domain::{PackageRelativePath, SkillKey},
    package::{
        common::hex_digest,
        skill::{SealSkillPackageReceipt, SealedSkillFileRequest, SealedSkillPackage},
    },
};

const SEALED_SKILL_PACKAGE_EXTENSION: &str = "matcha-skillpkg";
const AUTHORIZATION_KEY_EXTENSION: &str = "authorization-key";
const CLOUD_METADATA_EXTENSION: &str = "cloud-metadata.json";
const MAX_DIRECTORY_DEPTH: usize = 8;
const MAX_DIRECTORY_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Eq, PartialEq)]
struct SealedSkillRoot {
    target: SealedSkillTarget,
    skills_directory: PathBuf,
}

impl SealedSkillRoot {
    fn openclaw(state_dir: CanonicalStateDir) -> Self {
        Self {
            target: SealedSkillTarget::OpenClaw,
            skills_directory: state_dir.as_path().join("skills"),
        }
    }

    fn target(&self) -> SealedSkillTarget {
        self.target
    }

    fn skills_directory(&self) -> &Path {
        &self.skills_directory
    }
}

impl fmt::Debug for SealedSkillRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillRoot")
            .field("target", &self.target)
            .field("skills_directory", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillCatalog {
    entries: Vec<SealedSkillCatalogEntry>,
}

impl SealedSkillCatalog {
    pub fn entries(&self) -> &[SealedSkillCatalogEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillCatalogEntry {
    skill_key: SkillKey,
    target: SealedSkillTarget,
    descriptor: SealedSkillDescriptor,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedSkillPackageExport {
    entry: SealedSkillCatalogEntry,
    file_name: String,
    package_sha256: String,
    package_bytes: Vec<u8>,
}

impl SealedSkillCatalogEntry {
    pub fn skill_key(&self) -> &SkillKey {
        &self.skill_key
    }

    pub fn runtime_target(&self) -> SealedSkillTarget {
        self.target
    }

    pub fn descriptor(&self) -> &SealedSkillDescriptor {
        &self.descriptor
    }
}

impl SealedSkillPackageExport {
    pub fn entry(&self) -> &SealedSkillCatalogEntry {
        &self.entry
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub fn into_package_bytes(self) -> Vec<u8> {
        self.package_bytes
    }
}

impl fmt::Debug for SealedSkillPackageExport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillPackageExport")
            .field("entry", &self.entry)
            .field("file_name", &self.file_name)
            .field("package_sha256", &self.package_sha256)
            .field(
                "package_bytes",
                &format_args!("[REDACTED:{} bytes]", self.package_bytes.len()),
            )
            .finish()
    }
}

pub struct SealedSkillStore {
    root: SealedSkillRoot,
    private_directory: PathBuf,
    authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    operation_lock: Mutex<()>,
}

impl SealedSkillStore {
    fn new(
        root: SealedSkillRoot,
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
            operation_lock: Mutex::new(()),
        })
    }

    pub fn openclaw(
        state_dir: CanonicalStateDir,
        private_root: PathBuf,
    ) -> Result<Self, SealedResourceError> {
        Self::openclaw_with_keyring(
            state_dir,
            private_root,
            Arc::new(SealedPackageAuthorizationKeyring::new()),
        )
    }

    pub(crate) fn openclaw_with_keyring(
        state_dir: CanonicalStateDir,
        private_root: PathBuf,
        authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Result<Self, SealedResourceError> {
        Self::new(
            SealedSkillRoot::openclaw(state_dir),
            private_root,
            authorization_keyring,
        )
    }

    pub fn catalog(&self) -> Result<SealedSkillCatalog, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.catalog_locked()
    }

    pub(crate) fn cloud_packages(
        &self,
    ) -> Result<Vec<SealedCloudPackageEntry>, SealedResourceError> {
        let started = Instant::now();
        eprintln!(
            "[startup-trace] source=sealed-resource phase=cloud-package-scan stage=start kind=skill"
        );
        let mut lock_wait_ms = 0;
        let mut package_count = 0usize;
        let mut total_bytes = 0u64;
        let result = (|| {
            let lock_started = Instant::now();
            let guard = self.operation_lock.lock();
            lock_wait_ms = lock_started.elapsed().as_millis();
            let _guard = guard.map_err(|_| SealedResourceError::Unknown)?;
            let Some(root) = existing_skills_directory(self.root.skills_directory())? else {
                return Ok(Vec::new());
            };
            let mut packages = Vec::new();
            for entry in fs::read_dir(root).map_err(|_| SealedResourceError::Unknown)? {
                let path = entry.map_err(|_| SealedResourceError::Unknown)?.path();
                if !sealed_package_file(&path)? {
                    continue;
                }
                let bytes = read_package_file(&path, SealedResourceError::Unknown)?;
                package_count += 1;
                total_bytes += bytes.len() as u64;
                let package_sha256 = hex_digest(&bytes);
                let Some(metadata) = self.cloud_metadata(&package_sha256)? else {
                    continue;
                };
                metadata.ensure_matches(SealedCloudPackageType::Skill, &package_sha256)?;
                if SealedSkillPackage::open_manifest(&bytes)?.target() == self.root.target() {
                    packages.push(metadata.into());
                }
            }
            Ok(packages)
        })();
        eprintln!(
            "[startup-trace] source=sealed-resource phase=cloud-package-scan stage=end kind=skill duration_ms={} lock_wait_ms={lock_wait_ms} package_count={package_count} total_bytes={total_bytes} outcome={}",
            started.elapsed().as_millis(),
            if result.is_ok() { "success" } else { "failed" }
        );
        result
    }

    pub fn read_file(
        &self,
        skill_key: SkillKey,
        path: PackageRelativePath,
    ) -> Result<SealedResourceRead, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let package = self.open_sealed_skill_locked(&skill_key)?;
        let file = package.file(&path).ok_or(SealedResourceError::NotFound)?;
        Ok(SealedResourceRead::new(
            file.content().to_vec(),
            Some(SealedResourceMeteringBinding::openclaw(
                SealedResourceMeteringKind::Skill,
                skill_key.as_str(),
                package.package_sha256(),
                SealedResourceMeteringUse::Turn,
            )?),
            package.package_sha256().to_owned(),
        ))
    }

    pub fn export_plain_directory_package(
        &self,
        skill_key: SkillKey,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        self.export_directory_package(skill_key, None, None)
            .map(|export| export.entry)
    }

    pub fn export_cloud_directory_package(
        &self,
        skill_key: SkillKey,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<SealedSkillPackageExport, SealedResourceError> {
        self.export_directory_package(
            skill_key,
            Some(cloud_public_key.as_str()),
            Some(cloud_key_id.as_str()),
        )
    }

    fn export_directory_package(
        &self,
        skill_key: SkillKey,
        cloud_public_key: Option<&str>,
        cloud_key_id: Option<&str>,
    ) -> Result<SealedSkillPackageExport, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        eprintln!(
            "[startup-trace] source=sealed-skills-export phase=store detail=start skillKey={}",
            skill_key.as_str()
        );
        let root = match ensure_skills_directory(self.root.skills_directory()) {
            Ok(root) => root,
            Err(error) => {
                trace_export_error("skills-dir", &skill_key, error);
                return Err(error);
            }
        };
        let Some(directory_name) = skill_key.safe_directory_component() else {
            trace_export_error("directory-key", &skill_key, SealedResourceError::NotFound);
            return Err(SealedResourceError::NotFound);
        };
        let directory = root.join(directory_name);
        let files = match collect_plain_directory(&directory) {
            Ok(files) => files,
            Err(error) => {
                trace_export_error("collect", &skill_key, error);
                return Err(error);
            }
        };
        eprintln!(
            "[startup-trace] source=sealed-skills-export phase=store detail=collected skillKey={} files={}",
            skill_key.as_str(),
            files.len()
        );
        let receipt = match SealedSkillPackage::seal_with_cloud_key(
            skill_key.clone(),
            self.root.target(),
            files,
            cloud_public_key,
            cloud_key_id,
        ) {
            Ok(receipt) => receipt,
            Err(error) => {
                trace_export_error("seal", &skill_key, error);
                return Err(error);
            }
        };
        let package =
            SealedSkillPackage::open(receipt.package_bytes(), receipt.authorization_key());
        let package = match package {
            Ok(package) => package,
            Err(error) => {
                trace_export_error("open", &skill_key, error);
                return Err(error);
            }
        };
        let file_name = super::export::package_file_name(
            &root,
            package.descriptor().name(),
            SEALED_SKILL_PACKAGE_EXTENSION,
        )?;
        let installed_path = match self.install_receipt_locked(&receipt, &file_name) {
            Ok(path) => path,
            Err(error) => {
                trace_export_error("install", &skill_key, error);
                return Err(error);
            }
        };
        if let Err(error) = self.remove_other_packages_locked(&skill_key, &installed_path) {
            trace_export_error("cleanup", &skill_key, error);
            return Err(error);
        }
        eprintln!(
            "[startup-trace] source=sealed-skills-export phase=store detail=accepted skillKey={}",
            skill_key.as_str()
        );
        Ok(SealedSkillPackageExport {
            entry: SealedSkillCatalogEntry {
                skill_key,
                target: package.target(),
                descriptor: package.descriptor().clone(),
            },
            file_name,
            package_sha256: receipt.package_sha256().to_owned(),
            package_bytes: receipt.into_package_bytes(),
        })
    }

    pub fn install_package_path(
        &self,
        package_path: PathBuf,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let bytes = read_install_package(&package_path)?;
        let authorization_key = self.read_authorization_key_for_package_bytes(&bytes)?;
        self.install_package_bytes_locked(bytes, authorization_key)
    }

    pub fn install_package_path_with_authorization_key(
        &self,
        package_path: PathBuf,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let bytes = read_install_package(&package_path)?;
        self.install_package_bytes_locked(bytes, authorization_key)
    }

    pub fn install_package_path_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let bytes = read_install_package(&package_path)?;
        let package_sha256 = hex_digest(&bytes);
        metadata.ensure_matches(SealedCloudPackageType::Skill, &package_sha256)?;
        let authorization_key = self.cloud_authorization_key(&package_sha256)?;
        self.install_cloud_package_bytes_locked(bytes, authorization_key, metadata)
    }

    pub fn remove_package(&self, skill_key: SkillKey) -> Result<bool, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let Some((path, package_sha256)) = self.find_sealed_package_locked(&skill_key)? else {
            return Ok(false);
        };
        self.remove_package_path_locked(&path, &package_sha256)?;
        Ok(true)
    }

    fn install_package_bytes_locked(
        &self,
        bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let receipt = SealSkillPackageReceipt::from_package_bytes(bytes, authorization_key);
        self.install_package_receipt_locked(receipt, None)
    }

    fn install_cloud_package_bytes_locked(
        &self,
        bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let receipt = SealSkillPackageReceipt::from_package_bytes(bytes, authorization_key);
        self.install_package_receipt_locked(receipt, Some(metadata))
    }

    fn install_package_receipt_locked(
        &self,
        receipt: SealSkillPackageReceipt,
        metadata: Option<SealedCloudPackageMetadata>,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let package =
            SealedSkillPackage::open(receipt.package_bytes(), receipt.authorization_key())?;
        if package.target() != self.root.target() {
            return Err(SealedResourceError::Rejected);
        }
        if self
            .find_sealed_package_locked(package.skill_key())?
            .is_some()
        {
            return Err(SealedResourceError::AlreadyExists);
        }
        match metadata.as_ref() {
            Some(metadata) => {
                metadata.ensure_matches(SealedCloudPackageType::Skill, receipt.package_sha256())?;
                self.install_cloud_receipt_locked(&receipt, metadata)?;
            }
            None => {
                self.install_receipt_locked(&receipt, receipt.package_file_name())?;
            }
        }
        Ok(SealedSkillCatalogEntry {
            skill_key: package.skill_key().clone(),
            target: package.target(),
            descriptor: package.descriptor().clone(),
        })
    }

    fn catalog_locked(&self) -> Result<SealedSkillCatalog, SealedResourceError> {
        let Some(root) = existing_skills_directory(self.root.skills_directory())? else {
            return Ok(SealedSkillCatalog { entries: vec![] });
        };
        let mut entries = Vec::new();
        for entry in fs::read_dir(root).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            if !sealed_package_file(&path)? {
                continue;
            }
            if let Some(entry) = self.catalog_sealed_package_locked(&path)? {
                entries.push(entry);
            }
        }
        entries.sort_by(|left, right| left.skill_key.cmp(&right.skill_key));
        let mut keys = BTreeSet::new();
        if entries
            .iter()
            .any(|entry| !keys.insert(entry.skill_key.as_str().to_owned()))
        {
            return Err(SealedResourceError::Rejected);
        }
        Ok(SealedSkillCatalog { entries })
    }

    fn open_sealed_skill_locked(
        &self,
        skill_key: &SkillKey,
    ) -> Result<SealedSkillPackage, SealedResourceError> {
        let (path, _) = self
            .find_sealed_package_locked(skill_key)?
            .ok_or(SealedResourceError::NotFound)?;
        self.open_package_path_locked(&path)
    }

    fn install_receipt_locked(
        &self,
        package: &SealSkillPackageReceipt,
        file_name: &str,
    ) -> Result<PathBuf, SealedResourceError> {
        let root = ensure_skills_directory(self.root.skills_directory())?;
        let path = root.join(file_name);
        ensure_missing(&path)?;
        let staging = root.join(format!(".{}.tmp", package.package_file_name()));
        let key_path = self.authorization_key_path(package.package_sha256());
        let key_staging = self.authorization_key_staging_path(package.package_sha256());
        let result = (|| {
            write_private_file(&key_staging, package.authorization_key().as_bytes())?;
            write_private_file(&staging, package.package_bytes())?;
            fs::rename(&key_staging, &key_path).map_err(|_| SealedResourceError::Unknown)?;
            fs::rename(&staging, &path).map_err(|_| SealedResourceError::Unknown)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
            let _ = fs::remove_file(&key_staging);
            let _ = fs::remove_file(&key_path);
        }
        result.map(|_| path)
    }

    fn install_cloud_receipt_locked(
        &self,
        package: &SealSkillPackageReceipt,
        metadata: &SealedCloudPackageMetadata,
    ) -> Result<PathBuf, SealedResourceError> {
        let root = ensure_skills_directory(self.root.skills_directory())?;
        let path = root.join(package.package_file_name());
        ensure_missing(&path)?;
        let staging = root.join(format!(".{}.tmp", package.package_file_name()));
        let metadata_path = self.cloud_metadata_path(package.package_sha256());
        let metadata_staging = self.cloud_metadata_staging_path(package.package_sha256());
        let key_path = self.authorization_key_path(package.package_sha256());
        let result = (|| {
            write_cloud_metadata_file(&metadata_staging, metadata)?;
            write_private_file(&staging, package.package_bytes())?;
            fs::rename(&metadata_staging, &metadata_path)
                .map_err(|_| SealedResourceError::Unknown)?;
            remove_authorization_key_file(&key_path)?;
            fs::rename(&staging, &path).map_err(|_| SealedResourceError::Unknown)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
            let _ = fs::remove_file(&metadata_staging);
            let _ = fs::remove_file(&metadata_path);
        }
        result.map(|_| path)
    }

    fn find_sealed_package_locked(
        &self,
        skill_key: &SkillKey,
    ) -> Result<Option<(PathBuf, String)>, SealedResourceError> {
        let Some(root) = existing_skills_directory(self.root.skills_directory())? else {
            return Ok(None);
        };
        let mut found = None;
        for entry in fs::read_dir(root).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            if !sealed_package_file(&path)? {
                continue;
            }
            let (key, target, package_sha256) = self.package_identity_path_locked(&path)?;
            if target == self.root.target() && &key == skill_key {
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
    ) -> Result<Option<SealedSkillCatalogEntry>, SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        if let Some(metadata) = self.cloud_metadata(&package_sha256)? {
            metadata.ensure_matches(SealedCloudPackageType::Skill, &package_sha256)?;
            let manifest = SealedSkillPackage::open_manifest(&bytes)?;
            if manifest.target() != self.root.target() {
                return Ok(None);
            }
            return Ok(Some(SealedSkillCatalogEntry {
                skill_key: manifest.skill_key().clone(),
                target: manifest.target(),
                descriptor: manifest.descriptor().clone(),
            }));
        }
        let Some(authorization_key) = self.catalog_local_authorization_key(&package_sha256)? else {
            return Ok(None);
        };
        let package = SealedSkillPackage::open(&bytes, &authorization_key)?;
        if package.target() != self.root.target() {
            return Ok(None);
        }
        Ok(Some(SealedSkillCatalogEntry {
            skill_key: package.skill_key().clone(),
            target: package.target(),
            descriptor: package.descriptor().clone(),
        }))
    }

    fn package_identity_path_locked(
        &self,
        path: &Path,
    ) -> Result<(SkillKey, SealedSkillTarget, String), SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let package_sha256 = hex_digest(&bytes);
        if let Some(metadata) = self.cloud_metadata(&package_sha256)? {
            metadata.ensure_matches(SealedCloudPackageType::Skill, &package_sha256)?;
            let manifest = SealedSkillPackage::open_manifest(&bytes)?;
            return Ok((
                manifest.skill_key().clone(),
                manifest.target(),
                package_sha256,
            ));
        }
        let authorization_key = self.read_authorization_key_for_package_bytes(&bytes)?;
        let package = SealedSkillPackage::open(&bytes, &authorization_key)?;
        Ok((
            package.skill_key().clone(),
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
        remove_authorization_key_file(&self.authorization_key_path(package_sha256))?;
        remove_authorization_key_file(&self.cloud_metadata_path(package_sha256))?;
        self.authorization_keyring.remove(package_sha256)
    }

    fn open_package_path_locked(
        &self,
        path: &Path,
    ) -> Result<SealedSkillPackage, SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let authorization_key = self.read_authorization_key_for_package_bytes(&bytes)?;
        SealedSkillPackage::open(&bytes, &authorization_key)
    }

    fn remove_other_packages_locked(
        &self,
        skill_key: &SkillKey,
        keep_path: &Path,
    ) -> Result<(), SealedResourceError> {
        let Some(root) = existing_skills_directory(self.root.skills_directory())? else {
            return Ok(());
        };
        for entry in fs::read_dir(root).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let path = entry.path();
            if path == keep_path || !sealed_package_file(&path)? {
                continue;
            }
            let (key, target, package_sha256) = self.package_identity_path_locked(&path)?;
            if target == self.root.target() && &key == skill_key {
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
            metadata.ensure_matches(SealedCloudPackageType::Skill, &package_sha256)?;
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

    fn authorization_key_staging_path(&self, package_sha256: &str) -> PathBuf {
        self.private_directory.join(format!(
            ".{package_sha256}.{AUTHORIZATION_KEY_EXTENSION}.tmp"
        ))
    }

    fn cloud_metadata_path(&self, package_sha256: &str) -> PathBuf {
        self.private_directory
            .join(format!("{package_sha256}.{CLOUD_METADATA_EXTENSION}"))
    }

    fn cloud_metadata_staging_path(&self, package_sha256: &str) -> PathBuf {
        self.private_directory
            .join(format!(".{package_sha256}.{CLOUD_METADATA_EXTENSION}.tmp"))
    }
}

impl fmt::Debug for SealedSkillStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillStore")
            .field("root", &self.root)
            .field("private_directory", &"[REDACTED]")
            .finish()
    }
}

fn trace_export_error(stage: &str, skill_key: &SkillKey, error: SealedResourceError) {
    eprintln!(
        "[startup-trace] source=sealed-skills-export phase=store detail={} outcome={} skillKey={}",
        stage,
        sealed_resource_error_detail(error),
        skill_key.as_str()
    );
}

fn trace_collect_error(
    reason: &str,
    depth: usize,
    files: usize,
    bytes: u64,
    error: SealedResourceError,
) {
    eprintln!(
        "[startup-trace] source=sealed-skills-export phase=collect detail={} outcome={} depth={} files={} bytes={}",
        reason,
        sealed_resource_error_detail(error),
        depth,
        files,
        bytes
    );
}

fn sealed_resource_error_detail(error: SealedResourceError) -> &'static str {
    match error {
        SealedResourceError::AlreadyExists => "already-exists",
        SealedResourceError::NotFound => "not-found",
        SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => "rejected",
        SealedResourceError::Unknown => "unknown",
    }
}

fn collect_plain_directory(
    directory: &Path,
) -> Result<Vec<SealedSkillFileRequest>, SealedResourceError> {
    let directory = match fs::canonicalize(directory) {
        Ok(directory) => directory,
        Err(_) => {
            trace_collect_error("canonicalize-root", 0, 0, 0, SealedResourceError::NotFound);
            return Err(SealedResourceError::NotFound);
        }
    };
    if !directory.is_dir() {
        trace_collect_error("root-not-directory", 0, 0, 0, SealedResourceError::NotFound);
        return Err(SealedResourceError::NotFound);
    }
    collect_plain_directory_at(&directory, &directory, 0, &mut 0)
}

fn collect_plain_directory_at(
    root: &Path,
    current: &Path,
    depth: usize,
    total_bytes: &mut u64,
) -> Result<Vec<SealedSkillFileRequest>, SealedResourceError> {
    if depth > MAX_DIRECTORY_DEPTH {
        trace_collect_error(
            "max-depth",
            depth,
            0,
            *total_bytes,
            SealedResourceError::Rejected,
        );
        return Err(SealedResourceError::Rejected);
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(current).map_err(|_| {
        trace_collect_error(
            "read-dir",
            depth,
            files.len(),
            *total_bytes,
            SealedResourceError::Unknown,
        );
        SealedResourceError::Unknown
    })? {
        let entry = entry.map_err(|_| {
            trace_collect_error(
                "dir-entry",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Unknown,
            );
            SealedResourceError::Unknown
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            trace_collect_error(
                "metadata",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Unknown,
            );
            SealedResourceError::Unknown
        })?;
        if metadata.file_type().is_symlink() {
            trace_collect_error(
                "symlink",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Rejected,
            );
            return Err(SealedResourceError::Rejected);
        }
        let canonical = fs::canonicalize(&path).map_err(|_| {
            trace_collect_error(
                "canonicalize-entry",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Unknown,
            );
            SealedResourceError::Unknown
        })?;
        if !contained(root, &canonical) {
            trace_collect_error(
                "outside-root",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Rejected,
            );
            return Err(SealedResourceError::Rejected);
        }
        if metadata.is_dir() {
            files.extend(collect_plain_directory_at(
                root,
                &canonical,
                depth + 1,
                total_bytes,
            )?);
            continue;
        }
        if !metadata.is_file() {
            trace_collect_error(
                "not-file",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Rejected,
            );
            return Err(SealedResourceError::Rejected);
        }
        if metadata.len() > MAX_FILE_BYTES {
            let error = SealedResourceError::rejected_with(SealedResourceRejectionDetail::bytes(
                "file-too-large",
                metadata.len(),
                MAX_FILE_BYTES,
            ));
            trace_collect_error("file-too-large", depth, files.len(), *total_bytes, error);
            return Err(error);
        }
        if files.len() >= MAX_DIRECTORY_FILES {
            let error = SealedResourceError::rejected_with(SealedResourceRejectionDetail::files(
                "too-many-files",
                files.len() + 1,
                MAX_DIRECTORY_FILES,
            ));
            trace_collect_error(
                "too-many-files",
                depth,
                files.len() + 1,
                *total_bytes,
                error,
            );
            return Err(error);
        }
        *total_bytes = match total_bytes.checked_add(metadata.len()) {
            Some(total) => total,
            None => {
                trace_collect_error(
                    "total-overflow",
                    depth,
                    files.len(),
                    *total_bytes,
                    SealedResourceError::Rejected,
                );
                return Err(SealedResourceError::Rejected);
            }
        };
        if *total_bytes > MAX_TOTAL_BYTES {
            trace_collect_error(
                "total-too-large",
                depth,
                files.len(),
                *total_bytes,
                SealedResourceError::Rejected,
            );
            return Err(SealedResourceError::Rejected);
        }
        let relative_path = match canonical.strip_prefix(root) {
            Ok(relative_path) => relative_path.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                trace_collect_error(
                    "relative-path",
                    depth,
                    files.len(),
                    *total_bytes,
                    SealedResourceError::Rejected,
                );
                return Err(SealedResourceError::Rejected);
            }
        };
        let content = match read_limited_file(&canonical, metadata.len(), MAX_FILE_BYTES) {
            Ok(content) => content,
            Err(error) => {
                trace_collect_error("read-file", depth, files.len(), *total_bytes, error);
                return Err(error);
            }
        };
        match SealedSkillFileRequest::try_new(relative_path, content) {
            Ok(file) => files.push(file),
            Err(error) => {
                trace_collect_error("file-request", depth, files.len(), *total_bytes, error);
                return Err(error);
            }
        }
    }
    files.sort_by(|left, right| left.path().cmp(right.path()));
    Ok(files)
}

fn existing_skills_directory(path: &Path) -> Result<Option<PathBuf>, SealedResourceError> {
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

fn ensure_skills_directory(path: &Path) -> Result<PathBuf, SealedResourceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(SealedResourceError::Rejected),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| SealedResourceError::Unknown)?;
        }
        Err(_) => return Err(SealedResourceError::Unknown),
    }
    fs::canonicalize(path).map_err(|_| SealedResourceError::Unknown)
}

fn contained(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root) && candidate != root
}

fn sealed_package_file(path: &Path) -> Result<bool, SealedResourceError> {
    if !is_sealed_package_path(path) {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| SealedResourceError::Unknown)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SealedResourceError::Rejected);
    }
    Ok(true)
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
        .is_some_and(|extension| extension == SEALED_SKILL_PACKAGE_EXTENSION)
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
    use std::{fs, io, path::Path};

    use super::*;

    #[test]
    fn catalog_skips_plain_skill_directory_links() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        let source = root.path().join("source-skill");
        fs::create_dir(&skills).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), skill_manifest("Linked Skill")).unwrap();
        if !create_dir_link(&source, &skills.join("linked-skill")).unwrap() {
            return;
        }
        let store = store(root.path());

        assert!(store.catalog().unwrap().entries().is_empty());
    }

    #[test]
    fn export_accepts_plain_skill_directory_link_root() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        let source = root.path().join("source-skill");
        fs::create_dir(&skills).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), skill_manifest("Linked Skill")).unwrap();
        if !create_dir_link(&source, &skills.join("linked-skill")).unwrap() {
            return;
        }
        let store = store(root.path());

        let entry = store
            .export_plain_directory_package(SkillKey::parse("linked-skill").unwrap())
            .unwrap();

        assert_eq!(entry.skill_key().as_str(), "linked-skill");
        assert_eq!(entry.descriptor().name(), "Linked Skill");
        assert_eq!(store.catalog().unwrap().entries().len(), 1);
    }

    #[test]
    fn read_file_returns_turn_metering_binding() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        let skill = skills.join("metered-skill");
        fs::create_dir(&skills).unwrap();
        fs::create_dir(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), skill_manifest("Metered Skill")).unwrap();
        let store = store(root.path());
        let skill_key = SkillKey::parse("metered-skill").unwrap();
        store
            .export_plain_directory_package(skill_key.clone())
            .unwrap();

        let read = store
            .read_file(skill_key, PackageRelativePath::skill_manifest())
            .unwrap();
        let binding = decode_binding(read.metering_binding().unwrap().as_str());

        assert_eq!(read.content(), skill_manifest("Metered Skill").as_bytes());
        assert_eq!(binding["kind"], "skill");
        assert_eq!(binding["runtime"], "openclaw");
        assert_eq!(binding["key"], "metered-skill");
        assert_eq!(binding["use"], "turn");
        assert_eq!(binding["packageSha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn catalog_reads_cloud_package_manifest_without_authorization_key() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        fs::create_dir(&skills).unwrap();
        let store = store(root.path());
        let receipt = SealedSkillPackage::seal(
            SkillKey::parse("cloud-skill").unwrap(),
            SealedSkillTarget::OpenClaw,
            vec![
                SealedSkillFileRequest::try_new("SKILL.md", skill_manifest("Cloud Skill")).unwrap(),
            ],
        )
        .unwrap();
        fs::write(
            skills.join(receipt.package_file_name()),
            receipt.package_bytes(),
        )
        .unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "package-version".to_owned(),
            SealedCloudPackageType::Skill,
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

        let catalog = store.catalog().unwrap();

        assert_eq!(catalog.entries().len(), 1);
        assert_eq!(catalog.entries()[0].skill_key().as_str(), "cloud-skill");
        assert_eq!(catalog.entries()[0].descriptor().name(), "Cloud Skill");
        assert_eq!(
            store
                .read_file(
                    SkillKey::parse("cloud-skill").unwrap(),
                    PackageRelativePath::skill_manifest()
                )
                .unwrap_err(),
            SealedResourceError::Rejected
        );
    }

    #[test]
    fn cloud_lease_expiry_blocks_reads_but_not_directory_uninstall_or_replacement() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let key = SkillKey::parse("cloud-skill").unwrap();
        let receipt = SealedSkillPackage::seal(
            key.clone(),
            SealedSkillTarget::OpenClaw,
            vec![
                SealedSkillFileRequest::try_new("SKILL.md", skill_manifest("Cloud Skill")).unwrap(),
            ],
        )
        .unwrap();
        let path = root.path().join(receipt.package_file_name());
        fs::write(&path, receipt.package_bytes()).unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "version-1".into(),
            SealedCloudPackageType::Skill,
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
            .install_package_path_with_cloud_metadata(path.clone(), metadata.clone())
            .unwrap();
        assert!(
            !store
                .authorization_key_path(receipt.package_sha256())
                .exists()
        );
        assert!(
            store
                .read_file(key.clone(), PackageRelativePath::skill_manifest())
                .is_ok()
        );
        std::thread::sleep(std::time::Duration::from_millis(
            expires.saturating_sub(crate::api::now_millis()) + 1,
        ));
        assert_eq!(
            store
                .read_file(key.clone(), PackageRelativePath::skill_manifest())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        assert_eq!(store.catalog().unwrap().entries().len(), 1);
        assert_eq!(
            store.cloud_packages().unwrap(),
            vec![metadata.clone().into()]
        );
        assert_eq!(
            store
                .install_package_path_with_authorization_key(
                    path.clone(),
                    receipt.authorization_key().clone()
                )
                .unwrap_err(),
            SealedResourceError::AlreadyExists
        );

        let plain = root.path().join("skills/cloud-skill");
        fs::create_dir(&plain).unwrap();
        fs::write(plain.join("SKILL.md"), skill_manifest("Replacement")).unwrap();
        store.export_plain_directory_package(key.clone()).unwrap();
        assert!(store.cloud_packages().unwrap().is_empty());
        assert!(!store.cloud_metadata_path(receipt.package_sha256()).exists());
        store.authorization_keyring.clear().unwrap();
        assert!(
            store
                .read_file(key.clone(), PackageRelativePath::skill_manifest())
                .is_ok()
        );
        assert!(store.remove_package(key.clone()).unwrap());

        store
            .authorization_keyring
            .register_authorization_key(
                receipt.package_sha256().into(),
                receipt.authorization_key().clone(),
                crate::api::now_millis() + 60_000,
            )
            .unwrap();
        store
            .install_package_path_with_cloud_metadata(path, metadata)
            .unwrap();
        store.authorization_keyring.clear().unwrap();
        assert_eq!(
            store
                .read_file(key.clone(), PackageRelativePath::skill_manifest())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(store.remove_package(key).unwrap());
        assert!(store.cloud_packages().unwrap().is_empty());
    }

    #[test]
    fn cloud_directory_and_removal_reject_unverified_metadata_or_manifest() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let receipt = SealedSkillPackage::seal(
            SkillKey::parse("cloud-skill").unwrap(),
            SealedSkillTarget::OpenClaw,
            vec![SealedSkillFileRequest::try_new("SKILL.md", skill_manifest("Cloud")).unwrap()],
        )
        .unwrap();
        let skills = root.path().join("skills");
        fs::create_dir(&skills).unwrap();
        fs::write(
            skills.join(receipt.package_file_name()),
            receipt.package_bytes(),
        )
        .unwrap();
        let metadata = SealedCloudPackageMetadata::new(
            "version".into(),
            SealedCloudPackageType::Skill,
            "a".repeat(64),
            receipt.package_file_name().into(),
            1,
        )
        .unwrap();
        let metadata_path = store.cloud_metadata_path(receipt.package_sha256());
        write_cloud_metadata_file(&metadata_path, &metadata).unwrap();
        assert_eq!(
            store.cloud_packages().unwrap_err(),
            SealedResourceError::Rejected
        );
        assert_eq!(
            store
                .remove_package(SkillKey::parse("cloud-skill").unwrap())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(skills.join(receipt.package_file_name()).exists());
        fs::remove_file(metadata_path).unwrap();
        fs::remove_file(skills.join(receipt.package_file_name())).unwrap();
        let bytes = b"invalid manifest";
        let hash = hex_digest(bytes);
        fs::write(skills.join("invalid.matcha-skillpkg"), bytes).unwrap();
        write_cloud_metadata_file(
            &store.cloud_metadata_path(&hash),
            &SealedCloudPackageMetadata::new(
                "version".into(),
                SealedCloudPackageType::Skill,
                hash,
                "invalid.matcha-skillpkg".into(),
                1,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.cloud_packages().unwrap_err(),
            SealedResourceError::Rejected
        );
        assert_eq!(
            store
                .remove_package(SkillKey::parse("cloud-skill").unwrap())
                .unwrap_err(),
            SealedResourceError::Rejected
        );
    }

    #[test]
    fn local_removal_still_requires_payload_validation() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let key = SkillKey::parse("local-skill").unwrap();
        let receipt = SealedSkillPackage::seal(
            key.clone(),
            SealedSkillTarget::OpenClaw,
            vec![SealedSkillFileRequest::try_new("SKILL.md", skill_manifest("Local")).unwrap()],
        )
        .unwrap();
        store
            .install_package_bytes_locked(
                receipt.package_bytes().to_vec(),
                receipt.authorization_key().clone(),
            )
            .unwrap();
        fs::write(
            store.authorization_key_path(receipt.package_sha256()),
            [0_u8; 32],
        )
        .unwrap();
        assert_eq!(
            store.remove_package(key).unwrap_err(),
            SealedResourceError::Rejected
        );
        assert!(
            root.path()
                .join("skills")
                .join(receipt.package_file_name())
                .exists()
        );
    }

    #[test]
    fn catalog_skips_package_without_local_or_cloud_authorization() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        fs::create_dir(&skills).unwrap();
        let receipt = SealedSkillPackage::seal(
            SkillKey::parse("orphan-skill").unwrap(),
            SealedSkillTarget::OpenClaw,
            vec![
                SealedSkillFileRequest::try_new("SKILL.md", skill_manifest("Orphan Skill"))
                    .unwrap(),
            ],
        )
        .unwrap();
        fs::write(
            skills.join(receipt.package_file_name()),
            receipt.package_bytes(),
        )
        .unwrap();
        let store = store(root.path());

        assert!(store.catalog().unwrap().entries().is_empty());
    }

    #[test]
    fn catalog_rejects_sealed_package_file_links() {
        let root = tempfile::tempdir().unwrap();
        let skills = root.path().join("skills");
        let target = root.path().join("target.matcha-skillpkg");
        fs::create_dir(&skills).unwrap();
        fs::write(&target, b"not a package").unwrap();
        if !create_file_link(&target, &skills.join("linked.matcha-skillpkg")).unwrap() {
            return;
        }
        let store = store(root.path());

        assert_eq!(store.catalog().unwrap_err(), SealedResourceError::Rejected);
    }

    fn store(root: &Path) -> SealedSkillStore {
        SealedSkillStore::new(
            SealedSkillRoot {
                target: SealedSkillTarget::OpenClaw,
                skills_directory: root.join("skills"),
            },
            root.join("private"),
            Arc::new(SealedPackageAuthorizationKeyring::new()),
        )
        .unwrap()
    }

    fn skill_manifest(name: &str) -> String {
        format!("---\nname: {name}\ndescription: Test skill\n---\n")
    }

    fn decode_binding(binding: &str) -> serde_json::Value {
        let payload = binding.strip_prefix("m1.").unwrap();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[cfg(unix)]
    fn create_dir_link(target: &Path, link: &Path) -> io::Result<bool> {
        std::os::unix::fs::symlink(target, link)?;
        Ok(true)
    }

    #[cfg(windows)]
    fn create_dir_link(target: &Path, link: &Path) -> io::Result<bool> {
        use std::process::{Command, Stdio};

        Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
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
}
