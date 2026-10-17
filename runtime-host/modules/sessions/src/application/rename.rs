use serde::Serialize;

use crate::state::SessionIdentity;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRenameCommand {
    pub identity: SessionIdentity,
    pub label: String,
}

impl SessionRenameCommand {
    pub fn new(identity: SessionIdentity, label: String) -> Self {
        Self { identity, label }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionRenameOutcome {
    Succeeded,
    TargetRejected,
    Unknown,
}
