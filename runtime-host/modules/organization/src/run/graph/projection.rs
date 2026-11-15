use std::collections::BTreeSet;

use super::{
    definition::{EdgeId, NodeId, NodeKind},
    state::{AttemptReason, AttemptStatus, ExecutionFence, GraphState},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeStatus {
    Waiting,
    Satisfied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptProjection {
    pub fence: ExecutionFence,
    pub number: u32,
    pub batch_id: u64,
    pub status: AttemptStatus,
    pub reason: AttemptReason,
    pub output_port: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeProjection {
    pub node_id: NodeId,
    pub current: AttemptProjection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeProjection {
    pub edge_id: EdgeId,
    pub status: EdgeStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputProjection {
    pub node_id: NodeId,
    pub satisfied_edge_ids: Vec<EdgeId>,
    pub waiting_edge_ids: Vec<EdgeId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReworkCounterProjection {
    pub batch_id: u64,
    pub source_node_id: String,
    pub source_port: String,
    pub used: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockedReworkProjection {
    pub batch_id: u64,
    pub source_node_id: String,
    pub source_port: String,
    pub source_node_execution_id: String,
    pub used: u32,
    pub max_reworks: u32,
    pub blocked_at: u64,
    pub scope_node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReworkProjection {
    pub counters: Vec<ReworkCounterProjection>,
    pub blocked: Vec<BlockedReworkProjection>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphProjection {
    pub graph_id: String,
    pub run_id: String,
    pub status: GraphStatus,
    pub ready_node_ids: Vec<NodeId>,
    pub nodes: Vec<NodeProjection>,
    pub edges: Vec<EdgeProjection>,
    pub inputs: Vec<InputProjection>,
    pub rework: ReworkProjection,
}

pub fn project(state: &GraphState) -> GraphProjection {
    let definition = state.definition();
    let nodes = definition
        .nodes()
        .iter()
        .map(|node| {
            let attempt = state
                .current_attempt(node.id())
                .expect("definition nodes always have an execution history");
            NodeProjection {
                node_id: node.id().clone(),
                current: AttemptProjection {
                    fence: attempt.fence().clone(),
                    number: attempt.number().get(),
                    batch_id: attempt.batch_id().get(),
                    status: attempt.status(),
                    reason: attempt.reason().clone(),
                    output_port: attempt.output_port().map(ToOwned::to_owned),
                    updated_at: attempt.updated_at(),
                },
            }
        })
        .collect();
    let edges = definition
        .edges()
        .iter()
        .map(|edge| EdgeProjection {
            edge_id: edge.id().clone(),
            status: if edge_satisfied(state, edge) {
                EdgeStatus::Satisfied
            } else {
                EdgeStatus::Waiting
            },
        })
        .collect();
    let inputs = definition
        .nodes()
        .iter()
        .filter_map(|node| {
            let inbound = definition
                .incoming_edges(node.id())
                .filter(|edge| edge.action().activates_target())
                .collect::<Vec<_>>();
            (!inbound.is_empty()).then(|| {
                let (satisfied, waiting): (Vec<_>, Vec<_>) = inbound
                    .into_iter()
                    .partition(|edge| edge_satisfied(state, edge));
                InputProjection {
                    node_id: node.id().clone(),
                    satisfied_edge_ids: satisfied
                        .into_iter()
                        .map(|edge| edge.id().clone())
                        .collect(),
                    waiting_edge_ids: waiting.into_iter().map(|edge| edge.id().clone()).collect(),
                }
            })
        })
        .collect();
    GraphProjection {
        graph_id: definition.graph_id().to_owned(),
        run_id: definition.run_id().as_str().to_owned(),
        status: graph_status(state),
        ready_node_ids: state
            .ready_queue()
            .iter()
            .map(|item| item.node_id().clone())
            .collect(),
        nodes,
        edges,
        inputs,
        rework: ReworkProjection {
            counters: state.rework_counts().iter().map(|(key, used)| ReworkCounterProjection {
                batch_id: key.batch_id.get(), source_node_id: key.source_node_id.as_str().to_owned(),
                source_port: key.source_port.clone(), used: *used,
            }).collect(),
            blocked: state.blocked_reworks().values().map(|blocked| BlockedReworkProjection {
                batch_id: blocked.batch_id.get(), source_node_id: blocked.source_node_id.as_str().to_owned(),
                source_port: blocked.source_port.clone(),
                source_node_execution_id: blocked.source_fence.node_execution_id().as_str().to_owned(),
                used: blocked.used, max_reworks: blocked.max_reworks, blocked_at: blocked.blocked_at,
                scope_node_ids: blocked.scope.iter().map(|id| id.as_str().to_owned()).collect(),
                edge_ids: blocked.edge_ids.iter().map(|id| id.as_str().to_owned()).collect(),
            }).collect(),
        },
    }
}

pub(crate) fn graph_status(state: &GraphState) -> GraphStatus {
    let attempts = state.executions().values().map(|history| history.current());
    let statuses = attempts.map(|attempt| attempt.status()).collect::<Vec<_>>();
    if statuses.contains(&AttemptStatus::Cancelled) {
        return GraphStatus::Cancelled;
    }
    if statuses.contains(&AttemptStatus::Failed) {
        return GraphStatus::Failed;
    }
    if statuses.contains(&AttemptStatus::Running) {
        return GraphStatus::Running;
    }
    if statuses.contains(&AttemptStatus::Waiting) || !state.blocked_reworks().is_empty() {
        return GraphStatus::Waiting;
    }
    if !state.ready_queue().is_empty() {
        return GraphStatus::Ready;
    }
    if statuses
        .iter()
        .all(|status| *status == AttemptStatus::Completed)
    {
        return GraphStatus::Completed;
    }
    if state.executions().values().any(|history| {
        let current = history.current();
        // Activate/Finish enqueue immediately; an incomplete Gate keeps its exact receipts.
        current.status() == AttemptStatus::Pending && !current.inputs().is_empty()
    }) {
        return GraphStatus::Pending;
    }
    let mut unfinished_batches = state
        .executions()
        .values()
        .map(|history| history.current())
        .filter(|attempt| attempt.status() == AttemptStatus::Completed)
        .map(|attempt| attempt.batch_id())
        .collect::<BTreeSet<_>>();
    let has_completed_batch = !unfinished_batches.is_empty();
    for history in state.executions().values() {
        if history.current().node_kind() != NodeKind::End {
            continue;
        }
        let mut seen_batches = BTreeSet::new();
        // Another trigger may replace this End's current batch; rework stays in the same batch.
        for attempt in history.attempts().iter().rev() {
            if seen_batches.insert(attempt.batch_id())
                && attempt.status() == AttemptStatus::Completed
            {
                unfinished_batches.remove(&attempt.batch_id());
            }
        }
    }
    if has_completed_batch && unfinished_batches.is_empty() {
        return GraphStatus::Completed;
    }
    GraphStatus::Pending
}

pub(crate) fn edge_satisfied(state: &GraphState, edge: &super::definition::EdgeDefinition) -> bool {
    let Some(source) = state.current_attempt(edge.source_node_id()) else {
        return false;
    };
    let satisfied = if edge.action() == super::definition::EdgeAction::Gate {
        source.status() == AttemptStatus::Completed
    } else {
        source.status().is_terminal()
    };
    satisfied && source.output_port() == Some(edge.source_port())
}
