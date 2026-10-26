use crate::{
    authorization::{ApprovalBinding, PolicyRef},
    budget::Budget,
    expression::{Effect, ExpressionIr, Parameter, TruthValue},
    identity::SubjectRef,
    ids::*,
    provenance::ReadDependency,
    query::{QueryArgument, ReadReceipt},
    sources::{SourceFailure, SourcePosition},
    time::Timestamp,
    value::{Value, ValueType},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionContract {
    pub name: String,
    pub parameters: Vec<Parameter>,
    pub result_type: ValueType,
    pub targets: Vec<ActionTarget>,
    pub reads: Vec<DefinitionRef>,
    pub writes: Vec<DefinitionRef>,
    pub effects: Vec<Effect>,
    pub preconditions: Vec<ExpressionIr>,
    pub policies: Vec<PolicyRef>,
    pub approval: ApprovalRequirement,
    pub risk: RiskClass,
    pub source_operation: SourceOperation,
    pub idempotency: IdempotencyPolicy,
    pub expected_effect: ExpressionIr,
    pub verifier: VerifierSpec,
    pub compensation: Option<CompensationSpec>,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionTarget {
    pub parameter_id: ParameterId,
    pub type_ref: DefinitionRef,
    pub scope: ScopeId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRequirement {
    None,
    Human,
    SeparateActor,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RiskClass {
    ReadOnly,
    Reversible,
    Consequential,
    Irreversible,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOperation {
    pub binding: DefinitionRef,
    pub resource: String,
    pub mutation: SourceMutation,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceMutation {
    Insert {
        values: Vec<SourceFieldExpression>,
    },
    Update {
        keys: Vec<SourceFieldExpression>,
        values: Vec<SourceFieldExpression>,
        expected: Vec<SourceFieldExpression>,
    },
    Delete {
        keys: Vec<SourceFieldExpression>,
        expected: Vec<SourceFieldExpression>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFieldExpression {
    pub field: SourceFieldId,
    pub expression: ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedExpression {
    pub name: String,
    pub expression: ExpressionIr,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyPolicy {
    SourceKey,
    ConditionalWrite,
    InspectBeforeRetry,
    NoAutomaticRetry,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifierSpec {
    pub query: crate::query::QueryIr,
    pub expected: ExpressionIr,
    pub require_authoritative: bool,
    pub maximum_attempts: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompensationSpec {
    pub action: DefinitionRef,
    pub arguments: Vec<NamedExpression>,
    pub preconditions: Vec<ExpressionIr>,
    pub approval: ApprovalRequirement,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionProposalRequest {
    pub world: WorldRef,
    pub branch_id: Option<BranchId>,
    pub action: DefinitionRef,
    pub arguments: Vec<QueryArgument>,
    pub targets: Vec<SubjectRef>,
    pub basis: Vec<ReadReceiptId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionProposal {
    pub id: CandidateId,
    pub request: ActionProposalRequest,
    pub digest: Digest,
    pub impact: crate::authorization::ActualImpact,
    pub preconditions: Vec<TruthValue>,
    pub read_dependencies: Vec<ReadDependency>,
    pub activation_lock_id: ActivationLockId,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionSubmitRequest {
    pub world: WorldRef,
    pub proposal_id: CandidateId,
    pub proposal_digest: Digest,
    pub idempotency_key: RequestId,
    pub approval: Option<ApprovalBinding>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectIntent {
    pub id: EffectIntentId,
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub step_id: StepId,
    pub action: DefinitionRef,
    pub proposal_digest: Digest,
    pub source_operation: SourceOperation,
    pub argument_values: Vec<QueryArgument>,
    pub idempotency_key: RequestId,
    pub activation_lock_id: ActivationLockId,
    pub decision_id: DecisionId,
    pub expected_versions: Vec<SourcePosition>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReceipt {
    pub id: SourceReceiptId,
    pub intent_id: EffectIntentId,
    pub source_id: SourceId,
    pub observed_at: Timestamp,
    pub disposition: EffectDisposition,
    pub position: Option<SourcePosition>,
    pub result: Option<Value>,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EffectDisposition {
    NotSent,
    Rejected,
    Accepted,
    Applied,
    NotApplied,
    Indeterminate,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationReceipt {
    pub id: VerificationId,
    pub intent_id: EffectIntentId,
    pub verdict: VerificationVerdict,
    pub read_receipt: ReadReceipt,
    pub evidence: Vec<EvidenceRef>,
    pub verified_at: Timestamp,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerificationVerdict {
    Verified,
    NotSatisfied,
    Inconclusive,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionStatus {
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub phase: ActionPhase,
    pub source_receipts: Vec<SourceReceipt>,
    pub verifications: Vec<VerificationReceipt>,
    pub commit: Option<crate::commit::CommitReceipt>,
    pub failure: Option<crate::failure::Failure<ActionFailure>>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionPhase {
    Proposed,
    Admitted,
    Prepared,
    Dispatching,
    EffectPending,
    Verifying,
    Committing,
    Completed,
    Rejected,
    CancelledBeforeEffect,
    CancelledAfterEffect,
    EffectIndeterminate,
    CommitIndeterminate,
    Compensating,
    Retained,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActionFailure {
    ContractMissing {
        reference: DefinitionRef,
    },
    Input {
        failure: crate::failure::InputFailure,
    },
    Compilation {
        failure: crate::compiler::CompileFailure,
    },
    Evaluation {
        failure: crate::query::QueryFailure,
    },
    Definition {
        failure: crate::definitions::DefinitionFailure,
    },
    PreconditionFalse {
        index: u32,
    },
    PreconditionUnknown {
        index: u32,
        value: TruthValue,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    ProposalExpired,
    ProposalDigestMismatch,
    IdempotencyConflict,
    Source {
        failure: SourceFailure,
    },
    ConditionalWriteConflict,
    EffectIndeterminate {
        intent_id: EffectIntentId,
    },
    VerificationFailed {
        verification_id: VerificationId,
    },
    VerificationUnavailable,
    CompensationFailed,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    CancelledBeforeEffect,
    CancelledAfterEffect,
    CleanupFailed,
    InternalFault,
}
