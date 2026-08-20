use std::{future::Future, sync::Arc, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{PolicyFuture, ReadinessProbe, ReadinessResult},
};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::{
    lifecycle::secret::Secret,
    session::client::{AppServerClient, AppServerClientError, AppServerEndpoint},
};

const STARTUP_PROBE_DEADLINE: Duration = Duration::from_secs(30);
const STARTUP_PROBE_RETRY_DELAY: Duration = Duration::from_millis(100);

pub struct AppServerReadiness {
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
}

impl AppServerReadiness {
    pub fn new(endpoint: AppServerEndpoint, secret: Arc<Secret>) -> Self {
        Self { endpoint, secret }
    }
}

impl ReadinessProbe for AppServerReadiness {
    fn wait_ready(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let endpoint = self.endpoint;
        let secret = Arc::clone(&self.secret);
        Box::pin(wait_for_app_server_readiness(
            cancellation,
            move || {
                let secret = Arc::clone(&secret);
                async move {
                    AppServerClient::inspect_health_and_initialize(endpoint, &secret)
                        .await
                        .map(|_| ())
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
    T: Future<Output = Result<(), AppServerClientError>>,
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
            Err(error) if ReadinessFailure::from(error) == ReadinessFailure::Starting => {
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
}

impl From<AppServerClientError> for ReadinessFailure {
    fn from(error: AppServerClientError) -> Self {
        match error {
            AppServerClientError::HealthDeadline
            | AppServerClientError::HealthFailed
            | AppServerClientError::UpgradeDeadline
            | AppServerClientError::UpgradeFailed
            | AppServerClientError::RequestDeadline
            | AppServerClientError::ConnectionClosed
            | AppServerClientError::Transport => Self::Starting,
            AppServerClientError::InvalidEndpoint
            | AppServerClientError::InitializeFailed
            | AppServerClientError::UnknownResponse
            | AppServerClientError::Protocol
            | AppServerClientError::PeerRejected
            | AppServerClientError::SessionNotFound
            | AppServerClientError::EventRecoveryRequired
            | AppServerClientError::CloseFailed => Self::Unavailable,
        }
    }
}

impl std::fmt::Debug for AppServerReadiness {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppServerReadiness")
            .field("endpoint", &self.endpoint)
            .field("secret", &self.secret)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use std::{future, time::Duration};

    use super::*;

    #[test]
    fn debug_redacts_the_owner_secret() {
        let secret = "readiness-secret-canary";
        let readiness = AppServerReadiness::new(
            AppServerEndpoint::try_new("127.0.0.1:19001".parse().unwrap()).unwrap(),
            Arc::new(Secret::new(secret.to_owned()).unwrap()),
        );

        let debug = format!("{readiness:?}");
        assert!(!debug.contains(secret));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn client_errors_are_classified_without_peer_data() {
        let starting = [
            AppServerClientError::HealthDeadline,
            AppServerClientError::HealthFailed,
            AppServerClientError::UpgradeDeadline,
            AppServerClientError::UpgradeFailed,
            AppServerClientError::RequestDeadline,
            AppServerClientError::ConnectionClosed,
            AppServerClientError::Transport,
        ];
        for error in starting {
            assert_eq!(ReadinessFailure::from(error), ReadinessFailure::Starting);
        }

        let unavailable = [
            AppServerClientError::InvalidEndpoint,
            AppServerClientError::InitializeFailed,
            AppServerClientError::UnknownResponse,
            AppServerClientError::Protocol,
            AppServerClientError::PeerRejected,
            AppServerClientError::SessionNotFound,
            AppServerClientError::EventRecoveryRequired,
            AppServerClientError::CloseFailed,
        ];
        for error in unavailable {
            assert_eq!(ReadinessFailure::from(error), ReadinessFailure::Unavailable);
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
        let mut results = [Err(AppServerClientError::HealthFailed), Ok(())].into_iter();

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
                || future::ready(Err(AppServerClientError::PeerRejected)),
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
