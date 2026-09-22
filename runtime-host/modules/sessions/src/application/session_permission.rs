use serde::Serialize;

pub use super::endpoint::NativeEndpoint;

const MAX_AGENT_ID_BYTES: usize = 256;
const MAX_SESSION_KEY_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPermissionMode {
    ReadOnly,
    Guarded,
    Workspace,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionPermissionAction {
    Get,
    Set {
        permission_mode: Option<SessionPermissionMode>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionPermissionCommand {
    pub endpoint: NativeEndpoint,
    agent_id: String,
    session_key: String,
    action: SessionPermissionAction,
}

impl SessionPermissionCommand {
    pub fn try_new(
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

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub const fn action(&self) -> SessionPermissionAction {
        self.action
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommand;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPermissionProjection {
    pub supported: bool,
    pub mode: Option<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<SessionPermissionMode>,
    pub pending: bool,
    pub can_select_full: bool,
    pub options: Vec<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SessionPermissionProjection {
    pub fn supported(
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

    pub fn unsupported(reason: impl Into<String>) -> Self {
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
}

impl SessionPermissionMode {
    const fn options() -> &'static [Self; 4] {
        &[Self::ReadOnly, Self::Guarded, Self::Workspace, Self::Full]
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionPermissionOutcome {
    Projection(SessionPermissionProjection),
    Unavailable,
}

impl SessionPermissionOutcome {
    pub const fn projection(projection: SessionPermissionProjection) -> Self {
        Self::Projection(projection)
    }

    pub fn unsupported() -> Self {
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
