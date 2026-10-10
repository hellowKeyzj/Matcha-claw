mod definition;
mod durable;
mod patch;
mod projection;
mod reducer;
mod restore;
mod rework;
mod state;
mod workflow;
mod yaml;

pub use definition::{
    DefinitionError, DependencyMetadata, EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy,
    ExecutorPolicy, GraphDefinition, GraphRunId, NodeDefinition, NodeId,
    NodeKind, NodeOutputPort, ReviewAssignment, StartTrigger, WorkAssignment, };
pub use durable::{
    DurableAttemptReason, DurableDependencyMetadata, DurableEdgeDefinition, DurableExecutionFence,
    DurableGraphLayout, DurableInputReceipt, DurableNodeAttempt, DurableNodeDefinition,
    DurableNodeExecution, DurableNodePosition, DurableReadyQueueItem, DurableRestoreError,
    DurableReviewAssignment, DurableStartTrigger, DurableWorkAssignment, GraphDurableSnapshot,
};
pub use patch::{GraphPatch, GraphPatchError, GraphPatchOperation, apply as apply_graph_patch};
pub(crate) use patch::apply_in_place as apply_graph_patch_in_place;
pub use projection::{
    AttemptProjection, EdgeProjection, EdgeStatus, GraphProjection, GraphStatus, InputProjection,
    NodeProjection, project,
};
pub use reducer::{GraphEvent, ReduceError, reduce, settle_superseded_attempt};
pub use restore::{RestoreError, restore_oracle};
pub(crate) use state::{GraphChanges, NodeAttemptDurableInput};
pub use state::{
    AttemptId, AttemptReason, AttemptStatus, ExecutionFence, GraphLayout, GraphState, InputReceipt,
    NodeAttempt, NodeExecutionHistory, NodeExecutionId, NodePosition, ReadyQueueItem,
};
pub use workflow::{
    WorkflowPlan, WorkflowPlanCompilation,
    WorkflowPlanCompileError, WorkflowTask, compile_workflow_plan, workflow_dependency_edge_id,
    workflow_task_node_id,
};
pub use yaml::{GraphYamlError, export as export_yaml, import as import_yaml, import_for_run};

#[cfg(test)]
mod tests;
