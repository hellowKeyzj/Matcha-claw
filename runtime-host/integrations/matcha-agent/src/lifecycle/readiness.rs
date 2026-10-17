use std::{future::Future, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{PolicyFuture, ReadinessProbe, ReadinessResult},
};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::client::{Client, Error};

const STARTUP_PROBE_DEADLINE: Duration = Duration::from_secs(30);
const STARTUP_PROBE_RETRY_DELAY: Duration = Duration::from_millis(100);

pub struct AppServerReadiness {
    client: Client,
}

impl AppServerReadiness {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

impl ReadinessProbe for AppServerReadiness {
    fn wait_ready(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let client = self.client.clone();
        let probe_cancellation = cancellation.clone();
        Box::pin(wait_for_app_server_readiness(
            cancellation,
            move || {
                let client = client.clone();
                let cancellation = probe_cancellation.clone();
                async move {
                    client.probe_ready(&cancellation).await.map_err(|error| {
                        if error.is_cancelled() {
                            ReadinessFailure::Cancelled
                        } else {
                            ReadinessFailure::classify(&error)
                        }
                    })
                }
            },
            Instant::now() + STARTUP_PROBE_DEADLINE,
            STARTUP_PROBE_RETRY_DELAY,
        ))
    }
}

async fn wait_for_app_server_readiness<F, T>(
    cancellation: CancellationToken,
    mut probe: F,
    deadline: Instant,
    retry_delay: Duration,
) -> ReadinessResult
where
    F: FnMut() -> T,
    T: Future<Output = Result<(), ReadinessFailure>>,
{
    loop {
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
            _ = sleep_until(deadline) => return ReadinessResult::Unavailable,
            result = probe() => result,
        };
        match result {
            Ok(()) => return ReadinessResult::Ready,
            Err(ReadinessFailure::Cancelled) => return ReadinessResult::Cancelled,
            Err(ReadinessFailure::Starting) => {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
                    _ = sleep_until(deadline) => return ReadinessResult::Unavailable,
                    _ = sleep(retry_delay) => {}
                }
            }
            Err(_) => return ReadinessResult::Unavailable,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadinessFailure {
    Starting,
    Unavailable,
    Cancelled,
}

impl ReadinessFailure {
    fn classify(error: &Error) -> Self {
        Self::classify_kind(error.kind())
    }

    fn classify_kind(kind: &str) -> Self {
        match kind {
            "connect_failed" | "upgrade_failed" | "transport" | "deadline"
            | "connection_closed" => Self::Starting,
            _ => Self::Unavailable,
        }
    }
}

impl std::fmt::Debug for AppServerReadiness {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppServerReadiness")
            .field("client", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use crate::lifecycle::secret::Secret;
    use std::{future, sync::Arc, time::Duration};

    use super::*;

    #[test]
    fn debug_redacts_the_owner_secret() {
        let secret = "readiness-secret-canary";
        let readiness = AppServerReadiness::new(Client::new(
            "127.0.0.1:19001".parse().unwrap(),
            Arc::new(Secret::new(secret.to_owned()).unwrap()),
        ));

        let debug = format!("{readiness:?}");
        assert!(!debug.contains(secret));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn client_errors_are_classified_without_peer_data() {
        let starting = [
            "connect_failed",
            "upgrade_failed",
            "transport",
            "deadline",
            "connection_closed",
        ];
        for kind in starting {
            assert_eq!(
                ReadinessFailure::classify_kind(kind),
                ReadinessFailure::Starting
            );
        }

        let unavailable = [
            "invalid_endpoint",
            "unsupported_protocol",
            "protocol",
            "unauthorized",
            "client_shutdown",
        ];
        for kind in unavailable {
            assert_eq!(
                ReadinessFailure::classify_kind(kind),
                ReadinessFailure::Unavailable
            );
        }
    }

    #[tokio::test]
    async fn successful_authenticated_control_probe_is_ready() {
        assert_eq!(
            wait_for_app_server_readiness(
                CancellationToken::new(),
                || future::ready(Ok(())),
                Instant::now() + Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Ready,
        );
    }

    #[tokio::test]
    async fn starting_control_retries_until_ready() {
        let mut results = [Err(ReadinessFailure::Starting), Ok(())].into_iter();

        assert_eq!(
            wait_for_app_server_readiness(
                CancellationToken::new(),
                move || future::ready(results.next().unwrap()),
                Instant::now() + Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Ready,
        );
    }

    #[tokio::test]
    async fn unavailable_control_fails_without_retry() {
        assert_eq!(
            wait_for_app_server_readiness(
                CancellationToken::new(),
                || future::ready(Err(ReadinessFailure::Unavailable)),
                Instant::now() + Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Unavailable,
        );
    }

    #[tokio::test]
    async fn cancellation_precedes_an_already_completed_probe() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            wait_for_app_server_readiness(
                cancellation,
                || future::ready(Ok(())),
                Instant::now() + Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Cancelled,
        );
    }
}
