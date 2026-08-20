mod adapter;
mod custody;
#[cfg(unix)]
mod descriptor_scan;
mod guardian_cleanup;
mod guardian_descriptors;
mod guardian_process;
pub(crate) const PRIVATE_CHILD_DESCRIPTOR_FD: std::os::fd::RawFd =
    guardian_descriptors::TARGET_PRIVATE_DESCRIPTOR_FD;
mod host_protocol;
mod io;
mod protocol;
mod protocol_observation_decode;
mod stdio;

#[cfg(test)]
mod guardian;
#[cfg(test)]
mod guardian_cleanup_runtime;
mod guardian_io;
#[cfg(test)]
mod guardian_protocol;
#[cfg(test)]
mod guardian_runtime_descriptors;
#[cfg(test)]
mod guardian_timeout;
#[cfg(all(test, target_os = "linux"))]
mod linux;
#[cfg(all(test, target_os = "macos"))]
mod macos;
#[cfg(test)]
mod platform;
#[cfg(test)]
mod scope;
#[cfg(test)]
mod sentinel;
#[cfg(test)]
#[path = "sentinel_test_support.rs"]
mod sentinel_test_support;

#[cfg(test)]
use custody::{CustodyDrain, CustodyFailure, NativeCustody};

use super::super::{LaunchAttemptMaterializer, resource::ResourceRuntime};
use adapter::Adapter;
use std::{fmt, path::PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidGuardianExecutable;

impl fmt::Display for InvalidGuardianExecutable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("guardian executable is not absolute")
    }
}

impl std::error::Error for InvalidGuardianExecutable {}

pub(crate) fn resource<M>(
    guardian_executable: PathBuf,
    materializer: M,
) -> Result<ResourceRuntime, InvalidGuardianExecutable>
where
    M: LaunchAttemptMaterializer,
{
    Adapter::new(guardian_executable)
        .map(|adapter| ResourceRuntime::deferred(adapter, materializer))
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod protocol_tests;
#[cfg(test)]
#[path = "real_guardian_smoke.rs"]
mod real_guardian_smoke;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
