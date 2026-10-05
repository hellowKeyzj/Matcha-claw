use crate::ports::{SessionObserveCommand, SessionObserveOutcome};
use foundation::execution::QueryRoute;
use tokio::sync::oneshot;

use super::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{PendingApprovalsCommand, PendingApprovalsOutcome},
    commands::{session_identity_lane_key, session_lane_key},
    session_catalog::{SessionCatalogCommand, SessionCatalogOutcome},
    session_history::{SessionHistoryCommand, SessionHistoryOutcome},
    state::SessionView,
    timeline::{
        Command as SessionTimelineCommand, ContentCommand as SessionContentCommand,
        ContentOutcome as SessionContentOutcome, Outcome as SessionTimelineOutcome,
    },
};
pub enum SessionQuery {
    Audited {
        query: Box<SessionQuery>,
        call: crate::call::SessionCall,
    },
    BoundaryOutcome {
        command: &'static str,
        detail: crate::call::SessionsCallDetail,
        outcome: crate::call::SessionsCallOutcome,
        reply: oneshot::Sender<crate::call::SessionsCallOutcome>,
    },
    EventsSubscribed {
        reply: oneshot::Sender<()>,
    },
    ListSessions {
        reply: oneshot::Sender<Vec<SessionView>>,
    },
    GetSession {
        session_key: String,
        reply: oneshot::Sender<Option<SessionView>>,
    },
    Observe {
        command: SessionObserveCommand,
        reply: oneshot::Sender<SessionObserveOutcome>,
    },
    /// Native cancellation control; never queued behind a session send.
    Abort {
        command: SessionAbortCommand,
        reply: oneshot::Sender<SessionAbortOutcome>,
    },
    PendingApprovals {
        command: PendingApprovalsCommand,
        reply: oneshot::Sender<PendingApprovalsOutcome>,
    },
    Timeline {
        command: SessionTimelineCommand,
        reply: oneshot::Sender<SessionTimelineOutcome>,
    },
    Content {
        command: SessionContentCommand,
        reply: oneshot::Sender<SessionContentOutcome>,
    },
    Catalog {
        command: SessionCatalogCommand,
        reply: oneshot::Sender<SessionCatalogOutcome>,
    },
    History {
        command: SessionHistoryCommand,
        reply: oneshot::Sender<SessionHistoryOutcome>,
    },
}

impl SessionQuery {
    pub fn send_unavailable(self) {
        match self {
            Self::Audited { query, .. } => query.send_unavailable(),
            Self::BoundaryOutcome { outcome, reply, .. } => {
                let _ = reply.send(outcome);
            }
            Self::EventsSubscribed { reply } => {
                let _ = reply.send(());
            }
            Self::ListSessions { reply } => {
                let _ = reply.send(Vec::new());
            }
            Self::GetSession { reply, .. } => {
                let _ = reply.send(None);
            }
            Self::Observe { reply, .. } => {
                let _ = reply.send(SessionObserveOutcome::Unavailable);
            }
            Self::Abort { reply, .. } => {
                let _ = reply.send(SessionAbortOutcome::Unavailable);
            }
            Self::PendingApprovals { reply, .. } => {
                let _ = reply.send(PendingApprovalsOutcome::Unavailable);
            }
            Self::Timeline { reply, .. } => {
                let _ = reply.send(SessionTimelineOutcome::unavailable(
                    super::timeline::UnavailableReason::RuntimeUnavailable,
                ));
            }
            Self::Content { reply, .. } => {
                let _ = reply.send(SessionContentOutcome::unavailable(
                    super::timeline::UnavailableReason::RuntimeUnavailable,
                ));
            }
            Self::Catalog { reply, .. } => {
                let _ = reply.send(SessionCatalogOutcome::Unavailable);
            }
            Self::History { reply, .. } => {
                let _ = reply.send(SessionHistoryOutcome::Failed(
                    super::session_history::SessionHistoryFailure::Unavailable,
                ));
            }
        }
    }
}

impl SessionQuery {
    pub fn route(&self) -> QueryRoute<String> {
        match self {
            Self::Audited { query, .. } => query.route(),
            Self::Abort { .. }
            | Self::BoundaryOutcome { .. }
            | Self::EventsSubscribed { .. }
            | Self::ListSessions { .. }
            | Self::GetSession { .. } => QueryRoute::Direct,
            Self::Observe { command, .. } => {
                QueryRoute::Keyed(session_identity_lane_key(&command.identity))
            }
            Self::PendingApprovals { command, .. } => QueryRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                &command.session_id,
            )),
            Self::Timeline { command, .. } => {
                QueryRoute::Keyed(session_identity_lane_key(command.identity()))
            }
            Self::Content { command, .. } => {
                QueryRoute::Keyed(session_identity_lane_key(command.identity()))
            }
            Self::Catalog { .. } | Self::History { .. } => QueryRoute::Global,
        }
    }
}
