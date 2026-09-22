use std::fmt;

use crate::run::graph::{AttemptId, ExecutionFence, GraphRunId, NodeId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptIdentity {
    run_id: GraphRunId,
    node_id: NodeId,
    attempt_id: AttemptId,
    fence: ExecutionFence,
}

impl AttemptIdentity {
    pub fn new(
        run_id: GraphRunId,
        node_id: NodeId,
        attempt_id: AttemptId,
        fence: ExecutionFence,
    ) -> Result<Self, InvalidAttemptIdentity> {
        if fence.attempt_id() != &attempt_id {
            return Err(InvalidAttemptIdentity);
        }
        Ok(Self {
            run_id,
            node_id,
            attempt_id,
            fence,
        })
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidAttemptIdentity;

impl fmt::Display for InvalidAttemptIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("attempt identity must match its execution fence")
    }
}

impl std::error::Error for InvalidAttemptIdentity {}
