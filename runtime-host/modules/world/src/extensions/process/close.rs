use std::{fmt, future::Future, pin::Pin, sync::Arc};

use foundation::{
    execution::OwnedTask,
    process::{
        ShutdownOutcome, TerminationOutcome,
        supervision::{
            CommandReceipt, CompletionError, Supervisor, SupervisorHandle, SupervisorOutcome,
            SupervisorRejection, TerminationCompletion,
        },
    },
};
use tokio::{
    task::JoinError,
    time::{Instant, timeout_at},
};

use crate::extensions::invocation::{
    CleanupControl, CleanupMode, ResourceFailure, ResourceKind, ResourcePartFailure, ResourceStage,
};

/// Every pending command stays owned across cancellation of the caller's close future.
type Pending<T> = Pin<Box<dyn Future<Output = Result<T, ControlFailure>> + Send>>;

pub(super) struct ProcessCustody {
    pub(super) supervisor: Supervisor,
    stop: Option<Pending<Option<TerminationCompletion>>>,
    stop_result: Option<Result<Option<TerminationCompletion>, Arc<ControlFailure>>>,
    shutdown: Option<Pending<ShutdownOutcome>>,
    shutdown_result: Option<Result<ShutdownOutcome, Arc<ControlFailure>>>,
    joined: bool,
    join_failure: Option<Arc<JoinError>>,
}

impl ProcessCustody {
    pub(super) fn new(supervisor: Supervisor) -> Self {
        Self {
            supervisor,
            stop: None,
            stop_result: None,
            shutdown: None,
            shutdown_result: None,
            joined: false,
            join_failure: None,
        }
    }

    pub(super) fn remaining(&self) -> Vec<ResourcePartFailure> {
        if self.joined {
            return Vec::new();
        }
        let mut remaining = vec![ResourcePartFailure {
            kind: ResourceKind::Process,
            name: "supervisor".into(),
            stage: ResourceStage::SupervisorJoin,
            code: "supervisor_join_not_confirmed",
            message: "process supervisor has not joined".into(),
        }];
        let terminated = matches!(
            self.shutdown_result.as_ref(),
            Some(Ok(ShutdownOutcome::Terminated(
                TerminationOutcome::Graceful(_)
                    | TerminationOutcome::Forced(_)
                    | TerminationOutcome::NoProcess
            )))
        );
        if !terminated {
            remaining.push(ResourcePartFailure {
                kind: ResourceKind::PrivateMaterial,
                name: "launch_material".into(),
                stage: ResourceStage::MaterialCleanup,
                code: "private_material_cleanup_not_confirmed",
                message: "launch material cleanup has not been confirmed".into(),
            });
        }
        remaining
    }

    pub(super) async fn close_checked(
        &mut self,
        deadline: Instant,
        control: &CleanupControl,
    ) -> Result<(), CloseFailure> {
        if control.mode() == CleanupMode::Graceful
            && self.stop_result.is_none()
            && self.shutdown.is_none()
            && self.shutdown_result.is_none()
        {
            let handle = self.supervisor.handle();
            let pending = self.stop.get_or_insert_with(|| {
                Box::pin(async move { await_receipt(handle.stop().await).await })
            });
            // Reserve time for containment shutdown and checked joins, even if guest stop hangs.
            let now = Instant::now();
            let stop_deadline = now + deadline.saturating_duration_since(now) / 2;
            tokio::select! {
                biased;
                _ = control.quarantined() => {}
                result = timeout_at(stop_deadline, pending.as_mut()) => {
                    if let Ok(result) = result {
                        self.stop_result = Some(result.map_err(Arc::new));
                        self.stop = None;
                    }
                }
            }
        }

        if self.shutdown_result.is_none() {
            let handle = self.supervisor.handle();
            let pending = self
                .shutdown
                .get_or_insert_with(|| Box::pin(shutdown(handle)));
            match timeout_at(deadline, pending.as_mut()).await {
                Ok(result) => {
                    self.shutdown_result = Some(result.map_err(Arc::new));
                    self.shutdown = None;
                }
                Err(_) => return Err(CloseFailure::Deadline(CloseStage::Shutdown)),
            }
        }

        let shutdown_confirmed = matches!(
            self.shutdown_result.as_ref(),
            Some(Ok(ShutdownOutcome::Terminated(
                TerminationOutcome::Graceful(_)
                    | TerminationOutcome::Forced(_)
                    | TerminationOutcome::NoProcess
            )))
        );
        if !shutdown_confirmed {
            // Unresolved Foundation shutdown is retryable; retain the complete Supervisor.
            let cause = self
                .shutdown_result
                .take()
                .expect("shutdown result recorded");
            return Err(match cause {
                Ok(outcome) => CloseFailure::Shutdown(outcome),
                Err(cause) => CloseFailure::Control {
                    stage: CloseStage::Shutdown,
                    cause,
                },
            });
        }

        if !self.joined {
            if let Some(cause) = &self.join_failure {
                return Err(CloseFailure::SupervisorJoin(cause.clone()));
            }
            match timeout_at(deadline, self.supervisor.join()).await {
                Ok(Ok(())) => self.joined = true,
                Ok(Err(cause)) => {
                    let cause = Arc::new(cause);
                    self.join_failure = Some(cause.clone());
                    return Err(CloseFailure::SupervisorJoin(cause));
                }
                Err(_) => return Err(CloseFailure::Deadline(CloseStage::SupervisorJoin)),
            }
        }
        // A stop completion can be superseded by shutdown; retain its final evidence too.
        if let Some(pending) = self.stop.as_mut() {
            let result = timeout_at(deadline, pending.as_mut())
                .await
                .map_err(|_| CloseFailure::Deadline(CloseStage::Stop))?;
            self.stop_result = Some(result.map_err(Arc::new));
            self.stop = None;
        }
        Ok(())
    }
}

pub(super) async fn shutdown(handle: SupervisorHandle) -> Result<ShutdownOutcome, ControlFailure> {
    if let Some(outcome) = await_receipt(handle.shutdown().await).await? {
        return Ok(outcome);
    }
    match handle.snapshot().last_outcome() {
        Some(SupervisorOutcome::ShutDown(outcome)) => Ok(outcome.clone()),
        _ => Err(ControlFailure::MissingOutcome),
    }
}

async fn await_receipt<T: Clone>(receipt: CommandReceipt<T>) -> Result<Option<T>, ControlFailure> {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
            .wait()
            .await
            .map(Some)
            .map_err(ControlFailure::Completion),
        CommandReceipt::AlreadySatisfied => Ok(None),
        CommandReceipt::Busy => Err(ControlFailure::Busy),
        CommandReceipt::Rejected(cause) => Err(ControlFailure::Rejected(cause)),
        CommandReceipt::ShuttingDown => Err(ControlFailure::ShuttingDown),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CloseStage {
    Stop,
    Shutdown,
    SupervisorJoin,
    ReaderJoin,
    WriterJoin,
    StderrJoin,
    FaultJoin,
    HostJoin,
}

#[derive(Debug)]
pub(super) enum ControlFailure {
    Completion(CompletionError),
    Rejected(SupervisorRejection),
    Busy,
    ShuttingDown,
    MissingOutcome,
}

#[derive(Debug)]
pub(super) enum CloseFailure {
    Deadline(CloseStage),
    Control {
        stage: CloseStage,
        cause: Arc<ControlFailure>,
    },
    Shutdown(ShutdownOutcome),
    SupervisorJoin(Arc<JoinError>),
    TaskJoin {
        stage: CloseStage,
        cause: Arc<JoinError>,
    },
}

impl CloseFailure {
    pub(super) fn safe_resource_failure(
        &self,
        remaining: Vec<ResourcePartFailure>,
    ) -> ResourceFailure {
        let (stage, code) = match self {
            Self::Deadline(stage) => (stage.resource_stage(), "process_close_deadline"),
            Self::Control { stage, cause } => (
                stage.resource_stage(),
                match cause.as_ref() {
                    ControlFailure::Completion(CompletionError::SupervisorStopped) => {
                        "supervisor_stopped_before_completion"
                    }
                    ControlFailure::Completion(CompletionError::Failed(_)) => {
                        "process_control_failed"
                    }
                    ControlFailure::Rejected(_) => "process_control_rejected",
                    ControlFailure::Busy => "process_control_busy",
                    ControlFailure::ShuttingDown => "process_control_shutting_down",
                    ControlFailure::MissingOutcome => "process_shutdown_outcome_missing",
                },
            ),
            Self::Shutdown(
                ShutdownOutcome::Unresolved { failure }
                | ShutdownOutcome::Terminated(TerminationOutcome::Failed(failure)),
            ) => (
                if *failure == foundation::process::TerminationFailure::MaterialCleanupFailed {
                    ResourceStage::MaterialCleanup
                } else {
                    ResourceStage::Shutdown
                },
                match failure {
                    foundation::process::TerminationFailure::AuthorityLost => {
                        "process_authority_lost"
                    }
                    foundation::process::TerminationFailure::CleanupUnconfirmed => {
                        "process_cleanup_not_confirmed"
                    }
                    foundation::process::TerminationFailure::MaterialCleanupFailed => {
                        "private_material_cleanup_failed"
                    }
                },
            ),
            Self::Shutdown(ShutdownOutcome::Detached) => {
                (ResourceStage::Shutdown, "process_detached_not_closed")
            }
            Self::Shutdown(_) => (ResourceStage::Shutdown, "process_exit_not_confirmed"),
            Self::SupervisorJoin(_) => (ResourceStage::SupervisorJoin, "supervisor_join_failed"),
            Self::TaskJoin { .. } => (ResourceStage::TaskJoin, "process_task_join_failed"),
        };
        ResourceFailure {
            stage,
            code,
            message: self.to_string(),
            remaining,
        }
    }
}

impl CloseStage {
    fn resource_stage(self) -> ResourceStage {
        match self {
            Self::Stop => ResourceStage::Stop,
            Self::Shutdown => ResourceStage::Shutdown,
            Self::SupervisorJoin => ResourceStage::SupervisorJoin,
            Self::ReaderJoin
            | Self::WriterJoin
            | Self::StderrJoin
            | Self::FaultJoin
            | Self::HostJoin => ResourceStage::TaskJoin,
        }
    }
}

impl std::error::Error for CloseFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Control { cause, .. } => match cause.as_ref() {
                ControlFailure::Completion(cause) => Some(cause),
                _ => None,
            },
            Self::SupervisorJoin(cause) | Self::TaskJoin { cause, .. } => Some(cause.as_ref()),
            _ => None,
        }
    }
}

impl fmt::Display for CloseFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Deadline(_) => "process resource close deadline elapsed",
            Self::Control { .. } => "process close command was not confirmed",
            Self::Shutdown(_) => {
                "process termination or private material cleanup was not confirmed"
            }
            Self::SupervisorJoin(_) => "process supervisor join failed",
            Self::TaskJoin { .. } => "process protocol task join failed",
        })
    }
}

/// Keep successful or failed joins, since polling a consumed JoinHandle again is invalid.
pub(super) struct JoinedTask<T: Send + 'static> {
    task: Option<OwnedTask<T>>,
    result: Option<Result<T, Arc<JoinError>>>,
}

impl<T: Send + 'static> JoinedTask<T> {
    pub(super) fn new(task: OwnedTask<T>) -> Self {
        Self {
            task: Some(task),
            result: None,
        }
    }

    pub(super) fn remaining(&self, name: &'static str) -> Option<ResourcePartFailure> {
        match &self.result {
            Some(_) => None,
            _ => Some(ResourcePartFailure {
                kind: ResourceKind::TaskJoin,
                name: name.into(),
                stage: ResourceStage::TaskJoin,
                code: if self.result.is_some() {
                    "process_task_join_failed"
                } else {
                    "process_task_join_not_confirmed"
                },
                message: "process protocol task cleanup has not been confirmed".into(),
            }),
        }
    }

    pub(super) fn is_finished(&self) -> bool {
        self.result.is_some() || self.task.as_ref().is_some_and(OwnedTask::is_finished)
    }

    pub(super) fn cancel(&self) {
        if let Some(task) = &self.task {
            task.cancel();
        }
    }

    pub(super) async fn join_checked(
        &mut self,
        stage: CloseStage,
        deadline: Instant,
    ) -> Result<&T, CloseFailure> {
        if self.result.is_none() {
            let task = self.task.as_mut().expect("unjoined process task retained");
            let result = timeout_at(deadline, task.join())
                .await
                .map_err(|_| CloseFailure::Deadline(stage))?;
            self.result = Some(result.map_err(Arc::new));
            self.task = None;
        }
        self.result
            .as_ref()
            .expect("process task join result recorded")
            .as_ref()
            .map_err(|cause| CloseFailure::TaskJoin {
                stage,
                cause: cause.clone(),
            })
    }
}
