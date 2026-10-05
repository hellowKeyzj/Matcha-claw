use serde::{Deserialize, Serialize};
use serde_json::Number;

use super::model::{
    MAX_ID_BYTES, MAX_SAFE_INTEGER, MAX_SESSION_KEY_BYTES, MAX_TEXT_BYTES, SessionIdentity,
    SessionStateError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionGoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

/// Read-only peer facts. Sessions never accounts usage or transitions a Goal.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoal {
    pub schema_version: u8,
    pub id: String,
    pub objective: String,
    pub status: SessionGoalStatus,
    pub created_at: Number,
    pub updated_at: Number,
    pub token_start: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_start_fresh: Option<bool>,
    pub tokens_used: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<Number>,
    pub continuation_turns: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_at: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_limited_at: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_limited_at: Option<Number>,
}

impl SessionGoal {
    pub fn validate(&self) -> Result<(), SessionStateError> {
        (self.schema_version == 1
            && valid_id(&self.id, MAX_ID_BYTES)
            && valid_text(&self.objective, MAX_TEXT_BYTES)
            && self
                .last_status_note
                .as_deref()
                .is_none_or(|note| valid_text(note, MAX_TEXT_BYTES)))
        .then_some(())
        .ok_or(SessionStateError::InvalidFacts)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionGoalView {
    Known { #[serde(deserialize_with = "required_goal")] goal: Option<SessionGoal> },
    Unknown,
    Unsupported,
}

fn required_goal<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<SessionGoal>, D::Error> {
    Option::<SessionGoal>::deserialize(deserializer)
}

impl SessionGoalView {
    pub fn validate(&self) -> Result<(), SessionStateError> {
        match self {
            Self::Known { goal: Some(goal) } => goal.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionSendIntent {
    GoalStart { issued_at_ms: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum SessionGoalMutation {
    Edit {
        objective: String,
    },
    Pause {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Resume {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Complete {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Block {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Clear,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionGoalCommand {
    pub identity: SessionIdentity,
    pub endpoint_session_id: String,
    pub goal_id: String,
    pub operation_id: String,
    pub issued_at_ms: u64,
    pub mutation: SessionGoalMutation,
}

impl SessionGoalCommand {
    pub fn validate(&self) -> Result<(), SessionStateError> {
        let valid_mutation = match &self.mutation {
            SessionGoalMutation::Edit { objective } => {
                !objective.trim().is_empty()
                    && objective.encode_utf16().count() <= 16_000
                    && valid_text(objective, MAX_TEXT_BYTES)
            }
            SessionGoalMutation::Pause { note }
            | SessionGoalMutation::Resume { note }
            | SessionGoalMutation::Complete { note }
            | SessionGoalMutation::Block { note } => note.as_deref().is_none_or(|note| {
                note.encode_utf16().count() <= 2_000 && valid_text(note, MAX_TEXT_BYTES)
            }),
            SessionGoalMutation::Clear => true,
        };
        (self.identity.validate().is_ok()
            && valid_id(&self.endpoint_session_id, MAX_SESSION_KEY_BYTES)
            && valid_id(&self.goal_id, MAX_ID_BYTES)
            && valid_id(&self.operation_id, 128)
            && self.issued_at_ms <= MAX_SAFE_INTEGER
            && valid_mutation)
            .then_some(())
            .ok_or(SessionStateError::InvalidFacts)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionGoalAction {
    Start,
    Edit,
    Pause,
    Resume,
    Complete,
    Block,
    Clear,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionGoalOperationStatus {
    Started,
    Updated,
    Cleared,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoalReceipt {
    pub operation_id: String,
    pub action: SessionGoalAction,
    pub session_id: String,
    pub goal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<SessionGoal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
    pub status: SessionGoalOperationStatus,
}

impl SessionGoalReceipt {
    pub fn validate(&self) -> Result<(), SessionStateError> {
        (valid_id(&self.operation_id, 128)
            && valid_id(&self.session_id, MAX_SESSION_KEY_BYTES)
            && valid_id(&self.goal_id, MAX_ID_BYTES)
            && self
                .goal
                .as_ref()
                .is_none_or(|goal| goal.id == self.goal_id && goal.validate().is_ok())
            && self
                .run_id
                .as_deref()
                .is_none_or(|id| valid_id(id, MAX_ID_BYTES))
            && self.replayed.is_none_or(|replayed| replayed)
            && match self.status {
                SessionGoalOperationStatus::Started => {
                    matches!(
                        self.action,
                        SessionGoalAction::Start | SessionGoalAction::Resume
                    ) && self.run_id.is_some()
                        && self.goal.is_some()
                }
                SessionGoalOperationStatus::Updated => {
                    matches!(
                        self.action,
                        SessionGoalAction::Edit
                            | SessionGoalAction::Pause
                            | SessionGoalAction::Complete
                            | SessionGoalAction::Block
                    ) && self.run_id.is_none()
                        && self.goal.is_some()
                }
                SessionGoalOperationStatus::Cleared => {
                    self.action == SessionGoalAction::Clear
                        && self.run_id.is_none()
                        && self.goal.is_none()
                }
            })
        .then_some(())
        .ok_or(SessionStateError::InvalidFacts)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionGoalOutcome {
    Succeeded { receipt: SessionGoalReceipt },
    TargetRejected,
    Unknown,
    Unsupported,
    Unavailable,
}

fn valid_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.contains('\0')
}
