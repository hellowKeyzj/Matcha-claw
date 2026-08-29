use std::sync::Arc;

use crate::{
    composition::{HostAdmission, OpenClawInstance},
    runtime_driver::RuntimeDriver as _,
};

#[derive(Clone)]
pub(crate) struct PlatformToolsHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
}

impl PlatformToolsHandle {
    pub(crate) fn new(admission: Arc<HostAdmission>, open_claw: Arc<OpenClawInstance>) -> Self {
        Self {
            admission,
            open_claw,
        }
    }

    pub(crate) async fn platform_tools(&self) -> Result<crate::platform_tools::Outcome, ()> {
        if self.admission.admit_request().is_err()
            || !self
                .open_claw
                .lifecycle_ops()
                .is_some_and(|ops| ops.readiness())
        {
            return Ok(crate::platform_tools::Outcome::Unavailable);
        }
        Ok(self.open_claw.platform_tools().await)
    }
}
