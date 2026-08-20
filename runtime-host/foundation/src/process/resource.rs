use std::{future::Future, num::NonZeroU64, pin::Pin, sync::Arc};

use tokio::sync::{mpsc, oneshot};

use super::supervision::LaunchFailure;
use super::{
    ExitObservation, LaunchAttemptGuard, LaunchAttemptMaterializer, LaunchRequest,
    ProcessObservation, ProcessStdio, TerminationFailure, task::TaskOwner,
};

mod adapter;
mod client;
mod owner;

#[cfg(test)]
mod tests;

const REQUEST_CAPACITY: usize = 4;
const EVENT_CAPACITY: usize = 8;

pub(crate) type NativeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ResourceEpoch(NonZeroU64);

impl ResourceEpoch {
    const INITIAL: Self = Self(NonZeroU64::MIN);

    #[cfg(test)]
    pub(crate) fn test(value: u64) -> Self {
        Self(NonZeroU64::new(value).expect("test epoch must be non-zero"))
    }

    #[cfg(test)]
    const fn new(value: NonZeroU64) -> Self {
        Self(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalOrigin {
    ObservedDrain,
    DestructiveCleanup,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalEvidence {
    epoch: ResourceEpoch,
    exit: ExitObservation,
    origin: TerminalOrigin,
}

impl TerminalEvidence {
    #[cfg(test)]
    pub(crate) fn test(epoch: ResourceEpoch, exit: ExitObservation) -> SharedTerminalEvidence {
        Arc::new(Self {
            epoch,
            exit,
            origin: TerminalOrigin::ObservedDrain,
        })
    }

    pub(crate) const fn epoch(&self) -> ResourceEpoch {
        self.epoch
    }

    pub(crate) const fn exit(&self) -> &ExitObservation {
        &self.exit
    }

    pub(crate) const fn origin(&self) -> TerminalOrigin {
        self.origin
    }
}

pub(crate) type SharedTerminalEvidence = Arc<TerminalEvidence>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BeginDrained {
    LaunchFailed(LaunchFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ActivationOutcome {
    Active,
    Terminal(SharedTerminalEvidence),
    Unresolved {
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    },
}

pub(crate) struct Activation {
    sender: oneshot::Sender<()>,
    outcome: oneshot::Receiver<ActivationOutcome>,
}

impl Activation {
    #[cfg(test)]
    pub(crate) fn closed() -> Self {
        let (sender, activation) = oneshot::channel();
        drop(activation);
        let (outcome, receiver) = oneshot::channel();
        drop(outcome);
        Self {
            sender,
            outcome: receiver,
        }
    }

    pub(crate) async fn activate(self) -> Result<ActivationOutcome, ResourceFailure> {
        self.sender
            .send(())
            .map_err(|_| ResourceFailure::OwnerStopped)?;
        self.outcome
            .await
            .map_err(|_| ResourceFailure::OwnerStopped)
    }
}

pub(crate) struct ManagedObservation {
    pub(crate) epoch: ResourceEpoch,
    pub(crate) observation: ProcessObservation,
    pub(crate) stdio: ProcessStdio,
    pub(crate) activation: Activation,
}

pub(crate) enum BeginCompletion {
    Installed(ManagedObservation),
    Drained(BeginDrained),
    MaterialCleanupFailed {
        epoch: ResourceEpoch,
    },
    Unresolved {
        epoch: ResourceEpoch,
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    },
}

pub(crate) enum ResourceEvent {
    BeginAccepted(ResourceEpoch),
    BeginCompleted {
        epoch: ResourceEpoch,
        completion: BeginCompletion,
    },
    NativeFact(SharedTerminalEvidence),
    MaterialCleanupFailed(SharedTerminalEvidence),
    Unresolved {
        epoch: ResourceEpoch,
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    },
    OwnerStopped,
}

struct ResourceEventSender(mpsc::Sender<ResourceEvent>);

impl ResourceEventSender {
    async fn send(
        &self,
        event: ResourceEvent,
    ) -> Result<(), mpsc::error::SendError<ResourceEvent>> {
        if let ResourceEvent::BeginCompleted {
            epoch,
            completion: BeginCompletion::Installed(installed),
        } = &event
        {
            assert_eq!(*epoch, installed.epoch, "installed resource epoch mismatch");
        }
        self.0.send(event).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceFailure {
    EpochMismatch,
    AuthorityLost,
    CleanupUnconfirmed,
    MaterialCleanupFailed,
    TimedOut,
    OwnerStopped,
}

impl From<TerminationFailure> for ResourceFailure {
    fn from(failure: TerminationFailure) -> Self {
        match failure {
            TerminationFailure::AuthorityLost => Self::AuthorityLost,
            TerminationFailure::CleanupUnconfirmed => Self::CleanupUnconfirmed,
            TerminationFailure::MaterialCleanupFailed => Self::MaterialCleanupFailed,
        }
    }
}

pub(crate) enum ResourceShutdown {
    Terminated(SharedTerminalEvidence),
    Detached,
    NoResource,
    Unresolved(TerminationFailure),
}

pub(crate) struct NativeStdio(ProcessStdio);

impl NativeStdio {
    pub(crate) const fn new(stdio: ProcessStdio) -> Self {
        Self(stdio)
    }

    fn into_stdio(self) -> ProcessStdio {
        self.0
    }
}

pub(crate) enum NativeInstallResult {
    Installed(ProcessObservation, NativeStdio),
    Drained(BeginDrained),
    Unresolved {
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    },
}

pub(crate) enum NativePollResult {
    Pending,
    Drained(ExitObservation),
    Unresolved(TerminationFailure),
}

pub(crate) enum NativeCleanupResult {
    AlreadyDrained(ExitObservation),
    Terminated(ExitObservation),
    Unresolved(TerminationFailure),
}

pub(crate) enum NativeDetachResult {
    Detached,
    Unresolved(TerminationFailure),
}

pub(crate) trait NativeAdapter: Send + 'static {
    fn install(&mut self, request: LaunchRequest) -> NativeFuture<'_, NativeInstallResult>;
    fn poll(&mut self) -> NativeFuture<'_, NativePollResult>;
    fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult>;
    fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult>;
}

#[derive(Clone)]
pub(crate) struct ResourceClient {
    requests: mpsc::Sender<client::Request>,
}

pub(crate) struct ResourceRuntime {
    pub(crate) client: ResourceClient,
    pub(crate) events: mpsc::Receiver<ResourceEvent>,
    pub(crate) task: TaskOwner<()>,
    pub(crate) initial: Option<(ResourceEpoch, ProcessObservation)>,
}

impl ResourceRuntime {
    #[cfg(test)]
    pub(crate) fn spawn<A, M>(adapter: A, materializer: M) -> Self
    where
        A: NativeAdapter,
        M: LaunchAttemptMaterializer,
    {
        Self::spawn_with(
            adapter,
            Some(Box::new(materializer)),
            None,
            Some(ResourceEpoch::INITIAL),
        )
    }

    pub(crate) fn deferred<A, M>(adapter: A, materializer: M) -> Self
    where
        A: NativeAdapter,
        M: LaunchAttemptMaterializer,
    {
        Self::deferred_with(
            adapter,
            Some(Box::new(materializer)),
            None,
            Some(ResourceEpoch::INITIAL),
        )
    }

    #[cfg(test)]
    pub(crate) fn spawn_attached<A: NativeAdapter>(
        adapter: A,
        observation: ProcessObservation,
    ) -> Self {
        Self::spawn_with(
            adapter,
            None,
            Some((ResourceEpoch::INITIAL, observation)),
            None,
        )
    }

    #[cfg(test)]
    fn spawn_with<A: NativeAdapter>(
        adapter: A,
        materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
        initial: Option<(ResourceEpoch, ProcessObservation)>,
        next_epoch: Option<ResourceEpoch>,
    ) -> Self {
        Self::with_task(initial, |requests, events| {
            owner::spawn(adapter, materializer, requests, events, initial, next_epoch)
        })
    }

    fn deferred_with<A: NativeAdapter>(
        adapter: A,
        materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
        initial: Option<(ResourceEpoch, ProcessObservation)>,
        next_epoch: Option<ResourceEpoch>,
    ) -> Self {
        Self::with_task(initial, |requests, events| {
            owner::deferred(adapter, materializer, requests, events, initial, next_epoch)
        })
    }

    fn with_task(
        initial: Option<(ResourceEpoch, ProcessObservation)>,
        make_task: impl FnOnce(mpsc::Receiver<client::Request>, ResourceEventSender) -> TaskOwner<()>,
    ) -> Self {
        let (requests, request_receiver) = mpsc::channel(REQUEST_CAPACITY);
        let (event_sender, events) = mpsc::channel(EVENT_CAPACITY);
        let task = make_task(request_receiver, ResourceEventSender(event_sender));
        Self {
            client: ResourceClient { requests },
            events,
            task,
            initial,
        }
    }

    #[cfg(test)]
    fn spawn_at<A, M>(adapter: A, materializer: M, next_epoch: ResourceEpoch) -> Self
    where
        A: NativeAdapter,
        M: LaunchAttemptMaterializer,
    {
        Self::spawn_with(
            adapter,
            Some(Box::new(materializer)),
            None,
            Some(next_epoch),
        )
    }
}

fn advance(epoch: ResourceEpoch) -> Option<ResourceEpoch> {
    epoch
        .0
        .get()
        .checked_add(1)
        .and_then(NonZeroU64::new)
        .map(ResourceEpoch)
}
