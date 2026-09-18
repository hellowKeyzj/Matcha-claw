use serde_json::{Value, json};

use crate::{
    organization::OrganizationHandle, transport::common::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "team.approvals.list";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/approvals";
const AUTHORIZATION_SCOPE: &str = "team:read";
const AUTHORIZATION_SUBJECT: &str = "team-pending-approvals";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    team_id: organization::TeamId,
    run_id: organization::GraphRunId,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            OPERATION_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;

    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    if body.len() != 2 {
        return Err(DecodeError::Invalid);
    }
    let Some(Value::String(team_id)) = body.get("teamId") else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(run_id)) = body.get("runId") else {
        return Err(DecodeError::Invalid);
    };
    if !valid_identifier(team_id) || !valid_identifier(run_id) {
        return Err(DecodeError::Invalid);
    }

    Ok(Request {
        team_id: organization::TeamId::try_new(team_id.clone())
            .map_err(|_| DecodeError::Invalid)?,
        run_id: organization::GraphRunId::new(run_id.clone()),
    })
}

pub(crate) enum Delivery {
    Available(organization::run::TeamPendingApprovals),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Available(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Available(approvals) => pending_approvals_body(approvals),
            Self::Unavailable => json!({
                "success": false,
                "error": "Team pending approvals are unavailable",
            }),
        }
    }
}

fn pending_approvals_body(approvals: &organization::run::TeamPendingApprovals) -> Value {
    json!({
        "teamId": approvals.team_id(),
        "runId": approvals.run_id(),
        "approvals": approvals.approvals().iter().map(|approval| json!({
            "approvalId": approval.approval_id(),
            "stageId": approval.stage_id(),
            "roleId": approval.role_id(),
            "reason": approval.reason(),
            "requestedAction": approval.requested_action(),
            "createdAt": approval.created_at(),
        })).collect::<Vec<_>>(),
    })
}

pub(crate) async fn read(owner: &OrganizationHandle, request: Request) -> Delivery {
    match owner
        .pending_approvals(request.team_id, request.run_id)
        .await
    {
        Ok(organization::run::TeamPendingApprovalsQueryOutcome::Available(approvals)) => {
            Delivery::Available(approvals)
        }
        Ok(organization::run::TeamPendingApprovalsQueryOutcome::Unavailable) | Err(_) => {
            Delivery::Unavailable
        }
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

pub(crate) mod handler;
