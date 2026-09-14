use std::sync::Arc;

use crate::composition::{HostAdmission, RequestAdmissionClosed};

#[derive(Clone)]
pub(crate) struct ToolchainHandle {
    admission: Arc<HostAdmission>,
    toolchain: Arc<toolchain::NativeToolchain>,
}

impl ToolchainHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        toolchain: Arc<toolchain::NativeToolchain>,
    ) -> Self {
        Self {
            admission,
            toolchain,
        }
    }

    pub(crate) async fn status(
        &self,
    ) -> Result<Result<toolchain::ToolchainStatus, RequestAdmissionClosed>, ()> {
        match self.admission.admit_request() {
            Ok(()) => Ok(Ok(self.toolchain.status().await)),
            Err(closed) => Ok(Err(closed)),
        }
    }

    pub(crate) async fn prepare(
        &self,
    ) -> Result<Result<toolchain::PrepareOutcome, RequestAdmissionClosed>, ()> {
        match self.admission.admit_request() {
            Ok(()) => Ok(Ok(self.toolchain.prepare().await)),
            Err(closed) => Ok(Err(closed)),
        }
    }
}
