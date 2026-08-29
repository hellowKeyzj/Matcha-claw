use super::openclaw::OpenClawInstance;
use crate::{
    skill_bundle,
    skill_install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    skill_management::{
        self, Command as SkillManagementCommand, Outcome as SkillManagementOutcome,
    },
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

    pub(crate) async fn status(&self) -> crate::skill_status::Outcome {
        match self.runtime.skill_status_catalog().await {
            Ok(catalog) => crate::skill_status::Outcome::Available(project_status(catalog)),
            Err(_) => crate::skill_status::Outcome::Unavailable,
        }
    }

    pub(crate) async fn manage(&self, command: SkillManagementCommand) -> SkillManagementOutcome {
        match command {
            skill_management::Command::Detail { slug } => {
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
                                skill_management::ReadError::Unavailable
                            }
                            openclaw::port::SkillReadError::Rejected => {
                                skill_management::ReadError::Rejected
                            }
                            openclaw::port::SkillReadError::Protocol => {
                                skill_management::ReadError::Protocol
                            }
                        }),
                )
            }
            skill_management::Command::Config {
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
            skill_management::Command::ClawHubInstall {
                slug,
                version,
                force,
            } => {
                let request = match clawhub::ClawHubInstallRequest::try_new(slug, version, force) {
                    Ok(request) => request,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                let outcome = match self.runtime.install_clawhub_skill(request).await {
                    Ok(()) => skill_management::MutationOutcome::Accepted,
                    Err(()) => skill_management::MutationOutcome::Unknown,
                };
                SkillManagementOutcome::Mutation(outcome)
            }
            skill_management::Command::ClawHubUpdate { slug, all } => {
                let request = match openclaw::port::SkillUpdateRequest::clawhub(slug, all) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Mutation(map_mutation(
                    self.runtime.update_skill(request).await,
                ))
            }
            skill_management::Command::UploadBegin {
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
            skill_management::Command::UploadChunk {
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
            skill_management::Command::UploadCommit { upload_id, sha256 } => {
                let request = match openclaw::port::SkillUploadCommit::try_new(upload_id, sha256) {
                    Ok(v) => v,
                    Err(_) => return SkillManagementOutcome::Rejected,
                };
                SkillManagementOutcome::Upload(map_upload(
                    self.runtime.commit_skill_upload(request).await,
                ))
            }
            skill_management::Command::Uninstall { skill_key } => {
                SkillManagementOutcome::Uninstall(map_remove(
                    self.runtime.skill_bundles().remove(skill_key),
                ))
            }
            skill_management::Command::ImportMarkdown { content } => {
                SkillManagementOutcome::Import(map_import(
                    self.runtime.skill_bundles().import_markdown(content),
                ))
            }
            skill_management::Command::ImportBundle { bundle } => {
                SkillManagementOutcome::Import(map_import(
                    self.runtime
                        .skill_bundles()
                        .import(vec![to_native_bundle(bundle)]),
                ))
            }
            skill_management::Command::Readme {
                skill_key,
                file_path,
                base_dir,
            } => {
                let request = match openclaw::skill::readme::SkillReadmeRequest::try_new(
                    skill_key, file_path, base_dir,
                ) {
                    Ok(request) => request,
                    Err(error) => {
                        return SkillManagementOutcome::Readme(Err(map_readme_error(error)));
                    }
                };
                let workspace_roots =
                    match self.runtime.workspace().maintenance_workspace_directories() {
                        Ok(roots) => roots,
                        Err(_) => {
                            return SkillManagementOutcome::Readme(Err(
                                skill_management::ReadmeError::Unknown,
                            ));
                        }
                    };
                SkillManagementOutcome::Readme(
                    self.runtime
                        .skill_readme()
                        .read(request, &workspace_roots)
                        .map(|receipt| skill_management::ReadmeReceipt {
                            skill_key: receipt.skill_key().to_owned(),
                            content: receipt.content().to_owned(),
                            file_path: receipt.file_path().to_owned(),
                        })
                        .map_err(map_readme_error),
                )
            }
        }
    }

    pub(crate) async fn bundles(&self, command: skill_bundle::Command) -> skill_bundle::Outcome {
        let store = self.runtime.skill_bundles();
        tokio::task::spawn_blocking(move || match command {
            skill_bundle::Command::Export { skill_keys } => store
                .export(skill_keys)
                .map(|bundles| {
                    skill_bundle::Outcome::Exported(
                        bundles.into_iter().map(from_native_bundle).collect(),
                    )
                })
                .map_err(map_bundle_error)
                .unwrap_or_else(|_| skill_bundle::Outcome::Unknown),
            skill_bundle::Command::Import { bundles } => {
                match store.import(bundles.into_iter().map(to_native_bundle).collect()) {
                    openclaw::skill::bundle::ImportOutcome::Accepted => {
                        skill_bundle::Outcome::Accepted
                    }
                    openclaw::skill::bundle::ImportOutcome::Rejected => {
                        skill_bundle::Outcome::Rejected
                    }
                    openclaw::skill::bundle::ImportOutcome::Unknown => {
                        skill_bundle::Outcome::Unknown
                    }
                }
            }
        })
        .await
        .unwrap_or(skill_bundle::Outcome::Unknown)
    }
}

fn project_status(catalog: openclaw::skill::SkillStatusCatalog) -> crate::skill_status::Catalog {
    crate::skill_status::Catalog {
        entries: catalog
            .entries()
            .iter()
            .map(|entry| crate::skill_status::Entry {
                key: entry.key().to_owned(),
                name: entry.display_name().to_owned(),
                description: entry.description().to_owned(),
                enabled: entry.enabled(),
                selectable: entry.selectable(),
                installed: entry.installed(),
                eligible: entry.eligible(),
                blocked_by_allowlist: entry.blocked_by_allowlist(),
                blocked_by_agent_filter: entry.blocked_by_agent_filter(),
                unavailable_reason: entry.unavailable_reason().map(|reason| match reason {
                    openclaw::skill::SkillStatusUnavailableReason::Disabled => {
                        crate::skill_status::UnavailableReason::Disabled
                    }
                    openclaw::skill::SkillStatusUnavailableReason::Blocked => {
                        crate::skill_status::UnavailableReason::Blocked
                    }
                    openclaw::skill::SkillStatusUnavailableReason::MissingRequirements => {
                        crate::skill_status::UnavailableReason::MissingRequirements
                    }
                    openclaw::skill::SkillStatusUnavailableReason::Ineligible => {
                        crate::skill_status::UnavailableReason::Ineligible
                    }
                }),
                missing_categories: entry
                    .missing_requirement_categories()
                    .iter()
                    .map(|category| match category {
                        openclaw::skill::MissingSkillRequirementCategory::Binaries => {
                            crate::skill_status::RequirementCategory::Binaries
                        }
                        openclaw::skill::MissingSkillRequirementCategory::AnyBinaries => {
                            crate::skill_status::RequirementCategory::AnyBinaries
                        }
                        openclaw::skill::MissingSkillRequirementCategory::Environment => {
                            crate::skill_status::RequirementCategory::Environment
                        }
                        openclaw::skill::MissingSkillRequirementCategory::Configuration => {
                            crate::skill_status::RequirementCategory::Configuration
                        }
                        openclaw::skill::MissingSkillRequirementCategory::OperatingSystem => {
                            crate::skill_status::RequirementCategory::OperatingSystem
                        }
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn project_detail(detail: openclaw::port::SkillDetail) -> skill_management::Detail {
    skill_management::Detail {
        skill: detail.skill().map(|v| skill_management::DetailSkill {
            slug: v.slug().into(),
            display_name: v.display_name().into(),
            summary: v.summary().map(str::to_owned),
            tags: v.tags().clone(),
            created_at: v.created_at(),
            updated_at: v.updated_at(),
        }),
        latest_version: detail
            .latest_version()
            .map(|v| skill_management::DetailVersion {
                version: v.version().into(),
                created_at: v.created_at(),
                changelog: v.changelog().map(str::to_owned),
            }),
        metadata: detail.metadata().map(|v| skill_management::DetailMetadata {
            os: v.os().map(<[String]>::to_vec),
            systems: v.systems().map(<[String]>::to_vec),
        }),
        owner: detail.owner().map(|v| skill_management::DetailOwner {
            handle: v.handle().map(str::to_owned),
            display_name: v.display_name().map(str::to_owned),
            image: v.image().map(str::to_owned),
        }),
    }
}
fn map_upload(v: openclaw::port::SkillUploadOutcome) -> skill_management::UploadOutcome {
    match v {
        openclaw::port::SkillUploadOutcome::Progress {
            upload_id,
            received_bytes,
            expires_at,
        } => skill_management::UploadOutcome::Accepted(skill_management::UploadReceipt {
            upload_id,
            received_bytes,
            expires_at,
            sha256: None,
        }),
        openclaw::port::SkillUploadOutcome::Commit {
            upload_id,
            received_bytes,
            sha256,
            expires_at,
        } => skill_management::UploadOutcome::Accepted(skill_management::UploadReceipt {
            upload_id,
            received_bytes,
            expires_at,
            sha256: Some(sha256),
        }),
        openclaw::port::SkillUploadOutcome::Rejected => skill_management::UploadOutcome::Rejected,
        openclaw::port::SkillUploadOutcome::Unknown => skill_management::UploadOutcome::Unknown,
    }
}

fn map_mutation(v: openclaw::port::SkillMutationOutcome) -> skill_management::MutationOutcome {
    match v {
        openclaw::port::SkillMutationOutcome::Accepted => {
            skill_management::MutationOutcome::Accepted
        }
        openclaw::port::SkillMutationOutcome::Rejected => {
            skill_management::MutationOutcome::Rejected
        }
        openclaw::port::SkillMutationOutcome::Unknown => skill_management::MutationOutcome::Unknown,
    }
}
fn map_remove(v: openclaw::skill::bundle::SkillRemoveOutcome) -> skill_management::RemoveOutcome {
    match v {
        openclaw::skill::bundle::SkillRemoveOutcome::Removed => {
            skill_management::RemoveOutcome::Removed
        }
        openclaw::skill::bundle::SkillRemoveOutcome::NotFound => {
            skill_management::RemoveOutcome::NotFound
        }
        openclaw::skill::bundle::SkillRemoveOutcome::Rejected => {
            skill_management::RemoveOutcome::Rejected
        }
        openclaw::skill::bundle::SkillRemoveOutcome::Unknown => {
            skill_management::RemoveOutcome::Unknown
        }
    }
}
fn map_import(v: openclaw::skill::bundle::ImportOutcome) -> skill_management::ImportOutcome {
    match v {
        openclaw::skill::bundle::ImportOutcome::Accepted => {
            skill_management::ImportOutcome::Accepted
        }
        openclaw::skill::bundle::ImportOutcome::Rejected => {
            skill_management::ImportOutcome::Rejected
        }
        openclaw::skill::bundle::ImportOutcome::Unknown => skill_management::ImportOutcome::Unknown,
    }
}
fn map_readme_error(v: openclaw::skill::readme::SkillReadmeError) -> skill_management::ReadmeError {
    match v {
        openclaw::skill::readme::SkillReadmeError::Rejected => {
            skill_management::ReadmeError::Rejected
        }
        openclaw::skill::readme::SkillReadmeError::Unknown => {
            skill_management::ReadmeError::Unknown
        }
    }
}

fn map_bundle_error(v: openclaw::skill::bundle::BundleError) -> skill_management::BundleError {
    match v {
        openclaw::skill::bundle::BundleError::Rejected => skill_management::BundleError::Rejected,
        openclaw::skill::bundle::BundleError::Unknown => skill_management::BundleError::Unknown,
    }
}
fn to_native_bundle(bundle: skill_bundle::Bundle) -> openclaw::skill::bundle::SkillBundle {
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
fn from_native_bundle(bundle: openclaw::skill::bundle::SkillBundle) -> skill_bundle::Bundle {
    skill_bundle::Bundle::try_new(
        bundle.skill_key().into(),
        bundle
            .files()
            .iter()
            .map(|f| {
                skill_bundle::BundleFile::try_new(f.path().into(), f.content().into())
                    .expect("native bundle is validated")
            })
            .collect(),
    )
    .expect("native bundle is validated")
}
