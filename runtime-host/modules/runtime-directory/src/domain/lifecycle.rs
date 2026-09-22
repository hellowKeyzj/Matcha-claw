use std::{future::Future, pin::Pin};

use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorRejection, SupervisorSnapshot, TerminationCompletion,
};
use tokio::sync::watch;

pub type OwnedRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub trait LifecycleOps: Send + Sync {
    fn snapshot(&self) -> SupervisorSnapshot;

    fn subscribe(&self) -> watch::Receiver<SupervisorSnapshot>;

    fn readiness(&self) -> bool {
        self.snapshot().phase() == foundation::process::supervision::SupervisorPhase::Running
    }

    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>>;

    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>>;

    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeStartFailure {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeLifecycleFailure {
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    Unsupported,
}
