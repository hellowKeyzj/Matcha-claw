use std::fmt;

use crate::session::{
    model::{RunId, SessionId, ValidationError},
    request::{SessionCreateParams, SessionPromptParams},
};

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionCwd(String);

impl RoleSessionCwd {
    pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.trim().is_empty()
            || value.len() > 32_768
            || value.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(ValidationError::new("role session cwd is invalid"));
        }
        Ok(Self(value))
    }

    pub(crate) fn create_params(&self, session_id: &RoleSessionId) -> SessionCreateParams {
        SessionCreateParams::try_new(self.0.clone())
            .expect("validated role session cwd is a valid native cwd")
            .with_session_id(session_id.native())
    }
}

impl fmt::Debug for RoleSessionCwd {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleSessionCwd(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionId(SessionId);

impl RoleSessionId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
        SessionId::try_new(value).map(Self)
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(crate) fn from_native(session_id: SessionId) -> Self {
        Self(session_id)
    }

    pub(crate) fn native(&self) -> SessionId {
        self.0.clone()
    }
}

impl fmt::Debug for RoleSessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleSessionId(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RolePrompt(String);

impl RolePrompt {
    pub fn try_new(value: impl Into<String>) -> Result<Self, RolePromptInputError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(RolePromptInputError::InvalidPrompt);
        }
        Ok(Self(value))
    }

    pub(crate) fn into_params(self, session_id: &RoleSessionId) -> SessionPromptParams {
        SessionPromptParams::try_new(session_id.native(), self.0)
            .expect("validated role prompt is a valid native prompt")
    }
}

impl fmt::Debug for RolePrompt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RolePrompt(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleRunId(RunId);

impl RoleRunId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
        RunId::try_new(value).map(Self)
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(crate) fn from_native(run_id: RunId) -> Self {
        Self(run_id)
    }

    pub(crate) fn native(&self) -> RunId {
        self.0.clone()
    }
}

impl fmt::Debug for RoleRunId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleRunId(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RolePromptInputError {
    InvalidPrompt,
}

impl fmt::Display for RolePromptInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("role prompt must be a non-empty string")
    }
}

impl std::error::Error for RolePromptInputError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn prompt_requires_a_non_empty_value() {
        assert_eq!(
            RolePrompt::try_new("  ").unwrap_err(),
            RolePromptInputError::InvalidPrompt,
        );
    }

    #[test]
    fn cwd_create_and_prompt_target_distinct_native_operations() {
        let cwd = RoleSessionCwd::try_new("E:/workspace-canary").unwrap();
        let prompt = RolePrompt::try_new("prompt-canary").unwrap();
        let session_id = RoleSessionId::try_new("created-session-canary").unwrap();

        assert_eq!(
            serde_json::to_value(cwd.create_params(&session_id)).unwrap(),
            json!({"cwd": "E:/workspace-canary", "sessionId": "created-session-canary"}),
        );
        assert_eq!(
            serde_json::to_value(prompt.into_params(&session_id)).unwrap(),
            json!({
                "sessionId": "created-session-canary",
                "prompt": "prompt-canary",
            }),
        );
    }

    #[test]
    fn typed_correlations_and_inputs_redact_native_values() {
        let cwd = RoleSessionCwd::try_new("E:/workspace-debug-canary").unwrap();
        let prompt = RolePrompt::try_new("prompt-canary").unwrap();
        let session_id = RoleSessionId::try_new("created-session-canary").unwrap();
        let run_id = RoleRunId::try_new("generated-run-canary").unwrap();
        let debug = format!("{cwd:?}\n{prompt:?}\n{session_id:?}\n{run_id:?}");

        assert_eq!(session_id.as_str(), "created-session-canary");
        assert_eq!(run_id.as_str(), "generated-run-canary");
        for canary in [
            "workspace-debug-canary",
            "prompt-canary",
            "created-session-canary",
            "generated-run-canary",
        ] {
            assert!(!debug.contains(canary), "Debug leaked {canary}");
        }
    }
}
