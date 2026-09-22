use crate::run::graph::{AttemptStatus, ExecutionFence, GraphRunId, GraphState, NodeId};

use super::{Attempt, AttemptPhase};

impl Attempt {
    pub fn recover(&mut self, graph: &GraphState) -> Result<RecoveryAction, RecoveryFault> {
        recovery_oracle(self, graph)?;

        let action = match self.phase {
            AttemptPhase::Graph(AttemptStatus::Ready) => RecoveryAction::Schedule,
            AttemptPhase::Graph(AttemptStatus::Running) | AttemptPhase::OutcomeUnknown => {
                self.phase = AttemptPhase::OutcomeUnknown;
                RecoveryAction::ObserveOutcome
            }
            AttemptPhase::Graph(AttemptStatus::Waiting) => RecoveryAction::PreserveWaiting,
            AttemptPhase::Graph(AttemptStatus::Pending)
            | AttemptPhase::Graph(
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled,
            ) => RecoveryAction::None,
        };

        Ok(action)
    }
}

pub fn recovery_oracle(attempt: &Attempt, graph: &GraphState) -> Result<(), RecoveryFault> {
    let graph_run_id = graph.definition().run_id();
    if graph_run_id != attempt.identity.run_id() {
        return Err(RecoveryFault::RunMismatch {
            attempt_run_id: attempt.identity.run_id().clone(),
            graph_run_id: graph_run_id.clone(),
        });
    }

    let current = graph
        .current_attempt(attempt.identity.node_id())
        .ok_or_else(|| RecoveryFault::MissingNode(attempt.identity.node_id().clone()))?;
    if current.fence() != attempt.identity.fence() {
        return Err(RecoveryFault::StaleFence {
            node_id: attempt.identity.node_id().clone(),
            expected: current.fence().clone(),
            actual: attempt.identity.fence().clone(),
        });
    }

    match attempt.phase {
        AttemptPhase::Graph(status) if status == current.status() => Ok(()),
        AttemptPhase::OutcomeUnknown if current.status() == AttemptStatus::Running => Ok(()),
        actual => Err(RecoveryFault::GraphPhaseMismatch {
            expected: current.status(),
            actual,
        }),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryFault {
    RunMismatch {
        attempt_run_id: GraphRunId,
        graph_run_id: GraphRunId,
    },
    MissingNode(NodeId),
    StaleFence {
        node_id: NodeId,
        expected: ExecutionFence,
        actual: ExecutionFence,
    },
    GraphPhaseMismatch {
        expected: AttemptStatus,
        actual: AttemptPhase,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryAction {
    Schedule,
    ObserveOutcome,
    PreserveWaiting,
    None,
}
