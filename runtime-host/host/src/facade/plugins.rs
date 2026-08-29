use std::sync::Arc;

use crate::{
    composition::{HostAdmission, OpenClawInstance, PeerHandle},
    runtime_driver::RuntimeDriver as _,
};

#[derive(Clone)]
pub(crate) struct PluginsHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
    peer: PeerHandle,
}

impl PluginsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        open_claw: Arc<OpenClawInstance>,
        peer: PeerHandle,
    ) -> Self {
        Self {
            admission,
            open_claw,
            peer,
        }
    }

    pub(crate) async fn catalog(
        &self,
    ) -> Result<Result<crate::plugin::Catalog, crate::plugin::PluginError>, ()> {
        self.admission.admit_request().map_err(|_| ())?;
        Ok(self.open_claw.plugin_catalog())
    }

    pub(crate) async fn runtime(
        &self,
    ) -> Result<Result<crate::plugin::Runtime, crate::plugin::PluginError>, ()> {
        self.admission.admit_request().map_err(|_| ())?;
        Ok(self.open_claw.plugin_runtime(self.open_claw_is_running()))
    }

    pub(crate) async fn set_enabled(
        &self,
        plugin_id: String,
        enabled: bool,
    ) -> Result<crate::plugin::ConfigurationOutcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::plugin::ConfigurationOutcome::Unknown);
        }
        let outcome = self.open_claw.plugin_set_enabled(&plugin_id, enabled);
        if outcome != crate::plugin::ConfigurationOutcome::Configured {
            return Ok(outcome);
        }
        match self.peer.restart_open_claw().await {
            Ok(Ok(_)) => Ok(outcome),
            Ok(Err(_)) | Err(_) => Ok(crate::plugin::ConfigurationOutcome::Unknown),
        }
    }

    pub(crate) async fn operation(
        &self,
        operation: crate::plugin::Operation,
        plugin_id: String,
    ) -> Result<crate::plugin::OperationOutcome, ()> {
        if self.admission.admit_request().is_err() || !self.open_claw_is_running() {
            return Ok(crate::plugin::OperationOutcome::Unknown);
        }
        let outcome = self.open_claw.plugin_operation(operation, &plugin_id);
        if outcome != crate::plugin::OperationOutcome::Configured {
            return Ok(outcome);
        }
        match self.peer.restart_open_claw().await {
            Ok(Ok(_)) if operation == crate::plugin::Operation::Uninstall => {
                Ok(self.open_claw.plugin_finalize_uninstall(&plugin_id))
            }
            Ok(Ok(_)) => Ok(crate::plugin::OperationOutcome::Configured),
            Ok(Err(_)) | Err(_) => Ok(crate::plugin::OperationOutcome::Unknown),
        }
    }

    fn open_claw_is_running(&self) -> bool {
        self.open_claw
            .lifecycle_ops()
            .is_some_and(|ops| ops.readiness())
    }
}
