use std::path::PathBuf;

use super::super::OpenClawInstance;
use crate::skills::{
    install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    management::{Command as SkillManagementCommand, Outcome as SkillManagementOutcome},
};

pub(crate) struct OpenClawSkillProvider<'a> {
    runtime: &'a OpenClawInstance,
}

impl<'a> OpenClawSkillProvider<'a> {
    pub(crate) fn openclaw(runtime: &'a OpenClawInstance) -> Self {
        Self { runtime }
    }

    pub(crate) async fn install_clawhub(
        &self,
        command: SkillInstallCommand,
    ) -> SkillInstallOutcome {
        let (slug, version, force) = command.into_parts();
        let request = match clawhub::ClawHubInstallRequest::try_new(slug, version, force) {
            Ok(request) => request,
            Err(_) => return SkillInstallOutcome::Rejected,
        };
        let slug = request.slug().to_owned();
        let version = request.version().map(str::to_owned);
        match self.runtime.install_clawhub_skill(request).await {
            Ok(()) => SkillInstallOutcome::accepted(slug, version),
            Err(()) => SkillInstallOutcome::Unknown,
        }
    }

    pub(crate) async fn status(&self) -> crate::skills::status::Outcome {
        match self.runtime.skill_status_catalog().await {
            Ok(catalog) => {
                eprintln!(
                    "[startup-trace] source=skills-status phase=host detail=available entries={}",
                    catalog.entries().len()
                );
                crate::skills::status::Outcome::Available(project_status(catalog))
            }
            Err(error) => {
                eprintln!(
                    "[startup-trace] source=skills-status phase=host detail=unavailable error={:?}",
                    error
                );
                crate::skills::status::Outcome::Unavailable
            }
        }
    }

    pub(crate) async fn manage(&self, command: SkillManagementCommand) -> SkillManagementOutcome {
        match command {
            crate::skills::management::Command::Detail { slug } => {
                let request = match openclaw::port::SkillDetailRequest::try_new(slug) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Detail(
                    self.runtime
                        .detail_skill(request)
                        .await
                        .map(project_detail)
                        .map_err(|error| match error {
                            openclaw::port::SkillReadError::Unavailable => {
                                crate::skills::management::ReadError::Unavailable
                            }
                            openclaw::port::SkillReadError::Rejected => {
                                crate::skills::management::ReadError::Rejected
                            }
                            openclaw::port::SkillReadError::Protocol => {
                                crate::skills::management::ReadError::Protocol
                            }
                        }),
                )
            }
            crate::skills::management::Command::Config {
                skill_key,
                enabled,
                api_key,
                env,
            } => {
                let request = match openclaw::port::SkillUpdateRequest::config(
                    skill_key, enabled, api_key, env,
                ) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Mutation(map_mutation(
                    self.runtime.update_skill(request).await,
                ))
            }
            crate::skills::management::Command::ClawHubInstall {
                slug,
                version,
                force,
            } => {
                let request = match clawhub::ClawHubInstallRequest::try_new(slug, version, force) {
                    Ok(request) => request,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                let outcome = match self.runtime.install_clawhub_skill(request).await {
                    Ok(()) => crate::skills::management::MutationOutcome::Accepted,
                    Err(()) => crate::skills::management::MutationOutcome::Unknown,
                };
                SkillManagementOutcome::Mutation(outcome)
            }
            crate::skills::management::Command::ClawHubUpdate { slug, all } => {
                let request = match openclaw::port::SkillUpdateRequest::clawhub(slug, all) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Mutation(map_mutation(
                    self.runtime.update_skill(request).await,
                ))
            }
            crate::skills::management::Command::UploadBegin {
                slug,
                size,
                sha256,
                force,
                idempotency_key,
            } => {
                let request = match openclaw::port::SkillUploadBegin::try_new(
                    slug,
                    size,
                    Some(sha256),
                    Some(force),
                    idempotency_key,
                ) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(
                    self.runtime.begin_skill_upload(request).await,
                ))
            }
            crate::skills::management::Command::UploadChunk {
                upload_id,
                offset,
                bytes,
            } => {
                let request =
                    match openclaw::port::SkillUploadChunk::try_new(upload_id, offset, bytes) {
                        Ok(v) => v,
                        Err(_) => return SkillManagementOutcome::Rejected,
                    };
                SkillManagementOutcome::Upload(map_upload(
                    self.runtime.chunk_skill_upload(request).await,
                ))
            }
            crate::skills::management::Command::UploadCommit { upload_id, sha256 } => {
                let request = match openclaw::port::SkillUploadCommit::try_new(upload_id, sha256) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(
                    self.runtime.commit_skill_upload(request).await,
                ))
            }
            crate::skills::management::Command::Uninstall { skill_key, slug } => {
                let (slugs, config_keys) = self.skill_uninstall_plan(&skill_key, slug).await;
                for slug in slugs {
                    let Ok(request) = clawhub::ClawHubUninstallRequest::try_new(slug) else {
                        continue;
                    };
                    match self.runtime.uninstall_clawhub_skill(request).await {
                        clawhub::ClawHubUninstallOutcome::Removed => {
                            return SkillManagementOutcome::Uninstall(
                                self.remove_skill_configs(config_keys).await,
                            );
                        }
                        clawhub::ClawHubUninstallOutcome::Unknown => {
                            return SkillManagementOutcome::Uninstall(
                                crate::skills::management::RemoveOutcome::Unknown,
                            );
                        }
                        clawhub::ClawHubUninstallOutcome::NotFound
                        | clawhub::ClawHubUninstallOutcome::Rejected => {}
                    }
                }
                let outcome = map_remove(self.runtime.skill_bundles().remove(skill_key));
                if outcome != crate::skills::management::RemoveOutcome::Removed {
                    return SkillManagementOutcome::Uninstall(outcome);
                }
                SkillManagementOutcome::Uninstall(self.remove_skill_configs(config_keys).await)
            }
            crate::skills::management::Command::ImportMarkdown { content } => {
                SkillManagementOutcome::Import(map_import(
                    self.runtime.skill_bundles().import_markdown(content),
                ))
            }
            crate::skills::management::Command::ImportBundle { bundle } => {
                SkillManagementOutcome::Import(map_import(
                    self.runtime
                        .skill_bundles()
                        .import(vec![to_native_bundle(bundle)]),
                ))
            }
            crate::skills::management::Command::Readme {
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
                            crate::skills::management::ReadmeError::Unknown,
                        ));
                    }
                };
                SkillManagementOutcome::Readme(
                    self.runtime
                        .skill_readme()
                        .read(request, &workspace_roots)
                        .map(project_readme_receipt)
                        .map_err(map_readme_error),
                )
            }
            crate::skills::management::Command::OpenReadme {
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
                            crate::skills::management::ReadmeError::Unknown,
                        ));
                    }
                };
                let receipt = match self
                    .runtime
                    .skill_readme()
                    .read_readme_target(request, &workspace_roots)
                {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        return SkillManagementOutcome::Readme(Err(map_readme_error(error)));
                    }
                };
                let path = PathBuf::from(receipt.file_path());
                if self.runtime.open_parent_path(path).await.is_err() {
                    return SkillManagementOutcome::Readme(Err(
                        crate::skills::management::ReadmeError::Unknown,
                    ));
                }
                SkillManagementOutcome::Readme(Ok(project_readme_receipt(receipt)))
            }
            crate::skills::management::Command::OpenPath {
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
                            crate::skills::management::ReadmeError::Unknown,
                        ));
                    }
                };
                let path = match self
                    .runtime
                    .skill_readme()
                    .resolve_directory(&request, &workspace_roots)
                {
                    Ok(path) => path,
                    Err(error) => {
                        return SkillManagementOutcome::OpenPath(Err(map_readme_error(error)));
                    }
                };
                if self.runtime.open_parent_path(path.clone()).await.is_err() {
                    return SkillManagementOutcome::OpenPath(Err(
                        crate::skills::management::ReadmeError::Unknown,
                    ));
                }
                SkillManagementOutcome::OpenPath(Ok(crate::skills::management::OpenPathReceipt))
            }
        }
    }

    async fn readme_request(
        &self,
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<
        openclaw::skill::readme::SkillReadmeRequest,
        openclaw::skill::readme::SkillReadmeError,
    > {
        if file_path.is_none() && base_dir.is_none() {
            let (file_path, base_dir) = match self.runtime.skill_status_catalog().await {
                Ok(catalog) => catalog.locator(&skill_key).map_or((None, None), |locator| {
                    (
                        locator.file_path().map(str::to_owned),
                        locator.base_dir().map(str::to_owned),
                    )
                }),
                Err(_) => (None, None),
            };
            return openclaw::skill::readme::SkillReadmeRequest::try_new(
                skill_key, slug, file_path, base_dir,
            );
        }
        openclaw::skill::readme::SkillReadmeRequest::try_new(skill_key, slug, file_path, base_dir)
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
        if let Ok(catalog) = self.runtime.skill_status_catalog().await {
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

    async fn remove_skill_configs(
        &self,
        skill_keys: Vec<String>,
    ) -> crate::skills::management::RemoveOutcome {
        for skill_key in skill_keys {
            match self.runtime.remove_skill_config(skill_key).await {
                openclaw::port::SkillConfigRemoveOutcome::Removed
                | openclaw::port::SkillConfigRemoveOutcome::NotFound => {}
                openclaw::port::SkillConfigRemoveOutcome::Rejected
                | openclaw::port::SkillConfigRemoveOutcome::Unknown => {
                    return crate::skills::management::RemoveOutcome::Unknown;
                }
            }
        }
        crate::skills::management::RemoveOutcome::Removed
    }

    fn workspace_roots(&self) -> Result<Vec<openclaw::workspace::TrustedWorkspaceDirectory>, ()> {
        self.runtime
            .workspace()
            .maintenance_workspace_directories()
            .map_err(|_| ())
    }

    pub(crate) async fn bundles(
        &self,
        command: crate::skills::bundle::Command,
    ) -> crate::skills::bundle::Outcome {
        let store = self.runtime.skill_bundles();
        tokio::task::spawn_blocking(move || match command {
            crate::skills::bundle::Command::Export { skill_keys } => store
                .export(skill_keys)
                .map(|bundles| {
                    crate::skills::bundle::Outcome::Exported(
                        bundles.into_iter().map(from_native_bundle).collect(),
                    )
                })
                .map_err(map_bundle_error)
                .unwrap_or_else(|_| crate::skills::bundle::Outcome::Unknown),
            crate::skills::bundle::Command::Import { bundles } => {
                match store.import(bundles.into_iter().map(to_native_bundle).collect()) {
                    openclaw::skill::bundle::ImportOutcome::Accepted => {
                        crate::skills::bundle::Outcome::Accepted
                    }
                    openclaw::skill::bundle::ImportOutcome::Rejected => {
                        crate::skills::bundle::Outcome::Rejected
                    }
                    openclaw::skill::bundle::ImportOutcome::Unknown => {
                        crate::skills::bundle::Outcome::Unknown
                    }
                }
            }
        })
        .await
        .unwrap_or(crate::skills::bundle::Outcome::Unknown)
    }
}

fn project_status(catalog: openclaw::skill::SkillStatusCatalog) -> crate::skills::status::Catalog {
    crate::skills::status::Catalog {
        entries: catalog
            .entries()
            .iter()
            .map(|entry| crate::skills::status::Entry {
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
                        openclaw::skill::MissingSkillRequirementCategory::Binaries => {
                            crate::skills::status::RequirementCategory::Binaries
                        }
                        openclaw::skill::MissingSkillRequirementCategory::AnyBinaries => {
                            crate::skills::status::RequirementCategory::AnyBinaries
                        }
                        openclaw::skill::MissingSkillRequirementCategory::Environment => {
                            crate::skills::status::RequirementCategory::Environment
                        }
                        openclaw::skill::MissingSkillRequirementCategory::Configuration => {
                            crate::skills::status::RequirementCategory::Configuration
                        }
                        openclaw::skill::MissingSkillRequirementCategory::OperatingSystem => {
                            crate::skills::status::RequirementCategory::OperatingSystem
                        }
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn project_readme_receipt(
    receipt: openclaw::skill::readme::SkillReadmeReceipt,
) -> crate::skills::management::ReadmeReceipt {
    crate::skills::management::ReadmeReceipt {
        skill_key: receipt.skill_key().to_owned(),
        content: receipt.content().to_owned(),
        file_path: receipt.file_path().to_owned(),
    }
}

fn project_detail(detail: openclaw::port::SkillDetail) -> crate::skills::management::Detail {
    crate::skills::management::Detail {
        skill: detail
            .skill()
            .map(|v| crate::skills::management::DetailSkill {
                slug: v.slug().into(),
                display_name: v.display_name().into(),
                summary: v.summary().map(str::to_owned),
                tags: v.tags().clone(),
                created_at: v.created_at(),
                updated_at: v.updated_at(),
            }),
        latest_version: detail
            .latest_version()
            .map(|v| crate::skills::management::DetailVersion {
                version: v.version().into(),
                created_at: v.created_at(),
                changelog: v.changelog().map(str::to_owned),
            }),
        metadata: detail
            .metadata()
            .map(|v| crate::skills::management::DetailMetadata {
                os: v.os().map(<[String]>::to_vec),
                systems: v.systems().map(<[String]>::to_vec),
            }),
        owner: detail
            .owner()
            .map(|v| crate::skills::management::DetailOwner {
                handle: v.handle().map(str::to_owned),
                display_name: v.display_name().map(str::to_owned),
                image: v.image().map(str::to_owned),
            }),
    }
}
fn map_upload(v: openclaw::port::SkillUploadOutcome) -> crate::skills::management::UploadOutcome {
    match v {
        openclaw::port::SkillUploadOutcome::Progress {
            upload_id,
            received_bytes,
            expires_at,
        } => crate::skills::management::UploadOutcome::Accepted(
            crate::skills::management::UploadReceipt {
                upload_id,
                received_bytes,
                expires_at,
                sha256: None,
            },
        ),
        openclaw::port::SkillUploadOutcome::Commit {
            upload_id,
            received_bytes,
            sha256,
            expires_at,
        } => crate::skills::management::UploadOutcome::Accepted(
            crate::skills::management::UploadReceipt {
                upload_id,
                received_bytes,
                expires_at,
                sha256: Some(sha256),
            },
        ),
        openclaw::port::SkillUploadOutcome::Rejected => {
            crate::skills::management::UploadOutcome::Rejected
        }
        openclaw::port::SkillUploadOutcome::Unknown => {
            crate::skills::management::UploadOutcome::Unknown
        }
    }
}

fn map_mutation(
    v: openclaw::port::SkillMutationOutcome,
) -> crate::skills::management::MutationOutcome {
    match v {
        openclaw::port::SkillMutationOutcome::Accepted => {
            crate::skills::management::MutationOutcome::Accepted
        }
        openclaw::port::SkillMutationOutcome::Rejected => {
            crate::skills::management::MutationOutcome::Rejected
        }
        openclaw::port::SkillMutationOutcome::Unknown => {
            crate::skills::management::MutationOutcome::Unknown
        }
    }
}
fn map_remove(
    v: openclaw::skill::bundle::SkillRemoveOutcome,
) -> crate::skills::management::RemoveOutcome {
    match v {
        openclaw::skill::bundle::SkillRemoveOutcome::Removed => {
            crate::skills::management::RemoveOutcome::Removed
        }
        openclaw::skill::bundle::SkillRemoveOutcome::NotFound => {
            crate::skills::management::RemoveOutcome::NotFound
        }
        openclaw::skill::bundle::SkillRemoveOutcome::Rejected => {
            crate::skills::management::RemoveOutcome::Rejected
        }
        openclaw::skill::bundle::SkillRemoveOutcome::Unknown => {
            crate::skills::management::RemoveOutcome::Unknown
        }
    }
}
fn map_import(
    v: openclaw::skill::bundle::ImportOutcome,
) -> crate::skills::management::ImportOutcome {
    match v {
        openclaw::skill::bundle::ImportOutcome::Accepted => {
            crate::skills::management::ImportOutcome::Accepted
        }
        openclaw::skill::bundle::ImportOutcome::Rejected => {
            crate::skills::management::ImportOutcome::Rejected
        }
        openclaw::skill::bundle::ImportOutcome::Unknown => {
            crate::skills::management::ImportOutcome::Unknown
        }
    }
}
fn map_readme_error(
    v: openclaw::skill::readme::SkillReadmeError,
) -> crate::skills::management::ReadmeError {
    match v {
        openclaw::skill::readme::SkillReadmeError::Rejected => {
            crate::skills::management::ReadmeError::Rejected
        }
        openclaw::skill::readme::SkillReadmeError::Unknown => {
            crate::skills::management::ReadmeError::Unknown
        }
    }
}

fn map_bundle_error(
    v: openclaw::skill::bundle::BundleError,
) -> crate::skills::management::BundleError {
    match v {
        openclaw::skill::bundle::BundleError::Rejected => {
            crate::skills::management::BundleError::Rejected
        }
        openclaw::skill::bundle::BundleError::Unknown => {
            crate::skills::management::BundleError::Unknown
        }
    }
}
fn to_native_bundle(bundle: crate::skills::bundle::Bundle) -> openclaw::skill::bundle::SkillBundle {
    openclaw::skill::bundle::SkillBundle::try_new(
        bundle.skill_key().into(),
        bundle
            .files()
            .iter()
            .map(|f| {
                openclaw::skill::bundle::SkillBundleFile::try_new(
                    f.path().into(),
                    f.content().into(),
                )
                .expect("validated bundle file")
            })
            .collect(),
    )
    .expect("validated bundle")
}
fn from_native_bundle(
    bundle: openclaw::skill::bundle::SkillBundle,
) -> crate::skills::bundle::Bundle {
    crate::skills::bundle::Bundle::try_new(
        bundle.skill_key().into(),
        bundle
            .files()
            .iter()
            .map(|f| {
                crate::skills::bundle::BundleFile::try_new(f.path().into(), f.content().into())
                    .expect("native bundle is validated")
            })
            .collect(),
    )
    .expect("native bundle is validated")
}
