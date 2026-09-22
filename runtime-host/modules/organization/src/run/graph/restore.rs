use std::{collections::BTreeSet, num::NonZeroU32};

use super::{
    definition::{DefinitionError, NodeId, NodeKind},
    reducer::state_has_only_current_ready_items,
    state::{AttemptId, GraphState, NodeExecutionId},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreError {
    InvalidDefinition(DefinitionError),
    MissingExecution(NodeId),
    UnexpectedExecution(NodeId),
    EmptyExecutionHistory(NodeId),
    InvalidAttemptNode {
        expected: NodeId,
        actual: NodeId,
    },
    InvalidAttemptKind {
        node_id: NodeId,
        expected: NodeKind,
        actual: NodeKind,
    },
    InvalidAttemptNumber {
        node_id: NodeId,
        expected: NonZeroU32,
        actual: NonZeroU32,
    },
    InvalidAttemptFence {
        node_id: NodeId,
        number: NonZeroU32,
    },
    AttemptLimitExceeded {
        node_id: NodeId,
        max_attempts: NonZeroU32,
    },
    AttemptHistoryTooLong(NodeId),
    InvalidAttemptTimestamp {
        node_id: NodeId,
        number: NonZeroU32,
    },
    NonTerminalAttemptHasOutput {
        node_id: NodeId,
        number: NonZeroU32,
    },
    TerminalAttemptMissingOutput {
        node_id: NodeId,
        number: NonZeroU32,
    },
    CancelledAttemptHasOutput {
        node_id: NodeId,
        number: NonZeroU32,
    },
    QueueContainsStaleFence(NodeId),
    QueueDoesNotMatchReadyAttempts,
    NonCanonicalReadyQueue,
}

pub fn restore_oracle(state: GraphState) -> Result<GraphState, RestoreError> {
    state
        .definition()
        .validate()
        .map_err(RestoreError::InvalidDefinition)?;
    let expected_ids = state
        .definition()
        .nodes()
        .iter()
        .map(|node| node.id().clone())
        .collect::<BTreeSet<_>>();
    let actual_ids = state.executions().keys().cloned().collect::<BTreeSet<_>>();
    if let Some(node_id) = expected_ids.difference(&actual_ids).next() {
        return Err(RestoreError::MissingExecution(node_id.clone()));
    }
    if let Some(node_id) = actual_ids.difference(&expected_ids).next() {
        return Err(RestoreError::UnexpectedExecution(node_id.clone()));
    }
    for (node_id, history) in state.executions() {
        let definition_node = state
            .definition()
            .node(node_id)
            .expect("execution ids match definition nodes");
        let attempts = history.attempts();
        if attempts.is_empty() {
            return Err(RestoreError::EmptyExecutionHistory(node_id.clone()));
        }
        let mut expected_number = NonZeroU32::MIN;
        for (index, attempt) in attempts.iter().enumerate() {
            if attempt.node_id() != node_id {
                return Err(RestoreError::InvalidAttemptNode {
                    expected: node_id.clone(),
                    actual: attempt.node_id().clone(),
                });
            }
            if attempt.node_kind() != definition_node.kind() {
                return Err(RestoreError::InvalidAttemptKind {
                    node_id: node_id.clone(),
                    expected: definition_node.kind(),
                    actual: attempt.node_kind(),
                });
            }
            if attempt.number() != expected_number {
                return Err(RestoreError::InvalidAttemptNumber {
                    node_id: node_id.clone(),
                    expected: expected_number,
                    actual: attempt.number(),
                });
            }
            if attempt.number() > definition_node.max_attempts() {
                return Err(RestoreError::AttemptLimitExceeded {
                    node_id: node_id.clone(),
                    max_attempts: definition_node.max_attempts(),
                });
            }
            let attempt_id = AttemptId::for_node(node_id, expected_number);
            let execution_id = NodeExecutionId::for_attempt(&attempt_id);
            if attempt.fence().attempt_id() != &attempt_id
                || attempt.fence().node_execution_id() != &execution_id
            {
                return Err(RestoreError::InvalidAttemptFence {
                    node_id: node_id.clone(),
                    number: expected_number,
                });
            }
            if attempt.updated_at() < attempt.created_at() {
                return Err(RestoreError::InvalidAttemptTimestamp {
                    node_id: node_id.clone(),
                    number: expected_number,
                });
            }
            if matches!(
                attempt.status(),
                super::state::AttemptStatus::Completed | super::state::AttemptStatus::Failed
            ) && attempt.output_port().is_none()
            {
                return Err(RestoreError::TerminalAttemptMissingOutput {
                    node_id: node_id.clone(),
                    number: expected_number,
                });
            }
            if attempt.status() == super::state::AttemptStatus::Cancelled
                && attempt.output_port().is_some()
            {
                return Err(RestoreError::CancelledAttemptHasOutput {
                    node_id: node_id.clone(),
                    number: expected_number,
                });
            }
            if !attempt.status().is_terminal() && attempt.output_port().is_some() {
                return Err(RestoreError::NonTerminalAttemptHasOutput {
                    node_id: node_id.clone(),
                    number: expected_number,
                });
            }
            if index + 1 < attempts.len() {
                expected_number = expected_number
                    .checked_add(1)
                    .ok_or_else(|| RestoreError::AttemptHistoryTooLong(node_id.clone()))?;
            }
        }
    }
    for queue_item in state.ready_queue() {
        let Some(current) = state.current_attempt(queue_item.node_id()) else {
            return Err(RestoreError::QueueContainsStaleFence(
                queue_item.node_id().clone(),
            ));
        };
        if current.fence() != queue_item.fence() {
            return Err(RestoreError::QueueContainsStaleFence(
                queue_item.node_id().clone(),
            ));
        }
    }
    if !state_has_only_current_ready_items(&state) {
        return Err(RestoreError::QueueDoesNotMatchReadyAttempts);
    }
    if state.ready_queue().windows(2).any(|items| {
        (items[0].enqueued_at(), items[0].node_id()) > (items[1].enqueued_at(), items[1].node_id())
    }) {
        return Err(RestoreError::NonCanonicalReadyQueue);
    }
    Ok(state)
}
