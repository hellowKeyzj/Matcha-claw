use std::fmt;

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};

/// A single-use native executable capability. It is deliberately distinct from
/// `LaunchSpec`: callers may use a pathname for command-line construction, but
/// a source-backed launch always executes this capability instead.
pub struct ExecutionSource {
    #[cfg(target_os = "linux")]
    executable: OwnedFd,
    #[cfg(windows)]
    pin: std::fs::File,
}

impl ExecutionSource {
    #[cfg(target_os = "linux")]
    pub fn from_linux_executable(executable: OwnedFd) -> Result<Self, ExecutionSourceError> {
        if executable.as_raw_fd() < 0 {
            return Err(ExecutionSourceError);
        }
        Ok(Self { executable })
    }

    #[cfg(windows)]
    pub fn from_windows_pin(pin: std::fs::File) -> Result<Self, ExecutionSourceError> {
        pin.metadata().map_err(|_| ExecutionSourceError)?;
        Ok(Self { pin })
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn into_linux_fd(self) -> OwnedFd {
        self.executable
    }

    #[cfg(windows)]
    pub(crate) fn pin(&self) -> &std::fs::File {
        &self.pin
    }
}

impl fmt::Debug for ExecutionSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ExecutionSource(<native>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecutionSourceError;

impl fmt::Display for ExecutionSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("native execution source is unavailable")
    }
}

impl std::error::Error for ExecutionSourceError {}
