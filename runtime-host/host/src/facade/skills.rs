use std::{path::PathBuf, sync::Arc};

use crate::{
    composition::HostAdmission, runtime_directory::RuntimeDriverDirectory,
    runtime_driver::RuntimeDriverIdentity, sealed_resource::SealedSkillStore,
};

#[derive(Clone)]
pub(crate) struct SkillsHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    sealed_store: Arc<SealedSkillStore>,
    sealed_runtime_token: Option<Arc<str>>,
}

impl SkillsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
        sealed_store: Arc<SealedSkillStore>,
        sealed_runtime_token: Option<Arc<str>>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
            sealed_store,
            sealed_runtime_token,
        }
    }

    pub(crate) async fn install_clawhub_skill(
        &self,
        command: crate::skill_install::Command,
    ) -> Result<crate::skill_install::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::skill_install::Outcome::Unknown);
        }
        let Some(driver) = self.running_openclaw_driver() else {
            return Ok(crate::skill_install::Outcome::Unknown);
        };
        match driver.skill_ops() {
            Some(ops) => Ok(ops.install_clawhub_skill(command).await),
            None => Ok(crate::skill_install::Outcome::Unknown),
        }
    }

    pub(crate) async fn skill_status(&self) -> Result<crate::skill_status::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::skill_status::Outcome::Unavailable);
        }
        let Some(driver) = self.running_openclaw_driver() else {
            return Ok(crate::skill_status::Outcome::Unavailable);
        };
        match driver.skill_ops() {
            Some(ops) => Ok(ops.skill_status().await),
            None => Ok(crate::skill_status::Outcome::Unavailable),
        }
    }

    pub(crate) async fn manage_skills(
        &self,
        command: crate::skill_management::Command,
    ) -> Result<crate::skill_management::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::skill_management::Outcome::Unavailable);
        }
        let Some(driver) = self.running_openclaw_driver() else {
            return Ok(crate::skill_management::Outcome::Unavailable);
        };
        match driver.skill_ops() {
            Some(ops) => Ok(ops.manage_skills(command).await),
            None => Ok(crate::skill_management::Outcome::Unavailable),
        }
    }

    pub(crate) async fn skill_bundles(
        &self,
        command: crate::skill_bundle::Command,
    ) -> Result<crate::skill_bundle::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::skill_bundle::Outcome::Unknown);
        }
        let Some(driver) = self.running_openclaw_driver() else {
            return Ok(crate::skill_bundle::Outcome::Unknown);
        };
        match driver.skill_ops() {
            Some(ops) => Ok(ops.skill_bundles(command).await),
            None => Ok(crate::skill_bundle::Outcome::Unknown),
        }
    }

    pub(crate) fn sealed_catalog(
        &self,
    ) -> Result<
        crate::sealed_resource::SealedSkillCatalog,
        crate::sealed_resource::SealedResourceError,
    > {
        self.sealed_store.catalog()
    }

    pub(crate) fn export_sealed_skill_package(
        &self,
        skill_key: crate::sealed_resource::SkillKey,
    ) -> Result<
        crate::sealed_resource::SealedSkillCatalogEntry,
        crate::sealed_resource::SealedResourceError,
    > {
        self.sealed_store.export_plain_directory_package(skill_key)
    }

    pub(crate) fn install_sealed_skill(
        &self,
        package_path: PathBuf,
    ) -> Result<
        crate::sealed_resource::SealedSkillCatalogEntry,
        crate::sealed_resource::SealedResourceError,
    > {
        self.sealed_store.install_package_path(package_path)
    }

    pub(crate) fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: crate::sealed_resource::SkillKey,
        path: crate::sealed_resource::PackageRelativePath,
    ) -> Result<
        crate::sealed_resource::SealedResourceRead,
        crate::sealed_resource::SealedResourceError,
    > {
        if !self
            .sealed_runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(crate::sealed_resource::SealedResourceError::Rejected);
        }
        self.sealed_store.read_file(skill_key, path)
    }

    pub(crate) fn remove_sealed_skill(
        &self,
        skill_key: crate::sealed_resource::SkillKey,
    ) -> Result<bool, crate::sealed_resource::SealedResourceError> {
        self.sealed_store.remove_package(skill_key)
    }

    fn running_openclaw_driver(&self) -> Option<Arc<dyn crate::runtime_driver::RuntimeDriver>> {
        let driver = self
            .runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())?;
        driver
            .lifecycle_ops()
            .is_some_and(|ops| ops.readiness())
            .then_some(driver)
    }
}
