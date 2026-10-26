use super::*;

impl Wire for query::QueryNode {
    type Output = w::QueryTree;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::QueryArena::from_query(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::QueryArena::lift(value)?.into_query()?)
    }
}
record!(component::QueryArena, QueryTree; nodes, root);
variant!(component::QueryTreeNode, QueryTreeNode;
    units []; tuples [];
    records [
        Objects { type_ref, symbol } => QueryTreeObjects,
        Relations { type_ref, symbol } => QueryTreeRelations,
        Filter { input, predicate } => QueryTreeFilter,
        Join { left, right, on, join_kind } => QueryTreeJoin,
        Traverse { input, relation_type, from_role, to_role, target } => QueryTreeTraverse,
        Project { input, columns } => QueryTreeProject,
        Aggregate { input, group_by, aggregates } => QueryTreeAggregate,
        Sort { input, order } => QueryTreeSort,
        Distinct { input } => QueryTreeDistinct,
        Union { inputs } => QueryTreeUnion,
        NotExists { input, correlated, predicate } => QueryTreeNotExists,
        Limit { input, count } => QueryTreeLimit
    ]
);
unit_enum!(query::JoinKind, JoinKind; Inner, Left);
record!(query::QueryAggregate, QueryAggregate; name, operator, expression);
record!(query::QueryOrder, QueryOrder; expression, descending, nulls);
unit_enum!(query::NullOrder, NullOrder; First, Last);

record!(world_protocol::query::QueryColumn, QueryColumn; name, expression);
record!(world_protocol::query::QueryIr, QueryIr; root, parameters, output, limit);
record!(world_protocol::query::QueryArgument, QueryArgument; parameter_id, value);
variant!(world_protocol::query::ReadMode, ReadMode; units [Authoritative]; tuples []; records [Projected { max_lag } => ReadModeProjected, After { receipt_id } => ReadModeAfter]);
record!(world_protocol::query::PageRequest, PageRequest; limit, cursor);
record!(world_protocol::query::QueryRequest, QueryRequest; world, branch_id, release_id, query, arguments, read_mode, valid_at, known_at, page);
record!(world_protocol::query::QueryCoverage, QueryCoverage; scope_digest, complete, missing_sources, missing_fields, gap_sources);
record!(world_protocol::query::SourceFreshness, SourceFreshness; source_id, lag, last_reconciled_at, satisfied);
unit_enum!(world_protocol::query::TruncationReason, TruncationReason; Rows, Objects, Bytes, Tokens, Deadline);
record!(world_protocol::query::Truncation, Truncation; reason, delivered, limit);
unit_enum!(world_protocol::query::ConsistencyBasis, ConsistencyBasis; PerSource, SingleSourceSnapshot, RecordedReplay, BranchAssumptions);
record!(world_protocol::query::ReadReceipt, ReadReceipt; world, id, branch_id, release_id, activation_lock_id, query_digest, evaluated_scope_digest, decision_id, policy_epoch, grant_epoch, observed_at, expires_at, requested_mode, basis, projection_generation, actual_dependencies, coverage, freshness, dirty, truncation, consistency);
record!(world_protocol::query::NamedCell, NamedCell; name, cell);
record!(world_protocol::query::QueryRow, QueryRow; columns);
record!(world_protocol::query::Page<world_protocol::query::QueryRow>, PageQueryRow; items, next_cursor);
record!(world_protocol::query::ObjectView, ObjectView; object, fields, receipt_id);
record!(world_protocol::query::RelationView, RelationView; relation, claim, roles, fields, receipt_id);
record!(world_protocol::query::QueryPage, QueryPage; rows, objects, relations, receipt);
impl Wire for world_protocol::query::QueryFailure {
    type Output = w::QueryFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_query_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_query_failure()?)
    }
}
variant!(component::QueryFailureNode, QueryFailureNode; units [CursorInvalid, BasisChanged, Cancelled, InternalFault]; tuples []; records [Expression { failure } => QueryFailureNodeExpression, Authorization { failure } => QueryFailureNodeAuthorization, Compile { failure } => QueryFailureNodeCompile, InvalidQuery { field } => QueryFailureNodeInvalidQuery, Source { source_id, failure } => QueryFailureNodeSource, GuaranteeUnsatisfied { mode, source_id } => QueryFailureNodeGuaranteeUnsatisfied, ProjectionLag { source_id, actual, maximum } => QueryFailureNodeProjectionLag, Gap { source_id } => QueryFailureNodeGap, Dirty { watches } => QueryFailureNodeDirty, HistoryUnavailable { source_id } => QueryFailureNodeHistoryUnavailable, BudgetExceeded { limit } => QueryFailureNodeBudgetExceeded]);
