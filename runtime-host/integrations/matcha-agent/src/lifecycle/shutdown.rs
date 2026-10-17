use std::{future::Future, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{GracefulStop, GracefulStopResult, PolicyFuture},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::client::{Client, Delivery, Error};

const GRACE_PERIOD: Duration = Duration::from_secs(5);

pub struct MatchaGracefulStop {
    client: Client,
}

impl MatchaGracefulStop {
    pub fn new(client: Client) -> Self {
        Self { client }
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
        let client = self.client.clone();
        Box::pin(async move {
            request_shutdown(
                &cancellation,
                client.call_cancellable("server.shutdown", json!({}), &cancellation),
            )
            .await
        })
    }
}

async fn request_shutdown(
    cancellation: &CancellationToken,
    request: impl Future<Output = Result<Value, Error>>,
) -> GracefulStopResult {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
        result = request => match result {
            Ok(response) if response.get("status").and_then(Value::as_str) == Some("stopping") => GracefulStopResult::Requested,
            Err(error) if error.is_cancelled() => GracefulStopResult::Cancelled,
            // Delivery uncertainty is not a rejection, nor proof of exit. The
            // Foundation owner must observe exit and retain independent cleanup failures.
            Err(error) if error.delivery() == Delivery::Unknown => GracefulStopResult::Requested,
            _ => GracefulStopResult::Rejected,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::secret::Secret;
    use std::{future, sync::Arc};

    #[test]
    fn grace_period_is_five_seconds() {
        let client = Client::new(
            "127.0.0.1:19001".parse().unwrap(),
            Arc::new(Secret::new("test-secret".into()).unwrap()),
        );
        let stop = MatchaGracefulStop::new(client);
        assert_eq!(stop.grace_period(), Duration::from_secs(5));
    }

    #[tokio::test]
    async fn accepted_shutdown_is_only_requested() {
        assert_eq!(
            request_shutdown(
                &CancellationToken::new(),
                future::ready(Ok(json!({ "status": "stopping" })))
            )
            .await,
            GracefulStopResult::Requested
        );
    }

    #[tokio::test]
    async fn unexpected_shutdown_reply_is_rejected() {
        assert_eq!(
            request_shutdown(&CancellationToken::new(), future::ready(Ok(json!({})))).await,
            GracefulStopResult::Rejected
        );
    }

    #[tokio::test]
    async fn cancellation_precedes_an_already_completed_request() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            request_shutdown(
                &cancellation,
                future::ready(Ok(json!({ "status": "stopping" })))
            )
            .await,
            GracefulStopResult::Cancelled
        );
    }
}
