use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::{
    definition::{EdgeAction, EdgeDefinition, NodeId},
    reducer::{ReduceError, next_attempt_number, receipt_for},
    state::{AttemptReason, AttemptStatus, GraphState, NodeAttempt},
};

pub(super) fn request(
    state: &mut GraphState,
    node_id: &NodeId,
    now: u64,
) -> Result<(), ReduceError> {
    let node = state
        .definition()
        .node(node_id)
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    let current = state
        .current_attempt(node_id)
        .expect("definition nodes always have an execution history");
    let attempt = NodeAttempt::create(
        node_id.clone(),
        node.kind(),
        next_attempt_number(node, current.number())?,
        AttemptStatus::Ready,
        AttemptReason::Rework,
        Vec::new(),
        now,
    );
    state.remove_ready_item(node_id);
    state.append_attempt(node_id, attempt.clone());
    state.enqueue(&attempt, now);
    Ok(())
}

pub(super) fn reopen(
    state: &mut GraphState,
    source: &NodeAttempt,
    edges: &[EdgeDefinition],
    now: u64,
) -> Result<(), ReduceError> {
    let mut targets = BTreeMap::<_, Vec<_>>::new();
    for edge in edges
        .iter()
        .filter(|edge| edge.action() == EdgeAction::Rework)
    {
        targets
            .entry(edge.target_node_id().clone())
            .or_default()
            .push(receipt_for(edge, source, now));
    }
    if targets.is_empty() {
        return Ok(());
    }

    let mut scope = activation_paths(state, source.node_id(), targets.keys().cloned().collect());
    invalidate_consumers(state, &mut scope);
    // Preflight every attempt before changing any fence, input or queue item.
    let attempts = scope
        .iter()
        .map(|node_id| {
            let node = state.definition().node(node_id).expect("scope node exists");
            let current = state
                .current_attempt(node_id)
                .expect("scope attempt exists");
            let number = next_attempt_number(node, current.number())?;
            let inputs = targets.remove(node_id);
            Ok(NodeAttempt::create(
                node_id.clone(),
                node.kind(),
                number,
                if inputs.is_some() {
                    AttemptStatus::Ready
                } else {
                    AttemptStatus::Pending
                },
                AttemptReason::Rework,
                inputs.unwrap_or_default(),
                now,
            ))
        })
        .collect::<Result<Vec<_>, ReduceError>>()?;
    for attempt in attempts {
        state.remove_ready_item(attempt.node_id());
        state.append_attempt(attempt.node_id(), attempt.clone());
        if attempt.status() == AttemptStatus::Ready {
            state.enqueue(&attempt, now);
        }
    }
    Ok(())
}

fn activation_paths(
    state: &GraphState,
    source: &NodeId,
    targets: BTreeSet<NodeId>,
) -> BTreeSet<NodeId> {
    let mut ancestors = BTreeSet::from([source.clone()]);
    let mut pending = VecDeque::from([source.clone()]);
    while let Some(node_id) = pending.pop_front() {
        for edge in state
            .definition()
            .incoming_edges(&node_id)
            .filter(|edge| edge.action().activates_target())
        {
            if ancestors.insert(edge.source_node_id().clone()) {
                pending.push_back(edge.source_node_id().clone());
            }
        }
    }
    let mut pending = targets
        .iter()
        .filter(|id| ancestors.contains(*id))
        .cloned()
        .collect::<VecDeque<_>>();
    let mut scope = targets;
    while let Some(node_id) = pending.pop_front() {
        for edge in state
            .definition()
            .outgoing_edges(&node_id)
            .filter(|edge| edge.action().activates_target())
        {
            let target = edge.target_node_id();
            if ancestors.contains(target) && scope.insert(target.clone()) {
                pending.push_back(target.clone());
            }
        }
    }
    scope
}

fn invalidate_consumers(state: &GraphState, scope: &mut BTreeSet<NodeId>) {
    let mut consumers = BTreeMap::<_, Vec<_>>::new();
    for history in state.executions().values() {
        let attempt = history.current();
        for input in attempt.inputs() {
            if state
                .current_attempt(input.source_node_id())
                .is_some_and(|source| source.fence() == input.source_fence())
            {
                consumers
                    .entry(input.source_node_id())
                    .or_default()
                    .push(attempt.node_id());
            }
        }
    }
    let mut pending = scope.iter().cloned().collect::<VecDeque<_>>();
    while let Some(node_id) = pending.pop_front() {
        if let Some(dependents) = consumers.get(&node_id) {
            for dependent in dependents {
                if scope.insert((*dependent).clone()) {
                    pending.push_back((*dependent).clone());
                }
            }
        }
    }
}
