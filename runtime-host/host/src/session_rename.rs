use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, SessionKey, SessionLabelPatchParams,
        SessionLabelPatchResult,
    },
};
use platform::exchange::InvocationOutcome;
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionRenameCommand {
    pub(crate) agent_id: String,
    pub(crate) session_key: String,
    pub(crate) label: String,
}

impl SessionRenameCommand {
    pub(crate) fn new(agent_id: String, session_key: String, label: String) -> Self {
        Self {
            agent_id,
            session_key,
            label,
        }
    }

    pub(crate) fn into_openclaw_params(
        self,
    ) -> Result<SessionLabelPatchParams, InvalidSessionRename> {
        let agent_id = AgentId::try_new(self.agent_id).map_err(|_| InvalidSessionRename)?;
        let prefix = format!("agent:{}:", agent_id.as_str());
        let endpoint_session_id = self
            .session_key
            .strip_prefix(&prefix)
            .and_then(|value| EndpointSessionId::try_new(value.to_owned()).ok())
            .ok_or(InvalidSessionRename)?;
        let session_key = AgentScopedSessionKey::try_new(agent_id, endpoint_session_id)
            .map_err(|_| InvalidSessionRename)?;
        let session_key = SessionKey::try_new(session_key.as_str().to_owned())
            .map_err(|_| InvalidSessionRename)?;
        SessionLabelPatchParams::try_new(session_key, self.label).map_err(|_| InvalidSessionRename)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidSessionRename;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SessionRenameOutcome {
    Succeeded,
    TargetRejected,
    Unknown,
}

pub(crate) fn project_openclaw_rename(
    outcome: InvocationOutcome<SessionLabelPatchResult, OpenClawSessionError>,
) -> SessionRenameOutcome {
    match outcome {
        InvocationOutcome::Succeeded(_) => SessionRenameOutcome::Succeeded,
        InvocationOutcome::TargetRejected(_) => SessionRenameOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionRenameOutcome::Unknown,
    }
}

pub(crate) const fn project_openclaw_client_error(
    error: OpenClawSessionError,
) -> SessionRenameOutcome {
    match error {
        OpenClawSessionError::TargetRejected => SessionRenameOutcome::TargetRejected,
        OpenClawSessionError::SessionConnection
        | OpenClawSessionError::RequestIdExhausted
        | OpenClawSessionError::RequestDeadline
        | OpenClawSessionError::ConnectionClosed
        | OpenClawSessionError::UnknownResponse
        | OpenClawSessionError::Transport
        | OpenClawSessionError::Protocol
        | OpenClawSessionError::EventBackpressure => SessionRenameOutcome::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    #[test]
    fn builds_the_agent_scoped_openclaw_label_patch() {
        let params = SessionRenameCommand::new(
            "main".into(),
            "agent:main:session-1".into(),
            "Renamed".into(),
        )
        .into_openclaw_params()
        .unwrap();

        assert_eq!(params.key().as_str(), "agent:main:session-1");
        assert_eq!(
            to_value(params).unwrap(),
            json!({ "key": "agent:main:session-1", "label": "Renamed" })
        );
    }

    #[test]
    fn rejects_a_foreign_or_empty_session_label() {
        for command in [
            SessionRenameCommand::new("main".into(), "agent:other:session-1".into(), "x".into()),
            SessionRenameCommand::new("main".into(), "agent:main:session-1".into(), "".into()),
        ] {
            assert_eq!(command.into_openclaw_params(), Err(InvalidSessionRename));
        }
    }

    #[test]
    fn preserves_ambiguous_delivery_as_unknown() {
        assert_eq!(
            project_openclaw_client_error(OpenClawSessionError::RequestDeadline),
            SessionRenameOutcome::Unknown
        );
        assert_eq!(
            project_openclaw_rename(InvocationOutcome::Unknown),
            SessionRenameOutcome::Unknown
        );
    }
}
