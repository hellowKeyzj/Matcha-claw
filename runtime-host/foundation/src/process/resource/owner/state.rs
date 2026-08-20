use tokio::{
    sync::{mpsc, oneshot},
    time::Instant,
};

use super::super::{
    LaunchAttemptGuard, LaunchAttemptMaterializer, ProcessObservation, ResourceEpoch,
    ResourceEventSender, SharedTerminalEvidence, TerminationFailure,
    adapter::PollTicket,
    client::{EvidenceReply, Request, ShutdownReply},
};
use super::AdapterOwner;

pub(super) struct Waiter {
    pub(super) epoch: ResourceEpoch,
    pub(super) deadline: Option<Instant>,
    pub(super) reply: EvidenceReply,
}

pub(super) enum OwnerState {
    Empty,
    Installing {
        epoch: ResourceEpoch,
    },
    AwaitingActivation {
        epoch: ResourceEpoch,
        observation: ProcessObservation,
        activation: oneshot::Receiver<()>,
        activation_reply: oneshot::Sender<super::super::ActivationOutcome>,
        terminal: Option<SharedTerminalEvidence>,
        unresolved: Option<(Option<ProcessObservation>, TerminationFailure)>,
    },
    Active {
        epoch: ResourceEpoch,
        observation: ProcessObservation,
    },
    Unresolved {
        epoch: ResourceEpoch,
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    },
    MaterialCleanupFailed {
        epoch: ResourceEpoch,
        terminal: Option<SharedTerminalEvidence>,
    },
    Closing,
    Closed,
}

pub(super) struct Owner {
    pub(super) adapter: AdapterOwner,
    pub(super) materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
    pub(super) active_attempt: Option<(ResourceEpoch, Box<dyn LaunchAttemptGuard>)>,
    pub(super) requests: mpsc::Receiver<Request>,
    pub(super) events: ResourceEventSender,
    pub(super) state: OwnerState,
    pub(super) next_epoch: Option<ResourceEpoch>,
    pub(super) last_terminal: Option<SharedTerminalEvidence>,
    pub(super) waiters: Vec<Waiter>,
    pub(super) pending_shutdown: Option<ShutdownReply>,
    pub(super) poll: Option<(ResourceEpoch, PollTicket)>,
    pub(super) next_poll_at: Instant,
    pub(super) next_non_request: NonRequestCursor,
    pub(super) non_request_turn: bool,
    pub(super) orphaned: bool,
}

#[derive(Clone, Copy)]
pub(super) enum NonRequestCursor {
    Activation,
    Poll,
    Wake,
}

impl NonRequestCursor {
    pub(super) const fn next(self) -> Self {
        match self {
            Self::Activation => Self::Poll,
            Self::Poll => Self::Wake,
            Self::Wake => Self::Activation,
        }
    }
}
