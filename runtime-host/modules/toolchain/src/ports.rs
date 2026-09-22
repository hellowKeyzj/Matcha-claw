#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolchainRequestAdmissionClosed;

pub trait ToolchainRequestAdmission: Send + Sync {
    fn admit_toolchain_request(&self) -> Result<(), ToolchainRequestAdmissionClosed>;
}
