use crate::{
    expression::{AggregateOperator, ExpressionIr, Parameter},
    identity::{Object, Relation},
    ids::*,
    provenance::ReadDependency,
    sources::{SourceBasis, SourceFailure},
    time::{DurationMs, Timestamp},
    value::{Cell, DirtyState, Value},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryIr {
    pub root: QueryNode,
    pub parameters: Vec<Parameter>,
    pub output: Vec<QueryColumn>,
    pub limit: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryNode {
    Objects {
        type_ref: DefinitionRef,
        symbol: SymbolId,
    },
    Relations {
        type_ref: DefinitionRef,
        symbol: SymbolId,
    },
    Filter {
        input: Box<QueryNode>,
        predicate: ExpressionIr,
    },
    Join {
        left: Box<QueryNode>,
        right: Box<QueryNode>,
        on: ExpressionIr,
        join_kind: JoinKind,
    },
    Traverse {
        input: Box<QueryNode>,
        relation_type: DefinitionRef,
        from_role: RoleId,
        to_role: RoleId,
        target: SymbolId,
    },
    Project {
        input: Box<QueryNode>,
        columns: Vec<QueryColumn>,
    },
    Aggregate {
        input: Box<QueryNode>,
        group_by: Vec<QueryColumn>,
        aggregates: Vec<QueryAggregate>,
    },
    Sort {
        input: Box<QueryNode>,
        order: Vec<QueryOrder>,
    },
    Distinct {
        input: Box<QueryNode>,
    },
    Union {
        inputs: Vec<QueryNode>,
    },
    NotExists {
        input: Box<QueryNode>,
        correlated: Box<QueryNode>,
        predicate: ExpressionIr,
    },
    Limit {
        input: Box<QueryNode>,
        count: u32,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JoinKind {
    Inner,
    Left,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryColumn {
    pub name: String,
    pub expression: ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryAggregate {
    pub name: String,
    pub operator: AggregateOperator,
    pub expression: ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryOrder {
    pub expression: ExpressionIr,
    pub descending: bool,
    pub nulls: NullOrder,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NullOrder {
    First,
    Last,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReadMode {
    Projected { max_lag: DurationMs },
    Authoritative,
    After { receipt_id: ReadReceiptId },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRequest {
    pub world: WorldRef,
    pub branch_id: Option<BranchId>,
    pub release_id: Option<ReleaseId>,
    pub query: QueryIr,
    pub arguments: Vec<QueryArgument>,
    pub read_mode: ReadMode,
    pub valid_at: Option<Timestamp>,
    pub known_at: Option<Timestamp>,
    pub page: PageRequest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryArgument {
    pub parameter_id: ParameterId,
    pub value: Value,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRequest {
    pub limit: u32,
    pub cursor: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldCell {
    pub property: DefinitionRef,
    pub cell: Cell,
    pub evidence: Vec<EvidenceRef>,
    pub dirty: DirtyState,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectView {
    pub object: Object,
    pub fields: Vec<FieldCell>,
    pub receipt_id: ReadReceiptId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationView {
    pub relation: Relation,
    pub claim: Option<AssertionRef>,
    pub roles: Vec<crate::facts::RoleBinding>,
    pub fields: Vec<FieldCell>,
    pub receipt_id: ReadReceiptId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRow {
    pub columns: Vec<NamedCell>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedCell {
    pub name: String,
    pub cell: Cell,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryPage {
    pub rows: Page<QueryRow>,
    pub objects: Vec<ObjectView>,
    pub relations: Vec<RelationView>,
    pub receipt: ReadReceipt,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadReceipt {
    pub world: WorldRef,
    pub id: ReadReceiptId,
    pub branch_id: Option<BranchId>,
    pub release_id: ReleaseId,
    pub activation_lock_id: ActivationLockId,
    pub query_digest: Digest,
    pub evaluated_scope_digest: Digest,
    pub decision_id: DecisionId,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
    pub observed_at: Timestamp,
    pub expires_at: Option<Timestamp>,
    pub requested_mode: ReadMode,
    pub basis: Vec<SourceBasis>,
    pub projection_generation: Option<Generation>,
    pub actual_dependencies: Vec<ReadDependency>,
    pub coverage: QueryCoverage,
    pub freshness: Vec<SourceFreshness>,
    pub dirty: Vec<WatchId>,
    pub truncation: Option<Truncation>,
    pub consistency: ConsistencyBasis,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryCoverage {
    pub scope_digest: Digest,
    pub complete: bool,
    pub missing_sources: Vec<SourceId>,
    pub missing_fields: Vec<DefinitionId>,
    pub gap_sources: Vec<SourceId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFreshness {
    pub source_id: SourceId,
    pub lag: Option<DurationMs>,
    pub last_reconciled_at: Option<Timestamp>,
    pub satisfied: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConsistencyBasis {
    PerSource,
    SingleSourceSnapshot,
    RecordedReplay,
    BranchAssumptions,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Truncation {
    pub reason: TruncationReason,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub delivered: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub limit: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TruncationReason {
    Rows,
    Objects,
    Bytes,
    Tokens,
    Deadline,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryFailure {
    Expression {
        failure: crate::expression::ExpressionFailure,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    InvalidQuery {
        field: crate::failure::FieldPath,
    },
    Source {
        source_id: SourceId,
        failure: SourceFailure,
    },
    GuaranteeUnsatisfied {
        mode: ReadMode,
        source_id: Option<SourceId>,
    },
    ProjectionLag {
        source_id: SourceId,
        actual: DurationMs,
        maximum: DurationMs,
    },
    Gap {
        source_id: SourceId,
    },
    Dirty {
        watches: Vec<WatchId>,
    },
    HistoryUnavailable {
        source_id: SourceId,
    },
    BudgetExceeded {
        limit: TruncationReason,
    },
    CursorInvalid,
    BasisChanged,
    Cancelled,
    InternalFault,
}
