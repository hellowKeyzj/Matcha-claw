use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use foundation::process::{
    ProcessObservation, ProcessStdin,
    supervision::{GracefulStop, GracefulStopResult, PolicyFuture},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const GRACE_PERIOD: Duration = Duration::from_secs(30);
const STOP_FRAME: &[u8] = b"matchaclaw.openclaw.stop.v1\n";

#[derive(Clone, Default)]
pub struct OpenClawGracefulStop {
    stdin: Arc<Mutex<Option<(ProcessObservation, ProcessStdin)>>>,
}

impl OpenClawGracefulStop {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) fn bind_stdin(
        &self,
        process: ProcessObservation,
        stdin: ProcessStdin,
        cancellation: &CancellationToken,
    ) -> Option<OpenClawStdinGuard> {
        let mut slot = self
            .stdin
            .lock()
            .expect("OpenClaw stdin lock must not be poisoned");
        if cancellation.is_cancelled() {
            return None;
        }
        *slot = Some((process, stdin));
        Some(OpenClawStdinGuard {
            stop: self.clone(),
            process,
        })
    }

    fn take_stdin(&self, process: ProcessObservation) -> Option<ProcessStdin> {
        let mut slot = self
            .stdin
            .lock()
            .expect("OpenClaw stdin lock must not be poisoned");
        if slot.as_ref().is_some_and(|(bound, _)| *bound == process) {
            slot.take().map(|(_, stdin)| stdin)
        } else {
            None
        }
    }
}

pub(super) struct OpenClawStdinGuard {
    stop: OpenClawGracefulStop,
    process: ProcessObservation,
}

impl Drop for OpenClawStdinGuard {
    fn drop(&mut self) {
        self.stop.take_stdin(self.process);
    }
}

impl GracefulStop for OpenClawGracefulStop {
    fn grace_period(&self) -> Duration {
        GRACE_PERIOD
    }

    fn request_stop(
        &self,
        process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        let stop = self.clone();
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
                result = async {
                    let Some(mut stdin) = stop.take_stdin(process) else {
                        return GracefulStopResult::Rejected;
                    };
                    match async {
                        stdin.write_all(STOP_FRAME).await?;
                        stdin.flush().await
                    }.await {
                        Ok(()) => GracefulStopResult::Requested,
                        Err(error) => {
                            eprintln!("[openclaw-stop] owned stdin request failed: {error}");
                            GracefulStopResult::Rejected
                        }
                    }
                } => result,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grace_period_preserves_the_gateway_shutdown_window() {
        assert_eq!(GRACE_PERIOD, Duration::from_secs(30));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unbound_process_stop_is_rejected_for_foundation_fallback_kill() {
        use foundation::process::{StdioMode, StdioSpec};

        let result = super::super::stdio::with_process_stdio(
            StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
            |process, stdio| async move {
                drop(stdio);
                OpenClawGracefulStop::new()
                    .request_stop(process, CancellationToken::new())
                    .await
            },
        )
        .await;

        assert_eq!(result, GracefulStopResult::Rejected);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancellation_precedes_the_local_rejection() {
        use foundation::process::{StdioMode, StdioSpec};

        let result = super::super::stdio::with_process_stdio(
            StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
            |process, stdio| async move {
                drop(stdio);
                let cancellation = CancellationToken::new();
                cancellation.cancel();
                OpenClawGracefulStop::new()
                    .request_stop(process, cancellation)
                    .await
            },
        )
        .await;

        assert_eq!(result, GracefulStopResult::Cancelled);
    }
}
