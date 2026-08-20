use std::fmt;

use foundation::process::{
    ShutdownOutcome,
    supervision::{
        CommandReceipt, CompletionError, RestartOutcome, StartOutcome, Supervisor,
        SupervisorHandle, SupervisorLease, SupervisorOutcome, SupervisorRejection,
        SupervisorSnapshot, TerminationCompletion,
    },
};

pub(super) struct SupervisorOwner {
    handle: SupervisorHandle,
    supervisor: Supervisor,
}

#[derive(Clone)]
pub(super) struct SupervisorLifecycleHandle {
    handle: SupervisorHandle,
}

impl SupervisorOwner {
    pub(super) fn new(supervisor: Supervisor) -> Self {
        Self {
            handle: supervisor.handle(),
            supervisor,
        }
    }

    pub(super) fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    pub(super) fn handle(&self) -> SupervisorHandle {
        self.handle.clone()
    }

    pub(super) fn lifecycle_handle(&self) -> SupervisorLifecycleHandle {
        SupervisorLifecycleHandle {
            handle: self.handle.clone(),
        }
    }

    pub(super) fn lease(&self) -> Option<SupervisorLease> {
        self.handle.lease()
    }

    pub(super) fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.handle.subscribe()
    }

    pub(super) async fn request_start(&self) -> Result<(), SupervisorStartFailureKind> {
        match self.handle.start().await {
            CommandReceipt::Accepted(_)
            | CommandReceipt::Shared(_)
            | CommandReceipt::AlreadySatisfied => Ok(()),
            CommandReceipt::Busy => Err(SupervisorStartFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorStartFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorStartFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn start(&self) -> Result<SupervisorStart, SupervisorStartFailureKind> {
        match self.handle.start().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map(SupervisorStart::from)
                .map_err(SupervisorStartFailureKind::from),
            CommandReceipt::AlreadySatisfied => Ok(SupervisorStart::Started),
            CommandReceipt::Busy => Err(SupervisorStartFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorStartFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorStartFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn stop(
        &self,
    ) -> Result<TerminationCompletion, SupervisorLifecycleFailureKind> {
        match self.handle.stop().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map_err(SupervisorLifecycleFailureKind::from),
            CommandReceipt::AlreadySatisfied => {
                Err(SupervisorLifecycleFailureKind::AlreadySatisfied)
            }
            CommandReceipt::Busy => Err(SupervisorLifecycleFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorLifecycleFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorLifecycleFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn restart(
        &self,
    ) -> Result<SupervisorRestart, SupervisorLifecycleFailureKind> {
        match self.handle.restart().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map(SupervisorRestart::from)
                .map_err(SupervisorLifecycleFailureKind::from),
            CommandReceipt::AlreadySatisfied => {
                Err(SupervisorLifecycleFailureKind::AlreadySatisfied)
            }
            CommandReceipt::Busy => Err(SupervisorLifecycleFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorLifecycleFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorLifecycleFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn confirm_shutdown(
        &self,
    ) -> Result<ShutdownOutcome, SupervisorShutdownFailureKind> {
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

    pub(super) fn begin_join(self) -> PendingSupervisorJoin {
        let mut supervisor = self.supervisor;
        PendingSupervisorJoin {
            task: tokio::spawn(async move {
                supervisor.join().await.map_err(SupervisorJoinError::from)
            }),
        }
    }

    fn confirmed_shutdown_outcome(&self) -> Option<ShutdownOutcome> {
        match self.handle.snapshot().last_outcome() {
            Some(SupervisorOutcome::ShutDown(outcome)) => Some(outcome.clone()),
            _ => None,
        }
    }
}

impl SupervisorLifecycleHandle {
    pub(super) fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    pub(super) async fn start(&self) -> Result<SupervisorStart, SupervisorStartFailureKind> {
        match self.handle.start().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map(SupervisorStart::from)
                .map_err(SupervisorStartFailureKind::from),
            CommandReceipt::AlreadySatisfied => Ok(SupervisorStart::Started),
            CommandReceipt::Busy => Err(SupervisorStartFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorStartFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorStartFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn stop(
        &self,
    ) -> Result<TerminationCompletion, SupervisorLifecycleFailureKind> {
        match self.handle.stop().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map_err(SupervisorLifecycleFailureKind::from),
            CommandReceipt::AlreadySatisfied => {
                Err(SupervisorLifecycleFailureKind::AlreadySatisfied)
            }
            CommandReceipt::Busy => Err(SupervisorLifecycleFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorLifecycleFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorLifecycleFailureKind::ShuttingDown),
        }
    }

    pub(super) async fn restart(
        &self,
    ) -> Result<SupervisorRestart, SupervisorLifecycleFailureKind> {
        match self.handle.restart().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
                .wait()
                .await
                .map(SupervisorRestart::from)
                .map_err(SupervisorLifecycleFailureKind::from),
            CommandReceipt::AlreadySatisfied => {
                Err(SupervisorLifecycleFailureKind::AlreadySatisfied)
            }
            CommandReceipt::Busy => Err(SupervisorLifecycleFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorLifecycleFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorLifecycleFailureKind::ShuttingDown),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum SupervisorStart {
    Started,
    Cancelled,
}

impl From<StartOutcome> for SupervisorStart {
    fn from(outcome: StartOutcome) -> Self {
        match outcome {
            StartOutcome::Started => Self::Started,
            StartOutcome::Cancelled { .. } => Self::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SupervisorStartFailureKind {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
}

impl From<CompletionError> for SupervisorStartFailureKind {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for SupervisorStartFailureKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("supervisor start failed"),
            Self::SupervisorStopped => {
                formatter.write_str("supervisor stopped before start completed")
            }
            Self::Busy => formatter.write_str("supervisor start was busy"),
            Self::Rejected(_) => formatter.write_str("supervisor start was rejected"),
            Self::ShuttingDown => formatter.write_str("supervisor stopped accepting start"),
        }
    }
}

impl std::error::Error for SupervisorStartFailureKind {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum SupervisorRestart {
    Restarted,
    Cancelled,
}

impl From<RestartOutcome> for SupervisorRestart {
    fn from(outcome: RestartOutcome) -> Self {
        match outcome {
            RestartOutcome::Restarted => Self::Restarted,
            RestartOutcome::Cancelled { .. } => Self::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SupervisorLifecycleFailureKind {
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
}

impl From<CompletionError> for SupervisorLifecycleFailureKind {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for SupervisorLifecycleFailureKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("supervisor lifecycle command failed"),
            Self::SupervisorStopped => {
                formatter.write_str("supervisor stopped before lifecycle command completed")
            }
            Self::AlreadySatisfied => {
                formatter.write_str("supervisor lifecycle command was already satisfied")
            }
            Self::Busy => formatter.write_str("supervisor lifecycle command was busy"),
            Self::Rejected(_) => formatter.write_str("supervisor lifecycle command was rejected"),
            Self::ShuttingDown => {
                formatter.write_str("supervisor stopped accepting lifecycle command")
            }
        }
    }
}

impl std::error::Error for SupervisorLifecycleFailureKind {}

pub(super) struct PendingSupervisorJoin {
    task: tokio::task::JoinHandle<Result<(), SupervisorJoinError>>,
}

impl PendingSupervisorJoin {
    pub(super) async fn wait(&mut self) -> Result<(), SupervisorJoinError> {
        (&mut self.task).await.map_err(SupervisorJoinError::from)?
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SupervisorShutdownFailureKind {
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
pub(super) enum SupervisorJoinError {
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
