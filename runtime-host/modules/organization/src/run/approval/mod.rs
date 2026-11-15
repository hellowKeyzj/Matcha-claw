mod content;
mod decision;

pub use content::{ApprovalContent, ApprovalSubmission};
mod model;
mod transition;

pub use decision::{HumanDecisionCommand, HumanDecisionCommandError, HumanDecisionOutcome};
pub(crate) use model::ApprovalBinding;
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
