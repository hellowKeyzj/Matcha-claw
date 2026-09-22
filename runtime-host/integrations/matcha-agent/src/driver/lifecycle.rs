use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorSnapshot, TerminationCompletion,
};
use runtime_directory::{
    LifecycleOps, OwnedRuntimeFuture, RuntimeLifecycleFailure, RuntimeStartFailure,
};

use super::{MatchaAgentInstance, MatchaRuntimeDriver};
use crate::peer::LifecycleError;

impl LifecycleOps for MatchaRuntimeDriver {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.lifecycle_handle().snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.lifecycle_handle().subscribe()
    }

    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>> {
        let lifecycle = self.lifecycle_handle();
        Box::pin(async move { lifecycle.start().await.map_err(map_matcha_start_failure) })
    }

    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>> {
        let lifecycle = self.lifecycle_handle();
        Box::pin(async move {
            lifecycle.advance_source_epoch();
            lifecycle.stop().await.map_err(map_matcha_lifecycle_failure)
        })
    }

    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>> {
        let lifecycle = self.lifecycle_handle();
        Box::pin(async move {
            lifecycle.advance_source_epoch();
            lifecycle
                .restart()
                .await
                .map_err(map_matcha_lifecycle_failure)
        })
    }
}

impl LifecycleOps for MatchaAgentInstance {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.runtime_driver().snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.runtime_driver().subscribe()
    }

    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>> {
        self.runtime_driver().start()
    }

    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>> {
        self.runtime_driver().stop()
    }

    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>> {
        self.runtime_driver().restart()
    }
}

fn map_matcha_start_failure(error: LifecycleError) -> RuntimeStartFailure {
    match error {
        LifecycleError::CompletionFailed => RuntimeStartFailure::CompletionFailed,
        LifecycleError::SupervisorStopped => RuntimeStartFailure::SupervisorStopped,
        LifecycleError::AlreadySatisfied => {
            unreachable!("Matcha peer start reports already satisfied as Started")
        }
        LifecycleError::Busy => RuntimeStartFailure::Busy,
        LifecycleError::Rejected(rejection) => RuntimeStartFailure::Rejected(rejection),
        LifecycleError::ShuttingDown => RuntimeStartFailure::ShuttingDown,
    }
}

fn map_matcha_lifecycle_failure(error: LifecycleError) -> RuntimeLifecycleFailure {
    match error {
        LifecycleError::CompletionFailed => RuntimeLifecycleFailure::CompletionFailed,
        LifecycleError::SupervisorStopped => RuntimeLifecycleFailure::SupervisorStopped,
        LifecycleError::AlreadySatisfied => RuntimeLifecycleFailure::AlreadySatisfied,
        LifecycleError::Busy => RuntimeLifecycleFailure::Busy,
        LifecycleError::Rejected(rejection) => RuntimeLifecycleFailure::Rejected(rejection),
        LifecycleError::ShuttingDown => RuntimeLifecycleFailure::ShuttingDown,
    }
}
