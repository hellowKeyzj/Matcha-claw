use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::{
    definition::{EdgeAction, EdgeDefinition, NodeId},
    execution_control::{BlockedRework, ReworkCounterKey},
    reducer::{ReduceError, next_attempt_number, receipt_for},
    state::{AttemptReason, AttemptStatus, GraphState, NodeAttempt},
};

pub(super) enum ReworkRouting {
    Continue,
    Blocked,
}

pub(super) fn request(state: &mut GraphState, node_id: &NodeId, now: u64) -> Result<(), ReduceError> {
    let node = state.definition().node(node_id)
        .ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
    let current = state.current_attempt(node_id).expect("definition node has history");
    let attempt = NodeAttempt::create(
        node_id.clone(), node.kind(), next_attempt_number(node, current.number())?,
        current.batch_id(), AttemptStatus::Ready, AttemptReason::Rework, Vec::new(), now,
    ).in_namespace(state.replacement_namespace());
    if state.is_rework_blocked(node_id) {
        return Err(ReduceError::InvalidReworkContinuation { node_id: node_id.clone() });
    }
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
) -> Result<ReworkRouting, ReduceError> {
    let mut targets = BTreeMap::<_, Vec<_>>::new();
    for edge in edges.iter().filter(|edge| edge.action() == EdgeAction::Rework) {
        targets.entry(edge.target_node_id().clone()).or_default()
            .push(receipt_for(edge, source, now));
    }
    if targets.is_empty() { return Ok(ReworkRouting::Continue); }
    let source_port = source.output_port().expect("resolved source has output");
    let node = state.definition().node(source.node_id()).expect("source node exists");
    let max_reworks = node.rework_limit(source_port).ok_or_else(|| ReduceError::InvalidReworkPort {
        node_id: source.node_id().clone(), source_port: source_port.to_owned(),
    })?;
    let key = ReworkCounterKey {
        batch_id: source.batch_id(), source_node_id: source.node_id().clone(),
        source_port: source_port.to_owned(),
    };
    let used = state.rework_counts().get(&key).copied().unwrap_or(0);
    let mut scope = activation_paths(state, source.node_id(), targets.keys().cloned().collect());
    invalidate_consumers(state, &mut scope);
    if scope.iter().any(|id| state.current_attempt(id).is_none_or(|attempt| attempt.batch_id() != source.batch_id())) {
        return Err(ReduceError::BatchMismatch { node_id: source.node_id().clone() });
    }
    ensure_unblocked_scope(state, &scope, None)?;
    if used >= max_reworks {
        state.block_rework(BlockedRework {
            batch_id: source.batch_id(), source_node_id: source.node_id().clone(),
            source_port: source_port.to_owned(), source_fence: source.fence().clone(),
            scope: scope.into_iter().collect(), edge_ids: edges.iter().map(|edge| edge.id().clone()).collect(),
            used, max_reworks, blocked_at: now,
        });
        return Ok(ReworkRouting::Blocked);
    }
    apply_rework_scope(state, source, targets, scope, key, used, now)?;
    Ok(ReworkRouting::Continue)
}

fn apply_rework_scope(
    state: &mut GraphState,
    source: &NodeAttempt,
    mut targets: BTreeMap<NodeId, Vec<super::InputReceipt>>,
    scope: BTreeSet<NodeId>,
    key: ReworkCounterKey,
    used: u32,
    now: u64,
) -> Result<(), ReduceError> {
    let attempts = scope.iter().map(|node_id| {
        let node = state.definition().node(node_id).ok_or_else(|| ReduceError::UnknownNode(node_id.clone()))?;
        let current = state.current_attempt(node_id).expect("scope attempt exists");
        if current.batch_id() != source.batch_id() {
            return Err(ReduceError::BatchMismatch { node_id: node_id.clone() });
        }
        let number = next_attempt_number(node, current.number())?;
        let inputs = targets.remove(node_id);
        Ok(NodeAttempt::create(
            node_id.clone(), node.kind(), number, source.batch_id(),
            if inputs.is_some() { AttemptStatus::Ready } else { AttemptStatus::Pending },
            AttemptReason::Rework, inputs.unwrap_or_default(), now,
        ).in_namespace(state.replacement_namespace()))
    }).collect::<Result<Vec<_>, ReduceError>>()?;
    state.record_rework(key, used + 1);
    for attempt in attempts {
        state.remove_ready_item(attempt.node_id());
        state.append_attempt(attempt.node_id(), attempt.clone());
        if attempt.status() == AttemptStatus::Ready { state.enqueue(&attempt, now); }
    }
    Ok(())
}

fn ensure_unblocked_scope(
    state: &GraphState,
    scope: &BTreeSet<NodeId>,
    continuing: Option<&NodeId>,
) -> Result<(), ReduceError> {
    if let Some(blocked) = state.blocked_reworks().values().find(|blocked| {
        Some(&blocked.source_node_id) != continuing
            && (scope.contains(&blocked.source_node_id) || blocked.scope.iter().any(|id| scope.contains(id)))
    }) {
        return Err(ReduceError::InvalidReworkContinuation { node_id: blocked.source_node_id.clone() });
    }
    Ok(())
}

pub(super) fn continue_blocked(
    state: &mut GraphState,
    source_node_id: &NodeId,
    source_port: &str,
    batch_id: std::num::NonZeroU64,
    source_fence: &super::ExecutionFence,
    max_reworks: u32,
    now: u64,
) -> Result<(), ReduceError> {
    let blocked = state.blocked_reworks().get(source_node_id).cloned()
        .ok_or_else(|| ReduceError::ReworkNotBlocked { node_id: source_node_id.clone() })?;
    let source = state.current_attempt(source_node_id)
        .ok_or_else(|| ReduceError::UnknownNode(source_node_id.clone()))?.clone();
    if blocked.source_port != source_port || blocked.batch_id != batch_id
        || &blocked.source_fence != source_fence || source.fence() != source_fence
        || source.batch_id() != batch_id || !source.status().is_terminal()
        || source.output_port() != Some(source_port)
    {
        return Err(ReduceError::InvalidReworkContinuation { node_id: source_node_id.clone() });
    }
    let node = state.definition().node(source_node_id).expect("blocked source exists");
    if node.rework_limit(source_port) != Some(max_reworks)
        || max_reworks <= blocked.max_reworks || max_reworks <= blocked.used
    {
        return Err(ReduceError::ReworkLimitNotIncreased { node_id: source_node_id.clone() });
    }
    let edges = state.definition().outgoing_edges(source_node_id)
        .filter(|edge| edge.source_port() == source_port).cloned().collect::<Vec<_>>();
    if edges.iter().map(|edge| edge.id()).collect::<Vec<_>>() != blocked.edge_ids.iter().collect::<Vec<_>>() {
        return Err(ReduceError::InvalidReworkContinuation { node_id: source_node_id.clone() });
    }
    let scope = blocked.scope.iter().cloned().collect::<BTreeSet<_>>();
    ensure_unblocked_scope(state, &scope, Some(source_node_id))?;
    let key = ReworkCounterKey {
        batch_id, source_node_id: source_node_id.clone(), source_port: source_port.to_owned(),
    };
    if state.rework_counts().get(&key).copied().unwrap_or(0) != blocked.used {
        return Err(ReduceError::InvalidReworkContinuation { node_id: source_node_id.clone() });
    }
    let mut targets = BTreeMap::<_, Vec<_>>::new();
    for edge in edges.iter().filter(|edge| edge.action() == EdgeAction::Rework) {
        if !scope.contains(edge.target_node_id()) {
            return Err(ReduceError::InvalidReworkContinuation { node_id: source_node_id.clone() });
        }
        targets.entry(edge.target_node_id().clone()).or_default().push(receipt_for(edge, &source, now));
    }
    apply_rework_scope(state, &source, targets, scope, key, blocked.used, now)?;
    state.remove_blocked_rework(source_node_id);
    super::reducer::route_edges(state, &source, &edges, now)
}

fn activation_paths(state: &GraphState, source: &NodeId, targets: BTreeSet<NodeId>) -> BTreeSet<NodeId> {
    let mut ancestors = BTreeSet::from([source.clone()]);
    let mut pending = VecDeque::from([source.clone()]);
    while let Some(node_id) = pending.pop_front() {
        for edge in state.definition().incoming_edges(&node_id).filter(|edge| edge.action().activates_target()) {
            if ancestors.insert(edge.source_node_id().clone()) { pending.push_back(edge.source_node_id().clone()); }
        }
    }
    let mut pending = targets.iter().filter(|id| ancestors.contains(*id)).cloned().collect::<VecDeque<_>>();
    let mut scope = targets;
    while let Some(node_id) = pending.pop_front() {
        for edge in state.definition().outgoing_edges(&node_id).filter(|edge| edge.action().activates_target()) {
            let target = edge.target_node_id();
            if ancestors.contains(target) && scope.insert(target.clone()) { pending.push_back(target.clone()); }
        }
    }
    scope
}

fn invalidate_consumers(state: &GraphState, scope: &mut BTreeSet<NodeId>) {
    let mut consumers = BTreeMap::<_, Vec<_>>::new();
    for history in state.executions().values() {
        let attempt = history.current();
        for input in attempt.inputs() {
            if state.current_attempt(input.source_node_id()).is_some_and(|source| source.fence() == input.source_fence()) {
                consumers.entry(input.source_node_id()).or_default().push(attempt.node_id());
            }
        }
    }
    let mut pending = scope.iter().cloned().collect::<VecDeque<_>>();
    while let Some(node_id) = pending.pop_front() {
        if let Some(dependents) = consumers.get(&node_id) {
            for dependent in dependents {
                if scope.insert((*dependent).clone()) { pending.push_back((*dependent).clone()); }
            }
        }
    }
}
