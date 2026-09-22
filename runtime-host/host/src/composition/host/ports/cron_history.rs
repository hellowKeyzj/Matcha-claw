use sessions_module::{
    RuntimeDriverIdentity, SessionHandle,
    session_history::{
        SessionHistoryCommand, SessionHistoryFailure, SessionHistoryMessage, SessionHistoryOutcome,
        SessionHistoryRole, SessionHistoryView,
    },
};

#[derive(Clone)]
pub(in crate::composition::host) struct CronSessionHistory {
    session: SessionHandle,
}

impl CronSessionHistory {
    pub(in crate::composition::host) fn new(session: SessionHandle) -> Self {
        Self { session }
    }
}

impl ::cron::CronSessionHistoryPort for CronSessionHistory {
    fn load_cron_session_history<'a>(
        &'a self,
        session_key: String,
        limit: u64,
    ) -> ::cron::ports::CronFuture<
        'a,
        Result<::cron::CronHistoryView, ::cron::CronSessionHistoryFailure>,
    > {
        Box::pin(async move {
            let Some(command) = SessionHistoryCommand::new(
                RuntimeDriverIdentity::open_claw().endpoint(),
                session_key,
                None,
                Some(limit),
            ) else {
                return Err(::cron::CronSessionHistoryFailure::Protocol);
            };
            match self.session.load_session_history(command).await {
                Ok(SessionHistoryOutcome::Loaded(history)) => Ok(project_history_view(history)),
                Ok(SessionHistoryOutcome::Failed(failure)) => Err(project_history_failure(failure)),
                Err(()) => Err(::cron::CronSessionHistoryFailure::Unavailable),
            }
        })
    }
}

fn project_history_failure(failure: SessionHistoryFailure) -> ::cron::CronSessionHistoryFailure {
    match failure {
        SessionHistoryFailure::Rejected => ::cron::CronSessionHistoryFailure::Rejected,
        SessionHistoryFailure::Protocol => ::cron::CronSessionHistoryFailure::Protocol,
        SessionHistoryFailure::Unavailable => ::cron::CronSessionHistoryFailure::Unavailable,
        SessionHistoryFailure::Deadline => ::cron::CronSessionHistoryFailure::Deadline,
    }
}

fn project_history_view(history: SessionHistoryView) -> ::cron::CronHistoryView {
    ::cron::CronHistoryView {
        messages: history
            .messages
            .into_iter()
            .map(project_history_message_view)
            .collect(),
    }
}

fn project_history_message_view(message: SessionHistoryMessage) -> ::cron::CronHistoryMessageView {
    ::cron::CronHistoryMessageView {
        role: match message.role {
            SessionHistoryRole::User => ::cron::CronHistoryRole::User,
            SessionHistoryRole::Assistant => ::cron::CronHistoryRole::Assistant,
        },
        text: message.text,
    }
}
