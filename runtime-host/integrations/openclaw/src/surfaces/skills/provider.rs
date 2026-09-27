use platform::state_dir::CanonicalStateDir;
use std::{
    fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use skills_module::{
    install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    management::{Command as SkillManagementCommand, Outcome as SkillManagementOutcome},
};
use tokio::sync::Mutex;

use super::{
    MissingSkillRequirementCategory, SkillConfigRemoveOutcome, SkillDetail, SkillDetailRequest,
    SkillMutationOutcome, SkillReadError, SkillStatusCatalog, SkillStatusCatalogError,
    SkillStatusEntry, SkillStatusSource, SkillUploadBegin, SkillUploadChunk, SkillUploadCommit,
    SkillUploadOutcome, bundle as native_bundle, readme as native_readme,
};
use crate::{port::OpenClawGateway, workspace::OpenClawWorkspaceAccess};

pub struct OpenClawSkillProvider {
    gateway: Arc<Mutex<OpenClawGateway>>,
    electron_image: PathBuf,
    working_directory: PathBuf,
    state_dir: CanonicalStateDir,
}

impl OpenClawSkillProvider {
    pub fn new(
        gateway: Arc<Mutex<OpenClawGateway>>,
        electron_image: PathBuf,
        working_directory: PathBuf,
        state_dir: CanonicalStateDir,
    ) -> Self {
        Self {
            gateway,
            electron_image,
            working_directory,
            state_dir,
        }
    }

    pub async fn installed_skill_catalog(&self) -> Option<super::InstalledSkillCatalog> {
        self.gateway.lock().await.installed_skill_catalog().await
    }

    pub async fn install_clawhub(&self, command: SkillInstallCommand) -> SkillInstallOutcome {
        let (slug, version, force) = command.into_parts();
        let request = match clawhub::ClawHubInstallRequest::try_new(slug, version, force) {
            Ok(request) => request,
            Err(_) => return SkillInstallOutcome::Rejected,
        };
        let slug = request.slug().to_owned();
        let version = request.version().map(str::to_owned);
        match self.install_clawhub_skill(request).await {
            Ok(()) => SkillInstallOutcome::accepted(slug, version),
            Err(()) => SkillInstallOutcome::Unknown,
        }
    }

    pub async fn status(&self) -> skills_module::status::Outcome {
        match self.skill_status_catalog().await {
            Ok(catalog) => {
                eprintln!(
                    "[startup-trace] source=skills-status phase=host detail=available entries={}",
                    catalog.entries().len()
                );
                skills_module::status::Outcome::Available(project_status(&catalog))
            }
            Err(error) => {
                eprintln!(
                    "[startup-trace] source=skills-status phase=host detail=unavailable error={:?}",
                    error
                );
                skills_module::status::Outcome::Unavailable
            }
        }
    }

    pub async fn manage<OpenPath, OpenPathFuture>(
        &self,
        command: SkillManagementCommand,
        open_path: OpenPath,
    ) -> SkillManagementOutcome
    where
        OpenPath: FnOnce(PathBuf) -> OpenPathFuture + Send,
        OpenPathFuture: Future<Output = bool> + Send,
    {
        match command {
            skills_module::management::Command::Detail { slug } => {
                let request = match SkillDetailRequest::try_new(slug) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Detail(
                    self.detail_skill(request)
                        .await
                        .map(project_detail)
                        .map_err(|error| match error {
                            SkillReadError::Unavailable => {
                                skills_module::management::ReadError::Unavailable
                            }
                            SkillReadError::Rejected => {
                                skills_module::management::ReadError::Rejected
                            }
                            SkillReadError::Protocol => {
                                skills_module::management::ReadError::Protocol
                            }
                        }),
                )
            }
            skills_module::management::Command::Config {
                skill_key,
                enabled,
                api_key,
                env,
            } => {
                let request =
                    match super::SkillUpdateRequest::config(skill_key, enabled, api_key, env) {
                        Ok(v) => v,
                        Err(_) => return SkillManagementOutcome::Rejected,
                    };
                SkillManagementOutcome::Mutation(map_mutation(self.update_skill(request).await))
            }
            skills_module::management::Command::ClawHubInstall {
                slug,
                version,
                force,
            } => {
                let request = match clawhub::ClawHubInstallRequest::try_new(slug, version, force) {
                    Ok(request) => request,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                let outcome = match self.install_clawhub_skill(request).await {
                    Ok(()) => skills_module::management::MutationOutcome::Accepted,
                    Err(()) => skills_module::management::MutationOutcome::Unknown,
                };
                SkillManagementOutcome::Mutation(outcome)
            }
            skills_module::management::Command::ClawHubUpdate { slug, all } => {
                let request = match super::SkillUpdateRequest::clawhub(slug, all) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Mutation(map_mutation(self.update_skill(request).await))
            }
            skills_module::management::Command::UploadBegin {
                slug,
                size,
                sha256,
                force,
                idempotency_key,
            } => {
                let request = match SkillUploadBegin::try_new(
                    slug,
                    size,
                    Some(sha256),
                    Some(force),
                    idempotency_key,
                ) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(self.begin_skill_upload(request).await))
            }
            skills_module::management::Command::UploadChunk {
                upload_id,
                offset,
                bytes,
            } => {
                let request = match SkillUploadChunk::try_new(upload_id, offset, bytes) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(self.chunk_skill_upload(request).await))
            }
            skills_module::management::Command::UploadCommit { upload_id, sha256 } => {
                let request = match SkillUploadCommit::try_new(upload_id, sha256) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(self.commit_skill_upload(request).await))
            }
            skills_module::management::Command::Uninstall { skill_key, slug } => {
                let (slugs, config_keys) = self.skill_uninstall_plan(&skill_key, slug).await;
                for slug in &slugs {
                    let Ok(request) = clawhub::ClawHubUninstallRequest::try_new(slug.clone())
                    else {
                        continue;
                    };
                    match self.uninstall_clawhub_skill(request).await {
                        clawhub::ClawHubUninstallOutcome::Removed => {
                            self.remove_skill_configs_best_effort(config_keys);
                            return SkillManagementOutcome::Uninstall(
                                skills_module::management::RemoveOutcome::Removed,
                            );
                        }
                        clawhub::ClawHubUninstallOutcome::Unknown => {
                            return SkillManagementOutcome::Uninstall(
                                skills_module::management::RemoveOutcome::Unknown,
                            );
                        }
                        clawhub::ClawHubUninstallOutcome::NotFound
                        | clawhub::ClawHubUninstallOutcome::Rejected => {}
                    }
                }
                let outcome = map_remove(self.skill_bundles().remove(skill_key.clone()));
                if outcome == skills_module::management::RemoveOutcome::Removed {
                    self.remove_skill_configs_best_effort(config_keys);
                    return SkillManagementOutcome::Uninstall(
                        skills_module::management::RemoveOutcome::Removed,
                    );
                }
                if outcome == skills_module::management::RemoveOutcome::Unknown {
                    return SkillManagementOutcome::Uninstall(outcome);
                }
                if let Some(base_dir) = self
                    .openclaw_managed_skill_base_dir(&skill_key, &slugs)
                    .await
                {
                    let outcome =
                        remove_openclaw_managed_skill_dir(self.state_dir.as_path(), &base_dir);
                    if outcome == skills_module::management::RemoveOutcome::Removed {
                        self.remove_skill_configs_best_effort(config_keys);
                        return SkillManagementOutcome::Uninstall(
                            skills_module::management::RemoveOutcome::Removed,
                        );
                    }
                    return SkillManagementOutcome::Uninstall(outcome);
                }
                SkillManagementOutcome::Uninstall(outcome)
            }
            skills_module::management::Command::ImportMarkdown { content } => {
                SkillManagementOutcome::Import(map_import(
                    self.skill_bundles().import_markdown(content),
                ))
            }
            skills_module::management::Command::ImportBundle { bundle } => {
                SkillManagementOutcome::Import(map_import(
                    self.skill_bundles().import(vec![to_native_bundle(bundle)]),
                ))
            }
            skills_module::management::Command::Readme {
                skill_key,
                slug,
                file_path,
                base_dir,
            } => {
                let request = match self
                    .readme_request(skill_key, slug, file_path, base_dir)
                    .await
                {
                    Ok(request) => request,
                    Err(error) => {
                        return SkillManagementOutcome::Readme(Err(map_readme_error(error)));
                    }
                };
                let workspace_roots = match self.workspace_roots() {
                    Ok(roots) => roots,
                    Err(_) => {
                        return SkillManagementOutcome::Readme(Err(
                            skills_module::management::ReadmeError::Unknown,
                        ));
                    }
                };
                SkillManagementOutcome::Readme(
                    self.skill_readme()
                        .read(request, &workspace_roots)
                        .map(project_readme_receipt)
                        .map_err(map_readme_error),
                )
            }
            skills_module::management::Command::OpenReadme {
                skill_key,
                slug,
                file_path,
                base_dir,
            } => {
                let request = match self
                    .readme_request(skill_key, slug, file_path, base_dir)
                    .await
                {
                    Ok(request) => request,
                    Err(error) => {
                        return SkillManagementOutcome::Readme(Err(map_readme_error(error)));
                    }
                };
                let workspace_roots = match self.workspace_roots() {
                    Ok(roots) => roots,
                    Err(_) => {
                        return SkillManagementOutcome::Readme(Err(
                            skills_module::management::ReadmeError::Unknown,
                        ));
                    }
                };
                let receipt = match self
                    .skill_readme()
                    .read_readme_target(request, &workspace_roots)
                {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        return SkillManagementOutcome::Readme(Err(map_readme_error(error)));
                    }
                };
                let path = PathBuf::from(receipt.file_path());
                if !open_path(path).await {
                    return SkillManagementOutcome::Readme(Err(
                        skills_module::management::ReadmeError::Unknown,
                    ));
                }
                SkillManagementOutcome::Readme(Ok(project_readme_receipt(receipt)))
            }
            skills_module::management::Command::OpenPath {
                skill_key,
                slug,
                file_path,
                base_dir,
            } => {
                let request = match self
                    .readme_request(skill_key, slug, file_path, base_dir)
                    .await
                {
                    Ok(request) => request,
                    Err(error) => {
                        return SkillManagementOutcome::OpenPath(Err(map_readme_error(error)));
                    }
                };
                let workspace_roots = match self.workspace_roots() {
                    Ok(roots) => roots,
                    Err(_) => {
                        return SkillManagementOutcome::OpenPath(Err(
                            skills_module::management::ReadmeError::Unknown,
                        ));
                    }
                };
                let path = match self
                    .skill_readme()
                    .resolve_directory(&request, &workspace_roots)
                {
                    Ok(path) => path,
                    Err(error) => {
                        return SkillManagementOutcome::OpenPath(Err(map_readme_error(error)));
                    }
                };
                if !open_path(path).await {
                    return SkillManagementOutcome::OpenPath(Err(
                        skills_module::management::ReadmeError::Unknown,
                    ));
                }
                SkillManagementOutcome::OpenPath(Ok(skills_module::management::OpenPathReceipt))
            }
        }
    }

    pub async fn bundles(
        &self,
        command: skills_module::bundle::Command,
    ) -> skills_module::bundle::Outcome {
        let store = self.skill_bundles();
        tokio::task::spawn_blocking(move || match command {
            skills_module::bundle::Command::Export { skill_keys } => store
                .export(skill_keys)
                .map(|bundles| {
                    skills_module::bundle::Outcome::Exported(
                        bundles.into_iter().map(from_native_bundle).collect(),
                    )
                })
                .map_err(map_bundle_error)
                .unwrap_or_else(|_| skills_module::bundle::Outcome::Unknown),
            skills_module::bundle::Command::Import { bundles } => {
                match store.import(bundles.into_iter().map(to_native_bundle).collect()) {
                    native_bundle::ImportOutcome::Accepted => {
                        skills_module::bundle::Outcome::Accepted
                    }
                    native_bundle::ImportOutcome::Rejected => {
                        skills_module::bundle::Outcome::Rejected
                    }
                    native_bundle::ImportOutcome::Unknown => {
                        skills_module::bundle::Outcome::Unknown
                    }
                }
            }
        })
        .await
        .unwrap_or(skills_module::bundle::Outcome::Unknown)
    }

    async fn skill_status_catalog(&self) -> Result<SkillStatusCatalog, SkillStatusCatalogError> {
        self.gateway.lock().await.skill_status_catalog().await
    }

    async fn detail_skill(
        &self,
        request: SkillDetailRequest,
    ) -> Result<SkillDetail, SkillReadError> {
        self.gateway.lock().await.detail_skill(request).await
    }

    async fn update_skill(&self, request: super::SkillUpdateRequest) -> SkillMutationOutcome {
        self.gateway.lock().await.update_skill(request).await
    }

    async fn remove_skill_config(&self, skill_key: String) -> SkillConfigRemoveOutcome {
        self.gateway
            .lock()
            .await
            .remove_skill_config(skill_key)
            .await
    }

    async fn begin_skill_upload(&self, request: SkillUploadBegin) -> SkillUploadOutcome {
        self.gateway.lock().await.begin_skill_upload(request).await
    }

    async fn chunk_skill_upload(&self, request: SkillUploadChunk) -> SkillUploadOutcome {
        self.gateway.lock().await.chunk_skill_upload(request).await
    }

    async fn commit_skill_upload(&self, request: SkillUploadCommit) -> SkillUploadOutcome {
        self.gateway.lock().await.commit_skill_upload(request).await
    }

    async fn install_clawhub_skill(
        &self,
        request: clawhub::ClawHubInstallRequest,
    ) -> Result<(), ()> {
        let registries = clawhub::ClawHubRegistryClient::new(self.state_dir.as_path().to_owned())
            .registry_bases()
            .to_vec();
        self.clawhub_installer(registries).install(request).await
    }

    async fn uninstall_clawhub_skill(
        &self,
        request: clawhub::ClawHubUninstallRequest,
    ) -> clawhub::ClawHubUninstallOutcome {
        self.clawhub_installer(Vec::new()).uninstall(request).await
    }

    fn clawhub_installer(&self, registries: Vec<String>) -> clawhub::ClawHubCliInstaller {
        clawhub::ClawHubCliInstaller::new(
            self.electron_image.clone(),
            self.state_dir.as_path().to_owned(),
            self.clawhub_cli_entries(),
            registries,
        )
    }

    fn clawhub_cli_entries(&self) -> Vec<PathBuf> {
        let mut entries = Vec::with_capacity(2);
        if let Some(entry) = std::env::var_os("MATCHACLAW_CLAWHUB_CLI_ENTRY") {
            if !entry.is_empty() {
                entries.push(PathBuf::from(entry));
            }
        }
        entries.push(
            self.working_directory
                .join("node_modules")
                .join("clawhub")
                .join("bin")
                .join("clawdhub.js"),
        );
        entries
    }

    fn skill_bundles(&self) -> native_bundle::SkillBundleStore {
        native_bundle::SkillBundleStore::new(self.state_dir.clone())
    }

    fn skill_readme(&self) -> native_readme::SkillReadmeStore {
        native_readme::SkillReadmeStore::new(self.state_dir.clone())
    }

    fn workspace_roots(
        &self,
    ) -> Result<Vec<crate::surfaces::workspace::TrustedWorkspaceDirectory>, ()> {
        OpenClawWorkspaceAccess::new(self.state_dir.clone())
            .maintenance_workspace_directories()
            .map_err(|_| ())
    }

    async fn readme_request(
        &self,
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<native_readme::SkillReadmeRequest, native_readme::SkillReadmeError> {
        if file_path.is_none() && base_dir.is_none() {
            let (file_path, base_dir) = match self.skill_status_catalog().await {
                Ok(catalog) => catalog.locator(&skill_key).map_or((None, None), |locator| {
                    (
                        locator.file_path().map(str::to_owned),
                        locator.base_dir().map(str::to_owned),
                    )
                }),
                Err(_) => (None, None),
            };
            return native_readme::SkillReadmeRequest::try_new(
                skill_key, slug, file_path, base_dir,
            );
        }
        native_readme::SkillReadmeRequest::try_new(skill_key, slug, file_path, base_dir)
    }

    async fn openclaw_managed_skill_base_dir(
        &self,
        skill_key: &str,
        slugs: &[String],
    ) -> Option<String> {
        let catalog = self.skill_status_catalog().await.ok()?;
        let entry = catalog.entries().iter().find(|entry| {
            entry.key() == skill_key
                || entry.slug().is_some_and(|slug| {
                    slug == skill_key || slugs.iter().any(|candidate| candidate.as_str() == slug)
                })
        })?;
        if !is_uninstallable_status_entry(entry) {
            return None;
        }
        catalog
            .locator(entry.key())
            .and_then(|locator| locator.base_dir())
            .map(str::to_owned)
    }

    async fn skill_uninstall_plan(
        &self,
        skill_key: &str,
        slug: Option<String>,
    ) -> (Vec<String>, Vec<String>) {
        let mut slugs = Vec::with_capacity(2);
        let mut config_keys = vec![skill_key.to_owned()];
        if let Some(slug) = slug {
            if config_keys.iter().all(|known| known != &slug) {
                config_keys.push(slug.clone());
            }
            slugs.push(slug);
        }
        if let Ok(request) = clawhub::ClawHubUninstallRequest::try_new(skill_key.to_owned()) {
            if slugs.iter().all(|known| known != request.slug()) {
                slugs.push(request.slug().to_owned());
            }
        }
        if let Ok(catalog) = self.skill_status_catalog().await {
            if let Some(entry) = catalog
                .entries()
                .iter()
                .find(|entry| entry.key() == skill_key || entry.slug() == Some(skill_key))
            {
                if config_keys.iter().all(|known| known != entry.key()) {
                    config_keys.push(entry.key().to_owned());
                }
                if let Some(slug) = entry.slug() {
                    if slugs.iter().all(|known| known != slug) {
                        slugs.push(slug.to_owned());
                    }
                    if config_keys.iter().all(|known| known != slug) {
                        config_keys.push(slug.to_owned());
                    }
                }
            }
        }
        (slugs, config_keys)
    }

    fn remove_skill_configs_best_effort(&self, skill_keys: Vec<String>) {
        let gateway = Arc::clone(&self.gateway);
        tokio::spawn(async move {
            for skill_key in skill_keys {
                let _ = gateway.lock().await.remove_skill_config(skill_key).await;
            }
        });
    }
}

fn is_uninstallable_status_entry(entry: &SkillStatusEntry) -> bool {
    matches!(entry.source(), Some(SkillStatusSource::OpenClawManaged))
        && entry.bundled() != Some(true)
}

fn status_entry_exists(entry: &SkillStatusEntry, catalog: &SkillStatusCatalog) -> bool {
    if !matches!(entry.source(), Some(SkillStatusSource::OpenClawManaged)) {
        return true;
    }
    catalog
        .locator(entry.key())
        .and_then(|locator| locator.base_dir())
        .is_some_and(|base_dir| Path::new(base_dir).is_dir())
}

fn remove_openclaw_managed_skill_dir(
    state_dir: &Path,
    base_dir: &str,
) -> skills_module::management::RemoveOutcome {
    let target = Path::new(base_dir);
    if !target.is_absolute() {
        return skills_module::management::RemoveOutcome::Rejected;
    }

    let root = match fs::canonicalize(state_dir.join("skills")) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return skills_module::management::RemoveOutcome::NotFound;
        }
        Err(_) => return skills_module::management::RemoveOutcome::Unknown,
    };
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return skills_module::management::RemoveOutcome::NotFound;
        }
        Err(_) => return skills_module::management::RemoveOutcome::Unknown,
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return skills_module::management::RemoveOutcome::Rejected;
    }
    let target = match fs::canonicalize(target) {
        Ok(target) => target,
        Err(_) => return skills_module::management::RemoveOutcome::Unknown,
    };
    if target.parent() != Some(root.as_path()) {
        return skills_module::management::RemoveOutcome::Rejected;
    }
    fs::remove_dir_all(target)
        .map(|_| skills_module::management::RemoveOutcome::Removed)
        .unwrap_or(skills_module::management::RemoveOutcome::Unknown)
}

fn project_status(catalog: &SkillStatusCatalog) -> skills_module::status::Catalog {
    skills_module::status::Catalog {
        entries: catalog
            .entries()
            .iter()
            .filter(|entry| status_entry_exists(entry, catalog))
            .map(|entry| skills_module::status::Entry {
                key: entry.key().to_owned(),
                slug: entry.slug().map(str::to_owned),
                name: entry.display_name().to_owned(),
                description: entry.description().to_owned(),
                enabled: entry.enabled(),
                selectable: entry.selectable(),
                eligible: entry.eligible(),
                blocked_by_allowlist: entry.blocked_by_allowlist(),
                bundled: entry.bundled(),
                always: entry.always(),
                emoji: entry.emoji().map(str::to_owned),
                source: entry.source().map(|source| source.as_str().to_owned()),
                uninstallable: is_uninstallable_status_entry(entry),
                base_dir: catalog
                    .locator(entry.key())
                    .and_then(|locator| locator.base_dir())
                    .map(str::to_owned),
                file_path: catalog
                    .locator(entry.key())
                    .and_then(|locator| locator.file_path())
                    .map(str::to_owned),
                missing_categories: entry
                    .missing_requirement_categories()
                    .iter()
                    .map(|category| match category {
                        MissingSkillRequirementCategory::Binaries => {
                            skills_module::status::RequirementCategory::Binaries
                        }
                        MissingSkillRequirementCategory::AnyBinaries => {
                            skills_module::status::RequirementCategory::AnyBinaries
                        }
                        MissingSkillRequirementCategory::Environment => {
                            skills_module::status::RequirementCategory::Environment
                        }
                        MissingSkillRequirementCategory::Configuration => {
                            skills_module::status::RequirementCategory::Configuration
                        }
                        MissingSkillRequirementCategory::OperatingSystem => {
                            skills_module::status::RequirementCategory::OperatingSystem
                        }
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn project_readme_receipt(
    receipt: native_readme::SkillReadmeReceipt,
) -> skills_module::management::ReadmeReceipt {
    skills_module::management::ReadmeReceipt {
        skill_key: receipt.skill_key().to_owned(),
        content: receipt.content().to_owned(),
        file_path: receipt.file_path().to_owned(),
    }
}

fn project_detail(detail: SkillDetail) -> skills_module::management::Detail {
    skills_module::management::Detail {
        skill: detail
            .skill()
            .map(|v| skills_module::management::DetailSkill {
                slug: v.slug().into(),
                display_name: v.display_name().into(),
                summary: v.summary().map(str::to_owned),
                tags: v.tags().clone(),
                created_at: v.created_at(),
                updated_at: v.updated_at(),
            }),
        latest_version: detail
            .latest_version()
            .map(|v| skills_module::management::DetailVersion {
                version: v.version().into(),
                created_at: v.created_at(),
                changelog: v.changelog().map(str::to_owned),
            }),
        metadata: detail
            .metadata()
            .map(|v| skills_module::management::DetailMetadata {
                os: v.os().map(<[String]>::to_vec),
                systems: v.systems().map(<[String]>::to_vec),
            }),
        owner: detail
            .owner()
            .map(|v| skills_module::management::DetailOwner {
                handle: v.handle().map(str::to_owned),
                display_name: v.display_name().map(str::to_owned),
                image: v.image().map(str::to_owned),
            }),
    }
}

fn map_upload(v: SkillUploadOutcome) -> skills_module::management::UploadOutcome {
    match v {
        SkillUploadOutcome::Progress {
            upload_id,
            received_bytes,
            expires_at,
        } => skills_module::management::UploadOutcome::Accepted(
            skills_module::management::UploadReceipt {
                upload_id,
                received_bytes,
                expires_at,
                sha256: None,
            },
        ),
        SkillUploadOutcome::Commit {
            upload_id,
            received_bytes,
            sha256,
            expires_at,
        } => skills_module::management::UploadOutcome::Accepted(
            skills_module::management::UploadReceipt {
                upload_id,
                received_bytes,
                expires_at,
                sha256: Some(sha256),
            },
        ),
        SkillUploadOutcome::Rejected => skills_module::management::UploadOutcome::Rejected,
        SkillUploadOutcome::Unknown => skills_module::management::UploadOutcome::Unknown,
    }
}

fn map_mutation(v: SkillMutationOutcome) -> skills_module::management::MutationOutcome {
    match v {
        SkillMutationOutcome::Accepted => skills_module::management::MutationOutcome::Accepted,
        SkillMutationOutcome::Rejected => skills_module::management::MutationOutcome::Rejected,
        SkillMutationOutcome::Unknown => skills_module::management::MutationOutcome::Unknown,
    }
}

fn map_remove(v: native_bundle::SkillRemoveOutcome) -> skills_module::management::RemoveOutcome {
    match v {
        native_bundle::SkillRemoveOutcome::Removed => {
            skills_module::management::RemoveOutcome::Removed
        }
        native_bundle::SkillRemoveOutcome::NotFound => {
            skills_module::management::RemoveOutcome::NotFound
        }
        native_bundle::SkillRemoveOutcome::Rejected => {
            skills_module::management::RemoveOutcome::Rejected
        }
        native_bundle::SkillRemoveOutcome::Unknown => {
            skills_module::management::RemoveOutcome::Unknown
        }
    }
}

fn map_import(v: native_bundle::ImportOutcome) -> skills_module::management::ImportOutcome {
    match v {
        native_bundle::ImportOutcome::Accepted => {
            skills_module::management::ImportOutcome::Accepted
        }
        native_bundle::ImportOutcome::Rejected => {
            skills_module::management::ImportOutcome::Rejected
        }
        native_bundle::ImportOutcome::Unknown => skills_module::management::ImportOutcome::Unknown,
    }
}

fn map_readme_error(v: native_readme::SkillReadmeError) -> skills_module::management::ReadmeError {
    match v {
        native_readme::SkillReadmeError::Rejected => {
            skills_module::management::ReadmeError::Rejected
        }
        native_readme::SkillReadmeError::Unknown => skills_module::management::ReadmeError::Unknown,
    }
}

fn map_bundle_error(v: native_bundle::BundleError) -> skills_module::management::BundleError {
    match v {
        native_bundle::BundleError::Rejected => skills_module::management::BundleError::Rejected,
        native_bundle::BundleError::Unknown => skills_module::management::BundleError::Unknown,
    }
}

fn to_native_bundle(bundle: skills_module::bundle::Bundle) -> native_bundle::SkillBundle {
    native_bundle::SkillBundle::try_new(
        bundle.skill_key().into(),
        bundle
            .files()
            .iter()
            .map(|f| {
                native_bundle::SkillBundleFile::try_new(f.path().into(), f.content().into())
                    .expect("validated bundle file")
            })
            .collect(),
    )
    .expect("validated bundle")
}

fn from_native_bundle(bundle: native_bundle::SkillBundle) -> skills_module::bundle::Bundle {
    skills_module::bundle::Bundle::try_new(
        bundle.skill_key().into(),
        bundle
            .files()
            .iter()
            .map(|f| {
                skills_module::bundle::BundleFile::try_new(f.path().into(), f.content().into())
                    .expect("native bundle is validated")
            })
            .collect(),
    )
    .expect("native bundle is validated")
}
