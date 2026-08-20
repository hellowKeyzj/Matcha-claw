use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, SessionDeleteParams, SessionDeleteResult,
    },
};
use platform::exchange::InvocationOutcome;
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionDeleteCommand {
    pub(crate) agent_id: String,
    pub(crate) session_key: String,
}

impl SessionDeleteCommand {
    pub(crate) fn new(agent_id: String, session_key: String) -> Self {
        Self {
            agent_id,
            session_key,
        }
    }

    pub(crate) fn into_openclaw_params(self) -> Result<SessionDeleteParams, InvalidSessionDelete> {
        let agent_id = AgentId::try_new(self.agent_id).map_err(|_| InvalidSessionDelete)?;
        let session_key =
            EndpointSessionId::try_new(self.session_key).map_err(|_| InvalidSessionDelete)?;
        let key = AgentScopedSessionKey::try_new(agent_id, session_key)
            .map_err(|_| InvalidSessionDelete)?;
        Ok(SessionDeleteParams::new(key))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidSessionDelete;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SessionDeleteOutcome {
    Succeeded,
    TargetRejected,
    Unknown,
}

pub(crate) fn project_openclaw_delete(
    outcome: InvocationOutcome<SessionDeleteResult, OpenClawSessionError>,
) -> SessionDeleteOutcome {
    match outcome {
        InvocationOutcome::Succeeded(SessionDeleteResult { deleted: true }) => {
            SessionDeleteOutcome::Succeeded
        }
        InvocationOutcome::Succeeded(SessionDeleteResult { deleted: false })
        | InvocationOutcome::TargetRejected(_) => SessionDeleteOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionDeleteOutcome::Unknown,
    }
}

pub(crate) const fn project_openclaw_client_error(
    error: OpenClawSessionError,
) -> SessionDeleteOutcome {
    match error {
        OpenClawSessionError::TargetRejected => SessionDeleteOutcome::TargetRejected,
        OpenClawSessionError::SessionConnection
        | OpenClawSessionError::RequestIdExhausted
        | OpenClawSessionError::RequestDeadline
        | OpenClawSessionError::ConnectionClosed
        | OpenClawSessionError::UnknownResponse
        | OpenClawSessionError::Transport
        | OpenClawSessionError::Protocol
        | OpenClawSessionError::EventBackpressure => SessionDeleteOutcome::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    #[test]
    fn builds_the_agent_scoped_openclaw_delete_params() {
        let params = SessionDeleteCommand::new("main".into(), "session-1".into())
            .into_openclaw_params()
            .unwrap();

        assert_eq!(params.key().as_str(), "agent:main:session-1");
    }

    #[test]
    fn rejects_a_missing_target_as_target_rejected() {
        assert_eq!(
            project_openclaw_delete(InvocationOutcome::Succeeded(SessionDeleteResult {
                deleted: false,
            })),
            SessionDeleteOutcome::TargetRejected
        );
    }

    #[test]
    fn preserves_ambiguous_delivery_as_unknown() {
        assert_eq!(
            project_openclaw_client_error(OpenClawSessionError::RequestDeadline),
            SessionDeleteOutcome::Unknown
        );
        assert_eq!(
            project_openclaw_client_error(OpenClawSessionError::SessionConnection),
            SessionDeleteOutcome::Unknown
        );
        assert_eq!(
            project_openclaw_delete(InvocationOutcome::Unknown),
            SessionDeleteOutcome::Unknown
        );
    }

    #[test]
    fn serializes_only_the_semantic_outcome() {
        assert_eq!(
            to_value(SessionDeleteOutcome::TargetRejected).unwrap(),
            json!({ "outcome": "target_rejected" })
        );
    }
}
