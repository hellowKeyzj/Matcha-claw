use foundation::execution::QueryRoute;
use tokio::sync::oneshot;

use super::{
    approval::{PendingApprovalsCommand, PendingApprovalsOutcome},
    command::session_lane_key,
    openclaw_direct,
    state::SessionView,
    timeline::{
        Command as SessionTimelineCommand, ContentCommand as SessionContentCommand,
        ContentOutcome as SessionContentOutcome, Outcome as SessionTimelineOutcome,
    },
};
pub(crate) enum SessionQuery {
    ListSessions {
        reply: oneshot::Sender<Vec<SessionView>>,
    },
    GetSession {
        session_key: String,
        reply: oneshot::Sender<Option<SessionView>>,
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
    OpenClaw(openclaw_direct::Query),
    ListMatcha {
        reply: oneshot::Sender<crate::sessions::matcha_session_catalog::Outcome>,
    },
    MatchaHistory {
        command: crate::sessions::matcha_history::Command,
        reply: oneshot::Sender<crate::sessions::matcha_history::Outcome>,
    },
}

impl SessionQuery {
    pub(crate) fn send_unavailable(self) {
        match self {
            Self::ListSessions { reply } => {
                let _ = reply.send(Vec::new());
            }
            Self::GetSession { reply, .. } => {
                let _ = reply.send(None);
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
            Self::OpenClaw(query) => query.send_unavailable(),
            Self::ListMatcha { reply } => {
                let _ = reply.send(crate::sessions::matcha_session_catalog::Outcome::Unavailable);
            }
            Self::MatchaHistory { reply, .. } => {
                let _ = reply.send(crate::sessions::matcha_history::Outcome::Unavailable);
            }
        }
    }
}

impl SessionQuery {
    pub(crate) fn route(&self) -> QueryRoute<String> {
        match self {
            Self::ListSessions { .. } | Self::GetSession { .. } => QueryRoute::Direct,
            Self::PendingApprovals { command, .. } => QueryRoute::Keyed(session_lane_key(
                command.endpoint.provider(),
                &command.session_id,
            )),
            Self::Timeline { command, .. } => QueryRoute::Keyed(session_lane_key(
                command.session_provider(),
                command.session_key(),
            )),
            Self::Content { command, .. } => QueryRoute::Keyed(session_lane_key(
                command.session_provider(),
                command.session_key(),
            )),
            Self::OpenClaw(_) | Self::MatchaHistory { .. } => QueryRoute::Global,
            Self::ListMatcha { .. } => QueryRoute::Global,
        }
    }
}
