use std::num::NonZeroU64;

use crate::{GraphRunId, NodeExecutionId, NodeId, TeamId, run::event::OpaqueId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReworkContinueRequest {
    pub team_id: TeamId,
    pub run_id: GraphRunId,
    pub source_node_id: NodeId,
    pub source_port: String,
    pub batch_id: NonZeroU64,
    pub source_node_execution_id: NodeExecutionId,
    pub max_reworks: u32,
    pub expected_graph_version: String,
    pub command_id: OpaqueId,
    pub idempotency_key: OpaqueId,
}
