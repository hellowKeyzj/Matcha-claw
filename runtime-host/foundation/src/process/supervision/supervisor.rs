use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tokio::sync::oneshot;

use super::super::{ShutdownOutcome, resource::ResourceRuntime, task::TaskOwner};
use super::{
    CommandReceipt, RestartOutcome, StartOutcome, SupervisorLease, SupervisorSnapshot,
    TerminationCompletion,
    actor::{self, Parts},
    dispatch::Ingress,
    policy::{GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation},
};

#[derive(Clone)]
pub struct SupervisorHandle {
    ingress: Ingress,
    actor: TaskOwner<()>,
}

impl std::fmt::Debug for SupervisorHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SupervisorHandle")
            .finish_non_exhaustive()
    }
}

impl SupervisorHandle {
    pub async fn start(&self) -> CommandReceipt<StartOutcome> {
        self.actor.start();
        self.ingress.start().await
    }

    pub async fn restart(&self) -> CommandReceipt<RestartOutcome> {
        self.actor.start();
        self.ingress.restart().await
    }

    pub async fn stop(&self) -> CommandReceipt<TerminationCompletion> {
        self.actor.start();
        self.ingress.stop().await
    }

    pub async fn kill(&self) -> CommandReceipt<TerminationCompletion> {
        self.actor.start();
        self.ingress.kill().await
    }

    pub async fn shutdown(&self) -> CommandReceipt<ShutdownOutcome> {
        self.actor.start();
        self.ingress.shutdown().await
    }

    pub fn lease(&self) -> Option<SupervisorLease> {
        self.ingress.lease()
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.ingress.snapshot()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.ingress.subscribe()
    }
}

pub struct Supervisor {
    handle: SupervisorHandle,
    actor: TaskOwner<()>,
    resource_started: bool,
    lease_issuance_closed: Arc<AtomicBool>,
    owner_drop: Option<oneshot::Sender<()>>,
}

impl Supervisor {
    pub(crate) fn new<A, R, G, S, T>(
        resource: ResourceRuntime,
        stdio_activation: A,
        readiness: R,
        graceful_stop: G,
        recovery: S,
        restart_policy: T,
    ) -> Self
    where
        A: StdioActivation,
        R: ReadinessProbe,
        G: GracefulStop,
        S: StartRecovery,
        T: RestartPolicy,
    {
        let (commands, command_receiver) = tokio::sync::mpsc::channel(16);
        let (controls, control_receiver) = tokio::sync::mpsc::channel(16);
        let (owner_drop, owner_dropped) = oneshot::channel();
        let resource_started = resource.task.is_started();
        let state = super::settle::State::new(resource.initial);
        let (snapshots, snapshot_receiver) =
            tokio::sync::watch::channel(SupervisorSnapshot::idle());
        let leases = state.published_lease();
        let lease_issuance_closed = state.lease_issuance_closed();
        state.publish(&snapshots);
        let actor = TaskOwner::deferred(actor::run(
            Parts {
                stdio_activation,
                readiness,
                graceful_stop,
                recovery,
                restart_policy,
            },
            state,
            resource,
            command_receiver,
            control_receiver,
            owner_dropped,
            snapshots,
        ));
        let handle = SupervisorHandle {
            ingress: Ingress::new(commands, controls, snapshot_receiver, leases),
            actor: actor.clone(),
        };
        Self {
            handle,
            actor,
            resource_started,
            lease_issuance_closed,
            owner_drop: Some(owner_drop),
        }
    }

    pub fn handle(&self) -> SupervisorHandle {
        self.handle.clone()
    }

    pub async fn join(&mut self) -> Result<(), tokio::task::JoinError> {
        (&mut self.actor).await
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.lease_issuance_closed.store(true, Ordering::Release);
        self.handle.ingress.invalidate_lease();
        if let Some(owner_drop) = self.owner_drop.take() {
            let _ = owner_drop.send(());
        }
        if self.resource_started {
            self.actor.start();
        }
    }
}
