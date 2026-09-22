use super::{
    definition::{EdgeId, NodeId},
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
pub struct GraphProjection {
    pub graph_id: String,
    pub run_id: String,
    pub status: GraphStatus,
    pub ready_node_ids: Vec<NodeId>,
    pub nodes: Vec<NodeProjection>,
    pub edges: Vec<EdgeProjection>,
    pub inputs: Vec<InputProjection>,
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
    }
}

fn graph_status(state: &GraphState) -> GraphStatus {
    let attempts = state.executions().values().map(|history| history.current());
    let statuses = attempts.map(|attempt| attempt.status()).collect::<Vec<_>>();
    let end_nodes = state
        .definition()
        .nodes()
        .iter()
        .filter(|node| node.kind() == super::definition::NodeKind::End)
        .collect::<Vec<_>>();
    let all_end_nodes_completed = !end_nodes.is_empty()
        && end_nodes.iter().all(|node| {
            state
                .current_attempt(node.id())
                .expect("definition nodes always have an execution history")
                .status()
                == AttemptStatus::Completed
        });
    if statuses.contains(&AttemptStatus::Cancelled) {
        return GraphStatus::Cancelled;
    }
    if all_end_nodes_completed {
        return GraphStatus::Completed;
    }
    if statuses.contains(&AttemptStatus::Failed) {
        return GraphStatus::Failed;
    }
    if statuses.contains(&AttemptStatus::Running) {
        return GraphStatus::Running;
    }
    if statuses.contains(&AttemptStatus::Waiting) {
        return GraphStatus::Waiting;
    }
    if statuses
        .iter()
        .all(|status| *status == AttemptStatus::Completed)
    {
        return GraphStatus::Completed;
    }
    if !state.ready_queue().is_empty() {
        return GraphStatus::Ready;
    }
    GraphStatus::Pending
}

fn edge_satisfied(state: &GraphState, edge: &super::definition::EdgeDefinition) -> bool {
    let Some(source) = state.current_attempt(edge.source_node_id()) else {
        return false;
    };
    source.status().is_terminal() && source.output_port() == Some(edge.source_port())
}
