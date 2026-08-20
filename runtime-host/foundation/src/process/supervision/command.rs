use std::fmt;

use tokio::sync::watch;

use super::super::{
    ExitObservation, ProcessObservation, ShutdownOutcome, TerminationFailure, TerminationOutcome,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorPhase {
    Idle,
    Starting,
    Running,
    Stopping,
    WaitingToRestart,
    OperationFailed,
    ShutDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorOperation {
    Start,
    Restart,
    Stop,
    Kill,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ControlIntent {
    Stop,
    Kill,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RestartEpisode(u32);

impl RestartEpisode {
    pub const fn initial() -> Self {
        Self(0)
    }

    pub const fn settled_failures(self) -> u32 {
        self.0
    }

    pub(crate) const fn checked_next(self) -> Option<Self> {
        match self.0.checked_add(1) {
            Some(failures) => Some(Self(failures)),
            None => None,
        }
    }

    pub const fn from_settled_failures(failures: u32) -> Self {
        Self(failures)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchFailure {
    ArtifactUnavailable,
    PermissionDenied,
    ResourceUnavailable,
    PlatformRejected,
}

impl fmt::Display for LaunchFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArtifactUnavailable => formatter.write_str("process artifact is unavailable"),
            Self::PermissionDenied => formatter.write_str("process launch permission was denied"),
            Self::ResourceUnavailable => {
                formatter.write_str("process launch resource is unavailable")
            }
            Self::PlatformRejected => {
                formatter.write_str("process launch was rejected by the platform")
            }
        }
    }
}

impl std::error::Error for LaunchFailure {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SupervisorFailure {
    LaunchFailed(LaunchFailure),
    StdioFailed,
    ReadinessFailed,
    Exited(ExitObservation),
    Termination(TerminationFailure),
}

impl fmt::Display for SupervisorFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LaunchFailed(failure) => failure.fmt(formatter),
            Self::StdioFailed => formatter.write_str("process stdio activation failed"),
            Self::ReadinessFailed => formatter.write_str("process readiness failed"),
            Self::Exited(_) => formatter.write_str("process exited unexpectedly"),
            Self::Termination(failure) => failure.fmt(formatter),
        }
    }
}

impl std::error::Error for SupervisorFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorRejection {
    AuthorityLost,
    NoTerminationAuthority,
    RecoveryRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartOutcome {
    Started,
    Cancelled {
        by: ControlIntent,
        cleanup: TerminationOutcome,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestartOutcome {
    Restarted,
    Cancelled {
        by: ControlIntent,
        cleanup: TerminationOutcome,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminationCompletion {
    Completed(TerminationOutcome),
    Superseded {
        by: ControlIntent,
        final_outcome: TerminationOutcome,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SupervisorOutcome {
    Started(StartOutcome),
    Restarted(RestartOutcome),
    Terminated(TerminationCompletion),
    ShutDown(ShutdownOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisorSnapshot {
    phase: SupervisorPhase,
    process: Option<ProcessObservation>,
    active_operation: Option<SupervisorOperation>,
    restart_episode: RestartEpisode,
    failure: Option<SupervisorFailure>,
    last_outcome: Option<SupervisorOutcome>,
}

impl SupervisorSnapshot {
    pub(crate) const fn idle() -> Self {
        Self {
            phase: SupervisorPhase::Idle,
            process: None,
            active_operation: None,
            restart_episode: RestartEpisode::initial(),
            failure: None,
            last_outcome: None,
        }
    }

    pub const fn phase(&self) -> SupervisorPhase {
        self.phase
    }

    pub const fn process(&self) -> Option<ProcessObservation> {
        self.process
    }

    pub const fn active_operation(&self) -> Option<SupervisorOperation> {
        self.active_operation
    }

    pub const fn restart_episode(&self) -> RestartEpisode {
        self.restart_episode
    }

    pub const fn failure(&self) -> Option<&SupervisorFailure> {
        self.failure.as_ref()
    }

    pub const fn last_outcome(&self) -> Option<&SupervisorOutcome> {
        self.last_outcome.as_ref()
    }

    pub(crate) fn update(
        &mut self,
        phase: SupervisorPhase,
        process: Option<ProcessObservation>,
        active_operation: Option<SupervisorOperation>,
        restart_episode: RestartEpisode,
        failure: Option<SupervisorFailure>,
        last_outcome: Option<SupervisorOutcome>,
    ) {
        self.phase = phase;
        self.process = process;
        self.active_operation = active_operation;
        self.restart_episode = restart_episode;
        self.failure = failure;
        self.last_outcome = last_outcome;
    }
}

#[derive(Debug)]
pub enum CompletionError {
    Failed(SupervisorFailure),
    SupervisorStopped,
}

impl fmt::Display for CompletionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(failure) => failure.fmt(formatter),
            Self::SupervisorStopped => formatter.write_str("supervisor stopped before completion"),
        }
    }
}

impl std::error::Error for CompletionError {}

pub struct Completion<T> {
    receiver: watch::Receiver<Option<Result<T, SupervisorFailure>>>,
}

impl<T: Clone> Completion<T> {
    pub(crate) const fn new(
        receiver: watch::Receiver<Option<Result<T, SupervisorFailure>>>,
    ) -> Self {
        Self { receiver }
    }

    pub async fn wait(mut self) -> Result<T, CompletionError> {
        loop {
            if let Some(result) = self.receiver.borrow().clone() {
                return result.map_err(CompletionError::Failed);
            }
            if self.receiver.changed().await.is_err() {
                return Err(CompletionError::SupervisorStopped);
            }
        }
    }
}

pub enum CommandReceipt<T> {
    Accepted(Completion<T>),
    Shared(Completion<T>),
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
}
