use super::{Approval, ApprovalDecision, ApprovalResolutionCause};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalResolutionInput {
    pub approval_id: String,
    pub run_id: String,
    pub stage_id: String,
    pub role_id: String,
    pub decision: ApprovalDecision,
    pub resolved_at: u64,
    pub note: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolveApprovalError {
    UnknownApproval,
    InvalidResolution,
    ConflictingIdempotencyKey,
}

pub fn resolve_approval(
    approvals: &mut [Approval],
    input: ApprovalResolutionInput,
) -> Result<(), ResolveApprovalError> {
    let ApprovalResolutionInput {
        approval_id,
        run_id,
        stage_id,
        role_id,
        decision,
        resolved_at,
        note,
        idempotency_key,
    } = input;
    let approval = approvals
        .iter_mut()
        .find(|approval| approval.facts().approval_id == approval_id)
        .filter(|approval| {
            let facts = approval.facts();
            facts.run_id == run_id && facts.stage_id == stage_id && facts.role_id == role_id
        })
        .ok_or(ResolveApprovalError::UnknownApproval)?;

    approval
        .resolve_with_receipt(
            decision,
            resolved_at,
            note,
            idempotency_key,
            ApprovalResolutionCause::HumanDecision,
        )
        .map_err(|error| match error {
            super::ApprovalResolutionError::InvalidResolution => {
                ResolveApprovalError::InvalidResolution
            }
            super::ApprovalResolutionError::ConflictingIdempotencyKey => {
                ResolveApprovalError::ConflictingIdempotencyKey
            }
        })
}

pub fn abort_pending_approvals(
    approvals: &mut [Approval],
    resolved_at: u64,
    note: Option<&str>,
) -> usize {
    let mut aborted = 0;

    for approval in approvals
        .iter_mut()
        .filter(|approval| approval.is_pending())
    {
        approval
            .resolve(
                ApprovalDecision::Abort,
                resolved_at,
                note.map(str::to_owned),
            )
            .expect("pending approval must be resolvable");
        aborted += 1;
    }

    aborted
}
