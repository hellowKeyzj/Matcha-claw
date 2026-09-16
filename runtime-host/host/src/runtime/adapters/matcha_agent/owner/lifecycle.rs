use super::super::*;

impl LifecycleOps for MatchaRuntimeDriver {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.lifecycle.snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.lifecycle.subscribe()
    }

    fn start(
        &self,
    ) -> OwnedRuntimeFuture<Result<StartOutcome, crate::runtime::driver::RuntimeStartFailure>> {
        let lifecycle = self.lifecycle.clone();
        Box::pin(async move { lifecycle.start().await.map_err(map_matcha_start_failure) })
    }

    fn stop(
        &self,
    ) -> OwnedRuntimeFuture<
        Result<TerminationCompletion, crate::runtime::driver::RuntimeLifecycleFailure>,
    > {
        let lifecycle = self.lifecycle.clone();
        Box::pin(async move {
            lifecycle.advance_source_epoch();
            lifecycle.stop().await.map_err(map_matcha_lifecycle_failure)
        })
    }

    fn restart(
        &self,
    ) -> OwnedRuntimeFuture<Result<RestartOutcome, crate::runtime::driver::RuntimeLifecycleFailure>>
    {
        let lifecycle = self.lifecycle.clone();
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
        self.team.snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.team.subscribe()
    }

    fn start(
        &self,
    ) -> OwnedRuntimeFuture<Result<StartOutcome, crate::runtime::driver::RuntimeStartFailure>> {
        self.team.start()
    }

    fn stop(
        &self,
    ) -> OwnedRuntimeFuture<
        Result<TerminationCompletion, crate::runtime::driver::RuntimeLifecycleFailure>,
    > {
        self.team.stop()
    }

    fn restart(
        &self,
    ) -> OwnedRuntimeFuture<Result<RestartOutcome, crate::runtime::driver::RuntimeLifecycleFailure>>
    {
        self.team.restart()
    }
}

fn map_matcha_start_failure(
    error: MatchaLifecycleError,
) -> crate::runtime::driver::RuntimeStartFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => {
            crate::runtime::driver::RuntimeStartFailure::CompletionFailed
        }
        MatchaLifecycleError::SupervisorStopped => {
            crate::runtime::driver::RuntimeStartFailure::SupervisorStopped
        }
        MatchaLifecycleError::AlreadySatisfied => {
            unreachable!("Matcha peer start reports already satisfied as Started")
        }
        MatchaLifecycleError::Busy => crate::runtime::driver::RuntimeStartFailure::Busy,
        MatchaLifecycleError::Rejected(rejection) => {
            crate::runtime::driver::RuntimeStartFailure::Rejected(rejection)
        }
        MatchaLifecycleError::ShuttingDown => {
            crate::runtime::driver::RuntimeStartFailure::ShuttingDown
        }
    }
}

fn map_matcha_lifecycle_failure(
    error: MatchaLifecycleError,
) -> crate::runtime::driver::RuntimeLifecycleFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => {
            crate::runtime::driver::RuntimeLifecycleFailure::CompletionFailed
        }
        MatchaLifecycleError::SupervisorStopped => {
            crate::runtime::driver::RuntimeLifecycleFailure::SupervisorStopped
        }
        MatchaLifecycleError::AlreadySatisfied => {
            crate::runtime::driver::RuntimeLifecycleFailure::AlreadySatisfied
        }
        MatchaLifecycleError::Busy => crate::runtime::driver::RuntimeLifecycleFailure::Busy,
        MatchaLifecycleError::Rejected(rejection) => {
            crate::runtime::driver::RuntimeLifecycleFailure::Rejected(rejection)
        }
        MatchaLifecycleError::ShuttingDown => {
            crate::runtime::driver::RuntimeLifecycleFailure::ShuttingDown
        }
    }
}
