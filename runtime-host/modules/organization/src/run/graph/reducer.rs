use std::{
    collections::{BTreeMap, BTreeSet},
    num::{NonZeroU32, NonZeroU64},
};

use super::{
    definition::{EdgeAction, EdgeDefinition, GraphDefinition, NodeDefinition, NodeId, NodeKind},
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
    ContinueRework {
        source_node_id: NodeId,
        source_port: String,
        batch_id: NonZeroU64,
        source_fence: ExecutionFence,
        max_reworks: u32,
        continued_at: u64,
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
    InvalidDefinition(super::DefinitionError),
    InvalidSettlementEvent,
    InvalidOutputPort { node_id: NodeId },
    StaleFence {
        node_id: NodeId,
    },
    InvalidTransition {
        node_id: NodeId,
        status: AttemptStatus,
    },
    AttemptNumberOverflow { node_id: NodeId },
    BatchNumberOverflow,
    BatchMismatch { node_id: NodeId },
    TriggerScopeBusy { node_id: NodeId },
    InvalidReworkPort { node_id: NodeId, source_port: String },
    ReworkNotBlocked { node_id: NodeId },
    InvalidReworkContinuation { node_id: NodeId },
    ReworkLimitNotIncreased { node_id: NodeId },
}

pub fn reduce(mut state: GraphState, event: GraphEvent) -> Result<GraphState, ReduceError> {
    reduce_in_place(&mut state, event)?;
    Ok(state)
}

pub(super) fn reduce_in_place(mut state: &mut GraphState, event: GraphEvent) -> Result<(), ReduceError> {
    match event {
        GraphEvent::AttemptStarted {
            node_id,
            fence,
            started_at,
        } => {
            let blocked = state.is_rework_blocked(&node_id);
            let attempt = require_current_fence_mut(&mut state, &node_id, &fence)?;
            if attempt.status() != AttemptStatus::Ready {
                return Err(ReduceError::InvalidTransition {
                    node_id,
                    status: attempt.status(),
                });
            }
            if blocked {
                return Err(ReduceError::InvalidReworkContinuation { node_id });
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
        } => super::rework::request(&mut state, &node_id, requested_at)?,
        GraphEvent::ContinueRework { source_node_id, source_port, batch_id, source_fence, max_reworks, continued_at } => {
            super::rework::continue_blocked(state, &source_node_id, &source_port, batch_id, &source_fence, max_reworks, continued_at)?;
        }
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
    Ok(())
}

/// Records a trusted native terminal fact without advancing the current graph.
/// Ordinary graph events must continue to use `reduce` and its current-fence check.
pub fn settle_superseded_attempt(
    mut state: GraphState,
    event: GraphEvent,
) -> Result<GraphState, ReduceError> {
    settle_superseded_in_place(&mut state, event)?;
    Ok(state)
}

pub(super) fn settle_superseded_in_place(state: &mut GraphState, event: GraphEvent) -> Result<(), ReduceError> {
    let (node_id, fence, status, output_port, now) = match event {
        GraphEvent::NodeCompleted {
            node_id,
            fence,
            output_port,
            completed_at,
        } => (
            node_id,
            fence,
            AttemptStatus::Completed,
            Some(output_port),
            completed_at,
        ),
        GraphEvent::NodeFailed {
            node_id,
            fence,
            output_port,
            failed_at,
        } => (
            node_id,
            fence,
            AttemptStatus::Failed,
            Some(output_port),
            failed_at,
        ),
        GraphEvent::NodeCancelled {
            node_id,
            fence,
            cancelled_at,
        } => (node_id, fence, AttemptStatus::Cancelled, None, cancelled_at),
        _ => return Err(ReduceError::InvalidSettlementEvent),
    };
    if state.current_attempt(&node_id).is_none() {
        return Err(ReduceError::UnknownNode(node_id));
    }
    let attempt = state
        .superseded_attempt_mut(&node_id, &fence)
        .ok_or_else(|| ReduceError::StaleFence {
            node_id: node_id.clone(),
        })?;
    if !attempt.status().accepts_outcome() || now < attempt.updated_at() {
        return Err(ReduceError::InvalidTransition {
            node_id,
            status: attempt.status(),
        });
    }
    if let Some(output_port) = output_port {
        attempt.resolve(status, output_port, now);
    } else {
        attempt.transition_to(status, now);
    }
    Ok(())
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
    let graph_id = state.definition().graph_id().to_owned();
    let plan_id = state.definition().workflow_plan_id().to_owned();
    let run_id = state.definition().run_id().clone();
    let title = state.definition().title().to_owned();
    let mut nodes = state.definition().nodes().to_vec();
    let mut edges = state.definition().edges().to_vec();
    let mut metadata = state.metadata().clone();
    let mut layout = state.layout().clone();
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
            GraphPatchOperation::SetReworkLimit { source_node_id, source_port, max_reworks } => {
                let node = nodes.iter_mut().find(|node| node.id() == source_node_id)
                    .ok_or_else(|| ReduceError::UnknownNode(source_node_id.clone()))?;
                if !node.kind().accepts_edge_action(source_port, EdgeAction::Rework) {
                    return Err(ReduceError::InvalidReworkPort { node_id: source_node_id.clone(), source_port: source_port.clone() });
                }
                node.set_rework_limit(source_port.clone(), *max_reworks);
            }
            GraphPatchOperation::RemoveNode(node_id) => {
                let Some(index) = nodes.iter().position(|node| node.id() == node_id) else {
                    return Err(ReduceError::InvalidGraphPatch);
                };
                nodes.remove(index);
                edges.retain(|edge| {
                    edge.source_node_id() != node_id && edge.target_node_id() != node_id
                });
                if layout.node_positions().contains_key(node_id) { state.remember_position(node_id); }
                layout.remove_node(node_id);
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
            GraphPatchOperation::SetNodePosition { node_id, position } => {
                if !nodes.iter().any(|node| node.id() == node_id) {
                    return Err(ReduceError::InvalidGraphPatch);
                }
                if layout.node_positions().get(node_id) != Some(position) { state.remember_position(node_id); }
                layout.set_node_position(node_id.clone(), *position);
            }
            GraphPatchOperation::SetMetadata { key, value } => {
                if metadata.get(key) != Some(value) { state.remember_metadata(key); }
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    let definition = GraphDefinition::new(
        graph_id,
        plan_id,
        run_id,
        title,
        nodes,
        edges,
    )
    .map_err(ReduceError::InvalidDefinition)?;
    let initial_batches = super::patch::initial_batches(state, &definition, operations)?;
    for (node_id, batch_id) in &initial_batches {
        if state.current_attempt(node_id).is_some_and(|attempt| attempt.batch_id() != *batch_id) {
            state.current_attempt_mut(node_id).expect("assignable initial attempt").assign_batch(*batch_id);
        }
    }
    let root_ids = definition.execution_root_ids();
    let namespace = state.replacement_namespace().map(str::to_owned);
    let mut executions = BTreeMap::new();
    for node in definition.nodes() {
        let initial_status = if root_ids.contains(node.id()) && !node.is_armed_start() {
            AttemptStatus::Ready
        } else {
            AttemptStatus::Pending
        };
        if node.kind() == NodeKind::Start
            && state
                .definition()
                .node(node.id())
                .is_some_and(|previous| previous.trigger() != node.trigger())
            && state.executions().get(node.id()).is_some_and(|history| {
                history.attempts().len() == 1
                    && matches!(history.current().reason(), AttemptReason::Initial)
                    && matches!(history.current().status(), AttemptStatus::Pending | AttemptStatus::Ready)
                    && history.current().status() != initial_status
            })
        {
            state.current_attempt_mut(node.id()).expect("existing start attempt")
                .transition_to(initial_status, patched_at);
        }
        let history = state.take_history(node.id()).unwrap_or_else(|| {
            state.remember_new_history(node.id());
            NodeExecutionHistory::initial(NodeAttempt::create(
                node.id().clone(), node.kind(), NonZeroU32::MIN,
                initial_batches[node.id()],
                if node.kind() == NodeKind::Start { initial_status } else { AttemptStatus::Pending },
                AttemptReason::Initial, Vec::new(), patched_at,
            )
            .in_namespace(namespace.as_deref()))
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
    state.finish_patch(definition, metadata, layout, executions, ready_queue);
    super::execution_control::validate(state).map_err(|_| ReduceError::InvalidGraphPatch)?;
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
        if terminal_status == AttemptStatus::Completed
            && !source_node.kind().accepts_completed_output(&output_port)
        {
            return Err(ReduceError::InvalidOutputPort { node_id });
        }
        attempt.resolve(terminal_status, output_port.clone(), now);
    }
    state.remove_ready_item(&node_id);
    if state.is_rework_blocked(&node_id) {
        return Ok(());
    }

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
    match super::rework::reopen(state, &source_attempt, &edges, now)? {
        super::rework::ReworkRouting::Blocked => Ok(()),
        super::rework::ReworkRouting::Continue => route_edges(state, &source_attempt, &edges, now),
    }
}

pub(super) fn route_edges(
    state: &mut GraphState,
    source: &NodeAttempt,
    edges: &[EdgeDefinition],
    now: u64,
) -> Result<(), ReduceError> {
    for edge in edges {
        let receipt = receipt_for(edge, source, now);
        match edge.action() {
            EdgeAction::Activate | EdgeAction::Finish => {
                activate_node(state, edge.target_node_id(), source, receipt, now)?
            }
            EdgeAction::Gate => activate_gate_if_satisfied(state, edge.target_node_id(), source, receipt, now)?,
            EdgeAction::Rework => {}
        }
    }
    Ok(())
}

fn fire_trigger(state: &mut GraphState, node_id: &NodeId, now: u64) -> Result<(), ReduceError> {
    let scope = state.trigger_scope(node_id)?;
    if let Some(busy) = state.trigger_busy_nodes(node_id)?.into_iter().next() {
        return Err(ReduceError::TriggerScopeBusy { node_id: busy });
    }
    let attempts = scope.iter().map(|id| {
        let node = state.definition().node(id).expect("trigger scope node exists");
        let current = state.current_attempt(id).expect("trigger scope has history");
        Ok((id.clone(), node.kind(), next_attempt_number(node, current.number())?))
    }).collect::<Result<Vec<_>, ReduceError>>()?;
    let batch_id = state.allocate_batch()?;
    for (id, kind, number) in attempts {
        let attempt = NodeAttempt::create(
            id.clone(), kind, number, batch_id,
            if &id == node_id { AttemptStatus::Ready } else { AttemptStatus::Pending },
            AttemptReason::Trigger, Vec::new(), now,
        ).in_namespace(state.replacement_namespace());
        state.remove_ready_item(&id);
        state.append_attempt(&id, attempt.clone());
        if &id == node_id { state.enqueue(&attempt, now); }
    }
    Ok(())
}

fn activate_node(
    state: &mut GraphState,
    node_id: &NodeId,
    source: &NodeAttempt,
    receipt: InputReceipt,
    now: u64,
) -> Result<(), ReduceError> {
    let current = state
        .current_attempt(node_id)
        .expect("edge endpoint has an execution history")
        .clone();
    if current.status() != AttemptStatus::Pending || current.batch_id() != source.batch_id() {
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
    outcome_source: &NodeAttempt,
    receipt: InputReceipt,
    now: u64,
) -> Result<(), ReduceError> {
    let batch_id = outcome_source.batch_id();
    let current = state
        .current_attempt(node_id)
        .expect("edge endpoint has an execution history")
        .clone();
    if current.status() != AttemptStatus::Pending || current.batch_id() != batch_id
        || outcome_source.status() != AttemptStatus::Completed
    {
        return Ok(());
    }
    let gate_edges = state
        .definition()
        .incoming_edges(node_id)
        .filter(|edge| edge.action() == EdgeAction::Gate)
        .cloned()
        .collect::<Vec<_>>();
    let mut inputs = current.inputs().iter().cloned()
        .map(|input| (input.edge_id().clone(), input)).collect::<BTreeMap<_, _>>();
    inputs.entry(receipt.edge_id().clone()).or_insert(receipt);
    let receipts = gate_edges.iter().map(|edge| {
        if let Some(input) = inputs.get(edge.id()) { return Some(input.clone()); }
        if state.is_rework_blocked(edge.source_node_id()) { return None; }
        let source = state.current_attempt(edge.source_node_id())?;
        (source.status() == AttemptStatus::Completed
            && source.batch_id() == batch_id
            && source.output_port() == Some(edge.source_port()))
            .then(|| receipt_for(edge, source, now))
    }).collect::<Option<Vec<_>>>();
    let attempt = state
        .current_attempt_mut(node_id)
        .expect("edge endpoint has an execution history");
    let Some(receipts) = receipts else {
        let inputs = gate_edges.iter().filter_map(|edge| inputs.remove(edge.id())).collect();
        attempt.record_gate_inputs(inputs, now);
        return Ok(());
    };
    attempt.activate(
        AttemptReason::Edge(gate_edges[0].id().clone()),
        receipts,
        now,
    );
    let queued = attempt.clone();
    state.enqueue(&queued, now);
    Ok(())
}

pub(super) fn receipt_for(edge: &EdgeDefinition, source: &NodeAttempt, now: u64) -> InputReceipt {
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

pub(super) fn next_attempt_number(
    node: &NodeDefinition,
    current: NonZeroU32,
) -> Result<NonZeroU32, ReduceError> {
    current.checked_add(1).ok_or_else(|| ReduceError::AttemptNumberOverflow {
        node_id: node.id().clone(),
    })
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
