use foundation::execution::QueryRoute;
use tokio::sync::oneshot;

use super::{
    approval::{PendingApprovalsCommand, PendingApprovalsOutcome},
    command::{OpenClawSessionResult, session_lane_key},
    state::SessionView,
    timeline::{Command as SessionTimelineCommand, Outcome as SessionTimelineOutcome},
};
use crate::RuntimeSessionError;

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
    ListOpenClaw {
        reply:
            oneshot::Sender<OpenClawSessionResult<openclaw::session::protocol::SessionsListResult>>,
    },
    OpenClawHistory {
        params: openclaw::session::protocol::ChatHistoryParams,
        reply:
            oneshot::Sender<OpenClawSessionResult<openclaw::session::protocol::ChatHistoryResult>>,
    },
    ListMatcha {
        reply: oneshot::Sender<crate::matcha_session_catalog::Outcome>,
    },
    MatchaHistory {
        command: crate::matcha_history::Command,
        reply: oneshot::Sender<crate::matcha_history::Outcome>,
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
            Self::ListOpenClaw { reply } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
            Self::OpenClawHistory { reply, .. } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
            Self::ListMatcha { reply } => {
                let _ = reply.send(crate::matcha_session_catalog::Outcome::Unavailable);
            }
            Self::MatchaHistory { reply, .. } => {
                let _ = reply.send(crate::matcha_history::Outcome::Unavailable);
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
            Self::OpenClawHistory { .. } | Self::MatchaHistory { .. } => QueryRoute::Global,
            Self::ListOpenClaw { .. } | Self::ListMatcha { .. } => QueryRoute::Global,
        }
    }
}
