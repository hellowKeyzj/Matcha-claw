use std::collections::{BTreeMap, BTreeSet};

use crate::run::event::{MetadataValue, OpaqueId};

use super::{
    EdgeDefinition, EdgeId, GraphEvent, GraphState, NodeDefinition, NodeId, NodeKind, NodePosition,
    ReduceError,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphPatchOperation {
    AddNode(NodeDefinition),
    ReplaceNode(NodeDefinition),
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
    NodeAlreadyExists(NodeId),
    UnknownNode(NodeId),
    NodeKindChanged(NodeId),
    EdgeAlreadyExists(EdgeId),
    UnknownEdge(EdgeId),
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
    let definition = state.definition();
    if definition.graph_id() != patch.expected_graph_id
        || definition.workflow_plan_id() != patch.expected_workflow_plan_id
    {
        return Err(GraphPatchError::StaleRevision);
    }
    validate_operations(state, &patch.operations)?;

    let patched = super::reduce(
        state.clone(),
        GraphEvent::GraphPatched {
            expected_graph_id: patch.expected_graph_id.clone(),
            expected_workflow_plan_id: patch.expected_workflow_plan_id.clone(),
            operations: patch.operations.clone(),
            patched_at: applied_at,
        },
    )
    .map_err(map_reduce_error)?;

    validate_metadata_and_layout_projection(state, patch, &patched)?;
    Ok(patched)
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
                if state.executions().get(node.id()).is_some_and(|history| {
                    history
                        .attempts()
                        .iter()
                        .any(|attempt| attempt.number() > node.max_attempts())
                }) {
                    return Err(GraphPatchError::InvalidDefinition);
                }
                node_kinds.insert(node.id().clone(), node.kind());
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
    match node.kind() {
        NodeKind::Work => {
            let Some(work) = node.work_assignment() else {
                return Err(GraphPatchError::InvalidDefinition);
            };
            if node.review_assignment().is_some()
                || work.task_id().trim().is_empty()
                || work.role_id().trim().is_empty()
            {
                return Err(GraphPatchError::InvalidDefinition);
            }
        }
        NodeKind::Review => {
            if node.work_assignment().is_some()
                || node.review_assignment().is_some_and(|review| {
                    review.role_id().trim().is_empty() || review.prompt().trim().is_empty()
                })
            {
                return Err(GraphPatchError::InvalidDefinition);
            }
        }
        _ if node.work_assignment().is_some() || node.review_assignment().is_some() => {
            return Err(GraphPatchError::InvalidDefinition);
        }
        _ => {}
    }
    if node.kind() != NodeKind::Start && node.trigger().is_some() {
        return Err(GraphPatchError::InvalidDefinition);
    }
    Ok(())
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
    if !node_ids.contains(edge.source_node_id()) || !node_ids.contains(edge.target_node_id()) {
        return Err(GraphPatchError::InvalidDefinition);
    }
    Ok(())
}

fn validate_metadata_and_layout_projection(
    state: &GraphState,
    patch: &GraphPatch,
    patched: &GraphState,
) -> Result<(), GraphPatchError> {
    let mut expected_metadata = state.metadata().clone();
    let mut expected_layout = state.layout().clone();
    for operation in &patch.operations {
        match operation {
            GraphPatchOperation::RemoveNode(node_id) => {
                expected_layout.remove_node(node_id);
            }
            GraphPatchOperation::SetNodePosition { node_id, position } => {
                expected_layout.set_node_position(node_id.clone(), *position);
            }
            GraphPatchOperation::SetMetadata { key, value } => {
                expected_metadata.insert(key.clone(), value.clone());
            }
            GraphPatchOperation::AddNode(_)
            | GraphPatchOperation::ReplaceNode(_)
            | GraphPatchOperation::AddEdge(_)
            | GraphPatchOperation::ReplaceEdge(_)
            | GraphPatchOperation::RemoveEdge(_) => {}
        }
    }
    if patched.metadata() != &expected_metadata || patched.layout() != &expected_layout {
        return Err(GraphPatchError::InvalidDefinition);
    }
    Ok(())
}

fn map_reduce_error(error: ReduceError) -> GraphPatchError {
    match error {
        ReduceError::StaleGraphIdentity => GraphPatchError::StaleRevision,
        ReduceError::InvalidGraphPatch
        | ReduceError::InvalidSettlementEvent
        | ReduceError::UnknownNode(_)
        | ReduceError::TriggerNotArmed(_)
        | ReduceError::StaleFence { .. }
        | ReduceError::InvalidTransition { .. }
        | ReduceError::AttemptLimitExceeded { .. } => GraphPatchError::InvalidDefinition,
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
