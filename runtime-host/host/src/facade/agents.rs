use std::sync::Arc;

use crate::{composition::HostAdmission, runtime_directory::RuntimeDriverDirectory};

#[derive(Clone)]
pub(crate) struct AgentsHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl AgentsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
        }
    }

    pub(crate) async fn agents(
        &self,
        command: crate::agents::Command,
    ) -> Result<crate::agents::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::agents::Outcome::Unavailable);
        }
        let endpoint = command.endpoint().runtime_endpoint();
        let Some(driver) = self.runtime_directory.lookup(&endpoint) else {
            return Ok(crate::agents::Outcome::Unsupported);
        };
        if !driver.lifecycle_ops().is_some_and(|ops| ops.readiness()) {
            return Ok(crate::agents::Outcome::Unavailable);
        }
        match driver.subagent_ops() {
            Some(ops) => Ok(ops.agents(command).await),
            None => Ok(crate::agents::Outcome::Unsupported),
        }
    }
}
