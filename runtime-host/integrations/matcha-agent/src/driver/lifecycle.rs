use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorPhase, SupervisorSnapshot, TerminationCompletion,
};
use runtime_directory::{
    LifecycleOps, OwnedRuntimeFuture, RuntimeControlFailure, RuntimeControlOps,
    RuntimeControlReadiness, RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLifecycleFailure,
    RuntimeLogSnapshot, RuntimeStartFailure,
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

impl RuntimeControlOps for MatchaRuntimeDriver {
    fn logs(
        &self,
        cursor: Option<u64>,
    ) -> OwnedRuntimeFuture<Result<RuntimeLogSnapshot, RuntimeControlFailure>> {
        let native = self.native_client();
        Box::pin(async move {
            let response = native
                .call(
                    "diagnostics.query",
                    serde_json::json!({ "afterId": cursor.unwrap_or(0), "limit": 101 }),
                )
                .await
                .map_err(|_| RuntimeControlFailure::Unavailable)?;
            crate::diagnostics::project_logs(response, cursor.unwrap_or(0))
        })
    }

    fn control_readiness(
        &self,
    ) -> OwnedRuntimeFuture<Result<RuntimeControlReadiness, RuntimeControlFailure>> {
        let lifecycle = self.lifecycle_handle();
        let snapshot = lifecycle.snapshot();
        let native = self.native_client();
        Box::pin(async move {
            match snapshot.phase() {
                SupervisorPhase::Starting | SupervisorPhase::WaitingToRestart => {
                    Ok(RuntimeControlReadiness::Starting)
                }
                SupervisorPhase::Running => match native
                    .probe_ready(&tokio_util::sync::CancellationToken::new())
                    .await
                {
                    Ok(()) => {
                        let current = lifecycle.snapshot();
                        Ok(
                            if current.phase() == SupervisorPhase::Running
                                && current.process() == snapshot.process()
                            {
                                RuntimeControlReadiness::Ready
                            } else {
                                RuntimeControlReadiness::Unavailable
                            },
                        )
                    }
                    Err(_) => Ok(RuntimeControlReadiness::Unavailable),
                },
                _ => Ok(RuntimeControlReadiness::Unavailable),
            }
        })
    }

    fn gateway_health(
        &self,
        _probe: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayHealth, RuntimeControlFailure>> {
        // Native HTTP health describes only its listener, not CLI or model availability.
        Box::pin(async { Err(RuntimeControlFailure::Unsupported) })
    }

    fn gateway_status(
        &self,
        _include_channel_summary: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayStatus, RuntimeControlFailure>> {
        Box::pin(async { Err(RuntimeControlFailure::Unsupported) })
    }

    fn control_ui_url(&self) -> OwnedRuntimeFuture<Result<String, RuntimeControlFailure>> {
        Box::pin(async { Err(RuntimeControlFailure::Unsupported) })
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
