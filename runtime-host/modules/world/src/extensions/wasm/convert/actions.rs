use super::*;

record!(world_protocol::actions::ActionTarget, ActionTarget; parameter_id, type_ref, scope);
unit_enum!(world_protocol::actions::ApprovalRequirement, ApprovalRequirement; None, Human, SeparateActor);
unit_enum!(world_protocol::actions::RiskClass, RiskClass; ReadOnly, Reversible, Consequential, Irreversible);
record!(world_protocol::actions::SourceFieldExpression, SourceFieldExpression; field, expression);
variant!(world_protocol::actions::SourceMutation, SourceMutation; units []; tuples []; records [Insert { values } => SourceMutationInsert, Update { keys, values, expected } => SourceMutationUpdate, Delete { keys, expected } => SourceMutationDelete]);
record!(world_protocol::actions::SourceOperation, SourceOperation; binding, resource, mutation);
unit_enum!(world_protocol::actions::IdempotencyPolicy, IdempotencyPolicy; SourceKey, ConditionalWrite, InspectBeforeRetry, NoAutomaticRetry);
record!(world_protocol::actions::VerifierSpec, VerifierSpec; query, expected, require_authoritative, maximum_attempts);
record!(world_protocol::actions::NamedExpression, NamedExpression; name, expression);
record!(world_protocol::actions::CompensationSpec, CompensationSpec; action, arguments, preconditions, approval);
record!(world_protocol::actions::ActionContract, ActionContract; name, parameters, result_type, targets, reads, writes, effects, preconditions, policies, approval, risk, source_operation, idempotency, expected_effect, verifier, compensation, budget);
record!(world_protocol::actions::ActionProposalRequest, ActionProposalRequest; world, branch_id, action, arguments, targets, basis);
record!(world_protocol::actions::ActionProposal, ActionProposal; id, request, digest, impact, preconditions, read_dependencies, activation_lock_id, created_at, expires_at);
unit_enum!(world_protocol::actions::EffectDisposition, EffectDisposition; NotSent, Rejected, Accepted, Applied, NotApplied, Indeterminate);
record!(world_protocol::actions::ActionSubmitRequest, ActionSubmitRequest; world, proposal_id, proposal_digest, idempotency_key, approval);
unit_enum!(world_protocol::actions::ActionPhase, ActionPhase; Proposed, Admitted, Prepared, Dispatching, EffectPending, Verifying, Committing, Completed, Rejected, CancelledBeforeEffect, CancelledAfterEffect, EffectIndeterminate, CommitIndeterminate, Compensating, Retained);
record!(world_protocol::actions::SourceReceipt, SourceReceipt; id, intent_id, source_id, observed_at, disposition, position, result, evidence);
unit_enum!(world_protocol::actions::VerificationVerdict, VerificationVerdict; Verified, NotSatisfied, Inconclusive);
record!(world_protocol::actions::VerificationReceipt, VerificationReceipt; id, intent_id, verdict, read_receipt, evidence, verified_at);
impl Wire for world_protocol::actions::ActionFailure {
    type Output = w::ActionFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_action_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_action_failure()?)
    }
}
variant!(component::ActionFailureNode, ActionFailureNode; units [ProposalExpired, ProposalDigestMismatch, IdempotencyConflict, ConditionalWriteConflict, VerificationUnavailable, CompensationFailed, CancelledBeforeEffect, CancelledAfterEffect, CleanupFailed, InternalFault]; tuples []; records [ContractMissing { reference } => ActionFailureNodeContractMissing, Input { failure } => ActionFailureNodeInput, Compilation { failure } => ActionFailureNodeCompilation, Evaluation { failure } => ActionFailureNodeEvaluation, Definition { failure } => ActionFailureNodeDefinition, PreconditionFalse { index } => ActionFailureNodePreconditionFalse, PreconditionUnknown { index, value } => ActionFailureNodePreconditionUnknown, Authorization { failure } => ActionFailureNodeAuthorization, Source { failure } => ActionFailureNodeSource, EffectIndeterminate { intent_id } => ActionFailureNodeEffectIndeterminate, VerificationFailed { verification_id } => ActionFailureNodeVerificationFailed, Commit { failure } => ActionFailureNodeCommit, BudgetExceeded { dimension } => ActionFailureNodeBudgetExceeded]);
record!(world_protocol::actions::ActionStatus, ActionStatus; operation_id, run_id, phase, source_receipts, verifications, commit, failure);
