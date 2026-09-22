use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroU32,
};

use super::{
    definition::{EdgeAction, EdgeDefinition, GraphDefinition, NodeDefinition, NodeId},
    patch::GraphPatchOperation,
    state::{
        AttemptReason, AttemptStatus, ExecutionFence, GraphState, InputReceipt, NodeAttempt,
        NodeExecutionHistory, ReadyQueueItem,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphEvent {
    AttemptStarted {
        node_id: NodeId,
        fence: ExecutionFence,
        started_at: u64,
    },
    NodeWaiting {
        node_id: NodeId,
        fence: ExecutionFence,
        waiting_at: u64,
    },
    NodeCompleted {
        node_id: NodeId,
        fence: ExecutionFence,
        output_port: String,
        completed_at: u64,
    },
    NodeFailed {
        node_id: NodeId,
        fence: ExecutionFence,
        output_port: String,
        failed_at: u64,
    },
    NodeCancelled {
        node_id: NodeId,
        fence: ExecutionFence,
        cancelled_at: u64,
    },
    ReworkRequested {
        node_id: NodeId,
        requested_at: u64,
    },
    TriggerFired {
        node_id: NodeId,
        fired_at: u64,
    },
    GraphPatched {
        expected_graph_id: String,
        expected_workflow_plan_id: String,
        operations: Vec<GraphPatchOperation>,
        patched_at: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReduceError {
    UnknownNode(NodeId),
    TriggerNotArmed(NodeId),
    StaleGraphIdentity,
    InvalidGraphPatch,
    StaleFence {
        node_id: NodeId,
    },
    InvalidTransition {
        node_id: NodeId,
        status: AttemptStatus,
    },
    AttemptLimitExceeded {
        node_id: NodeId,
        max_attempts: NonZeroU32,
    },
}

pub fn reduce(mut state: GraphState, event: GraphEvent) -> Result<GraphState, ReduceError> {
    match event {
        GraphEvent::AttemptStarted {
            node_id,
            fence,
            started_at,
        } => {
            let attempt = require_current_fence_mut(&mut state, &node_id, &fence)?;
            if attempt.status() != AttemptStatus::Ready {
                return Err(ReduceError::InvalidTransition {
                    node_id,
                    status: attempt.status(),
                });
            }
            attempt.transition_to(AttemptStatus::Running, started_at);
            state.remove_ready_item(&node_id);
        }
        GraphEvent::NodeWaiting {
            node_id,
            fence,
            waiting_at,
        } => {
            let attempt = require_current_fence_mut(&mut state, &node_id, &fence)?;
            if !attempt.status().accepts_outcome() {
                return Err(ReduceError::InvalidTransition {
                    node_id,
                    status: attempt.status(),
                });
            }
            attempt.transition_to(AttemptStatus::Waiting, waiting_at);
            state.remove_ready_item(&node_id);
        }
        GraphEvent::NodeCompleted {
            node_id,
            fence,
            output_port,
            completed_at,
        } => resolve_outcome(
            &mut state,
            node_id,
            fence,
            output_port,
            AttemptStatus::Completed,
            completed_at,
        )?,
        GraphEvent::NodeFailed {
            node_id,
            fence,
            output_port,
            failed_at,
        } => resolve_outcome(
            &mut state,
            node_id,
            fence,
            output_port,
            AttemptStatus::Failed,
            failed_at,
        )?,
        GraphEvent::NodeCancelled {
            node_id,
            fence,
            cancelled_at,
        } => cancel_node(&mut state, node_id, fence, cancelled_at)?,
        GraphEvent::ReworkRequested {
            node_id,
            requested_at,
        } => rework_node(&mut state, &node_id, Vec::new(), requested_at)?,
        GraphEvent::TriggerFired { node_id, fired_at } => {
            fire_trigger(&mut state, &node_id, fired_at)?
        }
        GraphEvent::GraphPatched {
            expected_graph_id,
            expected_workflow_plan_id,
            operations,
            patched_at,
        } => apply_graph_patch(
            &mut state,
            &expected_graph_id,
            &expected_workflow_plan_id,
            &operations,
            patched_at,
        )?,
    }
    Ok(state)
}

fn apply_graph_patch(
    state: &mut GraphState,
    expected_graph_id: &str,
    expected_workflow_plan_id: &str,
    operations: &[GraphPatchOperation],
    patched_at: u64,
) -> Result<(), ReduceError> {
    if state.definition().graph_id() != expected_graph_id
        || state.definition().workflow_plan_id() != expected_workflow_plan_id
    {
        return Err(ReduceError::StaleGraphIdentity);
    }
    if operations.is_empty() {
        return Err(ReduceError::InvalidGraphPatch);
    }
    let definition = state.definition();
    let mut nodes = definition.nodes().to_vec();
    let mut edges = definition.edges().to_vec();
    let mut metadata = state.metadata().clone();
    for operation in operations {
        match operation {
            GraphPatchOperation::AddNode(node) => {
                if nodes.iter().any(|existing| existing.id() == node.id()) {
                    return Err(ReduceError::InvalidGraphPatch);
                }
                nodes.push(node.clone());
            }
            GraphPatchOperation::ReplaceNode(node) => {
                let Some(index) = nodes.iter().position(|existing| existing.id() == node.id())
                else {
                    return Err(ReduceError::InvalidGraphPatch);
                };
                nodes[index] = node.clone();
            }
            GraphPatchOperation::RemoveNode(node_id) => {
                let Some(index) = nodes.iter().position(|node| node.id() == node_id) else {
                    return Err(ReduceError::InvalidGraphPatch);
                };
                nodes.remove(index);
                edges.retain(|edge| {
                    edge.source_node_id() != node_id && edge.target_node_id() != node_id
                });
            }
            GraphPatchOperation::AddEdge(edge) => {
                if edges.iter().any(|existing| existing.id() == edge.id()) {
                    return Err(ReduceError::InvalidGraphPatch);
                }
                edges.push(edge.clone());
            }
            GraphPatchOperation::ReplaceEdge(edge) => {
                let Some(index) = edges.iter().position(|existing| existing.id() == edge.id())
                else {
                    return Err(ReduceError::InvalidGraphPatch);
                };
                edges[index] = edge.clone();
            }
            GraphPatchOperation::RemoveEdge(edge_id) => {
                let Some(index) = edges.iter().position(|edge| edge.id() == edge_id) else {
                    return Err(ReduceError::InvalidGraphPatch);
                };
                edges.remove(index);
            }
            GraphPatchOperation::SetMetadata { key, value } => {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    let definition = GraphDefinition::new(
        definition.graph_id(),
        definition.workflow_plan_id(),
        definition.run_id().clone(),
        definition.title(),
        nodes,
        edges,
    )
    .map_err(|_| ReduceError::InvalidGraphPatch)?;
    let mut executions = BTreeMap::new();
    for node in definition.nodes() {
        let history = state
            .executions()
            .get(node.id())
            .cloned()
            .unwrap_or_else(|| {
                let status = if definition.execution_root_ids().contains(node.id())
                    && !node.is_armed_start()
                {
                    AttemptStatus::Ready
                } else {
                    AttemptStatus::Pending
                };
                NodeExecutionHistory::initial(NodeAttempt::create(
                    node.id().clone(),
                    node.kind(),
                    NonZeroU32::MIN,
                    status,
                    AttemptReason::Initial,
                    Vec::new(),
                    patched_at,
                ))
            });
        executions.insert(node.id().clone(), history);
    }

    let mut ready_queue_by_node = BTreeMap::new();
    for item in state.ready_queue() {
        let Some(history) = executions.get(item.node_id()) else {
            continue;
        };
        let current = history.current();
        if current.status() == AttemptStatus::Ready && current.fence() == item.fence() {
            ready_queue_by_node
                .entry(item.node_id().clone())
                .or_insert_with(|| item.clone());
        }
    }
    for node in definition.nodes() {
        let current = executions
            .get(node.id())
            .expect("definition nodes always have an execution history")
            .current();
        if current.status() == AttemptStatus::Ready {
            ready_queue_by_node
                .entry(node.id().clone())
                .or_insert_with(|| ReadyQueueItem::for_attempt(current, patched_at));
        }
    }
    let mut ready_queue = ready_queue_by_node.into_values().collect::<Vec<_>>();
    ready_queue.sort_by(|left, right| {
        left.enqueued_at()
            .cmp(&right.enqueued_at())
            .then_with(|| left.node_id().cmp(right.node_id()))
    });
    *state = GraphState::from_durable(definition, metadata, executions, ready_queue);
    Ok(())
}

fn cancel_node(
    state: &mut GraphState,
    node_id: NodeId,
    fence: ExecutionFence,
    now: u64,
) -> Result<(), ReduceError> {
    let attempt = require_current_fence_mut(state, &node_id, &fence)?;
    if !attempt.status().accepts_outcome() {
        return Err(ReduceError::InvalidTransition {
            node_id,
            status: attempt.status(),
        });
    }
    attempt.transition_to(AttemptStatus::Cancelled, now);
    state.remove_ready_item(&node_id);
    Ok(())
}

fn resolve_outcome(
    state: &mut GraphState,
    node_id: NodeId,
    fence: ExecutionFence,
    output_port: String,
    terminal_status: AttemptStatus,
    now: u64,
) -> Result<(), ReduceError> {
    let source_node = state
        .definition()
        .node(&node_id)
        .cloned()
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    {
        let attempt = require_current_fence_mut(state, &node_id, &fence)?;
        if !attempt.status().accepts_outcome() {
            return Err(ReduceError::InvalidTransition {
                node_id,
                status: attempt.status(),
            });
        }
        attempt.resolve(terminal_status, output_port.clone(), now);
    }
    state.remove_ready_item(&node_id);

    let source_attempt = state
        .current_attempt(&source_node.id().clone())
        .expect("source node remains present")
        .clone();
    let edges = state
        .definition()
        .outgoing_edges(source_node.id())
        .filter(|edge| edge.source_port() == output_port)
        .cloned()
        .collect::<Vec<_>>();
    for edge in edges {
        let receipt = receipt_for(&edge, &source_attempt, now);
        match edge.action() {
            EdgeAction::Activate | EdgeAction::Finish => {
                activate_node(state, edge.target_node_id(), receipt, now)?
            }
            EdgeAction::Gate => activate_gate_if_satisfied(state, edge.target_node_id(), now)?,
            EdgeAction::Rework => rework_node(state, edge.target_node_id(), vec![receipt], now)?,
        }
    }
    Ok(())
}

fn fire_trigger(state: &mut GraphState, node_id: &NodeId, now: u64) -> Result<(), ReduceError> {
    let node = state
        .definition()
        .node(node_id)
        .cloned()
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    if !node.is_armed_start() {
        return Err(ReduceError::TriggerNotArmed(node_id.clone()));
    }
    let current = state
        .current_attempt(node_id)
        .expect("definition nodes always have an execution history")
        .clone();
    let reset_ids = if current.status() == AttemptStatus::Pending {
        vec![node_id.clone()]
    } else {
        let mut ids = state
            .definition()
            .reachable_from(node_id)
            .into_iter()
            .collect::<Vec<_>>();
        ids.push(node_id.clone());
        ids
    };
    state.remove_ready_items(&reset_ids);

    let start_number = if current.status() == AttemptStatus::Pending {
        current.number()
    } else {
        next_attempt_number(&node, current.number())?
    };
    let start_attempt = NodeAttempt::create(
        node_id.clone(),
        node.kind(),
        start_number,
        AttemptStatus::Ready,
        AttemptReason::Trigger,
        Vec::new(),
        now,
    );
    if current.status() == AttemptStatus::Pending {
        let current_mut = state
            .current_attempt_mut(node_id)
            .expect("definition nodes always have an execution history");
        *current_mut = start_attempt.clone();
    } else {
        state.append_attempt(node_id, start_attempt.clone());
    }
    state.enqueue(&start_attempt, now);

    for reset_id in reset_ids.into_iter().filter(|id| id != node_id) {
        let reset_node = state
            .definition()
            .node(&reset_id)
            .cloned()
            .expect("reachable graph node exists");
        let previous = state
            .current_attempt(&reset_id)
            .expect("definition nodes always have an execution history")
            .clone();
        if previous.status() == AttemptStatus::Pending {
            continue;
        }
        let pending = NodeAttempt::create(
            reset_id.clone(),
            reset_node.kind(),
            next_attempt_number(&reset_node, previous.number())?,
            AttemptStatus::Pending,
            AttemptReason::Trigger,
            Vec::new(),
            now,
        );
        state.append_attempt(&reset_id, pending);
    }
    Ok(())
}

fn rework_node(
    state: &mut GraphState,
    node_id: &NodeId,
    inputs: Vec<InputReceipt>,
    now: u64,
) -> Result<(), ReduceError> {
    let node = state
        .definition()
        .node(node_id)
        .cloned()
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    let current = state
        .current_attempt(node_id)
        .expect("definition nodes always have an execution history")
        .clone();
    let attempt = NodeAttempt::create(
        node_id.clone(),
        node.kind(),
        next_attempt_number(&node, current.number())?,
        AttemptStatus::Ready,
        AttemptReason::Rework,
        inputs,
        now,
    );
    state.remove_ready_item(node_id);
    state.append_attempt(node_id, attempt.clone());
    state.enqueue(&attempt, now);
    Ok(())
}

fn activate_node(
    state: &mut GraphState,
    node_id: &NodeId,
    receipt: InputReceipt,
    now: u64,
) -> Result<(), ReduceError> {
    let current = state
        .current_attempt(node_id)
        .expect("edge endpoint has an execution history")
        .clone();
    if current.status() != AttemptStatus::Pending {
        return Ok(());
    }
    let attempt = state
        .current_attempt_mut(node_id)
        .expect("edge endpoint has an execution history");
    attempt.activate(
        AttemptReason::Edge(receipt.edge_id().clone()),
        vec![receipt],
        now,
    );
    let queued = attempt.clone();
    state.enqueue(&queued, now);
    Ok(())
}

fn activate_gate_if_satisfied(
    state: &mut GraphState,
    node_id: &NodeId,
    now: u64,
) -> Result<(), ReduceError> {
    let current = state
        .current_attempt(node_id)
        .expect("edge endpoint has an execution history")
        .clone();
    if current.status() != AttemptStatus::Pending {
        return Ok(());
    }
    let gate_edges = state
        .definition()
        .incoming_edges(node_id)
        .filter(|edge| edge.action() == EdgeAction::Gate)
        .cloned()
        .collect::<Vec<_>>();
    if gate_edges.is_empty() {
        return Ok(());
    }
    let receipts = gate_edges
        .iter()
        .map(|edge| {
            let source = state.current_attempt(edge.source_node_id())?;
            (source.status().is_terminal() && source.output_port() == Some(edge.source_port()))
                .then(|| receipt_for(edge, source, now))
        })
        .collect::<Option<Vec<_>>>();
    let Some(receipts) = receipts else {
        return Ok(());
    };
    let attempt = state
        .current_attempt_mut(node_id)
        .expect("edge endpoint has an execution history");
    attempt.activate(
        AttemptReason::Edge(gate_edges[0].id().clone()),
        receipts,
        now,
    );
    let queued = attempt.clone();
    state.enqueue(&queued, now);
    Ok(())
}

fn receipt_for(edge: &EdgeDefinition, source: &NodeAttempt, now: u64) -> InputReceipt {
    InputReceipt::new(
        edge.id().clone(),
        edge.action(),
        edge.source_node_id().clone(),
        edge.source_port().to_owned(),
        edge.target_port().to_owned(),
        source.fence().clone(),
        now,
    )
}

fn require_current_fence_mut<'a>(
    state: &'a mut GraphState,
    node_id: &NodeId,
    fence: &ExecutionFence,
) -> Result<&'a mut NodeAttempt, ReduceError> {
    let attempt = state
        .current_attempt_mut(node_id)
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    if attempt.fence() != fence {
        return Err(ReduceError::StaleFence {
            node_id: node_id.clone(),
        });
    }
    Ok(attempt)
}

fn next_attempt_number(
    node: &NodeDefinition,
    current: NonZeroU32,
) -> Result<NonZeroU32, ReduceError> {
    let next = current
        .checked_add(1)
        .ok_or_else(|| ReduceError::AttemptLimitExceeded {
            node_id: node.id().clone(),
            max_attempts: node.max_attempts(),
        })?;
    if next > node.max_attempts() {
        return Err(ReduceError::AttemptLimitExceeded {
            node_id: node.id().clone(),
            max_attempts: node.max_attempts(),
        });
    }
    Ok(next)
}

pub(crate) fn state_has_only_current_ready_items(state: &GraphState) -> bool {
    let expected = state
        .executions()
        .values()
        .filter_map(|history| {
            let attempt = history.current();
            (attempt.status() == AttemptStatus::Ready)
                .then(|| (attempt.node_id().clone(), attempt.fence().clone()))
        })
        .collect::<BTreeSet<_>>();
    let actual = state
        .ready_queue()
        .iter()
        .map(|item| (item.node_id().clone(), item.fence().clone()))
        .collect::<BTreeSet<_>>();
    expected == actual && expected.len() == state.ready_queue().len()
}

#[cfg(test)]
mod tests {
    use super::super::definition::NodeKind;
    use super::*;

    #[test]
    fn rejects_attempt_number_overflow() {
        let node =
            NodeDefinition::control(NodeId::new("node"), NodeKind::End, "Node", NonZeroU32::MAX);

        assert_eq!(
            next_attempt_number(&node, NonZeroU32::MAX),
            Err(ReduceError::AttemptLimitExceeded {
                node_id: NodeId::new("node"),
                max_attempts: NonZeroU32::MAX,
            })
        );
    }
}
