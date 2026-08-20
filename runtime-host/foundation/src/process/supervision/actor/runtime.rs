use std::{
    future::pending,
    panic::{AssertUnwindSafe, resume_unwind},
    sync::Arc,
};

use futures_util::FutureExt;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::{Id, JoinError, JoinSet},
};

use super::super::super::resource::{
    Activation, ResourceClient, ResourceEpoch, ResourceEvent, ResourceRuntime,
};
use super::super::{
    GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation,
    SupervisorSnapshot,
    dispatch::{Command, ControlCommand},
    settle::State,
    worker::{TaskIdentity, Work},
};

pub(super) struct Policies<A, R, G, S, T> {
    pub(super) stdio_activation: Arc<A>,
    pub(super) readiness: Arc<R>,
    pub(super) graceful_stop: Arc<G>,
    pub(super) recovery: Arc<S>,
    pub(super) restart_policy: Arc<T>,
}

pub(super) enum Inbound {
    OwnerDropped,
    Command(Command),
    Control(ControlCommand),
    Resource(ResourceEvent),
    ResourceClosed,
    Work(Work),
    TaskFinished(Result<(Id, TaskIdentity), JoinError>),
}

#[derive(Clone, Copy)]
pub(super) enum ReceiveTurn {
    Control,
    Resource,
    Task,
    Work,
    Command,
}

impl ReceiveTurn {
    const fn next(self) -> Self {
        match self {
            Self::Control => Self::Resource,
            Self::Resource => Self::Task,
            Self::Task => Self::Work,
            Self::Work => Self::Command,
            Self::Command => Self::Control,
        }
    }
}

pub(super) enum FinalShutdown {
    Terminated(super::super::super::TerminationOutcome),
    Detached,
}

pub(super) struct Actor<A, R, G, S, T> {
    pub(super) policies: Policies<A, R, G, S, T>,
    pub(super) state: State,
    pub(super) resource: Option<ResourceRuntime>,
    pub(super) resource_events_open: bool,
    pub(super) commands: mpsc::Receiver<Command>,
    pub(super) controls: mpsc::Receiver<ControlCommand>,
    pub(super) owner_dropped: Option<oneshot::Receiver<()>>,
    pub(super) snapshots: watch::Sender<SupervisorSnapshot>,
    pub(super) work_sender: mpsc::Sender<Work>,
    pub(super) work: mpsc::Receiver<Work>,
    pub(super) tasks: JoinSet<TaskIdentity>,
    pub(super) task_identities: Vec<(Id, TaskIdentity, bool)>,
    pub(super) stdio_control: watch::Sender<super::super::worker::StdioDrainControl>,
    pub(super) receive_turn: ReceiveTurn,
    pub(super) next_request_id: u64,
    pub(super) next_activation_request_id: u64,
    pub(super) native_activation: Option<(ResourceEpoch, Activation)>,
    pub(super) pending_terminal: Option<super::super::super::resource::SharedTerminalEvidence>,
    pub(super) shutdown_terminal_ready: bool,
    pub(super) shutdown_terminal_outcome: Option<super::super::super::TerminationOutcome>,
    pub(super) shutdown_retry_pending: bool,
    pub(super) final_outcome: Option<FinalShutdown>,
}

impl<A, R, G, S, T> Actor<A, R, G, S, T>
where
    A: StdioActivation,
    R: ReadinessProbe,
    G: GracefulStop,
    S: StartRecovery,
    T: RestartPolicy,
{
    pub(super) fn new(
        parts: super::Parts<A, R, G, S, T>,
        state: State,
        resource: ResourceRuntime,
        commands: mpsc::Receiver<Command>,
        controls: mpsc::Receiver<ControlCommand>,
        owner_dropped: oneshot::Receiver<()>,
        snapshots: watch::Sender<SupervisorSnapshot>,
    ) -> Self {
        let (work_sender, work) = mpsc::channel(16);
        let (stdio_control, _) = watch::channel(super::super::worker::StdioDrainControl::Pending);
        Self {
            policies: Policies {
                stdio_activation: Arc::new(parts.stdio_activation),
                readiness: Arc::new(parts.readiness),
                graceful_stop: Arc::new(parts.graceful_stop),
                recovery: Arc::new(parts.recovery),
                restart_policy: Arc::new(parts.restart_policy),
            },
            state,
            resource: Some(resource),
            resource_events_open: true,
            commands,
            controls,
            owner_dropped: Some(owner_dropped),
            snapshots,
            work_sender,
            work,
            tasks: JoinSet::new(),
            task_identities: Vec::new(),
            stdio_control,
            receive_turn: ReceiveTurn::Control,
            next_request_id: 0,
            next_activation_request_id: 0,
            native_activation: None,
            pending_terminal: None,
            shutdown_terminal_ready: false,
            shutdown_terminal_outcome: None,
            shutdown_retry_pending: false,
            final_outcome: None,
        }
    }

    pub(super) async fn run(mut self) {
        let failure = AssertUnwindSafe(self.drive()).catch_unwind().await.err();
        if failure.is_some() {
            let _ = self.drain_custody().await;
        } else {
            self.finalize().await;
        }
        if let Some(failure) = failure {
            resume_unwind(failure);
        }
    }

    async fn drive(&mut self) {
        while self.final_outcome.is_none() {
            match self.receive().await {
                Inbound::OwnerDropped => self.owner_dropped(),
                Inbound::Command(command) => self.command(command),
                Inbound::Control(control) => self.control_batch(control),
                Inbound::Resource(event) => self.resource_event(event),
                Inbound::ResourceClosed => self.resource_closed(),
                Inbound::Work(work) => self.work(work),
                Inbound::TaskFinished(result) => self.task_finished(result),
            }
        }
    }

    pub(super) fn control_batch(&mut self, control: ControlCommand) {
        let previous = self.state.intent;
        let batch_open = !self.state.admission_closed;
        self.control(control, batch_open);
        for _ in 1..16 {
            let Ok(control) = self.controls.try_recv() else {
                break;
            };
            self.control(control, batch_open);
        }
        if self.state.intent != previous {
            self.apply_control();
        }
    }

    pub(super) async fn receive(&mut self) -> Inbound {
        if self.owner_dropped.as_mut().is_some_and(|owner_dropped| {
            !matches!(
                owner_dropped.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            )
        }) {
            self.owner_dropped = None;
            return Inbound::OwnerDropped;
        }

        for _ in 0..5 {
            let turn = self.receive_turn;
            self.receive_turn = turn.next();
            let inbound = match turn {
                ReceiveTurn::Control => self.controls.try_recv().ok().map(Inbound::Control),
                ReceiveTurn::Resource if self.resource_events_open => self
                    .resource
                    .as_mut()
                    .and_then(|resource| match resource.events.try_recv() {
                        Ok(event) => Some(Inbound::Resource(event)),
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            Some(Inbound::ResourceClosed)
                        }
                        Err(mpsc::error::TryRecvError::Empty) => None,
                    }),
                ReceiveTurn::Resource => None,
                ReceiveTurn::Task => self.work.try_recv().ok().map(Inbound::Work).or_else(|| {
                    self.tasks
                        .try_join_next_with_id()
                        .map(Inbound::TaskFinished)
                }),
                ReceiveTurn::Work => self.work.try_recv().ok().map(Inbound::Work),
                ReceiveTurn::Command => self.commands.try_recv().ok().map(Inbound::Command),
            };
            if let Some(inbound) = inbound {
                return inbound;
            }
        }

        let owner_dropped = &mut self.owner_dropped;
        let events = self.resource.as_mut().map(|resource| &mut resource.events);
        let events_open = self.resource_events_open;
        let tasks = &mut self.tasks;
        let inbound = tokio::select! {
            biased;
            _ = async {
                match owner_dropped {
                    Some(owner_dropped) => {
                        let _ = owner_dropped.await;
                    }
                    None => pending().await,
                }
            } => Inbound::OwnerDropped,
            Some(control) = self.controls.recv() => Inbound::Control(control),
            event = async {
                match events {
                    Some(events) if events_open => events.recv().await,
                    Some(_) | None => pending().await,
                }
            } => match event {
                Some(event) => Inbound::Resource(event),
                None => Inbound::ResourceClosed,
            },
            Some(work) = self.work.recv() => Inbound::Work(work),
            Some(result) = tasks.join_next_with_id(), if !tasks.is_empty() => {
                Inbound::TaskFinished(result)
            },
            Some(command) = self.commands.recv() => Inbound::Command(command),
        };
        self.receive_turn = match &inbound {
            Inbound::OwnerDropped => {
                self.owner_dropped = None;
                ReceiveTurn::Control
            }
            Inbound::Control(_) => ReceiveTurn::Resource,
            Inbound::Resource(_) | Inbound::ResourceClosed => ReceiveTurn::Task,
            Inbound::TaskFinished(_) => ReceiveTurn::Work,
            Inbound::Work(_) => ReceiveTurn::Command,
            Inbound::Command(_) => ReceiveTurn::Control,
        };
        inbound
    }

    pub(super) fn client(&self) -> &ResourceClient {
        &self
            .resource
            .as_ref()
            .expect("resource runtime available")
            .client
    }
}
