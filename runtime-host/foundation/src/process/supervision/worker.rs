use std::{future::Future, sync::Arc, time::Duration};

use tokio::{
    sync::{mpsc, watch},
    task::{Id, JoinSet},
    time::{Instant, sleep_until},
};
use tokio_util::sync::CancellationToken;

use super::super::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    resource::{
        Activation, ActivationOutcome, ResourceClient, ResourceEpoch, ResourceFailure,
        ResourceShutdown, SharedTerminalEvidence,
    },
};
use super::{
    GracefulStop, GracefulStopResult, ReadinessProbe, ReadinessResult, StartRecovery,
    StartRecoveryResult, StdioActivation, SupervisorFailure,
};

pub(super) enum GracefulCompletion {
    Completed(GracefulStopResult),
    DeadlineElapsed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StdioDrainCompletion {
    Completed(StdioDrainResult),
    DeadlineElapsed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StdioDrainControl {
    Pending,
    Deadline(Instant),
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TaskIdentity {
    Begin(u64),
    StdioActivation {
        generation: u64,
        epoch: ResourceEpoch,
    },
    NativeActivation {
        request_id: u64,
        epoch: ResourceEpoch,
    },
    StdioDrain {
        epoch: ResourceEpoch,
    },
    Readiness {
        generation: u64,
        epoch: ResourceEpoch,
    },
    Recovery(u64),
    Graceful {
        generation: u64,
        epoch: ResourceEpoch,
    },
    WaitDrained {
        generation: u64,
        epoch: ResourceEpoch,
    },
    Kill(ResourceEpoch),
    Shutdown,
    ShutdownRetry,
    Timer(u64),
    #[cfg(test)]
    Probe,
}

pub(super) enum Work {
    BeginEnqueued(u64),
    BeginOwnerClosed(u64),
    StdioActivation {
        generation: u64,
        epoch: ResourceEpoch,
        result: StdioActivationResult,
    },
    NativeActivation {
        request_id: u64,
        epoch: ResourceEpoch,
        result: Result<ActivationOutcome, ResourceFailure>,
    },
    StdioDrain {
        epoch: ResourceEpoch,
        result: StdioDrainCompletion,
    },
    Readiness {
        generation: u64,
        epoch: ResourceEpoch,
        result: ReadinessResult,
    },
    Recovery {
        generation: u64,
        failure: SupervisorFailure,
        result: StartRecoveryResult,
    },
    Graceful {
        generation: u64,
        epoch: ResourceEpoch,
        result: GracefulCompletion,
    },
    WaitDrained {
        generation: u64,
        epoch: ResourceEpoch,
        result: Result<SharedTerminalEvidence, ResourceFailure>,
    },
    Kill {
        epoch: ResourceEpoch,
        result: Result<SharedTerminalEvidence, ResourceFailure>,
    },
    Shutdown(Result<ResourceShutdown, ResourceFailure>),
    ShutdownRetry(Result<ResourceShutdown, ResourceFailure>),
    Timer(u64),
}

pub(super) struct SpawnContext<'a> {
    tasks: &'a mut JoinSet<TaskIdentity>,
    identities: &'a mut Vec<(Id, TaskIdentity, bool)>,
    work: mpsc::Sender<Work>,
}

impl<'a> SpawnContext<'a> {
    pub(super) fn new(
        tasks: &'a mut JoinSet<TaskIdentity>,
        identities: &'a mut Vec<(Id, TaskIdentity, bool)>,
        work: mpsc::Sender<Work>,
    ) -> Self {
        Self {
            tasks,
            identities,
            work,
        }
    }
}

fn spawn(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    identity: TaskIdentity,
    work: mpsc::Sender<Work>,
    task: impl Future<Output = Work> + Send + 'static,
) {
    let handle = tasks.spawn(async move {
        let result = task.await;
        let _ = work.send(result).await;
        identity
    });
    identities.push((handle.id(), identity, false));
}

pub(super) fn begin(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    request_id: u64,
    client: ResourceClient,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::Begin(request_id),
        work,
        async move {
            match client.begin().await {
                Ok(()) => Work::BeginEnqueued(request_id),
                Err(_) => Work::BeginOwnerClosed(request_id),
            }
        },
    );
}

pub(super) fn stdio_activation<A: StdioActivation>(
    context: SpawnContext<'_>,
    activation: Arc<A>,
    generation: u64,
    epoch: ResourceEpoch,
    observation: ProcessObservation,
    stdio: ProcessStdio,
    cancellation: CancellationToken,
) {
    spawn(
        context.tasks,
        context.identities,
        TaskIdentity::StdioActivation { generation, epoch },
        context.work,
        async move {
            let future = activation.activate(observation, stdio, cancellation.clone());
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => StdioActivationResult::Cancelled,
                result = future => result,
            };
            Work::StdioActivation {
                generation,
                epoch,
                result,
            }
        },
    );
}

pub(super) fn native_activation(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    activation: Activation,
    request_id: u64,
    epoch: ResourceEpoch,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::NativeActivation { request_id, epoch },
        work,
        async move {
            Work::NativeActivation {
                request_id,
                epoch,
                result: activation.activate().await,
            }
        },
    );
}

pub(super) fn stdio_drain(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    epoch: ResourceEpoch,
    drain: StdioDrain,
    control: watch::Receiver<StdioDrainControl>,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::StdioDrain { epoch },
        work,
        async move {
            let result = await_stdio_drain(drain, control).await;
            Work::StdioDrain { epoch, result }
        },
    );
}

pub(super) fn readiness<R: ReadinessProbe>(
    context: SpawnContext<'_>,
    readiness: Arc<R>,
    generation: u64,
    epoch: ResourceEpoch,
    observation: super::super::ProcessObservation,
    cancellation: CancellationToken,
) {
    spawn(
        context.tasks,
        context.identities,
        TaskIdentity::Readiness { generation, epoch },
        context.work,
        async move {
            let future = readiness.wait_ready(observation, cancellation.clone());
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => ReadinessResult::Cancelled,
                result = future => result,
            };
            Work::Readiness {
                generation,
                epoch,
                result,
            }
        },
    );
}

pub(super) fn recovery<S: StartRecovery>(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    recovery: Arc<S>,
    generation: u64,
    failure: SupervisorFailure,
    cancellation: CancellationToken,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::Recovery(generation),
        work,
        async move {
            let future = recovery.recover(failure.clone(), cancellation.clone());
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => StartRecoveryResult::Cancelled,
                result = future => result,
            };
            Work::Recovery {
                generation,
                failure,
                result,
            }
        },
    );
}

pub(super) fn graceful<G: GracefulStop>(
    context: SpawnContext<'_>,
    graceful_stop: Arc<G>,
    generation: u64,
    epoch: ResourceEpoch,
    observation: super::super::ProcessObservation,
    deadline: Instant,
    cancellation: CancellationToken,
) {
    spawn(
        context.tasks,
        context.identities,
        TaskIdentity::Graceful { generation, epoch },
        context.work,
        async move {
            let future = graceful_stop.request_stop(observation, cancellation.clone());
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    GracefulCompletion::Completed(GracefulStopResult::Cancelled)
                }
                result = tokio::time::timeout_at(deadline, future) => match result {
                    Ok(result) => GracefulCompletion::Completed(result),
                    Err(_) => GracefulCompletion::DeadlineElapsed,
                },
            };
            Work::Graceful {
                generation,
                epoch,
                result,
            }
        },
    );
}

pub(super) fn wait_drained(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    client: ResourceClient,
    generation: u64,
    epoch: ResourceEpoch,
    deadline: Instant,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::WaitDrained { generation, epoch },
        work,
        async move {
            Work::WaitDrained {
                generation,
                epoch,
                result: client.wait_drained(epoch, deadline).await,
            }
        },
    );
}

pub(super) fn kill(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    client: ResourceClient,
    epoch: ResourceEpoch,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::Kill(epoch),
        work,
        async move {
            Work::Kill {
                epoch,
                result: client.kill(epoch).await,
            }
        },
    );
}

pub(super) fn shutdown(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    client: ResourceClient,
    epoch: Option<ResourceEpoch>,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::Shutdown,
        work,
        async move { Work::Shutdown(client.shutdown(epoch).await) },
    );
}

pub(super) fn shutdown_retry(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    client: ResourceClient,
    epoch: ResourceEpoch,
    delay: Duration,
    work: mpsc::Sender<Work>,
) {
    spawn(
        tasks,
        identities,
        TaskIdentity::ShutdownRetry,
        work,
        async move {
            tokio::time::sleep(delay).await;
            Work::ShutdownRetry(client.shutdown(Some(epoch)).await)
        },
    );
}

async fn await_stdio_drain(
    mut drain: StdioDrain,
    mut control: watch::Receiver<StdioDrainControl>,
) -> StdioDrainCompletion {
    loop {
        let state = *control.borrow();
        match state {
            StdioDrainControl::Pending => {
                tokio::select! {
                    biased;
                    changed = control.changed() => {
                        if changed.is_err() {
                            return StdioDrainCompletion::Completed(StdioDrainResult::Cancelled);
                        }
                    }
                    result = &mut drain => return StdioDrainCompletion::Completed(result),
                }
            }
            StdioDrainControl::Deadline(deadline) => {
                return tokio::select! {
                    biased;
                    changed = control.changed() => {
                        if changed.is_err() {
                            StdioDrainCompletion::Completed(StdioDrainResult::Cancelled)
                        } else {
                            continue;
                        }
                    }
                    result = tokio::time::timeout_at(deadline, &mut drain) => match result {
                        Ok(result) => StdioDrainCompletion::Completed(result),
                        Err(_) => StdioDrainCompletion::DeadlineElapsed,
                    },
                };
            }
            StdioDrainControl::Cancel => {
                return StdioDrainCompletion::Completed(StdioDrainResult::Cancelled);
            }
        }
    }
}

pub(super) fn timer(
    tasks: &mut JoinSet<TaskIdentity>,
    identities: &mut Vec<(Id, TaskIdentity, bool)>,
    generation: u64,
    cancellation: CancellationToken,
    deadline: Instant,
    work: mpsc::Sender<Work>,
) {
    let identity = TaskIdentity::Timer(generation);
    let handle = tasks.spawn(async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {}
            _ = sleep_until(deadline) => {
                let _ = work.send(Work::Timer(generation)).await;
            }
        }
        identity
    });
    identities.push((handle.id(), identity, false));
}
