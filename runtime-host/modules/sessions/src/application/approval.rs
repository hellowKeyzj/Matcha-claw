use serde::Serialize;

use crate::{
    endpoint::NativeEndpoint,
    state::{ApprovalDetails, SessionIdentity},
};

const MAX_IDENTIFIER_BYTES: usize = 4096;

/// Approvals are owned by either fixed native peer, never by an unknown endpoint.
pub const fn endpoint_supports_approval(endpoint: NativeEndpoint) -> bool {
    matches!(
        endpoint,
        NativeEndpoint::MatchaAgentLocal | NativeEndpoint::OpenClawLocal
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApprovalsCommand {
    pub endpoint: NativeEndpoint,
    pub session_id: String,
    pub identity: SessionIdentity,
}

impl PendingApprovalsCommand {
    pub fn try_new(
        endpoint: NativeEndpoint,
        session_id: String,
        identity: SessionIdentity,
    ) -> Result<Self, InvalidCommand> {
        valid_identifier(&session_id)?;
        valid_identity(endpoint, &identity)?;
        Ok(Self {
            endpoint,
            session_id,
            identity,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionApprovalCommand {
    pub endpoint: NativeEndpoint,
    pub session_id: String,
    pub approval_id: String,
    pub option_id: String,
    pub identity: SessionIdentity,
}

impl SessionApprovalCommand {
    pub fn try_new(
        endpoint: NativeEndpoint,
        session_id: String,
        approval_id: String,
        option_id: String,
        identity: SessionIdentity,
    ) -> Result<Self, InvalidCommand> {
        for value in [&session_id, &approval_id, &option_id] {
            valid_identifier(value)?;
        }
        valid_identity(endpoint, &identity)?;
        Ok(Self {
            endpoint,
            session_id,
            approval_id,
            option_id,
            identity,
        })
    }
}

fn valid_identity(
    endpoint: NativeEndpoint,
    identity: &SessionIdentity,
) -> Result<(), InvalidCommand> {
    identity.validate().map_err(|_| InvalidCommand)?;
    let native_endpoint = NativeEndpoint::parse(
        &identity.endpoint.kind,
        identity.provider().as_str(),
        &identity.endpoint.runtime_instance_id,
    )
    .ok_or(InvalidCommand)?;
    (native_endpoint == endpoint)
        .then_some(())
        .ok_or(InvalidCommand)
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
pub struct PendingApproval {
    pub approval_id: String,
    pub option_ids: Vec<String>,
    pub details: Option<ApprovalDetails>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovals {
    pub approvals: Vec<PendingApproval>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PendingApprovalsOutcome {
    Found(PendingApprovals),
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommand;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionApprovalOutcome {
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
