use std::{future::Future, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{GracefulStop, GracefulStopResult, PolicyFuture},
};
use tokio_util::sync::CancellationToken;

use super::stdio::MatchaStdinControl;

const GRACE_PERIOD: Duration = Duration::from_secs(5);

pub struct MatchaGracefulStop {
    stdin: MatchaStdinControl,
}

impl MatchaGracefulStop {
    pub fn new(stdin: MatchaStdinControl) -> Self {
        Self { stdin }
    }
}

impl GracefulStop for MatchaGracefulStop {
    fn grace_period(&self) -> Duration {
        GRACE_PERIOD
    }

    fn request_stop(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        let stdin = self.stdin.clone();
        Box::pin(request_stdin_stop(cancellation, async move {
            stdin.close_stdin().await
        }))
    }
}

async fn request_stdin_stop(
    cancellation: CancellationToken,
    request: impl Future<Output = std::io::Result<()>>,
) -> GracefulStopResult {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
        result = request => match result {
            Ok(()) => GracefulStopResult::Requested,
            Err(_) => GracefulStopResult::Rejected,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::{future, io};

    use super::*;

    #[test]
    fn grace_period_is_five_seconds() {
        let stop = MatchaGracefulStop::new(MatchaStdinControl::new());

        assert_eq!(stop.grace_period(), Duration::from_secs(5));
    }

    #[tokio::test]
    async fn successful_stdin_close_is_requested() {
        assert_eq!(
            request_stdin_stop(CancellationToken::new(), future::ready(Ok(()))).await,
            GracefulStopResult::Requested,
        );
    }

    #[tokio::test]
    async fn failed_stdin_close_is_rejected() {
        assert_eq!(
            request_stdin_stop(
                CancellationToken::new(),
                future::ready(Err(io::Error::other("fixed close failure"))),
            )
            .await,
            GracefulStopResult::Rejected,
        );
    }

    #[tokio::test]
    async fn cancellation_precedes_an_already_completed_close() {
        for request_result in [Ok(()), Err(io::Error::other("fixed close failure"))] {
            let cancellation = CancellationToken::new();
            cancellation.cancel();

            assert_eq!(
                request_stdin_stop(cancellation, future::ready(request_result)).await,
                GracefulStopResult::Cancelled,
            );
        }
    }
}
