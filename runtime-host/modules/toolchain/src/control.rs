use crate::{PrepareOutcome, ToolchainStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolchainControlOutcome {
    Status(ToolchainStatus),
    Prepare(PrepareControlOutcome),
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrepareControlOutcome {
    Ready,
    Installed,
    Rejected,
    Unknown,
}

impl PrepareControlOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Installed => "installed",
            Self::Rejected => "rejected",
            Self::Unknown => "unknown",
        }
    }
}

pub fn project_status(status: ToolchainStatus) -> ToolchainControlOutcome {
    ToolchainControlOutcome::Status(status)
}

pub fn project_prepare(outcome: PrepareOutcome) -> ToolchainControlOutcome {
    match outcome {
        PrepareOutcome::Ready => ToolchainControlOutcome::Prepare(PrepareControlOutcome::Ready),
        PrepareOutcome::Installed => {
            ToolchainControlOutcome::Prepare(PrepareControlOutcome::Installed)
        }
        PrepareOutcome::Rejected => {
            ToolchainControlOutcome::Prepare(PrepareControlOutcome::Rejected)
        }
        PrepareOutcome::Unknown => ToolchainControlOutcome::Prepare(PrepareControlOutcome::Unknown),
        PrepareOutcome::Unavailable | PrepareOutcome::Unsupported => {
            ToolchainControlOutcome::Unavailable
        }
    }
}
