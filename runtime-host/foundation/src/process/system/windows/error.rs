use std::fmt;

use windows_sys::Win32::Foundation as F;

use super::super::super::supervision::LaunchFailure;

#[derive(Debug)]
pub(crate) struct WindowsCustodyError {
    operation: &'static str,
    code: Option<u32>,
}

impl WindowsCustodyError {
    pub(super) const fn invalid(operation: &'static str) -> Self {
        Self {
            operation,
            code: None,
        }
    }

    pub(super) const fn native(operation: &'static str, code: u32) -> Self {
        Self {
            operation,
            code: Some(code),
        }
    }

    pub(super) const fn launch_failure(&self) -> LaunchFailure {
        match self.code {
            Some(
                F::ERROR_FILE_NOT_FOUND
                | F::ERROR_PATH_NOT_FOUND
                | F::ERROR_MOD_NOT_FOUND
                | F::ERROR_BAD_EXE_FORMAT
                | F::ERROR_EXE_MACHINE_TYPE_MISMATCH,
            ) => LaunchFailure::ArtifactUnavailable,
            Some(
                F::ERROR_ACCESS_DENIED | F::ERROR_PRIVILEGE_NOT_HELD | F::ERROR_ELEVATION_REQUIRED,
            ) => LaunchFailure::PermissionDenied,
            Some(
                F::ERROR_TOO_MANY_OPEN_FILES
                | F::ERROR_NOT_ENOUGH_MEMORY
                | F::ERROR_OUTOFMEMORY
                | F::ERROR_NO_SYSTEM_RESOURCES
                | F::ERROR_COMMITMENT_LIMIT
                | F::ERROR_NOT_ENOUGH_QUOTA,
            ) => LaunchFailure::ResourceUnavailable,
            Some(_) | None => LaunchFailure::PlatformRejected,
        }
    }
}

impl fmt::Display for WindowsCustodyError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{}", self.operation)?;
        if let Some(code) = self.code {
            write!(out, " (Windows error {code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for WindowsCustodyError {}
