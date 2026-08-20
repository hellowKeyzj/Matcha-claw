use std::sync::{Arc, RwLock};

use tokio::sync::{mpsc, oneshot, watch};

use super::super::ShutdownOutcome;
use super::{
    CommandReceipt, RestartOutcome, StartOutcome, SupervisorLease, SupervisorPhase,
    SupervisorSnapshot, TerminationCompletion,
};

pub(super) enum Command {
    Start(oneshot::Sender<CommandReceipt<StartOutcome>>),
    Restart(oneshot::Sender<CommandReceipt<RestartOutcome>>),
}

pub(super) enum ControlCommand {
    Stop(oneshot::Sender<CommandReceipt<TerminationCompletion>>),
    Kill(oneshot::Sender<CommandReceipt<TerminationCompletion>>),
    Shutdown(oneshot::Sender<CommandReceipt<ShutdownOutcome>>),
}

#[derive(Clone)]
pub(super) struct Ingress {
    commands: mpsc::Sender<Command>,
    controls: mpsc::Sender<ControlCommand>,
    snapshots: watch::Receiver<SupervisorSnapshot>,
    lease: Arc<RwLock<Option<SupervisorLease>>>,
}

impl Ingress {
    pub(super) fn new(
        commands: mpsc::Sender<Command>,
        controls: mpsc::Sender<ControlCommand>,
        snapshots: watch::Receiver<SupervisorSnapshot>,
        lease: Arc<RwLock<Option<SupervisorLease>>>,
    ) -> Self {
        Self {
            commands,
            controls,
            snapshots,
            lease,
        }
    }

    pub(super) async fn start(&self) -> CommandReceipt<StartOutcome> {
        self.ask(&self.commands, Command::Start).await
    }

    pub(super) async fn restart(&self) -> CommandReceipt<RestartOutcome> {
        self.ask(&self.commands, Command::Restart).await
    }

    pub(super) async fn stop(&self) -> CommandReceipt<TerminationCompletion> {
        self.ask(&self.controls, ControlCommand::Stop).await
    }

    pub(super) async fn kill(&self) -> CommandReceipt<TerminationCompletion> {
        self.ask(&self.controls, ControlCommand::Kill).await
    }

    pub(super) async fn shutdown(&self) -> CommandReceipt<ShutdownOutcome> {
        if self.snapshot().phase() == SupervisorPhase::ShutDown {
            return CommandReceipt::AlreadySatisfied;
        }
        let receipt = self.ask(&self.controls, ControlCommand::Shutdown).await;
        if matches!(receipt, CommandReceipt::ShuttingDown)
            && self.snapshot().phase() == SupervisorPhase::ShutDown
        {
            CommandReceipt::AlreadySatisfied
        } else {
            receipt
        }
    }

    pub(super) fn lease(&self) -> Option<SupervisorLease> {
        self.lease
            .read()
            .expect("supervisor lease state lock poisoned")
            .clone()
    }

    pub(super) fn invalidate_lease(&self) {
        if let Some(lease) = self
            .lease
            .write()
            .expect("supervisor lease state lock poisoned")
            .take()
        {
            lease.cancel();
        }
    }

    pub(super) fn snapshot(&self) -> SupervisorSnapshot {
        self.snapshots.borrow().clone()
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<SupervisorSnapshot> {
        self.snapshots.clone()
    }

    async fn ask<T, C>(
        &self,
        sender: &mpsc::Sender<C>,
        command: impl FnOnce(oneshot::Sender<CommandReceipt<T>>) -> C,
    ) -> CommandReceipt<T> {
        let (reply, receipt) = oneshot::channel();
        if sender.send(command(reply)).await.is_err() {
            return CommandReceipt::ShuttingDown;
        }
        receipt.await.unwrap_or(CommandReceipt::ShuttingDown)
    }
}
