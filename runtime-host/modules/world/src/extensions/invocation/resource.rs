use std::{future::Future, pin::Pin};

use foundation::execution::OwnedTask;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::ids::{AcquisitionId, InvocationId, PluginGenerationId, ResourceToken};

pub(crate) type CleanupFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), ResourceFailure>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CleanupMode {
    Graceful,
    HostOnly,
}

/// A one-way quarantine signal. Recheck immediately before each guest interaction;
/// an in-flight graceful wait must observe `quarantined` and switch to containment.
#[derive(Clone)]
pub(crate) struct CleanupControl {
    host_only: CancellationToken,
}

impl CleanupControl {
    pub(super) fn new() -> Self {
        Self {
            host_only: CancellationToken::new(),
        }
    }
    pub(super) fn quarantine(&self) {
        self.host_only.cancel();
    }
    pub fn mode(&self) -> CleanupMode {
        if self.host_only.is_cancelled() {
            CleanupMode::HostOnly
        } else {
            CleanupMode::Graceful
        }
    }
    pub fn host_only(&self) -> bool {
        self.host_only.is_cancelled()
    }
    pub async fn quarantined(&self) {
        self.host_only.cancelled().await;
    }
}

/// Host custody only: never invoke guest cleanup after a trap or quarantine.
/// Cancelling this future must leave every unfinished handle in `self` for retry.
pub(crate) trait HostResource: Send {
    fn inspect_process(
        &self,
        _ledger: &super::ResourceLedger,
    ) -> Option<crate::extensions::process::ProcessInspection> {
        None
    }

    fn close_checked(&mut self, deadline: Instant, control: CleanupControl) -> CleanupFuture<'_>;
}

pub(crate) use world_protocol::lifecycle::ResourceKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceState {
    Acquiring,
    Active,
    CancelRequested,
    Releasing,
    WaitingForChildren,
    Retained,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceStage {
    Acquisition,
    Admission,
    Cancel,
    Stop,
    Shutdown,
    SupervisorJoin,
    TaskJoin,
    MaterialCleanup,
    Cleanup,
    Completion,
}

#[derive(Clone, Debug)]
pub(crate) struct ResourcePartFailure {
    pub kind: ResourceKind,
    pub name: String,
    pub stage: ResourceStage,
    pub code: &'static str,
    pub message: String,
}

/// Safe resource-specific diagnostics; adapters retain private causes themselves.
#[derive(Clone, Debug)]
pub(crate) struct ResourceFailure {
    pub stage: ResourceStage,
    pub code: &'static str,
    pub message: String,
    pub remaining: Vec<ResourcePartFailure>,
}

impl ResourceFailure {
    pub fn new(stage: ResourceStage, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            code,
            message: message.into(),
            remaining: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ResourceSpec {
    pub token: ResourceToken,
    pub kind: ResourceKind,
    pub parent: Option<ResourceToken>,
    pub invocation: Option<InvocationId>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResourceSnapshot {
    pub spec: ResourceSpec,
    pub acquisition: Option<AcquisitionId>,
    pub state: ResourceState,
    pub failure: Option<ResourceFailure>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Admission {
    Open,
    Closing,
    Closed,
}

#[derive(Clone, Debug)]
pub(crate) struct LedgerSnapshot {
    pub generation: PluginGenerationId,
    pub admission: Admission,
    pub dependency_retained: usize,
    pub invocation_inflight: usize,
    pub acquisitions: usize,
    pub resources: Vec<ResourceSnapshot>,
}

#[derive(Debug)]
pub(crate) enum DrainOutcome {
    Drained,
    Retained(LedgerSnapshot),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionFailure {
    Closed,
    StillOpen,
    DuplicateToken(ResourceToken),
    DuplicateAcquisition(AcquisitionId),
    GenerationConflict(PluginGenerationId),
    ParentUnavailable(ResourceToken),
}

/// A concrete Foundation task resource, not a second executor. Any separately
/// owned I/O or child resource must have its own ledger entry before spawning.
pub(crate) struct TaskResource<T> {
    task: Option<OwnedTask<T>>,
    check: fn(T) -> Result<(), ResourceFailure>,
    failure: Option<ResourceFailure>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl<T> TaskResource<T> {
    pub fn new(task: OwnedTask<T>, check: fn(T) -> Result<(), ResourceFailure>) -> Self {
        Self {
            task: Some(task),
            check,
            failure: None,
            permit: None,
        }
    }

    pub fn with_permit(mut self, permit: tokio::sync::OwnedSemaphorePermit) -> Self {
        self.permit = Some(permit);
        self
    }
}

impl<T: Send + 'static> HostResource for TaskResource<T> {
    fn close_checked(&mut self, deadline: Instant, _control: CleanupControl) -> CleanupFuture<'_> {
        Box::pin(async move {
            if let Some(failure) = &self.failure {
                return Err(failure.clone());
            }
            let Some(task) = &mut self.task else {
                return Ok(());
            };
            let result = tokio::time::timeout_at(deadline, task.cancel_and_join()).await;
            let result = match result {
                Err(_) => {
                    return Err(ResourceFailure::new(
                        ResourceStage::TaskJoin,
                        "task_join_deadline",
                        "task has not joined before the deadline",
                    ));
                }
                Ok(Ok(output)) => (self.check)(output),
                Ok(Err(error)) => Err(ResourceFailure::new(
                    ResourceStage::TaskJoin,
                    if error.is_panic() {
                        "task_panicked"
                    } else {
                        "task_aborted"
                    },
                    "task exited without a checked cleanup result",
                )),
            };
            self.task = None;
            if result.is_ok() {
                self.permit = None;
            }
            self.failure = result.as_ref().err().cloned();
            result
        })
    }
}
