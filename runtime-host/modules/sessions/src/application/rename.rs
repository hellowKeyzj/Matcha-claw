use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRenameCommand {
    pub agent_id: String,
    pub session_key: String,
    pub label: String,
}

impl SessionRenameCommand {
    pub fn new(agent_id: String, session_key: String, label: String) -> Self {
        Self {
            agent_id,
            session_key,
            label,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionRenameOutcome {
    Succeeded,
    TargetRejected,
    Unknown,
}
