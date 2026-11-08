use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::model::{
    MAX_SAFE_INTEGER, MAX_TEXT_BYTES, SessionStateError, payload_contains_nul, valid_id,
    valid_payload, valid_payload_text,
};

pub const MAX_APPROVAL_TEXT_BYTES: usize = MAX_TEXT_BYTES;
pub const MAX_APPROVAL_TARGET_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalText {
    pub text: String,
    pub total_bytes: u64,
}

impl ApprovalText {
    pub fn try_from_text(text: &str) -> Result<Self, SessionStateError> {
        if text.contains('\0') || text.len() as u64 > MAX_SAFE_INTEGER {
            return Err(SessionStateError::InvalidFacts);
        }
        Ok(Self::with_limit(text, MAX_APPROVAL_TEXT_BYTES))
    }

    fn with_limit(text: &str, limit: usize) -> Self {
        let mut end = text.len().min(limit);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Self {
            text: text[..end].to_owned(),
            total_bytes: text.len() as u64,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalTargetName {
    Command,
    FilePath,
    Path,
    Url,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalTarget {
    pub name: ApprovalTargetName,
    pub text: String,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalInputOmissionReason {
    SizeLimit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApprovalInput {
    Complete {
        value: Value,
    },
    Omitted {
        reason: ApprovalInputOmissionReason,
        total_bytes: u64,
        targets: Vec<ApprovalTarget>,
    },
}

impl ApprovalInput {
    pub fn try_from_value(value: Value) -> Result<Self, SessionStateError> {
        if !value.is_object() || payload_contains_nul(&value) {
            return Err(SessionStateError::InvalidFacts);
        }
        let total_bytes = serde_json::to_vec(&value)
            .map_err(|_| SessionStateError::InvalidFacts)?
            .len();
        if total_bytes <= MAX_TEXT_BYTES {
            return Ok(Self::Complete { value });
        }
        let targets = [
            ("command", ApprovalTargetName::Command),
            ("file_path", ApprovalTargetName::FilePath),
            ("path", ApprovalTargetName::Path),
            ("url", ApprovalTargetName::Url),
        ]
        .into_iter()
        .filter_map(|(key, name)| {
            let preview =
                ApprovalText::with_limit(value.get(key)?.as_str()?, MAX_APPROVAL_TARGET_BYTES);
            Some(ApprovalTarget {
                name,
                text: preview.text,
                total_bytes: preview.total_bytes,
            })
        })
        .collect();
        Ok(Self::Omitted {
            reason: ApprovalInputOmissionReason::SizeLimit,
            total_bytes: total_bytes as u64,
            targets,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalAudience {
    Internal,
    External,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalVisibility {
    Public,
    Restricted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApprovalScope {
    MessageSend {
        target: ApprovalText,
        recipient_count: u64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        recipients: Option<Vec<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        audience: Option<ApprovalAudience>,
    },
    Payment {
        amount: ApprovalText,
        currency: ApprovalText,
        target: ApprovalText,
    },
    ExternalPost {
        target: ApprovalText,
        visibility: ApprovalVisibility,
    },
    StandingGrant {
        automation: ApprovalText,
        command: ApprovalText,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        expires_in_days: Option<u64>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalExternalResolution {
    pub label: ApprovalText,
    pub decisions: Vec<ApprovalDecision>,
}

fn approval_optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn approval_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApprovalDetails {
    Tool {
        tool_call_id: String,
        tool_name: String,
        input: ApprovalInput,
        #[serde(deserialize_with = "Option::deserialize")]
        decision_reason: Option<ApprovalText>,
        #[serde(deserialize_with = "Option::deserialize")]
        blocked_path: Option<ApprovalText>,
    },
    Exec {
        command_text: ApprovalText,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        command_preview: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        warning_text: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        host: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        node_id: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        agent_id: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        scope: Option<ApprovalScope>,
        allowed_decisions: Vec<ApprovalDecision>,
    },
    Plugin {
        title: ApprovalText,
        description: ApprovalText,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        detail: Option<ApprovalText>,
        severity: ApprovalSeverity,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        plugin_id: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        tool_name: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        agent_id: Option<Option<ApprovalText>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        scope: Option<ApprovalScope>,
        allowed_decisions: Vec<ApprovalDecision>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_optional"
        )]
        external_resolution: Option<ApprovalExternalResolution>,
    },
    SystemAgent {
        title: ApprovalText,
        description: ApprovalText,
        proposal_hash: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "approval_nullable"
        )]
        agent_id: Option<Option<ApprovalText>>,
        allowed_decisions: Vec<ApprovalDecision>,
    },
}

impl ApprovalDetails {
    pub fn validate(&self) -> Result<(), SessionStateError> {
        valid_approval_details(self)
            .then_some(())
            .ok_or(SessionStateError::InvalidFacts)
    }
}

fn valid_approval_text(text: &ApprovalText) -> bool {
    valid_approval_preview(&text.text, text.total_bytes, MAX_APPROVAL_TEXT_BYTES)
}

fn valid_approval_preview(text: &str, total_bytes: u64, limit: usize) -> bool {
    valid_payload_text(text, limit)
        && total_bytes <= MAX_SAFE_INTEGER
        && total_bytes >= text.len() as u64
}

fn valid_approval_input(input: &ApprovalInput) -> bool {
    match input {
        ApprovalInput::Complete { value } => {
            value.is_object() && valid_payload(value, MAX_TEXT_BYTES)
        }
        ApprovalInput::Omitted {
            total_bytes,
            targets,
            ..
        } => {
            *total_bytes > MAX_TEXT_BYTES as u64
                && *total_bytes <= MAX_SAFE_INTEGER
                && targets.len() <= 4
                && targets.iter().enumerate().all(|(index, target)| {
                    !targets[..index]
                        .iter()
                        .any(|prior| prior.name == target.name)
                        && target.total_bytes <= *total_bytes
                        && valid_approval_preview(
                            &target.text,
                            target.total_bytes,
                            MAX_APPROVAL_TARGET_BYTES,
                        )
                })
        }
    }
}

fn valid_approval_decisions(decisions: &[ApprovalDecision]) -> bool {
    !decisions.is_empty()
        && decisions.len() <= 3
        && decisions.contains(&ApprovalDecision::Deny)
        && decisions
            .iter()
            .enumerate()
            .all(|(index, decision)| !decisions[..index].contains(decision))
}

fn valid_nonempty_approval_text(text: &ApprovalText) -> bool {
    valid_approval_text(text) && text.total_bytes > 0
}

fn valid_approval_scope(scope: &ApprovalScope) -> bool {
    match scope {
        ApprovalScope::MessageSend {
            target,
            recipient_count,
            recipients,
            ..
        } => {
            valid_nonempty_approval_text(target)
                && (1..=1_000_000).contains(recipient_count)
                && recipients.as_ref().is_none_or(|recipients| {
                    recipients.len() <= 5 && recipients.iter().all(valid_nonempty_approval_text)
                })
        }
        ApprovalScope::Payment {
            amount,
            currency,
            target,
        } => [amount, currency, target]
            .into_iter()
            .all(valid_nonempty_approval_text),
        ApprovalScope::ExternalPost { target, .. } => valid_nonempty_approval_text(target),
        ApprovalScope::StandingGrant {
            automation,
            command,
            expires_in_days,
        } => {
            valid_nonempty_approval_text(automation)
                && valid_nonempty_approval_text(command)
                && expires_in_days.is_none_or(|days| (1..=3650).contains(&days))
        }
    }
}

fn valid_approval_nullable_text(text: &Option<Option<ApprovalText>>, nonempty: bool) -> bool {
    text.as_ref()
        .and_then(Option::as_ref)
        .is_none_or(|text| valid_approval_text(text) && (!nonempty || text.total_bytes > 0))
}

pub(super) fn valid_approval_details(details: &ApprovalDetails) -> bool {
    match details {
        ApprovalDetails::Tool {
            tool_call_id,
            tool_name,
            input,
            decision_reason,
            blocked_path,
        } => {
            valid_id(tool_call_id)
                && valid_id(tool_name)
                && valid_approval_input(input)
                && decision_reason.as_ref().is_none_or(valid_approval_text)
                && blocked_path.as_ref().is_none_or(valid_approval_text)
        }
        ApprovalDetails::Exec {
            command_text,
            command_preview,
            warning_text,
            host,
            node_id,
            agent_id,
            scope,
            allowed_decisions,
        } => {
            valid_approval_text(command_text)
                && command_text.total_bytes > 0
                && [command_preview, warning_text, host]
                    .into_iter()
                    .all(|text| valid_approval_nullable_text(text, false))
                && [node_id, agent_id]
                    .into_iter()
                    .all(|text| valid_approval_nullable_text(text, true))
                && scope.as_ref().is_none_or(valid_approval_scope)
                && valid_approval_decisions(allowed_decisions)
        }
        ApprovalDetails::Plugin {
            title,
            description,
            detail,
            plugin_id,
            tool_name,
            agent_id,
            scope,
            allowed_decisions,
            external_resolution,
            ..
        } => {
            valid_nonempty_approval_text(title)
                && valid_nonempty_approval_text(description)
                && detail.as_ref().is_none_or(valid_nonempty_approval_text)
                && [plugin_id, tool_name, agent_id]
                    .into_iter()
                    .all(|text| valid_approval_nullable_text(text, true))
                && scope.as_ref().is_none_or(valid_approval_scope)
                && valid_approval_decisions(allowed_decisions)
                && external_resolution.as_ref().is_none_or(|external| {
                    valid_nonempty_approval_text(&external.label)
                        && (1..=2).contains(&external.decisions.len())
                        && external
                            .decisions
                            .iter()
                            .enumerate()
                            .all(|(index, decision)| {
                                *decision != ApprovalDecision::Deny
                                    && !external.decisions[..index].contains(decision)
                            })
                })
        }
        ApprovalDetails::SystemAgent {
            title,
            description,
            proposal_hash,
            agent_id,
            allowed_decisions,
        } => {
            valid_nonempty_approval_text(title)
                && valid_nonempty_approval_text(description)
                && proposal_hash.len() == 64
                && proposal_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                && valid_approval_nullable_text(agent_id, true)
                && *allowed_decisions == [ApprovalDecision::AllowOnce, ApprovalDecision::Deny]
        }
    }
}
