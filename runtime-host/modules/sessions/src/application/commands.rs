use std::sync::Arc;

use crate::ports::{RuntimeOperationFailure, SessionReleaseOutcome, SessionSync};
use crate::goal::{SessionGoalCommand, SessionGoalOutcome};
use connectors::ConnectorSecretResolverPort;
use foundation::execution::CommandRoute;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{
    approval::{SessionApprovalCommand, SessionApprovalOutcome},
    create::{SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
    question::{SessionQuestionCommand, SessionQuestionOutcome},
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    state::{
        SessionDelta, SessionEventBinding, SessionIdentity, SessionProvider, SessionSourceBinding,
        SessionState,
    },
};

#[derive(Clone, Debug)]
pub enum SessionEnsureOutcome {
    Created(SessionState),
    Existing(SessionState),
    RuntimeNotFound,
    RuntimeNoSessionSupport,
    Failed,
}

#[derive(Clone, Debug)]
pub enum SessionIngestOutcome {
    Applied(SessionDelta),
    TerminalRestored,
    Consumed { cursor: u64 },
    Duplicate { cursor: u64 },
    Stale { cursor: u64, received: u64 },
    Gap { expected: u64, received: u64 },
    Rejected { reason: String },
    RuntimeNotFound,
    RuntimeNoSessionSupport,
}

#[derive(Clone, Debug)]
pub enum SessionEvictOutcome {
    Evicted,
    NotFound,
    Failed,
}

pub struct SessionEvent {
    pub binding: SessionEventBinding,
    pub run_id: Option<String>,
    pub cursor: Option<u64>,
    pub history_refresh: bool,
    pub changes: Vec<super::state::SessionChange>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionObservationFailure {
    InvalidReadback,
}

pub enum SessionIngress {
    Event(SessionEvent),
    ObservationFailed {
        binding: SessionEventBinding,
        failure: SessionObservationFailure,
    },
    /// Recovery side effects only; never advances a native frontier or publishes replay.
    RestoredTerminal {
        binding: SessionEventBinding,
        terminal: crate::ports::SessionTerminalRun,
        assistant_texts: Vec<String>,
    },
}

impl SessionIngress {
    pub fn binding(&self) -> &SessionEventBinding {
        match self {
            Self::Event(event) => &event.binding,
            Self::ObservationFailed { binding, .. } | Self::RestoredTerminal { binding, .. } => binding,
        }
    }
}

pub struct SessionIngressEvent {
    identity: SessionIdentity,
    ingress: SessionIngress,
    receipt: Option<oneshot::Sender<bool>>,
}

impl SessionIngressEvent {
    pub fn new(identity: SessionIdentity, event: SessionEvent) -> Self {
        Self::from_ingress(identity, SessionIngress::Event(event))
    }

    pub fn observation_failed(
        identity: SessionIdentity,
        binding: SessionEventBinding,
        failure: SessionObservationFailure,
    ) -> Self {
        Self::from_ingress(identity, SessionIngress::ObservationFailed { binding, failure })
    }

    pub fn from_ingress(identity: SessionIdentity, ingress: SessionIngress) -> Self {
        Self { identity, ingress, receipt: None }
    }

    pub fn with_receipt(mut self) -> (Self, oneshot::Receiver<bool>) {
        let (receipt, received) = oneshot::channel();
        self.receipt = Some(receipt);
        (self, received)
    }

    pub fn take_receipt(&mut self) -> Option<oneshot::Sender<bool>> {
        self.receipt.take()
    }

    pub fn into_parts(self) -> (SessionIdentity, SessionIngress) {
        (self.identity, self.ingress)
    }
}

pub enum SessionSendRequest {
    Session {
        command: SessionSendCommand,
        cancellation: CancellationToken,
        reply: oneshot::Sender<SessionSendOutcome>,
    },
}

pub enum SessionCommand {
    Producing {
        command: Box<SessionCommand>,
        producer: crate::owner::terminal::Producer,
    },
    Audited {
        command: Box<SessionCommand>,
        call: crate::call::SessionCall,
    },
    Ensure {
        identity: SessionIdentity,
        source_binding: SessionSourceBinding,
        reply: oneshot::Sender<SessionEnsureOutcome>,
    },
    Ingest {
        identity: SessionIdentity,
        event: SessionEvent,
        reply: oneshot::Sender<SessionIngestOutcome>,
    },
    ObservationFailed {
        identity: SessionIdentity,
        binding: SessionEventBinding,
        failure: SessionObservationFailure,
        reply: oneshot::Sender<bool>,
    },
    ObserveReplyCompleted {
        identity: SessionIdentity,
        generation: u64,
        waiter_id: u64,
        acquired: bool,
    },
    SyncCompleted {
        identity: SessionIdentity,
        generation: u64,
        result: Result<SessionSync, RuntimeOperationFailure>,
    },
    SyncTerminals {
        identity: SessionIdentity,
        generation: u64,
        terminals: Vec<(crate::ports::SessionTerminalRun, Vec<String>)>,
        publish: bool,
        permit: crate::owner::terminal::TerminalPermit,
        reply: oneshot::Sender<Option<crate::state::SyncTerminalChanges>>,
    },
    TerminalIngest {
        identity: SessionIdentity,
        event: SessionEvent,
        permit: crate::owner::terminal::TerminalPermit,
        reply: oneshot::Sender<SessionIngestOutcome>,
    },
    TerminalDelivered {
        identity: SessionIdentity,
        run_id: String,
        reply: oneshot::Sender<bool>,
    },
    ObservationClosed {
        identity: SessionIdentity,
        generation: u64,
        restarted: Option<Result<u64, RuntimeOperationFailure>>,
    },
    Release {
        identity: SessionIdentity,
        lease_id: String,
        reply: oneshot::Sender<SessionReleaseOutcome>,
    },
    Evict {
        identity: SessionIdentity,
        reply: oneshot::Sender<SessionEvictOutcome>,
    },
    Create {
        command: SessionCreateCommand,
        reply: oneshot::Sender<SessionCreateOutcome>,
    },
    Send {
        request: SessionSendRequest,
    },
    SendCompleted {
        command: SessionSendCommand,
        goal_demand: Option<(String, Option<String>)>,
        receive_demand_added: bool,
        outcome: SessionSendOutcome,
        reply: oneshot::Sender<SessionSendOutcome>,
        call: Option<crate::call::SessionCall>,
    },
    Delete {
        command: SessionDeleteCommand,
        reply: oneshot::Sender<SessionDeleteOutcome>,
    },
    Rename {
        command: SessionRenameCommand,
        reply: oneshot::Sender<SessionRenameOutcome>,
    },
    Approval {
        command: SessionApprovalCommand,
        reply: oneshot::Sender<SessionApprovalOutcome>,
    },
    Question {
        command: SessionQuestionCommand,
        reply: oneshot::Sender<SessionQuestionOutcome>,
    },
    ModelSelection {
        command: SessionModelSelectionCommand,
        reply: oneshot::Sender<SessionModelSelectionOutcome>,
    },
    Goal {
        command: SessionGoalCommand,
        reply: oneshot::Sender<SessionGoalOutcome>,
    },
    GoalCompleted {
        command: SessionGoalCommand,
        demand_lease: String,
        outcome: SessionGoalOutcome,
        reply: oneshot::Sender<SessionGoalOutcome>,
        call: Option<crate::call::SessionCall>,
    },
    Permission {
        command: SessionPermissionCommand,
        reply: oneshot::Sender<SessionPermissionOutcome>,
    },
    ConfigurePrivateResolver {
        resolver: Arc<dyn ConnectorSecretResolverPort>,
        reply: oneshot::Sender<()>,
    },
}

impl SessionCommand {
    pub(crate) fn requires_terminal_settlement(&self) -> bool {
        match self {
            Self::Audited { command, .. } | Self::Producing { command, .. } => command.requires_terminal_settlement(),
            Self::Create { .. } | Self::Delete { .. } | Self::Evict { .. } => true,
            _ => false,
        }
    }

    pub fn send_unavailable(self) {
        match self {
            Self::Audited { command, .. } | Self::Producing { command, .. } => command.send_unavailable(),
            Self::Ensure { reply, .. } => {
                let _ = reply.send(SessionEnsureOutcome::Failed);
            }
            Self::Ingest { reply, .. } | Self::TerminalIngest { reply, .. } => {
                let _ = reply.send(SessionIngestOutcome::RuntimeNotFound);
            }
            Self::SyncCompleted { .. } | Self::ObservationClosed { .. } | Self::ObserveReplyCompleted { .. } => {}
            Self::ObservationFailed { reply, .. } => { let _ = reply.send(false); }
            Self::SyncTerminals { reply, .. } => { let _ = reply.send(None); }
            Self::TerminalDelivered { reply, .. } => { let _ = reply.send(false); }
            Self::Release { reply, .. } => {
                let _ = reply.send(SessionReleaseOutcome::Unavailable);
            }
            Self::Evict { reply, .. } => {
                let _ = reply.send(SessionEvictOutcome::Failed);
            }
            Self::Create { reply, .. } => {
                let _ = reply.send(SessionCreateOutcome::Unknown);
            }
            Self::Send { request } => match request {
                SessionSendRequest::Session { reply, .. } => {
                    let _ = reply.send(SessionSendOutcome::Unavailable);
                }
            },
            Self::SendCompleted { reply, .. } => {
                let _ = reply.send(SessionSendOutcome::Unavailable);
            }
            Self::Delete { reply, .. } => {
                let _ = reply.send(SessionDeleteOutcome::Unknown);
            }
            Self::Rename { reply, .. } => {
                let _ = reply.send(SessionRenameOutcome::Unknown);
            }
            Self::Approval { reply, .. } => {
                let _ = reply.send(SessionApprovalOutcome::Unavailable);
            }
            Self::Question { reply, .. } => {
                let _ = reply.send(SessionQuestionOutcome::unknown());
            }
            Self::ModelSelection { reply, .. } => {
                let _ = reply.send(SessionModelSelectionOutcome::Unavailable);
            }
            Self::Goal { reply, .. } | Self::GoalCompleted { reply, .. } => {
                let _ = reply.send(SessionGoalOutcome::Unavailable);
            }
            Self::Permission { reply, .. } => {
                let _ = reply.send(SessionPermissionOutcome::Unavailable);
            }
            Self::ConfigurePrivateResolver { reply, .. } => {
                let _ = reply.send(());
            }
        }
    }

    pub fn route(&self) -> CommandRoute<String> {
        match self {
            Self::Audited { command, .. } | Self::Producing { command, .. } => command.route(),
            Self::Ensure { identity, .. } | Self::Release { identity, .. } => {
                CommandRoute::Keyed(session_identity_lane_key(identity))
            }
            Self::Ingest { identity, .. }
            | Self::ObservationFailed { identity, .. }
            | Self::ObserveReplyCompleted { identity, .. }
            | Self::SyncCompleted { identity, .. }
            | Self::SyncTerminals { identity, .. }
            | Self::TerminalIngest { identity, .. }
            | Self::TerminalDelivered { identity, .. }
            | Self::ObservationClosed { identity, .. } => {
                CommandRoute::KeyedControl(session_identity_lane_key(identity))
            }
            Self::Evict { identity, .. } => {
                CommandRoute::Keyed(session_identity_lane_key(identity))
            }
            Self::Delete {
                command: super::delete::SessionDeleteCommand { identity },
                ..
            }
            | Self::Rename {
                command: super::rename::SessionRenameCommand { identity, .. },
                ..
            } => CommandRoute::Keyed(session_identity_lane_key(identity)),
            Self::ModelSelection {
                command:
                    super::model_selection::SessionModelSelectionCommand {
                        endpoint,
                        session_key,
                        ..
                    },
                ..
            } => CommandRoute::Keyed(session_lane_key(endpoint.provider(), session_key)),
            Self::Permission { command, .. } => CommandRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                command.session_key(),
            )),
            Self::Goal { command, .. } => {
                CommandRoute::Keyed(session_identity_lane_key(&command.identity))
            }
            Self::Question { command, .. } => {
                CommandRoute::Keyed(session_identity_lane_key(&command.identity))
            }
            Self::GoalCompleted { command, .. } => {
                CommandRoute::KeyedControl(session_identity_lane_key(&command.identity))
            }
            Self::ConfigurePrivateResolver { .. } => CommandRoute::Global,
            Self::Create { command, .. } => {
                CommandRoute::Keyed(session_identity_lane_key(&command.identity()))
            }
            Self::Send { request } => match request {
                SessionSendRequest::Session { command, .. } => {
                    CommandRoute::Keyed(session_identity_lane_key(&command.identity))
                }
            },
            Self::SendCompleted { command, .. } => {
                CommandRoute::KeyedControl(session_identity_lane_key(&command.identity))
            }
            Self::Approval { command, .. } => CommandRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                &command.session_id,
            )),
        }
    }
}

pub fn session_lane_key(provider: SessionProvider, session_key: &str) -> String {
    match provider {
        SessionProvider::OpenClaw => format!("openclaw:{session_key}"),
        SessionProvider::MatchaAgent => format!("matcha-agent:{session_key}"),
    }
}

pub fn inferred_session_lane_key(session_key: &str) -> String {
    if session_key.starts_with("matcha-agent:") {
        session_lane_key(SessionProvider::MatchaAgent, session_key)
    } else {
        session_lane_key(SessionProvider::OpenClaw, session_key)
    }
}

pub fn session_identity_lane_key(identity: &SessionIdentity) -> String {
    serde_json::to_string(identity).expect("session identity serialization")
}
