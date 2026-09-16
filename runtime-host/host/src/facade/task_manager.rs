use std::sync::Arc;

use crate::{
    composition::HostAdmission,
    runtime::{directory::RuntimeDriverDirectory, driver::RuntimeOperationFailure},
};

use super::driver_lookup::RuntimeDrivers;

#[derive(Clone)]
pub(crate) struct TaskManagerHandle {
    admission: Arc<HostAdmission>,
    runtimes: RuntimeDrivers,
}

impl TaskManagerHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            runtimes: RuntimeDrivers::new(runtime_directory),
        }
    }

    pub(crate) async fn task_manager(
        &self,
        command: crate::tasks::manager::Command,
    ) -> Result<crate::tasks::manager::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::tasks::manager::Outcome::unavailable(command));
        }
        let Some(driver) = self.runtimes.openclaw_driver() else {
            return Ok(crate::tasks::manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unsupported,
            ));
        };
        if !RuntimeDrivers::is_ready(driver.as_ref()) {
            return Ok(crate::tasks::manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unavailable,
            ));
        }
        match driver.task_ops() {
            Some(ops) => Ok(ops.task_manager(command).await),
            None => Ok(crate::tasks::manager::Outcome::from_failure(
                command,
                RuntimeOperationFailure::Unsupported,
            )),
        }
    }
}
