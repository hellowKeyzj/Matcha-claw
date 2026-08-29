use std::sync::Arc;

use crate::{
    composition::{HostAdmission, OpenClawInstance, RequestAdmissionClosed},
    runtime_driver::RuntimeDriver as _,
};

#[derive(Clone)]
pub(crate) struct PlatformRuntimeHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
}

impl PlatformRuntimeHandle {
    pub(crate) fn new(admission: Arc<HostAdmission>, open_claw: Arc<OpenClawInstance>) -> Self {
        Self {
            admission,
            open_claw,
        }
    }

    pub(crate) async fn installation_status(
        &self,
    ) -> Result<Option<openclaw::projection::installation::Status>, ()> {
        self.admission.admit_request().map_err(|_| ())?;
        Ok(self.open_claw.installation_status())
    }

    pub(crate) async fn runtime_paths(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::runtime_paths::RuntimePaths,
            openclaw::projection::runtime_paths::RuntimePathsError,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::runtime_paths::RuntimePathsError::Unavailable,
            ));
        }
        Ok(self.open_claw.runtime_paths())
    }

    pub(crate) async fn cli_command(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::runtime_paths::CliCommand,
            openclaw::projection::runtime_paths::CliCommandError,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::runtime_paths::CliCommandError::Unavailable,
            ));
        }
        Ok(self.open_claw.cli_command())
    }

    pub(crate) async fn tool_permission_mode(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::tool_permission::Mode,
            openclaw::projection::tool_permission::Error,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::tool_permission::Error::Unavailable,
            ));
        }
        Ok(self.open_claw.tool_permission_mode())
    }

    pub(crate) async fn set_tool_permission_mode(
        &self,
        mode: openclaw::projection::tool_permission::Mode,
    ) -> Result<
        Result<
            openclaw::projection::tool_permission::Effect,
            openclaw::projection::tool_permission::Error,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::tool_permission::Error::Unavailable,
            ));
        }
        Ok(self.open_claw.set_tool_permission_mode(mode))
    }

    pub(crate) async fn toolchain_status(
        &self,
    ) -> Result<Result<openclaw::toolchain::ToolchainStatus, RequestAdmissionClosed>, ()> {
        match self.admission.admit_request() {
            Ok(()) => Ok(Ok(self.open_claw.toolchain_status().await)),
            Err(closed) => Ok(Err(closed)),
        }
    }

    pub(crate) async fn install_uv(
        &self,
    ) -> Result<Result<openclaw::toolchain::UvInstallOutcome, RequestAdmissionClosed>, ()> {
        match self.admission.admit_request() {
            Ok(()) => Ok(Ok(self.open_claw.install_toolchain_uv().await)),
            Err(closed) => Ok(Err(closed)),
        }
    }

    pub(crate) async fn subagent_template_catalog(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::subagent_templates::Catalog,
            openclaw::projection::subagent_templates::SubagentTemplateError,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable,
            ));
        }
        Ok(self.open_claw.subagent_template_catalog())
    }

    pub(crate) async fn subagent_template(
        &self,
        id: &str,
    ) -> Result<
        Result<
            openclaw::projection::subagent_templates::Detail,
            openclaw::projection::subagent_templates::SubagentTemplateError,
        >,
        (),
    > {
        if self.admission.admit_request().is_err() {
            return Ok(Err(
                openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable,
            ));
        }
        Ok(self.open_claw.subagent_template(id))
    }

    pub(crate) fn is_running(&self) -> bool {
        self.open_claw
            .lifecycle_ops()
            .is_some_and(|ops| ops.readiness())
    }
}
