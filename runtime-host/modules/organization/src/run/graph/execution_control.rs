use std::{collections::{BTreeMap, BTreeSet}, num::NonZeroU64};

use super::{EdgeAction, EdgeId, ExecutionFence, GraphState, NodeId};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ReworkCounterKey {
    pub batch_id: NonZeroU64,
    pub source_node_id: NodeId,
    pub source_port: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockedRework {
    pub batch_id: NonZeroU64,
    pub source_node_id: NodeId,
    pub source_port: String,
    pub source_fence: ExecutionFence,
    pub scope: Vec<NodeId>,
    pub edge_ids: Vec<EdgeId>,
    pub used: u32,
    pub max_reworks: u32,
    pub blocked_at: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ExecutionControlSnapshot {
    pub next_batch_id: NonZeroU64,
    pub rework_counts: BTreeMap<ReworkCounterKey, u32>,
    pub blocked_reworks: BTreeMap<NodeId, BlockedRework>,
}

pub(super) fn validate(state: &GraphState) -> Result<(), ()> {
    for history in state.executions().values() {
        if history.attempts().iter().any(|attempt| attempt.batch_id() >= state.next_batch_id()) {
            return Err(());
        }
    }
    for (key, used) in state.rework_counts() {
        let node = state.definition().node(&key.source_node_id).ok_or(())?;
        if *used == 0 || key.batch_id >= state.next_batch_id()
            || node.rework_limit(&key.source_port).is_none()
        {
            return Err(());
        }
    }
    for (source_id, blocked) in state.blocked_reworks() {
        let source = state.current_attempt(source_id).ok_or(())?;
        let key = ReworkCounterKey {
            batch_id: blocked.batch_id,
            source_node_id: source_id.clone(),
            source_port: blocked.source_port.clone(),
        };
        if source_id != &blocked.source_node_id || source.fence() != &blocked.source_fence
            || source.batch_id() != blocked.batch_id || !source.status().is_terminal()
            || source.output_port() != Some(blocked.source_port.as_str())
            || source.updated_at() > blocked.blocked_at || blocked.used < blocked.max_reworks
            || state.rework_counts().get(&key).copied().unwrap_or(0) != blocked.used
            || blocked.scope.is_empty() || blocked.edge_ids.is_empty()
            || blocked.scope.windows(2).any(|pair| pair[0] >= pair[1])
            || blocked.edge_ids.iter().collect::<BTreeSet<_>>().len() != blocked.edge_ids.len()
        {
            return Err(());
        }
        if blocked.scope.iter().any(|node| state.current_attempt(node).is_none_or(|attempt| attempt.batch_id() != blocked.batch_id)) {
            return Err(());
        }
        let edges = state.definition().outgoing_edges(source_id)
            .filter(|edge| edge.source_port() == blocked.source_port)
            .map(|edge| edge.id()).collect::<Vec<_>>();
        let rework_edges = state.definition().outgoing_edges(source_id).filter(|edge| {
            edge.source_port() == blocked.source_port && edge.action() == EdgeAction::Rework
        }).collect::<Vec<_>>();
        if rework_edges.is_empty() || rework_edges.iter().any(|edge| !blocked.scope.contains(edge.target_node_id())) {
            return Err(());
        }
        if edges != blocked.edge_ids.iter().collect::<Vec<_>>() { return Err(()); }
    }
    Ok(())
}
