use std::fmt;

use foundation::process::{
    ShutdownOutcome,
    supervision::{
        CommandReceipt, CompletionError, Supervisor, SupervisorHandle, SupervisorLease,
        SupervisorOutcome, SupervisorRejection, SupervisorSnapshot,
    },
};

pub struct SupervisorOwner {
    handle: SupervisorHandle,
    supervisor: Supervisor,
}

#[derive(Clone)]
pub struct SupervisorLifecycleHandle {
    handle: SupervisorHandle,
}

impl SupervisorOwner {
    pub fn new(supervisor: Supervisor) -> Self {
        Self {
            handle: supervisor.handle(),
            supervisor,
        }
    }

    pub fn handle(&self) -> SupervisorHandle {
        self.handle.clone()
    }

    pub fn lifecycle_handle(&self) -> SupervisorLifecycleHandle {
        SupervisorLifecycleHandle {
            handle: self.handle.clone(),
        }
    }

    pub fn begin_join(self) -> PendingSupervisorJoin {
        let mut supervisor = self.supervisor;
        PendingSupervisorJoin {
            task: tokio::spawn(async move {
                supervisor.join().await.map_err(SupervisorJoinError::from)
            }),
        }
    }
}

impl SupervisorLifecycleHandle {
    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    pub fn lease(&self) -> Option<SupervisorLease> {
        self.handle.lease()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.handle.subscribe()
    }

    pub async fn confirm_shutdown(&self) -> Result<ShutdownOutcome, SupervisorShutdownFailureKind> {
        match self.handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map_err(SupervisorShutdownFailureKind::from),
            CommandReceipt::AlreadySatisfied => self
                .confirmed_shutdown_outcome()
                .ok_or(SupervisorShutdownFailureKind::MissingOutcome),
            CommandReceipt::Busy => Err(SupervisorShutdownFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorShutdownFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorShutdownFailureKind::ShuttingDown),
        }
    }

    fn confirmed_shutdown_outcome(&self) -> Option<ShutdownOutcome> {
        match self.handle.snapshot().last_outcome() {
            Some(SupervisorOutcome::ShutDown(outcome)) => Some(outcome.clone()),
            _ => None,
        }
    }
}

pub struct PendingSupervisorJoin {
    task: tokio::task::JoinHandle<Result<(), SupervisorJoinError>>,
}

impl PendingSupervisorJoin {
    pub async fn wait(&mut self) -> Result<(), SupervisorJoinError> {
        (&mut self.task).await.map_err(SupervisorJoinError::from)?
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorShutdownFailureKind {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    MissingOutcome,
}

impl From<CompletionError> for SupervisorShutdownFailureKind {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for SupervisorShutdownFailureKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("supervisor shutdown failed"),
            Self::SupervisorStopped => {
                formatter.write_str("supervisor stopped before shutdown completed")
            }
            Self::Busy => formatter.write_str("supervisor shutdown was busy"),
            Self::Rejected(_) => formatter.write_str("supervisor shutdown was rejected"),
            Self::ShuttingDown => formatter.write_str("supervisor stopped accepting shutdown"),
            Self::MissingOutcome => {
                formatter.write_str("supervisor shutdown outcome was unavailable")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorJoinError {
    Cancelled,
    Panicked,
}

impl From<tokio::task::JoinError> for SupervisorJoinError {
    fn from(error: tokio::task::JoinError) -> Self {
        if error.is_cancelled() {
            Self::Cancelled
        } else {
            Self::Panicked
        }
    }
}

impl fmt::Display for SupervisorJoinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("supervisor task was cancelled"),
            Self::Panicked => formatter.write_str("supervisor task panicked"),
        }
    }
}

impl std::error::Error for SupervisorJoinError {}
