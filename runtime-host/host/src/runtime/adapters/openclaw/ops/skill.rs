use super::*;

impl OpenClawInstance {
    pub(crate) async fn skill_status_catalog(
        &self,
    ) -> Result<openclaw::skill::SkillStatusCatalog, openclaw::skill::SkillStatusCatalogError> {
        self.gateway.lock().await.skill_status_catalog().await
    }

    pub(crate) async fn open_parent_path(&self, path: PathBuf) -> Result<(), ()> {
        let path = path.to_str().ok_or(())?.to_owned();
        match self
            .parent_callback
            .request_parent_shell_action(
                ParentShellAction::ShellOpenPath,
                Some(json!({ "path": path })),
            )
            .await
        {
            Ok(
                crate::transport::runtime::parent_callback::ParentShellActionResponse::Success {
                    status,
                    ..
                },
            ) if (200..300).contains(&status) => Ok(()),
            _ => Err(()),
        }
    }

    pub(crate) async fn detail_skill(
        &self,
        request: openclaw::port::SkillDetailRequest,
    ) -> Result<openclaw::port::SkillDetail, openclaw::port::SkillReadError> {
        self.gateway.lock().await.detail_skill(request).await
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

    pub(crate) async fn install_clawhub_skill(
        &self,
        request: clawhub::ClawHubInstallRequest,
    ) -> Result<(), ()> {
        let registries = clawhub::ClawHubRegistryClient::new(self.state_dir.as_path().to_owned())
            .registry_bases()
            .to_vec();
        let installer = clawhub::ClawHubCliInstaller::new(
            self.electron_image.clone(),
            self.state_dir.as_path().to_owned(),
            self.clawhub_cli_entries(),
            registries,
        );
        installer.install(request).await
    }

    pub(crate) async fn uninstall_clawhub_skill(
        &self,
        request: clawhub::ClawHubUninstallRequest,
    ) -> clawhub::ClawHubUninstallOutcome {
        let installer = clawhub::ClawHubCliInstaller::new(
            self.electron_image.clone(),
            self.state_dir.as_path().to_owned(),
            self.clawhub_cli_entries(),
            Vec::new(),
        );
        installer.uninstall(request).await
    }

    pub(crate) async fn update_skill(
        &self,
        request: openclaw::port::SkillUpdateRequest,
    ) -> openclaw::port::SkillMutationOutcome {
        self.gateway.lock().await.update_skill(request).await
    }

    pub(crate) async fn remove_skill_config(
        &self,
        skill_key: String,
    ) -> openclaw::port::SkillConfigRemoveOutcome {
        self.gateway
            .lock()
            .await
            .remove_skill_config(skill_key)
            .await
    }

    pub(crate) async fn begin_skill_upload(
        &self,
        request: openclaw::port::SkillUploadBegin,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.begin_skill_upload(request).await
    }

    pub(crate) async fn chunk_skill_upload(
        &self,
        request: openclaw::port::SkillUploadChunk,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.chunk_skill_upload(request).await
    }

    pub(crate) async fn commit_skill_upload(
        &self,
        request: openclaw::port::SkillUploadCommit,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.commit_skill_upload(request).await
    }

    pub(crate) fn skill_bundles(&self) -> openclaw::skill::bundle::SkillBundleStore {
        openclaw::skill::bundle::SkillBundleStore::new(self.state_dir.clone())
    }

    pub(crate) fn skill_readme(&self) -> openclaw::skill::readme::SkillReadmeStore {
        openclaw::skill::readme::SkillReadmeStore::new(self.state_dir.clone())
    }
}

impl SkillOps for OpenClawInstance {
    fn installed_skill_catalog(
        &self,
    ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move { gateway.lock().await.installed_skill_catalog().await })
    }

    fn install_clawhub_skill<'a>(
        &'a self,
        command: crate::skills::install::Command,
    ) -> SessionFuture<'a, crate::skills::install::Outcome> {
        Box::pin(async move {
            super::super::adapters::skill::OpenClawSkillProvider::openclaw(self)
                .install_clawhub(command)
                .await
        })
    }

    fn skill_status<'a>(&'a self) -> SessionFuture<'a, crate::skills::status::Outcome> {
        Box::pin(async move {
            super::super::adapters::skill::OpenClawSkillProvider::openclaw(self)
                .status()
                .await
        })
    }

    fn manage_skills<'a>(
        &'a self,
        command: crate::skills::management::Command,
    ) -> SessionFuture<'a, crate::skills::management::Outcome> {
        Box::pin(async move {
            super::super::adapters::skill::OpenClawSkillProvider::openclaw(self)
                .manage(command)
                .await
        })
    }

    fn skill_bundles<'a>(
        &'a self,
        command: crate::skills::bundle::Command,
    ) -> SessionFuture<'a, crate::skills::bundle::Outcome> {
        Box::pin(async move {
            super::super::adapters::skill::OpenClawSkillProvider::openclaw(self)
                .bundles(command)
                .await
        })
    }
}
