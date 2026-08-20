use std::{future::Future, pin::Pin, time::Duration};

use tokio_util::sync::CancellationToken;

use super::super::{ProcessObservation, ProcessStdio, StdioActivationResult};
use super::{RestartEpisode, SupervisorFailure};

pub type PolicyFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadinessResult {
    Ready,
    Unavailable,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartRecoveryResult {
    RetryAfter(Duration),
    Fail,
    Cancelled,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GracefulStopResult {
    Requested,
    Cancelled,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartDecision {
    Halt,
    RestartAfter(Duration),
}

pub trait StdioActivation: Send + Sync + 'static {
    fn activate(
        &self,
        process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult>;
}

pub trait ReadinessProbe: Send + Sync + 'static {
    fn wait_ready(
        &self,
        process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult>;
}

pub trait GracefulStop: Send + Sync + 'static {
    fn grace_period(&self) -> Duration;

    fn request_stop(
        &self,
        process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult>;
}

pub trait StartRecovery: Send + Sync + 'static {
    fn recover(
        &self,
        failure: SupervisorFailure,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult>;
}

pub trait RestartPolicy: Send + Sync + 'static {
    fn decide(&self, failure: &SupervisorFailure, episode: RestartEpisode) -> RestartDecision;
}
