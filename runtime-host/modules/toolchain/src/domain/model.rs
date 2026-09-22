use std::fmt;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolAvailability {
    Available,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PythonReadiness {
    Ready,
    NotReady,
    Unknown,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    uv: ToolAvailability,
    python: PythonReadiness,
}

impl ToolchainStatus {
    pub(crate) fn new(uv: ToolAvailability, python: PythonReadiness) -> Self {
        Self { uv, python }
    }

    pub fn uv(&self) -> ToolAvailability {
        self.uv
    }

    pub fn python(&self) -> PythonReadiness {
        self.python
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrepareOutcome {
    Ready,
    Installed,
    Rejected,
    Unknown,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainError {
    WorkingDirectoryUnavailable,
}

impl fmt::Display for ToolchainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Toolchain working directory is unavailable")
    }
}

impl std::error::Error for ToolchainError {}
