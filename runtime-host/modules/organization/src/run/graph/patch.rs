use std::{collections::{BTreeMap, BTreeSet}, num::NonZeroU64};

use crate::run::event::{MetadataValue, OpaqueId};

use super::{
    EdgeDefinition, EdgeId, GraphEvent, GraphState, NodeDefinition, NodeId, NodePosition,
    ReduceError,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphPatchOperation {
    AddNode(NodeDefinition),
    ReplaceNode(NodeDefinition),
    SetReworkLimit {
        source_node_id: NodeId,
        source_port: String,
        max_reworks: u32,
    },
    RemoveNode(NodeId),
    AddEdge(EdgeDefinition),
    ReplaceEdge(EdgeDefinition),
    RemoveEdge(EdgeId),
    SetNodePosition {
        node_id: NodeId,
        position: NodePosition,
    },
    SetMetadata {
        key: OpaqueId,
        value: MetadataValue,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphPatch {
    expected_graph_id: String,
    expected_workflow_plan_id: String,
    operations: Vec<GraphPatchOperation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphPatchError {
    EmptyPatch,
    UnknownRun,
    StaleRevision,
    InvalidDefinition,
    Definition(super::DefinitionError),
    NodeAlreadyExists(NodeId),
    UnknownNode(NodeId),
    NodeKindChanged(NodeId),
    EdgeAlreadyExists(EdgeId),
    UnknownEdge(EdgeId),
    ConsumedEdge(EdgeId),
}

impl GraphPatch {
    pub fn new(
        expected_graph_id: impl Into<String>,
        expected_workflow_plan_id: impl Into<String>,
        operations: Vec<GraphPatchOperation>,
    ) -> Result<Self, GraphPatchError> {
        let expected_graph_id = expected_graph_id.into();
        let expected_workflow_plan_id = expected_workflow_plan_id.into();
        if expected_graph_id.trim().is_empty() || expected_workflow_plan_id.trim().is_empty() {
            return Err(GraphPatchError::InvalidDefinition);
        }
        if operations.is_empty() {
            return Err(GraphPatchError::EmptyPatch);
        }
        Ok(Self {
            expected_graph_id,
            expected_workflow_plan_id,
            operations,
        })
    }

    pub fn expected_graph_id(&self) -> &str {
        &self.expected_graph_id
    }

    pub fn expected_workflow_plan_id(&self) -> &str {
        &self.expected_workflow_plan_id
    }

    pub fn operations(&self) -> &[GraphPatchOperation] {
        &self.operations
    }
}

pub fn apply(
    state: &GraphState,
    patch: &GraphPatch,
    applied_at: u64,
) -> Result<GraphState, GraphPatchError> {
    let mut patched = state.clone();
    apply_in_place(&mut patched, patch, applied_at)?;
    Ok(patched)
}

pub(crate) fn apply_in_place(
    state: &mut GraphState,
    patch: &GraphPatch,
    applied_at: u64,
) -> Result<(), GraphPatchError> {
    let standalone = state.changes().is_none();
    state.begin_mutation();
    let result = apply_checked(state, patch, applied_at);
    if standalone {
        if result.is_ok() { state.commit_mutation(); } else { state.rollback_mutation(); }
    }
    result
}

fn apply_checked(state: &mut GraphState, patch: &GraphPatch, applied_at: u64) -> Result<(), GraphPatchError> {
    let definition = state.definition().clone();
    if definition.graph_id() != patch.expected_graph_id
        || definition.workflow_plan_id() != patch.expected_workflow_plan_id
    {
        return Err(GraphPatchError::StaleRevision);
    }
    validate_operations(state, &patch.operations)?;
    for operation in &patch.operations {
        match operation {
            GraphPatchOperation::ReplaceEdge(edge) if state.blocked_reworks().values()
                .any(|blocked| blocked.edge_ids.contains(edge.id()))
                && definition.edges().iter().find(|previous| previous.id() == edge.id()) != Some(edge) =>
            {
                return Err(GraphPatchError::ConsumedEdge(edge.id().clone()));
            }
            GraphPatchOperation::RemoveEdge(edge_id) if state.blocked_reworks().values()
                .any(|blocked| blocked.edge_ids.contains(edge_id)) =>
            {
                return Err(GraphPatchError::ConsumedEdge(edge_id.clone()));
            }
            GraphPatchOperation::RemoveNode(node_id) if state.blocked_reworks().values()
                .any(|blocked| &blocked.source_node_id == node_id || blocked.scope.contains(node_id)) =>
            {
                return Err(GraphPatchError::InvalidDefinition);
            }
            _ => {}
        }
    }

    state.apply_event(
        GraphEvent::GraphPatched {
            expected_graph_id: patch.expected_graph_id.clone(),
            expected_workflow_plan_id: patch.expected_workflow_plan_id.clone(),
            operations: patch.operations.clone(),
            patched_at: applied_at,
        },
    )
    .map_err(map_reduce_error)?;

    if patch.operations().iter().any(|operation| matches!(operation,
        GraphPatchOperation::ReplaceEdge(_) | GraphPatchOperation::RemoveEdge(_)
            | GraphPatchOperation::RemoveNode(_)
    )) {
        let edges = state.definition().edges().iter()
            .map(|edge| (edge.id(), edge)).collect::<BTreeMap<_, _>>();
        for (node_id, history) in state.executions() {
            for input in history.attempts().iter().flat_map(|attempt| attempt.inputs()) {
                if edges.get(input.edge_id()).is_none_or(|edge| {
                    edge.source_node_id() != input.source_node_id()
                        || edge.target_node_id() != node_id
                        || edge.source_port() != input.source_port()
                        || edge.target_port() != input.target_port()
                        || edge.action() != input.action()
                }) {
                    return Err(GraphPatchError::ConsumedEdge(input.edge_id().clone()));
                }
            }
        }
    }
    state.definition().validate_references(Some(&definition))
        .map_err(GraphPatchError::Definition)?;
    Ok(())
}

fn validate_operations(
    state: &GraphState,
    operations: &[GraphPatchOperation],
) -> Result<(), GraphPatchError> {
    if operations.is_empty() {
        return Err(GraphPatchError::EmptyPatch);
    }

    let mut node_kinds = state
        .definition()
        .nodes()
        .iter()
        .map(|node| (node.id().clone(), node.kind()))
        .collect::<BTreeMap<_, _>>();
    let durable_node_kinds = node_kinds.clone();
    let mut edge_endpoints = state
        .definition()
        .edges()
        .iter()
        .map(|edge| {
            (
                edge.id().clone(),
                (edge.source_node_id().clone(), edge.target_node_id().clone()),
            )
        })
        .collect::<BTreeMap<_, _>>();

    for operation in operations {
        match operation {
            GraphPatchOperation::AddNode(node) => {
                if node_kinds.contains_key(node.id()) {
                    return Err(GraphPatchError::NodeAlreadyExists(node.id().clone()));
                }
                validate_node_payload(node)?;
                if let Some(previous_kind) = durable_node_kinds.get(node.id()) {
                    if *previous_kind != node.kind() {
                        return Err(GraphPatchError::NodeKindChanged(node.id().clone()));
                    }
                }
                node_kinds.insert(node.id().clone(), node.kind());
            }
            GraphPatchOperation::ReplaceNode(node) => {
                let Some(previous_kind) = node_kinds.get(node.id()).copied() else {
                    return Err(GraphPatchError::UnknownNode(node.id().clone()));
                };
                validate_node_payload(node)?;
                if durable_node_kinds
                    .get(node.id())
                    .is_some_and(|durable_kind| *durable_kind != node.kind())
                {
                    return Err(GraphPatchError::NodeKindChanged(node.id().clone()));
                }
                if previous_kind != node.kind() && durable_node_kinds.contains_key(node.id()) {
                    return Err(GraphPatchError::NodeKindChanged(node.id().clone()));
                }
                node_kinds.insert(node.id().clone(), node.kind());
            }
            GraphPatchOperation::SetReworkLimit { source_node_id, source_port, .. } => {
                let kind = node_kinds.get(source_node_id)
                    .ok_or_else(|| GraphPatchError::UnknownNode(source_node_id.clone()))?;
                if !kind.accepts_edge_action(source_port, super::EdgeAction::Rework) {
                    return Err(GraphPatchError::Definition(super::DefinitionError::InvalidReworkPort {
                        node_id: source_node_id.clone(), source_port: source_port.clone(),
                    }));
                }
            }
            GraphPatchOperation::RemoveNode(node_id) => {
                if node_kinds.remove(node_id).is_none() {
                    return Err(GraphPatchError::UnknownNode(node_id.clone()));
                }
                let incident_edges = edge_endpoints
                    .iter()
                    .filter(|(_, (source, target))| source == node_id || target == node_id)
                    .map(|(edge_id, _)| edge_id.clone())
                    .collect::<Vec<_>>();
                for edge_id in incident_edges {
                    edge_endpoints.remove(&edge_id);
                }
            }
            GraphPatchOperation::AddEdge(edge) => {
                if edge_endpoints.contains_key(edge.id()) {
                    return Err(GraphPatchError::EdgeAlreadyExists(edge.id().clone()));
                }
                validate_edge_payload(edge, node_kinds.keys())?;
                edge_endpoints.insert(
                    edge.id().clone(),
                    (edge.source_node_id().clone(), edge.target_node_id().clone()),
                );
            }
            GraphPatchOperation::ReplaceEdge(edge) => {
                if !edge_endpoints.contains_key(edge.id()) {
                    return Err(GraphPatchError::UnknownEdge(edge.id().clone()));
                }
                validate_edge_payload(edge, node_kinds.keys())?;
                edge_endpoints.insert(
                    edge.id().clone(),
                    (edge.source_node_id().clone(), edge.target_node_id().clone()),
                );
            }
            GraphPatchOperation::RemoveEdge(edge_id) => {
                if edge_endpoints.remove(edge_id).is_none() {
                    return Err(GraphPatchError::UnknownEdge(edge_id.clone()));
                }
            }
            GraphPatchOperation::SetNodePosition { node_id, .. } => {
                if !node_kinds.contains_key(node_id) {
                    return Err(GraphPatchError::UnknownNode(node_id.clone()));
                }
            }
            GraphPatchOperation::SetMetadata { key, .. } => {
                if key.as_str().trim().is_empty() {
                    return Err(GraphPatchError::InvalidDefinition);
                }
            }
        }
    }
    Ok(())
}

fn validate_node_payload(node: &NodeDefinition) -> Result<(), GraphPatchError> {
    if node.id().as_str().trim().is_empty() || node.title().trim().is_empty() {
        return Err(GraphPatchError::InvalidDefinition);
    }
    node.validate_assignment().map_err(GraphPatchError::Definition)
}

fn validate_edge_payload<'a>(
    edge: &EdgeDefinition,
    node_ids: impl Iterator<Item = &'a NodeId>,
) -> Result<(), GraphPatchError> {
    if edge.id().as_str().trim().is_empty()
        || edge.source_port().trim().is_empty()
        || edge.target_port().trim().is_empty()
    {
        return Err(GraphPatchError::InvalidDefinition);
    }
    let node_ids = node_ids.collect::<BTreeSet<_>>();
    if !node_ids.contains(edge.source_node_id()) {
        return Err(GraphPatchError::Definition(
            super::DefinitionError::UnknownEdgeSource {
                edge_id: edge.id().clone(),
                node_id: edge.source_node_id().clone(),
            },
        ));
    }
    if !node_ids.contains(edge.target_node_id()) {
        return Err(GraphPatchError::Definition(
            super::DefinitionError::UnknownEdgeTarget {
                edge_id: edge.id().clone(),
                node_id: edge.target_node_id().clone(),
            },
        ));
    }
    Ok(())
}

fn same_execution_edge(left: &EdgeDefinition, right: &EdgeDefinition) -> bool {
    left.source_node_id() == right.source_node_id()
        && left.target_node_id() == right.target_node_id()
        && left.source_port() == right.source_port()
        && left.target_port() == right.target_port()
        && left.action() == right.action()
}

pub(super) fn initial_batches(
    state: &GraphState,
    definition: &super::GraphDefinition,
    operations: &[GraphPatchOperation],
) -> Result<BTreeMap<NodeId, NonZeroU64>, ReduceError> {
    if !operations.iter().any(|operation| matches!(operation,
        GraphPatchOperation::AddNode(_) | GraphPatchOperation::AddEdge(_) | GraphPatchOperation::ReplaceEdge(_)
    )) {
        return Ok(BTreeMap::new());
    }
    let new_nodes = definition.nodes().iter().filter(|node| !state.executions().contains_key(node.id()))
        .map(|node| node.id().clone()).collect::<BTreeSet<_>>();
    let assignable = definition.nodes().iter().filter(|node| {
        new_nodes.contains(node.id()) || state.executions().get(node.id()).is_some_and(|history| {
            let attempt = history.current();
            history.attempts().len() == 1 && matches!(attempt.reason(), super::AttemptReason::Initial)
                && attempt.status() == super::AttemptStatus::Pending && attempt.inputs().is_empty()
                && !state.is_rework_blocked(node.id())
        })
    }).map(|node| node.id().clone()).collect::<BTreeSet<_>>();
    let previous_edges = state.definition().edges().iter().map(|edge| (edge.id(), edge))
        .collect::<BTreeMap<_, _>>();
    let changed_edges = definition.edges().iter().filter(|edge| {
        previous_edges.get(edge.id()).is_none_or(|previous| !same_execution_edge(previous, edge))
    }).collect::<Vec<_>>();
    if new_nodes.is_empty() && changed_edges.is_empty() { return Ok(BTreeMap::new()); }

    let mut seeds = new_nodes;
    let mut neighbors = BTreeMap::<NodeId, Vec<NodeId>>::new();
    let mut sources = BTreeMap::<NodeId, BTreeSet<NonZeroU64>>::new();
    for edge in definition.edges() {
        let source = edge.source_node_id();
        let target = edge.target_node_id();
        if assignable.contains(source) && assignable.contains(target) {
            neighbors.entry(source.clone()).or_default().push(target.clone());
            neighbors.entry(target.clone()).or_default().push(source.clone());
        } else if assignable.contains(target) {
            sources.entry(target.clone()).or_default()
                .insert(state.current_attempt(source).expect("existing boundary source").batch_id());
        }
    }
    for edge in &changed_edges {
        seeds.extend([edge.source_node_id(), edge.target_node_id()].into_iter()
            .filter(|node| assignable.contains(*node)).cloned());
    }
    let mut batches = BTreeMap::new();
    for seed in seeds {
        if batches.contains_key(&seed) { continue; }
        let mut scope = BTreeSet::from([seed.clone()]);
        let mut pending = vec![seed.clone()];
        let mut inherited = BTreeSet::new();
        let mut previous = BTreeSet::new();
        while let Some(node) = pending.pop() {
            if let Some(source_batches) = sources.get(&node) { inherited.extend(source_batches); }
            if let Some(attempt) = state.current_attempt(&node) { previous.insert(attempt.batch_id()); }
            if let Some(adjacent) = neighbors.get(&node) {
                for neighbor in adjacent {
                    if scope.insert(neighbor.clone()) { pending.push(neighbor.clone()); }
                }
            }
        }
        if inherited.is_empty() { inherited = previous; }
        if inherited.len() > 1 { return Err(ReduceError::BatchMismatch { node_id: seed }); }
        let batch_id = inherited.into_iter().next().unwrap_or(NonZeroU64::MIN);
        batches.extend(scope.into_iter().map(|node| (node, batch_id)));
    }
    for edge in changed_edges {
        let batch = |node| batches.get(node).copied()
            .or_else(|| state.current_attempt(node).map(super::NodeAttempt::batch_id))
            .expect("edge endpoint has a batch");
        if batch(edge.source_node_id()) != batch(edge.target_node_id()) {
            return Err(ReduceError::BatchMismatch { node_id: edge.target_node_id().clone() });
        }
    }
    Ok(batches)
}

fn map_reduce_error(error: ReduceError) -> GraphPatchError {
    match error {
        ReduceError::StaleGraphIdentity => GraphPatchError::StaleRevision,
        ReduceError::InvalidDefinition(source) => GraphPatchError::Definition(source),
        ReduceError::InvalidGraphPatch
        | ReduceError::InvalidSettlementEvent
        | ReduceError::InvalidOutputPort { .. }
        | ReduceError::UnknownNode(_)
        | ReduceError::TriggerNotArmed(_)
        | ReduceError::StaleFence { .. }
        | ReduceError::InvalidTransition { .. }
        | ReduceError::AttemptNumberOverflow { .. }
        | ReduceError::BatchNumberOverflow
        | ReduceError::BatchMismatch { .. }
        | ReduceError::TriggerScopeBusy { .. }
        | ReduceError::InvalidReworkPort { .. }
        | ReduceError::ReworkNotBlocked { .. }
        | ReduceError::InvalidReworkContinuation { .. }
        | ReduceError::ReworkLimitNotIncreased { .. } => GraphPatchError::InvalidDefinition,
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::*;
    use crate::{EdgeAction, GraphDefinition, GraphRunId, NodeKind, WorkAssignment};

    fn state() -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:one",
                "plan:one",
                GraphRunId::new("run:one"),
                "private graph title",
                vec![NodeDefinition::work(
                    NodeId::new("work"),
                    "private node title",
                    NonZeroU32::new(1).unwrap(),
                    WorkAssignment::new("task:work", "leader"),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    #[test]
    fn patch_rebuilds_a_valid_graph_only_at_its_expected_revision() {
        let patched = apply(
            &state(),
            &GraphPatch::new(
                "graph:one",
                "plan:one",
                vec![GraphPatchOperation::AddNode(NodeDefinition::control(
                    NodeId::new("end"),
                    NodeKind::End,
                    "private end title",
                    NonZeroU32::new(1).unwrap(),
                ))],
            )
            .unwrap(),
            2,
        )
        .unwrap();

        assert!(patched.definition().node(&NodeId::new("end")).is_some());
        assert_eq!(
            apply(
                &state(),
                &GraphPatch::new(
                    "graph:stale",
                    "plan:one",
                    vec![GraphPatchOperation::RemoveEdge(EdgeId::new("edge"))]
                )
                .unwrap(),
                2,
            ),
            Err(GraphPatchError::StaleRevision)
        );
    }

    #[test]
    fn patch_removes_edges_with_a_removed_node() {
        let state = GraphState::initialize(
            GraphDefinition::new(
                "graph:one",
                "plan:one",
                GraphRunId::new("run:one"),
                "graph",
                vec![
                    NodeDefinition::control(
                        NodeId::new("start"),
                        NodeKind::Start,
                        "start",
                        NonZeroU32::new(1).unwrap(),
                    ),
                    NodeDefinition::control(
                        NodeId::new("end"),
                        NodeKind::End,
                        "end",
                        NonZeroU32::new(1).unwrap(),
                    ),
                ],
                vec![EdgeDefinition::new(
                    EdgeId::new("edge"),
                    NodeId::new("start"),
                    "completed",
                    NodeId::new("end"),
                    "input",
                    EdgeAction::Activate,
                )],
            )
            .unwrap(),
            1,
        );

        let patched = apply(
            &state,
            &GraphPatch::new(
                "graph:one",
                "plan:one",
                vec![GraphPatchOperation::RemoveNode(NodeId::new("end"))],
            )
            .unwrap(),
            2,
        )
        .unwrap();
        assert!(patched.definition().edges().is_empty());
    }
}
