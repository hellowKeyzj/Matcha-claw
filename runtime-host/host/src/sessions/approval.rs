use serde::Serialize;

use super::endpoint::NativeEndpoint;

const MAX_IDENTIFIER_BYTES: usize = 4096;

/// Session approval is a matcha-agent-only operation.
///
/// Any other native endpoint is reported to the renderer as unsupported rather than routed to a
/// runtime that does not implement approvals, so the outcome does not depend on that runtime's
/// lifecycle.
pub(crate) const fn endpoint_supports_approval(endpoint: NativeEndpoint) -> bool {
    matches!(endpoint, NativeEndpoint::MatchaAgentLocal)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingApprovalsCommand {
    pub(crate) endpoint: NativeEndpoint,
    pub(crate) session_id: String,
}

impl PendingApprovalsCommand {
    pub(crate) fn try_new(
        endpoint: NativeEndpoint,
        session_id: String,
    ) -> Result<Self, InvalidCommand> {
        valid_identifier(&session_id)?;
        Ok(Self {
            endpoint,
            session_id,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionApprovalCommand {
    pub(crate) endpoint: NativeEndpoint,
    pub(crate) session_id: String,
    pub(crate) approval_id: String,
    pub(crate) option_id: String,
}

impl SessionApprovalCommand {
    pub(crate) fn try_new(
        endpoint: NativeEndpoint,
        session_id: String,
        approval_id: String,
        option_id: String,
    ) -> Result<Self, InvalidCommand> {
        for value in [&session_id, &approval_id, &option_id] {
            valid_identifier(value)?;
        }
        Ok(Self {
            endpoint,
            session_id,
            approval_id,
            option_id,
        })
    }
}

fn valid_identifier(value: &str) -> Result<(), InvalidCommand> {
    if value.trim().is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.as_bytes().contains(&0)
    {
        return Err(InvalidCommand);
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingApproval {
    pub(crate) approval_id: String,
    pub(crate) option_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingApprovals {
    pub(crate) approvals: Vec<PendingApproval>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PendingApprovalsOutcome {
    Found(PendingApprovals),
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SessionApprovalOutcome {
    Responded,
    #[serde(rename = "target_rejected")]
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::SessionApprovalOutcome;
    use serde_json::json;

    #[test]
    fn exposes_no_terminal_outcome() {
        assert_eq!(
            serde_json::to_value(SessionApprovalOutcome::Responded).unwrap(),
            json!({"outcome":"responded"})
        );
    }
}
