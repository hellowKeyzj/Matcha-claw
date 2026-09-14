use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::Serialize;

use super::state::SessionProvider;
use crate::runtime_driver::RuntimeDriverIdentity;

const MAX_AGENT_ID_BYTES: usize = 256;
const MAX_SESSION_KEY_BYTES: usize = 4096;

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

    fn from_runtime_endpoint(endpoint: RuntimeEndpoint) -> Self {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SessionPermissionMode {
    ReadOnly,
    Guarded,
    Workspace,
    Full,
}

impl From<SessionPermissionMode> for openclaw::session::protocol::SessionPermissionMode {
    fn from(value: SessionPermissionMode) -> Self {
        match value {
            SessionPermissionMode::ReadOnly => Self::ReadOnly,
            SessionPermissionMode::Guarded => Self::Guarded,
            SessionPermissionMode::Workspace => Self::Workspace,
            SessionPermissionMode::Full => Self::Full,
        }
    }
}

impl From<openclaw::session::protocol::SessionPermissionMode> for SessionPermissionMode {
    fn from(value: openclaw::session::protocol::SessionPermissionMode) -> Self {
        match value {
            openclaw::session::protocol::SessionPermissionMode::ReadOnly => Self::ReadOnly,
            openclaw::session::protocol::SessionPermissionMode::Guarded => Self::Guarded,
            openclaw::session::protocol::SessionPermissionMode::Workspace => Self::Workspace,
            openclaw::session::protocol::SessionPermissionMode::Full => Self::Full,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionPermissionAction {
    Get,
    Set {
        permission_mode: Option<SessionPermissionMode>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionPermissionCommand {
    pub(crate) endpoint: NativeEndpoint,
    agent_id: String,
    session_key: String,
    action: SessionPermissionAction,
}

impl SessionPermissionCommand {
    pub(crate) fn try_new(
        endpoint: NativeEndpoint,
        agent_id: String,
        session_key: String,
        action: SessionPermissionAction,
    ) -> Result<Self, InvalidCommand> {
        if !valid_bounded_identity(&agent_id, MAX_AGENT_ID_BYTES)
            || !valid_bounded_identity(&session_key, MAX_SESSION_KEY_BYTES)
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            endpoint,
            agent_id,
            session_key,
            action,
        })
    }

    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.session_key
    }

    pub(crate) const fn action(&self) -> SessionPermissionAction {
        self.action
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidCommand;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPermissionProjection {
    pub(crate) supported: bool,
    pub(crate) mode: Option<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_mode: Option<SessionPermissionMode>,
    pub(crate) pending: bool,
    pub(crate) can_select_full: bool,
    pub(crate) options: Vec<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

impl SessionPermissionProjection {
    pub(crate) fn supported(
        mode: Option<SessionPermissionMode>,
        default_mode: Option<SessionPermissionMode>,
        pending: bool,
        can_select_full: bool,
    ) -> Self {
        Self {
            supported: true,
            mode,
            default_mode,
            pending,
            can_select_full,
            options: SessionPermissionMode::options().to_vec(),
            reason: None,
        }
    }

    pub(crate) fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            supported: false,
            mode: None,
            default_mode: None,
            pending: false,
            can_select_full: false,
            options: Vec::new(),
            reason: Some(reason.into()),
        }
    }

    pub(crate) fn from_openclaw(
        projection: openclaw::session::protocol::SessionPermissionProjection,
    ) -> Self {
        if projection.supported {
            Self::supported(
                projection.mode.map(Into::into),
                projection.default_mode.map(Into::into),
                projection.pending,
                projection.can_select_full,
            )
        } else {
            Self::unsupported(
                projection
                    .reason
                    .unwrap_or_else(|| "Session permission is unsupported".into()),
            )
        }
    }
}

impl SessionPermissionMode {
    const fn options() -> &'static [Self; 4] {
        &[Self::ReadOnly, Self::Guarded, Self::Workspace, Self::Full]
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionPermissionOutcome {
    Projection(SessionPermissionProjection),
    Unavailable,
}

impl SessionPermissionOutcome {
    pub(crate) const fn projection(projection: SessionPermissionProjection) -> Self {
        Self::Projection(projection)
    }

    pub(crate) fn unsupported() -> Self {
        Self::Projection(SessionPermissionProjection::unsupported(
            "Session permission is unsupported",
        ))
    }
}

fn valid_bounded_identity(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_matcha_and_unknown_endpoints_without_openclaw_modes() {
        assert_eq!(
            NativeEndpoint::parse("native-runtime", "matcha-agent", "local"),
            Some(NativeEndpoint::MatchaAgentLocal)
        );
        assert_eq!(
            NativeEndpoint::parse("native-runtime", "other-runtime", "local"),
            Some(NativeEndpoint::Unsupported)
        );
        assert_eq!(
            SessionPermissionOutcome::unsupported(),
            SessionPermissionOutcome::Projection(SessionPermissionProjection::unsupported(
                "Session permission is unsupported",
            ))
        );
    }

    #[test]
    fn serializes_contract_projection_only() {
        let projection = SessionPermissionProjection::supported(
            Some(SessionPermissionMode::Full),
            Some(SessionPermissionMode::Workspace),
            true,
            false,
        );
        assert_eq!(
            serde_json::to_value(projection).unwrap(),
            serde_json::json!({
                "supported": true,
                "mode": "full",
                "defaultMode": "workspace",
                "pending": true,
                "canSelectFull": false,
                "options": ["read-only", "guarded", "workspace", "full"]
            })
        );
        assert_eq!(
            serde_json::to_value(SessionPermissionProjection::unsupported(
                "Session permission is unsupported",
            ))
            .unwrap(),
            serde_json::json!({
                "supported": false,
                "mode": null,
                "pending": false,
                "canSelectFull": false,
                "options": [],
                "reason": "Session permission is unsupported"
            })
        );
    }
}
