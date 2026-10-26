use crate::{
    budget::Budget,
    expression::{ExpressionIr, Parameter},
    ids::*,
    query::{ObjectView, RelationView, Truncation},
    value::ValueType,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionRef {
    pub world: WorldRef,
    pub id: AbstractionId,
    pub revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionRequest {
    pub world: WorldRef,
    pub task: crate::learning::TaskContract,
    pub definitions: Vec<DefinitionRef>,
    pub assurance: Assurance,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionDraft {
    pub id: AbstractionId,
    pub revision: Revision,
    pub strategy: Option<DefinitionRef>,
    pub applicable_actions: Vec<DefinitionRef>,
    pub original_definitions: Vec<DefinitionRef>,
    pub forward_plan: Vec<crate::learning::StrategyStep>,
    pub preserved_invariants: Vec<ExpressionIr>,
    pub parameters: Vec<Parameter>,
    pub slots: Vec<AbstractionSlot>,
    pub binding_map: BindingMap,
    pub guard: ExpressionIr,
    pub assurance: Assurance,
    pub assumptions: Vec<ExpressionIr>,
    pub evaluation_ids: Vec<EvaluationId>,
    pub fallback: Fallback,
    pub read_dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionContract {
    pub world: WorldRef,
    pub id: AbstractionId,
    pub revision: Revision,
    pub candidate_id: CandidateId,
    pub branch: Option<crate::releases::BranchRef>,
    pub strategy: Option<DefinitionRef>,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub base_release: ReleaseId,
    pub scope: ScopeId,
    pub applicable_actions: Vec<DefinitionRef>,
    pub original_definitions: Vec<DefinitionRef>,
    pub forward_plan: Vec<crate::learning::StrategyStep>,
    pub preserved_invariants: Vec<ExpressionIr>,
    pub parameters: Vec<Parameter>,
    pub slots: Vec<AbstractionSlot>,
    pub binding_map: BindingMap,
    pub guard: ExpressionIr,
    pub assurance: Assurance,
    pub assumptions: Vec<ExpressionIr>,
    pub evaluation_ids: Vec<EvaluationId>,
    pub fallback: Fallback,
    pub read_dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionSlot {
    pub id: AbstractionSlotId,
    pub value_type: ValueType,
    pub role: SlotRole,
    pub cardinality: crate::definitions::Cardinality,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SlotRole {
    Input,
    Output,
    Object,
    Relation,
    Action,
    State,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingMap {
    pub bindings: Vec<ConcreteBinding>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConcreteBinding {
    pub slot_id: AbstractionSlotId,
    pub parameter_id: Option<ParameterId>,
    pub target: BindingTarget,
    pub transform: Option<ExpressionIr>,
    pub inverse_transform: Option<ExpressionIr>,
    pub inverse_scope: ScopeId,
    pub guard: Option<ExpressionIr>,
    pub dependencies: Vec<crate::provenance::ReadDependency>,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BindingTarget {
    Object { id: ObjectId },
    Relation { id: RelationId },
    Property { definition: DefinitionRef },
    Action { definition: DefinitionRef },
    State { reference: StateRef },
    Expression { expression: ExpressionIr },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Assurance {
    Heuristic,
    Tested,
    Guarded,
    Verified,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Fallback {
    ExpandConcrete { concrete_strategy: DefinitionRef },
    RequestEvidence { evidence: Vec<EvidenceRef> },
    Stop,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldView {
    pub world: WorldRef,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub scope: ScopeId,
    pub goal: String,
    pub hard_constraints: Vec<ExpressionIr>,
    pub allowed_effects: Vec<crate::expression::Effect>,
    pub stop_conditions: Vec<ExpressionIr>,
    pub labels: Vec<String>,
    pub rows: Vec<crate::query::QueryRow>,
    pub objects: Vec<ObjectView>,
    pub relations: Vec<RelationView>,
    pub definitions: Vec<DefinitionRef>,
    pub actions: Vec<crate::actions::ActionProposal>,
    pub abstractions: Vec<AbstractionContract>,
    pub read_receipts: Vec<crate::query::ReadReceipt>,
    pub truncation: Option<Truncation>,
    pub untrusted_material: Vec<crate::materials::BlobRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AbstractionFailure {
    SlotUnbound { slot_id: AbstractionSlotId },
    DuplicateBinding { slot_id: AbstractionSlotId },
    TypeMismatch { slot_id: AbstractionSlotId },
    GuardFalse,
    GuardUnknown,
    AssuranceUnsupported { requested: Assurance },
    EvidenceMissing,
    BasisChanged,
    BudgetExceeded,
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContextFailure {
    InvalidTask,
    BudgetExceeded,
    QueryUnavailable,
    AuthorizationDenied,
    BasisChanged,
    Cancelled,
    InternalFault,
}
