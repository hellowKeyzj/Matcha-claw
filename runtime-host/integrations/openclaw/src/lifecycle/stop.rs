use std::{future, sync::Arc, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{GracefulStop, GracefulStopResult, PolicyFuture},
};
use tokio_util::sync::CancellationToken;

use crate::gateway::client::GatewayClient;

const GRACE_PERIOD: Duration = Duration::from_secs(30);

pub struct OpenClawGracefulStop;

impl OpenClawGracefulStop {
    pub fn new(_client: Arc<GatewayClient>) -> Self {
        Self
    }
}

impl GracefulStop for OpenClawGracefulStop {
    fn grace_period(&self) -> Duration {
        GRACE_PERIOD
    }

    fn request_stop(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(request_gateway_stop(cancellation))
    }
}

async fn request_gateway_stop(cancellation: CancellationToken) -> GracefulStopResult {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
        result = future::ready(GracefulStopResult::Rejected) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grace_period_preserves_the_gateway_shutdown_window() {
        assert_eq!(GRACE_PERIOD, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn gateway_stop_is_rejected_for_foundation_fallback_kill() {
        assert_eq!(
            request_gateway_stop(CancellationToken::new()).await,
            GracefulStopResult::Rejected,
        );
    }

    #[tokio::test]
    async fn cancellation_precedes_the_local_rejection() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            request_gateway_stop(cancellation).await,
            GracefulStopResult::Cancelled,
        );
    }
}
