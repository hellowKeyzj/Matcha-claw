use super::state::SessionIdentity;
use serde::Serialize;

pub use super::endpoint::NativeEndpoint;

const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_RUN_ID_BYTES: usize = 4096;
const MAX_APPROVAL_ID_BYTES: usize = 4096;
const MAX_APPROVAL_IDS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionAbortCommand {
    pub identity: SessionIdentity,
    /// Peer-native session binding. OpenClaw cancellation uses `session_key`; Matcha
    /// cancellation uses this native handle when it is present.
    pub endpoint_session_id: Option<String>,
    pub run_id: Option<String>,
    pub approval_ids: Option<Vec<String>>,
    /// Host-private transport correlation; never serialized or projected to a peer.
    trace_id: Option<String>,
}

impl SessionAbortCommand {
    pub fn try_new(
        identity: SessionIdentity,
        endpoint_session_id: Option<String>,
        run_id: Option<String>,
        approval_ids: Option<Vec<String>>,
    ) -> Result<Self, InvalidCommand> {
        if identity.validate().is_err()
            || endpoint_session_id
                .as_deref()
                .is_some_and(|endpoint_session_id| {
                    !valid_identity(endpoint_session_id, MAX_ENDPOINT_SESSION_ID_BYTES)
                })
            || run_id
                .as_deref()
                .is_some_and(|run_id| !valid_identity(run_id, MAX_RUN_ID_BYTES))
            || approval_ids.as_ref().is_some_and(|ids| {
                ids.is_empty()
                    || ids.len() > MAX_APPROVAL_IDS
                    || ids
                        .iter()
                        .any(|approval_id| !valid_identity(approval_id, MAX_APPROVAL_ID_BYTES))
            })
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            identity,
            endpoint_session_id,
            run_id,
            approval_ids,
            trace_id: None,
        })
    }

    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn with_endpoint_session_id(mut self, session_id: String) -> Result<Self, InvalidCommand> {
        if !valid_identity(&session_id, MAX_ENDPOINT_SESSION_ID_BYTES) {
            return Err(InvalidCommand);
        }
        self.endpoint_session_id = Some(session_id);
        Ok(self)
    }
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionAbortOutcome {
    Succeeded,
    #[serde(rename = "target_rejected")]
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{NativeEndpoint, SessionAbortCommand, SessionAbortOutcome};

    #[test]
    fn serializes_public_rejection_as_target_rejected() {
        assert_eq!(
            serde_json::to_value(SessionAbortOutcome::Rejected).unwrap(),
            json!({ "outcome": "target_rejected" })
        );
    }

    #[test]
    fn rejects_empty_run_identifier_when_one_is_provided() {
        assert!(
            SessionAbortCommand::try_new(
                NativeEndpoint::OpenClawLocal,
                "agent:main:demo".into(),
                None,
                Some(" ".into()),
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn preserves_missing_approval_ids_as_session_wide_abort() {
        let command = SessionAbortCommand::try_new(
            NativeEndpoint::MatchaAgentLocal,
            "session-1".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(command.approval_ids, None);
    }

    #[test]
    fn rejects_empty_approval_ids_without_treating_them_as_run_identity() {
        assert!(
            SessionAbortCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                None,
                Some(Vec::new()),
            )
            .is_err()
        );
    }
}
