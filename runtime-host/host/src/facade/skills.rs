use std::sync::Arc;

use crate::{
    composition::HostAdmission, runtime_directory::RuntimeDriverDirectory,
    runtime_driver::RuntimeDriverIdentity,
};

#[derive(Clone)]
pub(crate) struct SkillsHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl SkillsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
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
