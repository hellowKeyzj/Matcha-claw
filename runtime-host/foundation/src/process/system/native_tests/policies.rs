use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{
        GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe, ReadinessResult,
        RestartDecision, RestartEpisode, RestartPolicy, StartRecovery, StartRecoveryResult,
        StdioActivation, SupervisorFailure,
    },
};

#[derive(Clone, Copy)]
pub(super) struct DrainStdio;

impl StdioActivation for DrainStdio {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (None, Some(mut stdout), Some(mut stderr)) = stdio.into_parts() else {
                return StdioActivationResult::Unavailable;
            };
            StdioActivationResult::Activated(StdioDrain::new(async move {
                let stdout =
                    async move { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await };
                let stderr =
                    async move { tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await };
                let (stdout, stderr) = tokio::join!(stdout, stderr);
                if stdout.is_ok() && stderr.is_ok() {
                    StdioDrainResult::Drained
                } else {
                    StdioDrainResult::Unavailable
                }
            }))
        })
    }
}

#[derive(Clone)]
pub(super) struct Ready {
    marker: Option<PathBuf>,
}

impl Ready {
    pub(super) const fn immediate() -> Self {
        Self { marker: None }
    }

    pub(super) fn after(marker: PathBuf) -> Self {
        Self {
            marker: Some(marker),
        }
    }
}

impl ReadinessProbe for Ready {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let marker = self.marker.clone();
        Box::pin(async move {
            let Some(marker) = marker else {
                return ReadinessResult::Ready;
            };
            loop {
                if marker.exists() {
                    return ReadinessResult::Ready;
                }
                tokio::select! {
                    _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }
            }
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct Stop {
    grace_period: Duration,
}

impl Stop {
    pub(super) const fn after(grace_period: Duration) -> Self {
        Self { grace_period }
    }
}

impl GracefulStop for Stop {
    fn grace_period(&self) -> Duration {
        self.grace_period
    }

    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(std::future::pending())
    }
}

#[derive(Clone, Copy)]
pub(super) struct Recovery {
    retry_after: Duration,
}

impl Recovery {
    pub(super) const fn after(retry_after: Duration) -> Self {
        Self { retry_after }
    }
}

impl StartRecovery for Recovery {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        let retry_after = self.retry_after;
        Box::pin(async move { StartRecoveryResult::RetryAfter(retry_after) })
    }
}

#[derive(Clone)]
pub(super) struct Policy {
    decision: RestartDecision,
    calls: Arc<AtomicUsize>,
    failures: Arc<Mutex<Vec<SupervisorFailure>>>,
}

impl Policy {
    pub(super) fn halt() -> Self {
        Self::new(RestartDecision::Halt)
    }

    fn new(decision: RestartDecision) -> Self {
        Self {
            decision,
            calls: Arc::new(AtomicUsize::new(0)),
            failures: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(super) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub(super) fn failures(&self) -> Vec<SupervisorFailure> {
        self.failures.lock().unwrap().clone()
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self::new(RestartDecision::RestartAfter(Duration::ZERO))
    }
}

impl RestartPolicy for Policy {
    fn decide(&self, failure: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.failures.lock().unwrap().push(failure.clone());
        self.decision
    }
}
