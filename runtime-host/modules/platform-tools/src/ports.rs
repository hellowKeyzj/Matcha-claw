use crate::PlatformToolsOutcome;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformToolsRequestAdmissionClosed;

pub trait PlatformToolsRequestAdmission: Send + Sync {
    fn admit_platform_tools_request(&self) -> Result<(), PlatformToolsRequestAdmissionClosed>;
}

pub trait PlatformToolsOps: Send + Sync {
    fn platform_tools_ready(&self) -> bool;

    fn platform_tools(&self) -> PlatformToolsFuture<'_>;
}

pub type PlatformToolsFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = PlatformToolsOutcome> + Send + 'a>>;
