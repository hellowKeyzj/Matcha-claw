use super::*;
use crate::native::{NativeReadError, NativeSealedDescriptor, NativeSealedFile, NativeSealedSkill};

impl SealedSkillStore {
    pub(crate) fn matcha_with_keyring(
        root: CanonicalStateDir,
        keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Result<Self, SealedResourceError> {
        let packages = CanonicalStateDir::provision(root.as_path().join("packages"))
            .map_err(|_| SealedResourceError::Rejected)?;
        let private = CanonicalStateDir::provision(root.as_path().join("private"))
            .map_err(|_| SealedResourceError::Rejected)?;
        let mut store = Self::new(
            SealedSkillRoot {
                target: SealedSkillTarget::MatchaAgent,
                skills_directory: packages.as_path().to_owned(),
            },
            private.as_path().to_owned(),
            keyring,
        )?;
        store.native_directories = Some([root, packages, private]);
        Ok(store)
    }

    pub(crate) fn export_installed_cloud_package(
        &self,
        key: SkillKey,
        public_key: &str,
        key_id: &str,
    ) -> Result<SealedSkillPackageExport, SealedResourceError> {
        let _guard = self.lock_operation()?;
        if self.root.target() != SealedSkillTarget::MatchaAgent {
            return Err(SealedResourceError::Rejected);
        }
        let (path, _) = self
            .find_sealed_package_locked(&key)?
            .ok_or(SealedResourceError::NotFound)?;
        let bytes = read_package_file(&path, SealedResourceError::NotFound)?;
        let manifest = SealedSkillPackage::open_manifest(&bytes)?;
        if manifest.target() != self.root.target() || manifest.skill_key() != &key {
            return Err(SealedResourceError::Rejected);
        }
        let authorization = self.read_authorization_key_for_package_bytes(&bytes)?;
        let package_bytes =
            SealedSkillPackage::with_cloud_envelope(&bytes, &authorization, public_key, key_id)?;
        Ok(SealedSkillPackageExport {
            entry: SealedSkillCatalogEntry {
                skill_key: key.clone(),
                target: self.root.target(),
                descriptor: manifest.descriptor().clone(),
            },
            file_name: super::super::export::skill_package_file_name(key.as_str()),
            package_sha256: hex_digest(&package_bytes),
            package_bytes,
            cleanup_failed: false,
        })
    }

    pub(crate) fn native_catalog(&self) -> Result<Vec<NativeSealedSkill>, NativeReadError> {
        let _guard = self.lock_operation()?;
        let catalog = self.catalog_locked()?;
        let mut skills = Vec::with_capacity(catalog.entries().len());
        for entry in catalog.entries() {
            let (path, _) = self
                .find_sealed_package_locked(entry.skill_key())?
                .ok_or(NativeReadError::Disabled)?;
            let bytes = read_package_file(&path, SealedResourceError::Unknown)?;
            let manifest = SealedSkillPackage::open_manifest(&bytes)?;
            if manifest.target() != SealedSkillTarget::MatchaAgent
                || manifest.skill_key() != entry.skill_key()
                || manifest.descriptor() != entry.descriptor()
            {
                return Err(NativeReadError::Disabled);
            }
            let files = SealedSkillPackage::native_manifest_files(&bytes)?;
            skills.push(NativeSealedSkill {
                skill_key: entry.skill_key().as_str().to_owned(),
                package_sha256: hex_digest(&bytes),
                descriptor: NativeSealedDescriptor {
                    name: entry.descriptor().name().to_owned(),
                    description: entry.descriptor().description().to_owned(),
                    user_invocable: entry.descriptor().user_invocable().unwrap_or(true),
                    disable_model_invocation: entry
                        .descriptor()
                        .disable_model_invocation()
                        .unwrap_or(false),
                },
                files: files
                    .into_iter()
                    .map(|file| NativeSealedFile {
                        path: file.path.as_str().to_owned(),
                        size_bytes: file.size_bytes,
                        sha256: file.sha256,
                    })
                    .collect(),
            });
        }
        Ok(skills)
    }

    pub(crate) fn native_read(
        &self,
        key: SkillKey,
        path: PackageRelativePath,
        expected_sha256: &str,
    ) -> Result<SealedResourceRead, NativeReadError> {
        let _guard = self.lock_operation()?;
        let catalog = self.catalog_locked()?;
        if !catalog
            .entries()
            .iter()
            .any(|entry| entry.skill_key() == &key)
        {
            return Err(
                if catalog
                    .issues()
                    .iter()
                    .any(|issue| issue.skill_key() == Some(&key))
                {
                    NativeReadError::Disabled
                } else {
                    NativeReadError::NotFound
                },
            );
        }
        let (package_path, _) = self
            .find_sealed_package_locked(&key)?
            .ok_or(NativeReadError::NotFound)?;
        let bytes = read_package_file(&package_path, SealedResourceError::Unknown)?;
        let sha256 = hex_digest(&bytes);
        if sha256 != expected_sha256 {
            return Err(NativeReadError::PackageChanged);
        }
        let manifest = SealedSkillPackage::open_manifest(&bytes)?;
        if manifest.target() != SealedSkillTarget::MatchaAgent || manifest.skill_key() != &key {
            return Err(NativeReadError::Disabled);
        }
        let files = SealedSkillPackage::native_manifest_files(&bytes)?;
        let expected = files
            .iter()
            .find(|file| file.path == path)
            .ok_or(NativeReadError::NotFound)?;
        // Cloud authorization is deliberately acquired again for every read, never cached in a catalog.
        let authorization = match self.read_authorization_key_for_package_bytes(&bytes) {
            Ok(key) => key,
            Err(SealedResourceError::Rejected | SealedResourceError::NotFound) => {
                return Err(NativeReadError::Unauthorized);
            }
            Err(error) => return Err(error.into()),
        };
        let package = SealedSkillPackage::open(&bytes, &authorization)?;
        let file = package.file(&path).ok_or(NativeReadError::NotFound)?;
        if file.content().len() as u64 != expected.size_bytes
            || hex_digest(file.content()) != expected.sha256
        {
            return Err(NativeReadError::Disabled);
        }
        Ok(SealedResourceRead::new(
            file.content().to_vec(),
            Some(SealedResourceMeteringBinding::skill(
                SealedSkillTarget::MatchaAgent,
                key.as_str(),
                &sha256,
            )?),
            sha256,
        ))
    }
}
