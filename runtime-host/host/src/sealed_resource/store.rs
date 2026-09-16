use std::{
    collections::BTreeSet,
    fmt, fs,
    fs::{File, OpenOptions},
    io::{self, Read as _, Write as _},
    path::{Path, PathBuf},
    sync::Mutex,
};

use getrandom::fill as random_fill;
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use zeroize::Zeroize;

use super::{
    PackageRelativePath, SealedResourceError, SealedResourceMeteringBinding,
    SealedResourceMeteringKind, SealedResourceMeteringUse, SealedResourceRead,
    SealedSkillDescriptor, SealedSkillTarget, SkillKey,
    package::{SealSkillPackageReceipt, SealedSkillFileRequest, SealedSkillPackage},
};

const SEALED_SKILL_PACKAGE_EXTENSION: &str = "matcha-skillpkg";
const KEY_BYTES: usize = 32;
const KEY_FILE: &str = "sealed-skill.key";
const MAX_DIRECTORY_DEPTH: usize = 8;
const MAX_DIRECTORY_FILES: usize = 64;
const MAX_FILE_BYTES: u64 = 48 * 1024;
const MAX_TOTAL_BYTES: u64 = 48 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 256 * 1024;

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
pub(crate) struct SealedSkillCatalog {
    entries: Vec<SealedSkillCatalogEntry>,
}

impl SealedSkillCatalog {
    pub fn entries(&self) -> &[SealedSkillCatalogEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedSkillCatalogEntry {
    skill_key: SkillKey,
    target: SealedSkillTarget,
    descriptor: SealedSkillDescriptor,
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

pub(crate) struct SealedSkillStore {
    root: SealedSkillRoot,
    private_directory: PathBuf,
    key_path: PathBuf,
    operation_lock: Mutex<()>,
}

impl SealedSkillStore {
    fn new(root: SealedSkillRoot, private_directory: PathBuf) -> Result<Self, SealedResourceError> {
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
        Self::new(SealedSkillRoot::openclaw(state_dir), private_root)
    }

    pub fn catalog(&self) -> Result<SealedSkillCatalog, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        self.catalog_locked()
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
        ))
    }

    pub fn export_plain_directory_package(
        &self,
        skill_key: SkillKey,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let root = ensure_skills_directory(self.root.skills_directory())?;
        let Some(directory_name) = skill_key.safe_directory_component() else {
            return Err(SealedResourceError::NotFound);
        };
        let directory = root.join(directory_name);
        let files = collect_plain_directory(&directory)?;
        let mut key = self.read_or_create_key()?;
        let receipt = SealedSkillPackage::seal(skill_key.clone(), self.root.target(), files, &key)?;
        let package = SealedSkillPackage::open(receipt.package_bytes(), &key);
        key.zeroize();
        let package = package?;
        let installed_path = self.install_receipt_locked(&receipt)?;
        self.remove_other_packages_locked(&skill_key, &installed_path)?;
        Ok(SealedSkillCatalogEntry {
            skill_key,
            target: package.target(),
            descriptor: package.descriptor().clone(),
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
        if !package_path.is_absolute() || !is_sealed_package_path(&package_path) {
            return Err(SealedResourceError::Rejected);
        }
        let bytes = read_package_file(&package_path, SealedResourceError::NotFound)?;
        let mut key = self.read_key()?;
        let package = SealedSkillPackage::open(&bytes, &key);
        key.zeroize();
        let package = package?;
        if package.target() != self.root.target() {
            return Err(SealedResourceError::Rejected);
        }
        if self
            .find_sealed_package_locked(package.skill_key())?
            .is_some()
        {
            return Err(SealedResourceError::AlreadyExists);
        }
        let receipt = SealSkillPackageReceipt::from_package_bytes(bytes);
        self.install_receipt_locked(&receipt)?;
        Ok(SealedSkillCatalogEntry {
            skill_key: package.skill_key().clone(),
            target: package.target(),
            descriptor: package.descriptor().clone(),
        })
    }

    pub fn remove_package(&self, skill_key: SkillKey) -> Result<bool, SealedResourceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        let Some((path, _)) = self.find_sealed_package_locked(&skill_key)? else {
            return Ok(false);
        };
        fs::remove_file(path).map_err(|_| SealedResourceError::Unknown)?;
        Ok(true)
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
        self.find_sealed_package_locked(skill_key)?
            .map(|(_, package)| package)
            .ok_or(SealedResourceError::NotFound)
    }

    fn install_receipt_locked(
        &self,
        package: &SealSkillPackageReceipt,
    ) -> Result<PathBuf, SealedResourceError> {
        let root = ensure_skills_directory(self.root.skills_directory())?;
        let path = root.join(package.package_file_name());
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(SealedResourceError::AlreadyExists),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(SealedResourceError::Unknown),
        }
        let staging = root.join(format!(".{}.tmp", package.package_file_name()));
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

    fn find_sealed_package_locked(
        &self,
        skill_key: &SkillKey,
    ) -> Result<Option<(PathBuf, SealedSkillPackage)>, SealedResourceError> {
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
            let package = self.open_package_path_locked(&path)?;
            if package.target() == self.root.target() && package.skill_key() == skill_key {
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
    ) -> Result<Option<SealedSkillCatalogEntry>, SealedResourceError> {
        let package = self.open_package_path_locked(path)?;
        if package.target() != self.root.target() {
            return Ok(None);
        }
        Ok(Some(SealedSkillCatalogEntry {
            skill_key: package.skill_key().clone(),
            target: package.target(),
            descriptor: package.descriptor().clone(),
        }))
    }

    fn open_package_path_locked(
        &self,
        path: &Path,
    ) -> Result<SealedSkillPackage, SealedResourceError> {
        let bytes = read_package_file(path, SealedResourceError::Unknown)?;
        let mut key = self.read_key()?;
        let package = SealedSkillPackage::open(&bytes, &key);
        key.zeroize();
        package
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
            let package = self.open_package_path_locked(&path)?;
            if package.target() == self.root.target() && package.skill_key() == skill_key {
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

impl fmt::Debug for SealedSkillStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillStore")
            .field("root", &self.root)
            .field("private_directory", &"[REDACTED]")
            .finish()
    }
}

fn collect_plain_directory(
    directory: &Path,
) -> Result<Vec<SealedSkillFileRequest>, SealedResourceError> {
    let directory = fs::canonicalize(directory).map_err(|_| SealedResourceError::NotFound)?;
    if !directory.is_dir() {
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
        return Err(SealedResourceError::Rejected);
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(current).map_err(|_| SealedResourceError::Unknown)? {
        let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| SealedResourceError::Unknown)?;
        if metadata.file_type().is_symlink() {
            return Err(SealedResourceError::Rejected);
        }
        let canonical = fs::canonicalize(&path).map_err(|_| SealedResourceError::Unknown)?;
        if !contained(root, &canonical) {
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
        if !metadata.is_file()
            || metadata.len() > MAX_FILE_BYTES
            || files.len() >= MAX_DIRECTORY_FILES
        {
            return Err(SealedResourceError::Rejected);
        }
        *total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or(SealedResourceError::Rejected)?;
        if *total_bytes > MAX_TOTAL_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        let relative_path = canonical
            .strip_prefix(root)
            .map_err(|_| SealedResourceError::Rejected)?
            .to_string_lossy()
            .replace('\\', "/");
        let content = read_limited_file(&canonical, metadata.len(), MAX_FILE_BYTES)?;
        files.push(SealedSkillFileRequest::try_new(relative_path, content)?);
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

fn decode_fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N], SealedResourceError> {
    bytes.try_into().map_err(|_| SealedResourceError::Rejected)
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
