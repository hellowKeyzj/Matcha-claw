use crate::{
    actions::SourceReceipt,
    budget::Budget,
    definitions::{Definition, DefinitionBody},
    expression::{Effect, ExpressionIr, Parameter},
    facts::Evidence,
    ids::*,
    materials::{AccessPolicyRef, BlobRef},
    query::{QueryArgument, ReadReceipt},
    sources::RetentionPolicy,
    time::{Timestamp, ValidTime},
    value::{Value, ValueType},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SemanticOperation {
    NoOp {
        reason: String,
    },
    AttachEvidence {
        target: ResourceRef,
        evidence: Vec<EvidenceRef>,
    },
    EnrichAnnotation {
        target: DefinitionRef,
        annotation: Annotation,
    },
    RefineDefinition {
        previous: DefinitionRef,
        replacement: Box<Definition<DefinitionBody>>,
    },
    ScopeDefinition {
        previous: DefinitionRef,
        scope: ScopeId,
        valid_time: ValidTime,
    },
    SupersedeRule {
        previous: DefinitionRef,
        replacement: Box<Definition<DefinitionBody>>,
    },
    LinkExisting {
        source: DefinitionRef,
        target: DefinitionRef,
        relation: SemanticLink,
    },
    MergeAliases {
        sources: Vec<DefinitionRef>,
        target: DefinitionRef,
        evidence: Vec<EvidenceRef>,
    },
    DeprecateDefinition {
        previous: DefinitionRef,
        replacements: Vec<DefinitionRef>,
        reason: String,
        effective_at: Timestamp,
    },
    SplitDefinition {
        previous: DefinitionRef,
        replacements: Vec<Definition<DefinitionBody>>,
        partition: Vec<SplitPartition>,
    },
    CreateDefinition {
        definition: Box<Definition<DefinitionBody>>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub label: Option<String>,
    pub description: Option<String>,
    pub aliases: Vec<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SemanticLink {
    EquivalentWithinScope,
    Specializes,
    Implements,
    DependsOn,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitPartition {
    pub replacement: DefinitionId,
    pub predicate: ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeSet {
    pub world: WorldRef,
    pub id: ChangeSetId,
    pub revision: Revision,
    pub base_release: ReleaseId,
    pub operations: Vec<SemanticOperation>,
    pub evidence: Vec<EvidenceRef>,
    pub cases: Vec<CaseId>,
    pub rationale: String,
    pub status: ChangeStatus,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Proposed,
    Validated,
    Testing,
    Ready,
    Rejected,
    Published,
    Superseded,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Strategy {
    pub name: String,
    pub parameters: Vec<Parameter>,
    pub guard: ExpressionIr,
    pub steps: Vec<StrategyStep>,
    pub budget: Budget,
    pub cases: Vec<CaseId>,
    pub counterexamples: Vec<TestCaseId>,
    pub fallback: Option<DefinitionRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrategyStep {
    pub id: StepId,
    pub depends_on: Vec<StepId>,
    pub guard: ExpressionIr,
    pub operation: StrategyOperation,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StrategyOperation {
    Query {
        query: crate::query::QueryIr,
    },
    Action {
        action: DefinitionRef,
        arguments: Vec<QueryArgument>,
    },
    Function {
        function: DefinitionRef,
        arguments: Vec<ExpressionIr>,
    },
    Stop {
        reason: StopReason,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    GoalSatisfied,
    ConstraintViolated,
    BudgetExhausted,
    EvidenceRequired,
    HumanRequired,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRef {
    pub world: WorldRef,
    pub id: TaskId,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSummary {
    pub reference: TaskRef,
    pub goal: String,
    pub scope: ScopeId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskContract {
    pub world: WorldRef,
    pub id: TaskId,
    pub revision: Revision,
    pub goal: String,
    pub input_type: ValueType,
    pub scope: ScopeId,
    pub hard_constraints: Vec<ExpressionIr>,
    pub allowed_effects: Vec<Effect>,
    pub success_oracle: OracleSpec,
    pub required_suites: Vec<SuiteId>,
    pub budget: Budget,
    pub stop_conditions: Vec<ExpressionIr>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OracleSpec {
    Program {
        implementation: crate::bindings::ImplementationRef,
        fixture_schema: Digest,
        result_schema: Digest,
    },
    SourceReceipt {
        source_id: SourceId,
        required_disposition: crate::actions::EffectDisposition,
    },
    Human {
        actor_id: ActorId,
        decision_id: DecisionId,
        binding_digest: Digest,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Case {
    pub origin: CaseOrigin,
    pub used_definitions: Vec<DefinitionRef>,
    pub world: WorldRef,
    pub id: CaseId,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub input: Value,
    pub observable_trace: BlobRef,
    pub release_id: ReleaseId,
    pub activation_lock_id: ActivationLockId,
    pub model_binding: Option<crate::generation::ModelBindingRef>,
    pub read_receipts: Vec<ReadReceipt>,
    pub source_receipts: Vec<SourceReceipt>,
    pub evidence: Vec<EvidenceRef>,
    pub outcome: CaseOutcome,
    pub origin_family: OriginFamilyId,
    pub occurred_at: Timestamp,
    pub access: AccessPolicyRef,
    pub retention: RetentionPolicy,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CaseOutcome {
    Succeeded {
        result: Value,
    },
    Failed {
        failure: crate::failure::Failure<LearningFailure>,
    },
    Cancelled {
        stage: crate::failure::FailureStage,
    },
    Inconclusive {
        reason: CaseInconclusive,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CaseInconclusive {
    StopConditionSatisfied {
        field: crate::failure::FieldPath,
    },
    ResultUnavailable {
        field: crate::failure::FieldPath,
        cell: crate::value::Cell,
    },
    Stopped {
        field: crate::failure::FieldPath,
        reason: StopReason,
    },
    GuardNotSatisfied {
        field: crate::failure::FieldPath,
        truth: crate::expression::TruthValue,
    },
    EvidenceMissing {
        evidence: Vec<EvidenceRef>,
    },
    EffectIndeterminate {
        intent_id: EffectIntentId,
    },
    CommitIndeterminate {
        commit_id: CommitId,
    },
    OracleUnavailable,
    IncompleteBasis {
        sources: Vec<SourceId>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CaseOrigin {
    Recorded,
    Fixture,
    Replay {
        parent_case_id: CaseId,
        basis: crate::evaluation::BranchBasis,
    },
    Synthetic {
        generator: crate::bindings::ImplementationRef,
        assumptions: Vec<ExpressionIr>,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CaseOriginKind {
    Recorded,
    Fixture,
    Replay,
    Synthetic,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestCase {
    pub task_revision: Revision,
    pub scope: ScopeId,
    pub case_id: Option<CaseId>,
    pub world: WorldRef,
    pub id: TestCaseId,
    pub revision: Revision,
    pub task_id: TaskId,
    pub fixture: BlobRef,
    pub expected: BlobRef,
    pub oracle: OracleSpec,
    pub split: DatasetSplit,
    pub purpose: TestPurpose,
    pub protected: bool,
    pub origin_family: OriginFamilyId,
    pub occurred_at: Timestamp,
    pub candidate_id: Option<CandidateId>,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatasetSplit {
    Train,
    Dev,
    Holdout,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TestPurpose {
    Regression,
    Counterexample,
    Boundary,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub world: WorldRef,
    pub id: CandidateId,
    pub change_set: ChangeSet,
    pub origin: CandidateOrigin,
    pub evidence: Vec<Evidence>,
    pub model_calls: Vec<ModelCallId>,
    pub created_at: Timestamp,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CandidateOrigin {
    Direct,
    Human,
    Extraction,
    CaseInduction,
    Reconciliation,
    Abstraction,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LearningFailure {
    ConstraintViolated {
        field: crate::failure::FieldPath,
    },
    InvalidOperation {
        index: u32,
        field: crate::failure::FieldPath,
    },
    MissingEvidence {
        reference: EvidenceRef,
    },
    BasisChanged,
    UnauthorizedOperation,
    Definition {
        failure: crate::definitions::DefinitionFailure,
    },
    EvaluationRequired {
        suites: Vec<SuiteId>,
    },
    CounterexampleProtected {
        test_case_id: TestCaseId,
    },
    Model {
        failure: crate::generation::GenerationFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Cancelled,
    InternalFault,
}
