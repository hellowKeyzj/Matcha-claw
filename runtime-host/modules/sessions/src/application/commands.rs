use std::{fmt::Write, sync::Arc};

use connectors::ConnectorSecretResolverPort;
use foundation::execution::CommandRoute;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{SessionApprovalCommand, SessionApprovalOutcome},
    create::{SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
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
    pub changes: Vec<super::state::SessionChange>,
}

pub struct SessionIngressEvent {
    identity: SessionIdentity,
    event: SessionEvent,
}

impl SessionIngressEvent {
    pub fn new(identity: SessionIdentity, event: SessionEvent) -> Self {
        Self { identity, event }
    }

    pub fn into_parts(self) -> (SessionIdentity, SessionEvent) {
        (self.identity, self.event)
    }
}

pub enum SessionSendRequest {
    Session {
        command: SessionSendCommand,
        reply: oneshot::Sender<SessionSendOutcome>,
    },
}

pub enum SessionAbortRequest {
    Session {
        command: SessionAbortCommand,
        reply: oneshot::Sender<SessionAbortOutcome>,
    },
}

pub enum SessionCommand {
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
    pub fn send_unavailable(self) {
        match self {
            Self::Ensure { reply, .. } => {
                let _ = reply.send(SessionEnsureOutcome::Failed);
            }
            Self::Ingest { reply, .. } => {
                let _ = reply.send(SessionIngestOutcome::RuntimeNotFound);
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
            Self::Abort { request } => match request {
                SessionAbortRequest::Session { reply, .. } => {
                    let _ = reply.send(SessionAbortOutcome::Unavailable);
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
            Self::Evict { session_key, .. } => {
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
            Self::Permission { command, .. } => CommandRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                command.session_key(),
            )),
            Self::ConfigurePrivateResolver { .. } => CommandRoute::Global,
            Self::Create { command, .. } => {
                CommandRoute::Keyed(session_lane_key(command.provider(), command.session_key()))
            }
            Self::Send { request } => match request {
                SessionSendRequest::Session { command, .. } => CommandRoute::Keyed(
                    session_lane_key(command.endpoint.provider(), &command.session_key),
                ),
            },
            Self::Abort { request } => match request {
                SessionAbortRequest::Session { command, .. } => CommandRoute::Keyed(
                    session_lane_key(command.endpoint.provider(), &command.session_key),
                ),
            },
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

pub fn openclaw_agent_lane_key(agent_id: &str, session_key: &str) -> String {
    if session_key.starts_with("agent:") {
        session_lane_key(SessionProvider::OpenClaw, session_key)
    } else {
        session_lane_key(
            SessionProvider::OpenClaw,
            &format!("agent:{agent_id}:{session_key}"),
        )
    }
}

/// Derives the deterministic renderer route key Host owns for a team role session.
///
/// The renderer contract only admits `renderer-route:` followed by `[A-Za-z0-9_-]`,
/// so a session key carrying `:` separators is folded into a fixed-width digest.
pub fn role_session_route_key(session_key: &str) -> String {
    let digest = Sha256::digest(session_key.as_bytes());
    let mut route_key = String::with_capacity("renderer-route:team-".len() + 24);
    route_key.push_str("renderer-route:team-");
    for byte in &digest[..12] {
        let _ = write!(&mut route_key, "{byte:02x}");
    }
    route_key
}
