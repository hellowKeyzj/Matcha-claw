use std::sync::Arc;

use crate::{
    composition::HostAdmission,
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::{RuntimeDriverIdentity, RuntimeOperationFailure},
};

#[derive(Clone)]
pub(crate) struct TaskManagerHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl TaskManagerHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
        }
    }

    pub(crate) async fn task_manager(
        &self,
        command: crate::task_manager::Command,
    ) -> Result<crate::task_manager::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::task_manager::Outcome::unavailable(command));
        }
        let Some(driver) = self
            .runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
        else {
            return Ok(crate::task_manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unsupported,
            ));
        };
        if !driver.lifecycle_ops().is_some_and(|ops| ops.readiness()) {
            return Ok(crate::task_manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unavailable,
            ));
        }
        match driver.task_ops() {
            Some(ops) => Ok(ops.task_manager(command).await),
            None => Ok(crate::task_manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unsupported,
            )),
        }
    }
}
