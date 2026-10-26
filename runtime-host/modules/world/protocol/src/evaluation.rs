use crate::{
    budget::{Budget, Cost, Usage},
    definitions::{Definition, DefinitionBody, Scope},
    expression::ExpressionIr,
    ids::*,
    learning::{ChangeSet, OracleSpec},
    materials::{BlobRef, SourceVersionRef},
    query::ReadReceipt,
    sources::SourceBasis,
    time::{DurationMs, Timestamp},
    value::Decimal,
};
use serde::{Deserialize, Serialize};

pub mod oracle;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchBasis {
    pub release_id: ReleaseId,
    pub activation_lock_id: ActivationLockId,
    pub snapshots: Vec<BlobRef>,
    pub read_receipts: Vec<ReadReceipt>,
    pub sources: Vec<SourceBasis>,
    pub overlay: Vec<crate::learning::SemanticOperation>,
    pub assumptions: Vec<ExpressionIr>,
    pub replayability: Replayability,
    pub missing_sources: Vec<SourceId>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Replayability {
    Complete,
    Partial,
    NotReplayable,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteRef {
    pub world: WorldRef,
    pub id: SuiteId,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteSummary {
    pub reference: SuiteRef,
    pub task: crate::learning::TaskRef,
    pub frozen_at: Timestamp,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteCreationContext {
    pub branch: crate::releases::BranchRef,
    pub task: crate::learning::TaskContract,
    pub strategies: Vec<DefinitionRef>,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
    pub tool_lock: ActivationLockId,
    pub data_digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBranch {
    pub branch: crate::releases::BranchRef,
    pub suite: SuiteRef,
    pub budget: Budget,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRevision {
    pub id: TestCaseId,
    pub revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenSuite {
    pub world: WorldRef,
    pub id: SuiteId,
    pub revision: Revision,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub tests: Vec<TestRevision>,
    pub protected_counterexamples: Vec<TestRevision>,
    pub training_before: Timestamp,
    pub holdout_from: Timestamp,
    pub arms: Vec<EvaluationArm>,
    pub plans: Vec<PlanSelection>,
    pub conditions: EvaluationConditions,
    pub acceptance: Vec<AcceptanceCriterion>,
    pub frozen_by: ActorId,
    pub frozen_at: Timestamp,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FreezeSuite {
    pub world: WorldRef,
    pub branch: crate::releases::BranchRef,
    pub id: SuiteId,
    pub revision: Revision,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub tests: Vec<TestRevision>,
    pub protected_counterexamples: Vec<TestRevision>,
    pub training_before: Timestamp,
    pub holdout_from: Timestamp,
    pub arms: Vec<EvaluationArm>,
    pub plans: Vec<PlanSelection>,
    pub conditions: EvaluationConditions,
    pub acceptance: Vec<AcceptanceCriterion>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EvaluationArm {
    Candidate,
    ToolMemory,
    StaticOntology,
    AppendOnly,
    Ablation {
        disabled_definitions: Vec<DefinitionRef>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSelection {
    pub arm: EvaluationArm,
    pub plan: PlanReference,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "reference",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlanReference {
    Strategy(DefinitionRef),
    Abstraction {
        id: AbstractionId,
        revision: Revision,
    },
    Frozen(Box<FrozenPlan>),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenPlan {
    pub strategy: DefinitionRef,
    pub tools: Vec<DefinitionRef>,
    pub definitions: Vec<Definition<DefinitionBody>>,
    pub scopes: Vec<Scope>,
    pub knowledge: FrozenKnowledge,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FrozenKnowledge {
    ToolMemory {
        snapshot: SourceVersionRef,
        memory_function: DefinitionRef,
    },
    StaticOntology {
        release_id: ReleaseId,
    },
    AppendOnly {
        anchor_release: ReleaseId,
        changes: Vec<ChangeSet>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationConditions {
    pub read_mode: crate::query::ReadMode,
    pub valid_at: Timestamp,
    pub known_at: Timestamp,
    pub model_binding: Option<crate::generation::ModelBindingRef>,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
    pub tool_lock: ActivationLockId,
    pub data_digest: Digest,
    pub total_budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AcceptanceCriterion {
    HardCheck {
        name: String,
    },
    Minimum {
        metric: EvaluationMetric,
        value: Decimal,
    },
    Maximum {
        metric: EvaluationMetric,
        value: Decimal,
    },
    NoProtectedRegression,
    NoDangerousEffect,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationMetric {
    Success,
    Regression,
    DangerousEffects,
    ErrorMerge,
    EvidenceCoverage,
    Conflict,
    RetractionLag,
    ActiveComplexity,
    MigrationCost,
    Tokens,
    Cost,
    FullLatency,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationRequest {
    pub world: WorldRef,
    pub id: EvaluationId,
    pub candidate_id: CandidateId,
    pub branch_id: BranchId,
    pub basis: BranchBasis,
    pub suite: FrozenSuite,
    pub oracle: OracleSpec,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationReport {
    pub world: WorldRef,
    pub id: EvaluationId,
    pub candidate_id: CandidateId,
    pub suite_id: SuiteId,
    pub suite_revision: Revision,
    pub basis_digest: Digest,
    pub execution: EvaluationExecution,
    pub verdict: CandidateVerdict,
    pub cases: Vec<CaseEvaluation>,
    pub hard_checks: Vec<HardCheck>,
    pub estimates: Vec<EffectEstimate>,
    pub arms: Vec<ArmMetrics>,
    pub counterexamples: Vec<TestRevision>,
    pub coverage: EvaluationCoverage,
    pub assurance: EvaluationAssurance,
    pub usage: Usage,
    pub completed_at: Option<Timestamp>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EvaluationExecution {
    Running,
    Completed,
    Cancelled,
    Failed {
        failure: crate::failure::Failure<crate::operation::OperationFailure>,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CandidateVerdict {
    Pending,
    Accepted,
    Rejected,
    Inconclusive,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationAssurance {
    Untested,
    Tested,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationSummaryExecution {
    Running,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationSummary {
    pub world: WorldRef,
    pub id: EvaluationId,
    pub candidate_id: CandidateId,
    pub suite_id: SuiteId,
    pub suite_revision: Revision,
    pub execution: EvaluationSummaryExecution,
    pub verdict: CandidateVerdict,
    pub assurance: EvaluationAssurance,
    pub usage: Usage,
    pub completed_at: Option<Timestamp>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaseEvaluation {
    pub case_id: Option<CaseId>,
    pub test: TestRevision,
    pub arm: EvaluationArm,
    pub execution: CaseExecution,
    pub oracle_passed: Option<bool>,
    pub observed: Option<BlobRef>,
    pub usage: Usage,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CaseExecution {
    Completed,
    BusinessFailed {
        failure: crate::failure::Failure<crate::actions::ActionFailure>,
    },
    BadFixture {
        field: crate::failure::FieldPath,
    },
    OracleUnavailable,
    Cancelled,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardCheck {
    pub name: String,
    pub passed: bool,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectEstimate {
    pub split: crate::learning::DatasetSplit,
    pub origin: crate::learning::CaseOriginKind,
    pub metric: EvaluationMetric,
    pub estimate: Decimal,
    pub lower: Option<Decimal>,
    pub upper: Option<Decimal>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub sample_size: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArmMetrics {
    pub split: crate::learning::DatasetSplit,
    pub origin: crate::learning::CaseOriginKind,
    pub arm: EvaluationArm,
    pub success: Decimal,
    pub regression: Option<Decimal>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub dangerous_effects: Option<u64>,
    pub error_merge: Option<Decimal>,
    pub evidence_coverage: Option<Decimal>,
    pub conflict: Option<Decimal>,
    pub retraction_lag: Option<DurationMs>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub active_complexity: Option<u64>,
    pub migration_cost: Option<Decimal>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub input_tokens: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub output_tokens: u64,
    pub cost: Option<Cost>,
    pub full_latency: DurationMs,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationCoverage {
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub tested: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub total: u64,
    pub missing_tests: Vec<TestRevision>,
    pub missing_sources: Vec<SourceId>,
    pub assumptions_used: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EvaluationFailure {
    BadCase {
        test_case_id: TestCaseId,
    },
    OracleUnavailable,
    SchemaMismatch {
        expected: Digest,
    },
    SourceMissing {
        source_id: SourceId,
    },
    BasisChanged,
    EpochChanged,
    BudgetExhausted {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    ExecutionFailed,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EvaluationSummaryFailure {
    BadCase,
    OracleUnavailable,
    SchemaMismatch,
    SourceMissing,
    BasisChanged,
    EpochChanged,
    BudgetExhausted {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    ExecutionFailed,
    Commit,
    InternalFault,
}
