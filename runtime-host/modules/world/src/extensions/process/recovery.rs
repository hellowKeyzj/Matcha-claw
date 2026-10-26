use foundation::process::supervision::{
    PolicyFuture, RestartDecision, RestartEpisode, RestartPolicy, StartRecovery,
    StartRecoveryResult, SupervisorFailure,
};
use tokio_util::sync::CancellationToken;

/// A fresh process does not recover an accepted invocation or replay its effects.
pub(super) struct NoReplay(pub(super) std::sync::Arc<super::session::Session>);

impl StartRecovery for NoReplay {
    fn recover(
        &self,
        failure: SupervisorFailure,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        self.0
            .fail(std::sync::Arc::new(super::error::ProcessError::Supervisor(
                std::sync::Arc::new(failure),
            )));
        Box::pin(async move {
            if cancellation.is_cancelled() {
                StartRecoveryResult::Cancelled
            } else {
                StartRecoveryResult::Fail
            }
        })
    }
}

impl RestartPolicy for NoReplay {
    fn decide(&self, failure: &SupervisorFailure, _episode: RestartEpisode) -> RestartDecision {
        self.0
            .fail(std::sync::Arc::new(super::error::ProcessError::Supervisor(
                std::sync::Arc::new(failure.clone()),
            )));
        RestartDecision::Halt
    }
}
