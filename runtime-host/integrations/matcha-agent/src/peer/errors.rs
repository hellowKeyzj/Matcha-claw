use foundation::process::supervision::{CompletionError, SupervisorRejection};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
}

impl From<CompletionError> for LifecycleError {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("matcha peer lifecycle command failed"),
            Self::SupervisorStopped => {
                formatter.write_str("matcha peer stopped before lifecycle command completed")
            }
            Self::AlreadySatisfied => {
                formatter.write_str("matcha peer lifecycle command was already satisfied")
            }
            Self::Busy => formatter.write_str("matcha peer lifecycle command was busy"),
            Self::Rejected(_) => formatter.write_str("matcha peer lifecycle command was rejected"),
            Self::ShuttingDown => {
                formatter.write_str("matcha peer stopped accepting lifecycle commands")
            }
        }
    }
}

impl std::error::Error for LifecycleError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownError {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    MissingOutcome,
}

impl From<CompletionError> for ShutdownError {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for ShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("matcha peer shutdown failed"),
            Self::SupervisorStopped => {
                formatter.write_str("matcha peer stopped before shutdown completed")
            }
            Self::Busy => formatter.write_str("matcha peer shutdown was busy"),
            Self::Rejected(_) => formatter.write_str("matcha peer shutdown was rejected"),
            Self::ShuttingDown => formatter.write_str("matcha peer stopped accepting shutdown"),
            Self::MissingOutcome => {
                formatter.write_str("matcha peer shutdown outcome was unavailable")
            }
        }
    }
}

impl std::error::Error for ShutdownError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinError {
    Cancelled,
    Panicked,
    TransportCleanup,
}

impl From<tokio::task::JoinError> for JoinError {
    fn from(error: tokio::task::JoinError) -> Self {
        if error.is_cancelled() {
            Self::Cancelled
        } else {
            Self::Panicked
        }
    }
}

impl fmt::Display for JoinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("matcha peer supervisor task was cancelled"),
            Self::Panicked => formatter.write_str("matcha peer supervisor task panicked"),
            Self::TransportCleanup => formatter.write_str("matcha peer transport cleanup failed"),
        }
    }
}

impl std::error::Error for JoinError {}
