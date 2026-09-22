use std::{collections::BTreeMap, num::NonZeroU32};

use crate::run::event::{MetadataValue, OpaqueId};

use super::{
    AttemptReason, AttemptStatus, DefinitionError, DependencyMetadata, EdgeAction, EdgeDefinition,
    EdgeId, EdgePayloadPolicy, ExecutionFence, ExecutorPolicy, GraphDefinition, GraphRunId,
    GraphState, GroupId, InputReceipt, JoinPolicy, NodeAttempt, NodeAttemptDurableInput,
    NodeDefinition, NodeExecutionHistory, NodeId, NodeKind, ReadyQueueItem, RestoreError,
    ReviewAssignment, StartTrigger, WorkAssignment, WorkGroup, restore_oracle,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphDurableSnapshot {
    pub graph_id: String,
    pub workflow_plan_id: String,
    pub run_id: String,
    pub title: String,
    pub metadata: BTreeMap<OpaqueId, MetadataValue>,
    pub nodes: Vec<DurableNodeDefinition>,
    pub edges: Vec<DurableEdgeDefinition>,
    pub executions: Vec<DurableNodeExecution>,
    pub ready_queue: Vec<DurableReadyQueueItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableNodeDefinition {
    pub order: u32,
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    pub max_attempts: u32,
    pub is_control: bool,
    pub trigger: Option<DurableStartTrigger>,
    pub work: Option<DurableWorkAssignment>,
    pub review: Option<DurableReviewAssignment>,
    pub group: Option<DurableWorkGroup>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableStartTrigger {
    Webhook { path: String },
    Cron { expression: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableWorkAssignment {
    pub task_id: String,
    pub prompt: String,
    pub role_id: String,
    pub session_ref: String,
    pub output_artifact_kind: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableReviewAssignment {
    pub role_id: String,
    pub session_ref: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableWorkGroup {
    pub group_id: String,
    pub require_completed: bool,
    pub allow_failed: bool,
    pub retry_limit: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableEdgeDefinition {
    pub order: u32,
    pub id: String,
    pub source_node_id: String,
    pub source_port: String,
    pub target_node_id: String,
    pub target_port: String,
    pub action: EdgeAction,
    pub include_upstream_result: bool,
    pub dependency: Option<DurableDependencyMetadata>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDependencyMetadata {
    pub dependency_task_id: String,
    pub task_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableNodeExecution {
    pub node_id: String,
    pub attempts: Vec<DurableNodeAttempt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableNodeAttempt {
    pub fence: DurableExecutionFence,
    pub number: u32,
    pub node_id: String,
    pub node_kind: NodeKind,
    pub status: AttemptStatus,
    pub reason: DurableAttemptReason,
    pub inputs: Vec<DurableInputReceipt>,
    pub output_port: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableExecutionFence {
    pub attempt_id: String,
    pub node_execution_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableAttemptReason {
    Initial,
    Trigger,
    Edge { edge_id: String },
    Rework,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableInputReceipt {
    pub edge_id: String,
    pub action: EdgeAction,
    pub source_node_id: String,
    pub source_port: String,
    pub target_port: String,
    pub source_fence: DurableExecutionFence,
    pub arrived_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableReadyQueueItem {
    pub node_id: String,
    pub fence: DurableExecutionFence,
    pub enqueued_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableRestoreError {
    NonCanonicalNodeOrder,
    NonCanonicalEdgeOrder,
    NonCanonicalExecutions,
    InvalidAttemptNumber {
        node_id: String,
        number: u32,
    },
    InvalidNodeSnapshot {
        node_id: String,
    },
    InvalidDefinition(DefinitionError),
    InvalidAttemptReason {
        node_id: NodeId,
        number: NonZeroU32,
    },
    InvalidAttemptInputs {
        node_id: NodeId,
        number: NonZeroU32,
    },
    UnknownInputEdge {
        node_id: NodeId,
        number: NonZeroU32,
        edge_id: EdgeId,
    },
    InvalidInputEdge {
        node_id: NodeId,
        number: NonZeroU32,
        edge_id: EdgeId,
    },
    MissingInputSourceAttempt {
        node_id: NodeId,
        number: NonZeroU32,
        edge_id: EdgeId,
    },
    InvalidInputSourceAttempt {
        node_id: NodeId,
        number: NonZeroU32,
        edge_id: EdgeId,
    },
    InvalidInputTimestamp {
        node_id: NodeId,
        number: NonZeroU32,
        edge_id: EdgeId,
    },
    InvalidState(RestoreError),
}

impl GraphState {
    pub fn durable_snapshot(&self) -> GraphDurableSnapshot {
        GraphDurableSnapshot {
            graph_id: self.definition().graph_id().to_owned(),
            workflow_plan_id: self.definition().workflow_plan_id().to_owned(),
            run_id: self.definition().run_id().as_str().to_owned(),
            title: self.definition().title().to_owned(),
            metadata: self.metadata().clone(),
            nodes: self
                .definition()
                .nodes()
                .iter()
                .enumerate()
                .map(|(order, node)| DurableNodeDefinition {
                    order: u32::try_from(order).expect("graph node count exceeds durable ordering"),
                    id: node.id().as_str().to_owned(),
                    kind: node.kind(),
                    title: node.title().to_owned(),
                    max_attempts: node.max_attempts().get(),
                    is_control: node.is_control(),
                    trigger: node.trigger().map(durable_trigger),
                    work: node.work_assignment().map(|work| DurableWorkAssignment {
                        task_id: work.task_id().to_owned(),
                        prompt: work.prompt().to_owned(),
                        role_id: work.role_id().to_owned(),
                        session_ref: work.session_ref().as_str().to_owned(),
                        output_artifact_kind: work.output_artifact_kind().map(ToOwned::to_owned),
                        group_id: work.group_id().map(|id| id.as_str().to_owned()),
                    }),
                    review: node
                        .review_assignment()
                        .map(|review| DurableReviewAssignment {
                            role_id: review.role_id().to_owned(),
                            session_ref: review.session_ref().as_str().to_owned(),
                            prompt: review.prompt().to_owned(),
                        }),
                    group: node.work_group().map(|group| DurableWorkGroup {
                        group_id: group.id().as_str().to_owned(),
                        require_completed: group.join_policy().require_completed(),
                        allow_failed: group.join_policy().allow_failed(),
                        retry_limit: group.join_policy().retry_limit(),
                    }),
                })
                .collect(),
            edges: self
                .definition()
                .edges()
                .iter()
                .enumerate()
                .map(|(order, edge)| DurableEdgeDefinition {
                    order: u32::try_from(order).expect("graph edge count exceeds durable ordering"),
                    id: edge.id().as_str().to_owned(),
                    source_node_id: edge.source_node_id().as_str().to_owned(),
                    source_port: edge.source_port().to_owned(),
                    target_node_id: edge.target_node_id().as_str().to_owned(),
                    target_port: edge.target_port().to_owned(),
                    action: edge.action(),
                    include_upstream_result: edge.payload().include_upstream_result(),
                    dependency: edge
                        .dependency()
                        .map(|dependency| DurableDependencyMetadata {
                            dependency_task_id: dependency.dependency_task_id().to_owned(),
                            task_id: dependency.task_id().to_owned(),
                        }),
                })
                .collect(),
            executions: self
                .executions()
                .iter()
                .map(|(node_id, history)| DurableNodeExecution {
                    node_id: node_id.as_str().to_owned(),
                    attempts: history.attempts().iter().map(durable_attempt).collect(),
                })
                .collect(),
            ready_queue: self.ready_queue().iter().map(durable_ready_item).collect(),
        }
    }

    pub fn restore_durable(snapshot: GraphDurableSnapshot) -> Result<Self, DurableRestoreError> {
        let definition = restore_definition(&snapshot)?;
        let executions = restore_executions(&snapshot.executions)?;
        let ready_queue = snapshot
            .ready_queue
            .into_iter()
            .map(|item| {
                ReadyQueueItem::from_durable(
                    NodeId::new(item.node_id),
                    restore_fence(item.fence),
                    item.enqueued_at,
                )
            })
            .collect();
        let state =
            GraphState::from_durable(definition, snapshot.metadata, executions, ready_queue);
        validate_cross_references(&state)?;
        restore_oracle(state).map_err(DurableRestoreError::InvalidState)
    }
}

fn durable_trigger(trigger: &StartTrigger) -> DurableStartTrigger {
    match trigger {
        StartTrigger::Webhook { path } => DurableStartTrigger::Webhook { path: path.clone() },
        StartTrigger::Cron { expression } => DurableStartTrigger::Cron {
            expression: expression.clone(),
        },
    }
}

fn durable_attempt(attempt: &NodeAttempt) -> DurableNodeAttempt {
    DurableNodeAttempt {
        fence: durable_fence(attempt.fence()),
        number: attempt.number().get(),
        node_id: attempt.node_id().as_str().to_owned(),
        node_kind: attempt.node_kind(),
        status: attempt.status(),
        reason: durable_reason(attempt.reason()),
        inputs: attempt.inputs().iter().map(durable_input).collect(),
        output_port: attempt.output_port().map(ToOwned::to_owned),
        created_at: attempt.created_at(),
        updated_at: attempt.updated_at(),
    }
}

fn durable_fence(fence: &ExecutionFence) -> DurableExecutionFence {
    DurableExecutionFence {
        attempt_id: fence.attempt_id().as_str().to_owned(),
        node_execution_id: fence.node_execution_id().as_str().to_owned(),
    }
}

fn durable_reason(reason: &AttemptReason) -> DurableAttemptReason {
    match reason {
        AttemptReason::Initial => DurableAttemptReason::Initial,
        AttemptReason::Trigger => DurableAttemptReason::Trigger,
        AttemptReason::Edge(edge_id) => DurableAttemptReason::Edge {
            edge_id: edge_id.as_str().to_owned(),
        },
        AttemptReason::Rework => DurableAttemptReason::Rework,
    }
}

fn durable_input(receipt: &InputReceipt) -> DurableInputReceipt {
    DurableInputReceipt {
        edge_id: receipt.edge_id().as_str().to_owned(),
        action: receipt.action(),
        source_node_id: receipt.source_node_id().as_str().to_owned(),
        source_port: receipt.source_port().to_owned(),
        target_port: receipt.target_port().to_owned(),
        source_fence: durable_fence(receipt.source_fence()),
        arrived_at: receipt.arrived_at(),
    }
}

fn durable_ready_item(item: &ReadyQueueItem) -> DurableReadyQueueItem {
    DurableReadyQueueItem {
        node_id: item.node_id().as_str().to_owned(),
        fence: durable_fence(item.fence()),
        enqueued_at: item.enqueued_at(),
    }
}

fn restore_definition(
    snapshot: &GraphDurableSnapshot,
) -> Result<GraphDefinition, DurableRestoreError> {
    let nodes = snapshot
        .nodes
        .iter()
        .enumerate()
        .map(|(order, node)| {
            if node.order
                != u32::try_from(order).expect("graph node count exceeds durable ordering")
            {
                return Err(DurableRestoreError::NonCanonicalNodeOrder);
            }
            let id = NodeId::new(node.id.clone());
            let Some(max_attempts) = NonZeroU32::new(node.max_attempts) else {
                return Err(DurableRestoreError::InvalidNodeSnapshot {
                    node_id: node.id.clone(),
                });
            };
            match (
                node.kind,
                node.is_control,
                &node.trigger,
                &node.work,
                &node.review,
                &node.group,
            ) {
                (NodeKind::Start, false, trigger, None, None, None) => Ok(NodeDefinition::start(
                    id,
                    node.title.clone(),
                    max_attempts,
                    trigger.as_ref().map(restore_trigger),
                )),
                (NodeKind::Work, false, None, Some(work), None, None) => Ok(NodeDefinition::work(
                    id,
                    node.title.clone(),
                    max_attempts,
                    WorkAssignment::typed(
                        work.task_id.clone(),
                        work.prompt.clone(),
                        ExecutorPolicy::team_role_session(
                            work.role_id.clone(),
                            crate::RoleSessionRef::try_new(work.session_ref.clone()).map_err(
                                |_| DurableRestoreError::InvalidNodeSnapshot {
                                    node_id: node.id.clone(),
                                },
                            )?,
                        ),
                        work.output_artifact_kind.clone(),
                        work.group_id.clone().map(GroupId::new),
                    ),
                )),
                (NodeKind::Review, false, None, None, Some(review), None) => {
                    Ok(NodeDefinition::review(
                        id,
                        node.title.clone(),
                        max_attempts,
                        ReviewAssignment::with_executor(
                            ExecutorPolicy::team_role_session(
                                review.role_id.clone(),
                                crate::RoleSessionRef::try_new(review.session_ref.clone())
                                    .map_err(|_| DurableRestoreError::InvalidNodeSnapshot {
                                        node_id: node.id.clone(),
                                    })?,
                            ),
                            review.prompt.clone(),
                        ),
                    ))
                }
                (NodeKind::Join, false, None, None, None, Some(group)) => Ok(NodeDefinition::join(
                    id,
                    node.title.clone(),
                    max_attempts,
                    WorkGroup::new(
                        GroupId::new(group.group_id.clone()),
                        JoinPolicy::new(
                            group.require_completed,
                            group.allow_failed,
                            group.retry_limit,
                        ),
                    ),
                )),
                (NodeKind::Start, true, None, None, None, None)
                | (NodeKind::Review, true, None, None, None, None)
                | (NodeKind::Join, true, None, None, None, None)
                | (NodeKind::HumanDecision, true, None, None, None, None)
                | (NodeKind::ScriptReview, true, None, None, None, None)
                | (NodeKind::End, true, None, None, None, None) => Ok(NodeDefinition::control(
                    id,
                    node.kind,
                    node.title.clone(),
                    max_attempts,
                )),
                _ => Err(DurableRestoreError::InvalidNodeSnapshot {
                    node_id: node.id.clone(),
                }),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let edges = snapshot
        .edges
        .iter()
        .enumerate()
        .map(|(order, edge)| {
            if edge.order
                != u32::try_from(order).expect("graph edge count exceeds durable ordering")
            {
                return Err(DurableRestoreError::NonCanonicalEdgeOrder);
            }
            Ok(EdgeDefinition::new(
                EdgeId::new(edge.id.clone()),
                NodeId::new(edge.source_node_id.clone()),
                edge.source_port.clone(),
                NodeId::new(edge.target_node_id.clone()),
                edge.target_port.clone(),
                edge.action,
            )
            .with_payload(EdgePayloadPolicy::new(edge.include_upstream_result))
            .with_dependency_opt(edge.dependency.clone().map(|dependency| {
                DependencyMetadata::new(dependency.dependency_task_id, dependency.task_id)
            })))
        })
        .collect::<Result<Vec<_>, _>>()?;
    GraphDefinition::new(
        snapshot.graph_id.clone(),
        snapshot.workflow_plan_id.clone(),
        GraphRunId::new(snapshot.run_id.clone()),
        snapshot.title.clone(),
        nodes,
        edges,
    )
    .map_err(DurableRestoreError::InvalidDefinition)
}

fn restore_trigger(trigger: &DurableStartTrigger) -> StartTrigger {
    match trigger {
        DurableStartTrigger::Webhook { path } => StartTrigger::Webhook { path: path.clone() },
        DurableStartTrigger::Cron { expression } => StartTrigger::Cron {
            expression: expression.clone(),
        },
    }
}

fn restore_executions(
    snapshots: &[DurableNodeExecution],
) -> Result<BTreeMap<NodeId, NodeExecutionHistory>, DurableRestoreError> {
    let mut previous = None;
    let mut executions = BTreeMap::new();
    for snapshot in snapshots {
        if previous
            .as_ref()
            .is_some_and(|last: &String| last >= &snapshot.node_id)
        {
            return Err(DurableRestoreError::NonCanonicalExecutions);
        }
        previous = Some(snapshot.node_id.clone());
        let node_id = NodeId::new(snapshot.node_id.clone());
        let attempts = snapshot
            .attempts
            .iter()
            .map(restore_attempt)
            .collect::<Result<Vec<_>, _>>()?;
        if executions
            .insert(node_id, NodeExecutionHistory::from_durable(attempts))
            .is_some()
        {
            return Err(DurableRestoreError::NonCanonicalExecutions);
        }
    }
    Ok(executions)
}

fn restore_attempt(snapshot: &DurableNodeAttempt) -> Result<NodeAttempt, DurableRestoreError> {
    let Some(number) = NonZeroU32::new(snapshot.number) else {
        return Err(DurableRestoreError::InvalidAttemptNumber {
            node_id: snapshot.node_id.clone(),
            number: snapshot.number,
        });
    };
    Ok(NodeAttempt::from_durable(NodeAttemptDurableInput {
        fence: restore_fence(snapshot.fence.clone()),
        number,
        node_id: NodeId::new(snapshot.node_id.clone()),
        node_kind: snapshot.node_kind,
        status: snapshot.status,
        reason: restore_reason(&snapshot.reason),
        inputs: snapshot.inputs.iter().map(restore_input).collect(),
        output_port: snapshot.output_port.clone(),
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
    }))
}

fn restore_fence(snapshot: DurableExecutionFence) -> ExecutionFence {
    ExecutionFence::from_durable(snapshot.attempt_id, snapshot.node_execution_id)
}

fn restore_reason(reason: &DurableAttemptReason) -> AttemptReason {
    match reason {
        DurableAttemptReason::Initial => AttemptReason::Initial,
        DurableAttemptReason::Trigger => AttemptReason::Trigger,
        DurableAttemptReason::Edge { edge_id } => AttemptReason::Edge(EdgeId::new(edge_id.clone())),
        DurableAttemptReason::Rework => AttemptReason::Rework,
    }
}

fn restore_input(snapshot: &DurableInputReceipt) -> InputReceipt {
    InputReceipt::from_durable(
        EdgeId::new(snapshot.edge_id.clone()),
        snapshot.action,
        NodeId::new(snapshot.source_node_id.clone()),
        snapshot.source_port.clone(),
        snapshot.target_port.clone(),
        restore_fence(snapshot.source_fence.clone()),
        snapshot.arrived_at,
    )
}

fn validate_cross_references(state: &GraphState) -> Result<(), DurableRestoreError> {
    for (node_id, history) in state.executions() {
        for attempt in history.attempts() {
            validate_reason(state, node_id, attempt)?;
            for receipt in attempt.inputs() {
                validate_input(state, node_id, attempt, receipt)?;
            }
        }
    }
    Ok(())
}

fn validate_reason(
    state: &GraphState,
    node_id: &NodeId,
    attempt: &NodeAttempt,
) -> Result<(), DurableRestoreError> {
    let invalid_reason = || DurableRestoreError::InvalidAttemptReason {
        node_id: node_id.clone(),
        number: attempt.number(),
    };
    let invalid_inputs = || DurableRestoreError::InvalidAttemptInputs {
        node_id: node_id.clone(),
        number: attempt.number(),
    };
    match attempt.reason() {
        AttemptReason::Initial if attempt.number() == NonZeroU32::MIN => attempt
            .inputs()
            .is_empty()
            .then_some(())
            .ok_or_else(invalid_inputs),
        AttemptReason::Trigger => attempt
            .inputs()
            .is_empty()
            .then_some(())
            .ok_or_else(invalid_inputs),
        AttemptReason::Edge(edge_id) => {
            let Some(reason_edge) = state
                .definition()
                .edges()
                .iter()
                .find(|edge| edge.id() == edge_id && edge.target_node_id() == node_id)
            else {
                return Err(invalid_reason());
            };
            let expected = if reason_edge.action() == EdgeAction::Gate {
                state
                    .definition()
                    .incoming_edges(node_id)
                    .filter(|edge| edge.action() == EdgeAction::Gate)
                    .map(|edge| edge.id())
                    .collect::<Vec<_>>()
            } else {
                vec![reason_edge.id()]
            };
            let actual = attempt
                .inputs()
                .iter()
                .map(InputReceipt::edge_id)
                .collect::<Vec<_>>();
            (actual == expected)
                .then_some(())
                .ok_or_else(invalid_inputs)
        }
        AttemptReason::Rework => {
            let actual = attempt.inputs();
            if actual.is_empty() {
                return Ok(());
            }
            (actual.len() == 1
                && state.definition().edges().iter().any(|edge| {
                    edge.id() == actual[0].edge_id()
                        && edge.target_node_id() == node_id
                        && edge.action() == EdgeAction::Rework
                }))
            .then_some(())
            .ok_or_else(invalid_inputs)
        }
        _ => Err(invalid_reason()),
    }
}

fn validate_input(
    state: &GraphState,
    node_id: &NodeId,
    attempt: &NodeAttempt,
    receipt: &InputReceipt,
) -> Result<(), DurableRestoreError> {
    let edge_id = receipt.edge_id().clone();
    let Some(edge) = state
        .definition()
        .edges()
        .iter()
        .find(|edge| edge.id() == &edge_id)
    else {
        return Err(DurableRestoreError::UnknownInputEdge {
            node_id: node_id.clone(),
            number: attempt.number(),
            edge_id,
        });
    };
    if edge.action() != receipt.action()
        || edge.source_node_id() != receipt.source_node_id()
        || edge.source_port() != receipt.source_port()
        || edge.target_node_id() != node_id
        || edge.target_port() != receipt.target_port()
    {
        return Err(DurableRestoreError::InvalidInputEdge {
            node_id: node_id.clone(),
            number: attempt.number(),
            edge_id,
        });
    }
    let source = state
        .executions()
        .get(receipt.source_node_id())
        .and_then(|history| {
            history
                .attempts()
                .iter()
                .find(|source| source.fence() == receipt.source_fence())
        });
    let Some(source) = source else {
        return Err(DurableRestoreError::MissingInputSourceAttempt {
            node_id: node_id.clone(),
            number: attempt.number(),
            edge_id,
        });
    };
    if !source.status().is_terminal() || source.output_port() != Some(receipt.source_port()) {
        return Err(DurableRestoreError::InvalidInputSourceAttempt {
            node_id: node_id.clone(),
            number: attempt.number(),
            edge_id,
        });
    }
    if source.updated_at() > receipt.arrived_at()
        || attempt.created_at() > receipt.arrived_at()
        || receipt.arrived_at() > attempt.updated_at()
    {
        return Err(DurableRestoreError::InvalidInputTimestamp {
            node_id: node_id.clone(),
            number: attempt.number(),
            edge_id,
        });
    }
    Ok(())
}
