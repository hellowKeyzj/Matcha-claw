use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::Serialize;

use super::state::SessionProvider;
use crate::runtime_driver::RuntimeDriverIdentity;

const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_RUN_ID_BYTES: usize = 4096;
const MAX_APPROVAL_ID_BYTES: usize = 4096;
const MAX_APPROVAL_IDS: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
    Unsupported,
}

impl NativeEndpoint {
    pub(crate) fn parse(
        kind: &str,
        runtime_adapter_id: &str,
        runtime_instance_id: &str,
    ) -> Option<Self> {
        if kind != "native-runtime" {
            return None;
        }
        RuntimeEndpoint::try_new(runtime_adapter_id, runtime_instance_id)
            .ok()
            .map(Self::from_runtime_endpoint)
    }

    pub(crate) fn from_runtime_endpoint(endpoint: RuntimeEndpoint) -> Self {
        if endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            Self::OpenClawLocal
        } else if endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            Self::MatchaAgentLocal
        } else {
            Self::Unsupported
        }
    }

    pub(crate) const fn provider(self) -> SessionProvider {
        match self {
            Self::OpenClawLocal => SessionProvider::OpenClaw,
            Self::MatchaAgentLocal => SessionProvider::MatchaAgent,
            Self::Unsupported => SessionProvider::OpenClaw,
        }
    }

    pub(crate) fn runtime_endpoint(self) -> Option<RuntimeEndpoint> {
        match self {
            Self::OpenClawLocal => Some(RuntimeDriverIdentity::open_claw().endpoint()),
            Self::MatchaAgentLocal => Some(RuntimeDriverIdentity::matcha_agent().endpoint()),
            Self::Unsupported => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionAbortCommand {
    pub(crate) endpoint: NativeEndpoint,
    pub(crate) session_key: String,
    /// Peer-native session binding. OpenClaw cancellation uses `session_key`; Matcha
    /// cancellation uses this native handle when it is present.
    pub(crate) endpoint_session_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) approval_ids: Option<Vec<String>>,
}

impl SessionAbortCommand {
    pub(crate) fn try_new(
        endpoint: NativeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        run_id: Option<String>,
        approval_ids: Option<Vec<String>>,
    ) -> Result<Self, InvalidCommand> {
        if !valid_identity(&session_key, MAX_SESSION_KEY_BYTES)
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
            endpoint,
            session_key,
            endpoint_session_id,
            run_id,
            approval_ids,
        })
    }
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SessionAbortOutcome {
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
