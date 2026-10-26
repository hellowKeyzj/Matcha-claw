use super::*;

impl Wire for world_protocol::operation::OperationFailure {
    type Output = w::OperationFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_operation_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_operation_failure()?)
    }
}

variant!(component::OperationFailureNode, OperationFailureNode; units [DetailsWithheld, NotConfigured, NotFound, RevisionConflict, Cancelled, CleanupFailed, InternalFault]; tuples [Input, Authorization, Upload, Material, Source, Mapping, Query, Slot, Identity, Fact, Definition, Release, Compile, Learning, Generation, Evaluation, EvaluationSummary, Action, Package, Binding, State, Lifecycle, Process, Commit]; records [BudgetExceeded { dimension } => OperationFailureNodeBudgetExceeded]);

record!(world_protocol::operation::OperationKey, OperationKey; world, operation_id);
record!(world_protocol::operation::OperationAccepted, OperationAccepted; world, operation_id, revision, incarnation);
