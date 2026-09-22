use platform::endpoint::runtime_address::RuntimeEndpoint;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionHistoryCommand {
    endpoint: RuntimeEndpoint,
    session_key: String,
    endpoint_session_id: Option<String>,
    limit: Option<u64>,
}

impl SessionHistoryCommand {
    pub fn new(
        endpoint: RuntimeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        limit: Option<u64>,
    ) -> Option<Self> {
        (!session_key.trim().is_empty()
            && endpoint_session_id
                .as_deref()
                .is_none_or(|session_id| !session_id.trim().is_empty()))
        .then_some(Self {
            endpoint,
            session_key,
            endpoint_session_id,
            limit,
        })
    }

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub const fn limit(&self) -> Option<u64> {
        self.limit
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionHistoryView {
    pub messages: Vec<SessionHistoryMessage>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionHistoryMessage {
    pub role: SessionHistoryRole,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistoryRole {
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistoryFailure {
    Rejected,
    Protocol,
    Unavailable,
    Deadline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionHistoryOutcome {
    Loaded(SessionHistoryView),
    Failed(SessionHistoryFailure),
}
