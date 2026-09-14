use std::{future::Future, sync::Arc, time::Duration};

use foundation::process::{
    ProcessObservation,
    supervision::{PolicyFuture, ReadinessProbe, ReadinessResult},
};
use tokio::time::{Instant, sleep, sleep_until, timeout};
use tokio_util::sync::CancellationToken;

use crate::gateway::client::GatewayClient;

const STARTUP_PROBE_DEADLINE: Duration = Duration::from_secs(600);
const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_PROBE_RETRY_DELAY: Duration = Duration::from_secs(1);

pub struct OpenClawReadiness {
    client: Arc<GatewayClient>,
}

impl OpenClawReadiness {
    pub fn new(client: Arc<GatewayClient>) -> Self {
        Self { client }
    }
}

impl ReadinessProbe for OpenClawReadiness {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let client = Arc::clone(&self.client);
        Box::pin(wait_for_gateway_stability(
            cancellation,
            move || {
                let client = Arc::clone(&client);
                async move { client.http_ready().await }
            },
            Instant::now() + STARTUP_PROBE_DEADLINE,
            STARTUP_PROBE_TIMEOUT,
            STARTUP_PROBE_RETRY_DELAY,
        ))
    }
}

async fn wait_for_gateway_stability<F, T>(
    cancellation: CancellationToken,
    mut listener: F,
    deadline: Instant,
    probe_timeout: Duration,
    retry_delay: Duration,
) -> ReadinessResult
where
    F: FnMut() -> T,
    T: Future<Output = bool>,
{
    let mut attempt = 0usize;
    loop {
        attempt += 1;
        let ready = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
            _ = sleep_until(deadline) => return ReadinessResult::Unavailable,
            ready = timeout(probe_timeout, listener()) => ready.is_ok_and(|ready| ready),
        };
        eprintln!(
            "[startup-trace] source=openclaw-readiness phase=http-ready-probe detail=healthz-readyz attempt={attempt} ready={ready}"
        );
        if ready {
            eprintln!(
                "[startup-trace] source=openclaw-readiness phase=http-ready detail=healthz-readyz-ready attempt={attempt}"
            );
            return ReadinessResult::Ready;
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
            _ = sleep_until(deadline) => return ReadinessResult::Unavailable,
            _ = sleep(retry_delay) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn successful_gateway_stability_probe_marks_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await.unwrap();
        });

        assert_eq!(
            wait_for_gateway_stability(
                CancellationToken::new(),
                move || async move { tokio::net::TcpStream::connect(address).await.is_ok() },
                Instant::now() + Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Ready,
        );
        accept.await.unwrap();
    }

    #[tokio::test]
    async fn unreachable_listener_retries_until_ready() {
        let mut observations = [false, true].into_iter();

        assert_eq!(
            wait_for_gateway_stability(
                CancellationToken::new(),
                move || future::ready(observations.next().unwrap()),
                Instant::now() + Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Ready,
        );
    }

    #[tokio::test]
    async fn times_out_a_hung_probe_then_retries() {
        let attempts = Arc::new(AtomicUsize::new(0));

        assert_eq!(
            wait_for_gateway_stability(
                CancellationToken::new(),
                {
                    let attempts = Arc::clone(&attempts);
                    move || {
                        let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                        async move {
                            if attempt == 0 {
                                future::pending::<bool>().await
                            } else {
                                true
                            }
                        }
                    }
                },
                Instant::now() + Duration::from_secs(1),
                Duration::from_millis(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Ready,
        );
    }

    #[tokio::test]
    async fn cancellation_precedes_an_already_observed_control_result() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            wait_for_gateway_stability(
                cancellation,
                || future::ready(true),
                Instant::now() + Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await,
            ReadinessResult::Cancelled,
        );
    }
}
