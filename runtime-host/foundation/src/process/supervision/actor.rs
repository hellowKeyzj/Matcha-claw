mod activation;
mod command;
mod control;
mod finish;
mod lifecycle;
mod runtime;
mod task;
mod terminal;

#[cfg(test)]
mod tests;

use tokio::sync::{mpsc, oneshot, watch};

use super::super::resource::ResourceRuntime;
use super::{
    GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation,
    SupervisorSnapshot,
    dispatch::{Command, ControlCommand},
    settle::State,
};

pub(crate) struct Parts<A, R, G, S, T> {
    pub(crate) stdio_activation: A,
    pub(crate) readiness: R,
    pub(crate) graceful_stop: G,
    pub(crate) recovery: S,
    pub(crate) restart_policy: T,
}

pub(crate) async fn run<A, R, G, S, T>(
    parts: Parts<A, R, G, S, T>,
    state: State,
    resource: ResourceRuntime,
    commands: mpsc::Receiver<Command>,
    controls: mpsc::Receiver<ControlCommand>,
    owner_dropped: oneshot::Receiver<()>,
    snapshots: watch::Sender<SupervisorSnapshot>,
) where
    A: StdioActivation,
    R: ReadinessProbe,
    G: GracefulStop,
    S: StartRecovery,
    T: RestartPolicy,
{
    resource.task.start();
    runtime::Actor::new(
        parts,
        state,
        resource,
        commands,
        controls,
        owner_dropped,
        snapshots,
    )
    .run()
    .await;
}
