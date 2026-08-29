use foundation::execution::CommandRoute;
use tokio::sync::oneshot;

use super::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{SessionApprovalCommand, SessionApprovalOutcome},
    create::{SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    state::{SessionDelta, SessionIdentity, SessionProvider, SessionSourceBinding, SessionState},
};

pub(crate) type OpenClawSessionResult<T> =
    Result<T, crate::RuntimeSessionError<openclaw::port::OpenClawSessionError>>;
pub(crate) type OpenClawInvocationResult<T> = Result<
    platform::exchange::InvocationOutcome<T, openclaw::port::OpenClawSessionError>,
    crate::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
>;

#[derive(Clone, Debug)]
pub(crate) enum SessionEnsureOutcome {
    Created(SessionState),
    Existing(SessionState),
    RuntimeNotFound,
    RuntimeNoSessionSupport,
    Failed,
}

#[derive(Clone, Debug)]
pub(crate) enum SessionIngestOutcome {
    Applied(SessionDelta),
    Duplicate { cursor: u64 },
    Stale { cursor: u64, received: u64 },
    Gap { expected: u64, received: u64 },
    Rejected { reason: String },
    RuntimeNotFound,
    RuntimeNoSessionSupport,
}

#[derive(Clone, Debug)]
pub(crate) enum SessionEvictOutcome {
    Evicted,
    NotFound,
    Failed,
}

pub(crate) struct SessionEvent {
    pub(crate) binding: SessionSourceBinding,
    pub(crate) run_id: Option<String>,
    pub(crate) cursor: Option<u64>,
    pub(crate) changes: Vec<super::state::SessionChange>,
}

pub(crate) enum SessionSendRequest {
    Session {
        command: SessionSendCommand,
        reply: oneshot::Sender<SessionSendOutcome>,
    },
    OpenClawChat {
        params: openclaw::session::protocol::ChatSendParams,
        reply:
            oneshot::Sender<OpenClawInvocationResult<openclaw::session::protocol::ChatSendResult>>,
    },
}

pub(crate) enum SessionAbortRequest {
    Session {
        command: SessionAbortCommand,
        reply: oneshot::Sender<SessionAbortOutcome>,
    },
    OpenClawChat {
        params: openclaw::session::protocol::ChatAbortParams,
        reply:
            oneshot::Sender<OpenClawInvocationResult<openclaw::session::protocol::ChatAbortResult>>,
    },
}

pub(crate) enum SessionCommand {
    Ensure {
        identity: SessionIdentity,
        reply: oneshot::Sender<SessionEnsureOutcome>,
    },
    Ingest {
        identity: SessionIdentity,
        event: SessionEvent,
        reply: oneshot::Sender<SessionIngestOutcome>,
    },
    Touch {
        session_key: String,
        reply: oneshot::Sender<()>,
    },
    Evict {
        session_key: String,
        reply: oneshot::Sender<SessionEvictOutcome>,
    },
    Create {
        command: SessionCreateCommand,
        reply: oneshot::Sender<SessionCreateOutcome>,
    },
    Send {
        request: SessionSendRequest,
    },
    Abort {
        request: SessionAbortRequest,
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
    ModelSelection {
        command: SessionModelSelectionCommand,
        reply: oneshot::Sender<SessionModelSelectionOutcome>,
    },
}

impl SessionCommand {
    pub(crate) fn send_unavailable(self) {
        match self {
            Self::Ensure { reply, .. } => {
                let _ = reply.send(SessionEnsureOutcome::Failed);
            }
            Self::Ingest { reply, .. } => {
                let _ = reply.send(SessionIngestOutcome::RuntimeNotFound);
            }
            Self::Touch { reply, .. } => {
                let _ = reply.send(());
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
                SessionSendRequest::OpenClawChat { reply, .. } => {
                    let _ = reply.send(Err(crate::RuntimeSessionError::RuntimeUnavailable));
                }
            },
            Self::Abort { request } => match request {
                SessionAbortRequest::Session { reply, .. } => {
                    let _ = reply.send(SessionAbortOutcome::Unavailable);
                }
                SessionAbortRequest::OpenClawChat { reply, .. } => {
                    let _ = reply.send(Err(crate::RuntimeSessionError::RuntimeUnavailable));
                }
            },
            Self::Delete { reply, .. } => {
                let _ = reply.send(SessionDeleteOutcome::Unknown);
            }
            Self::Rename { reply, .. } => {
                let _ = reply.send(SessionRenameOutcome::Unknown);
            }
            Self::Approval { reply, .. } => {
                let _ = reply.send(SessionApprovalOutcome::Unavailable);
            }
            Self::ModelSelection { reply, .. } => {
                let _ = reply.send(SessionModelSelectionOutcome::Unavailable);
            }
        }
    }

    pub(crate) fn route(&self) -> CommandRoute<String> {
        match self {
            Self::Ensure { identity, .. } => CommandRoute::Keyed(session_lane_key(
                identity.provider(),
                identity.session_key(),
            )),
            Self::Ingest {
                identity, event, ..
            } => CommandRoute::Keyed(session_lane_key(
                identity.provider(),
                event.binding.session_key(),
            )),
            Self::Touch { session_key, .. } | Self::Evict { session_key, .. } => {
                CommandRoute::Keyed(inferred_session_lane_key(session_key))
            }
            Self::Delete {
                command:
                    super::delete::SessionDeleteCommand {
                        agent_id,
                        session_key,
                    },
                ..
            }
            | Self::Rename {
                command:
                    super::rename::SessionRenameCommand {
                        agent_id,
                        session_key,
                        ..
                    },
                ..
            } => CommandRoute::Keyed(openclaw_agent_lane_key(agent_id, session_key)),
            Self::ModelSelection {
                command:
                    super::model_selection::SessionModelSelectionCommand {
                        endpoint,
                        session_key,
                        ..
                    },
                ..
            } => CommandRoute::Keyed(session_lane_key(endpoint.provider(), session_key)),
            Self::Create { command, .. } => {
                CommandRoute::Keyed(session_lane_key(command.provider(), command.session_key()))
            }
            Self::Send { request } => match request {
                SessionSendRequest::Session { command, .. } => CommandRoute::Keyed(
                    session_lane_key(command.endpoint.provider(), &command.session_key),
                ),
                SessionSendRequest::OpenClawChat { .. } => CommandRoute::Global,
            },
            Self::Abort { request } => match request {
                SessionAbortRequest::Session { command, .. } => CommandRoute::Keyed(
                    session_lane_key(command.endpoint.provider(), &command.session_key),
                ),
                SessionAbortRequest::OpenClawChat { .. } => CommandRoute::Global,
            },
            Self::Approval { command, .. } => CommandRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                &command.session_id,
            )),
        }
    }
}

pub(crate) fn session_lane_key(provider: SessionProvider, session_key: &str) -> String {
    match provider {
        SessionProvider::OpenClaw => format!("openclaw:{session_key}"),
        SessionProvider::MatchaAgent => format!("matcha-agent:{session_key}"),
    }
}

pub(crate) fn inferred_session_lane_key(session_key: &str) -> String {
    if session_key.starts_with("matcha-agent:") {
        session_lane_key(SessionProvider::MatchaAgent, session_key)
    } else {
        session_lane_key(SessionProvider::OpenClaw, session_key)
    }
}

pub(crate) fn openclaw_agent_lane_key(agent_id: &str, session_key: &str) -> String {
    if session_key.starts_with("agent:") {
        session_lane_key(SessionProvider::OpenClaw, session_key)
    } else {
        session_lane_key(
            SessionProvider::OpenClaw,
            &format!("agent:{agent_id}:{session_key}"),
        )
    }
}
