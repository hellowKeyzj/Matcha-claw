use crate::driver::OpenClawDriver;

use super::platform_tools_projection::platform_tools_catalog;

impl platform_tools::PlatformToolsOps for OpenClawDriver {
    fn platform_tools_ready(&self) -> bool {
        self.owner().snapshot().phase()
            == foundation::process::supervision::SupervisorPhase::Running
    }

    fn platform_tools(&self) -> platform_tools::PlatformToolsFuture<'_> {
        Box::pin(async move {
            platform_tools_catalog(self.gateway.lock().await.platform_tools_catalog().await)
        })
    }
}
