mod decision;
mod model;
mod transition;

pub use decision::{HumanDecisionCommand, HumanDecisionCommandError, HumanDecisionOutcome};
pub use model::{
    Approval, ApprovalDecision, ApprovalDurableSnapshot, ApprovalEffect, ApprovalOrigin,
    ApprovalRequest, ApprovalResolution, ApprovalResolutionCause, ApprovalResolutionError,
    ApprovalRestoreError, ApprovalStatus, ApprovalSubject,
};
pub use transition::{
    ApprovalResolutionInput, ResolveApprovalError, abort_pending_approvals, resolve_approval,
};

#[cfg(test)]
mod tests;
