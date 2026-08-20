use std::{
    fmt,
    time::{Duration, SystemTime},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandState {
    Queued {
        queued_at: SystemTime,
    },
    Running {
        started_at: SystemTime,
    },
    Succeeded {
        completed_at: SystemTime,
    },
    Failed {
        completed_at: SystemTime,
        failure: CommandFailure,
    },
    Cancelled {
        completed_at: SystemTime,
        reason: Option<CommandCancellation>,
    },
    TimedOut {
        completed_at: SystemTime,
        timeout: Duration,
    },
    OutcomeUnknown {
        observed_at: SystemTime,
    },
}

impl CommandState {
    pub const fn is_active(&self) -> bool {
        matches!(self, Self::Queued { .. } | Self::Running { .. })
    }

    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded { .. }
                | Self::Failed { .. }
                | Self::Cancelled { .. }
                | Self::TimedOut { .. }
        )
    }

    pub const fn active_since(&self) -> Option<SystemTime> {
        match self {
            Self::Queued { queued_at } => Some(*queued_at),
            Self::Running { started_at } => Some(*started_at),
            Self::Succeeded { .. }
            | Self::Failed { .. }
            | Self::Cancelled { .. }
            | Self::TimedOut { .. }
            | Self::OutcomeUnknown { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandFailure {
    Rejected,
    Unavailable,
    ExecutionFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandCancellation {
    Requested,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandTransitionError {
    InvalidTransition,
    BackdatedTransition,
    AttemptOverflow,
}

impl fmt::Display for CommandTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition => {
                formatter.write_str("command transition is not allowed for its current state")
            }
            Self::BackdatedTransition => {
                formatter.write_str("command transition cannot predate its current state")
            }
            Self::AttemptOverflow => formatter.write_str("command attempt sequence overflowed"),
        }
    }
}

impl std::error::Error for CommandTransitionError {}
