use std::{
    collections::{BTreeMap, BTreeSet},
    num::{NonZeroU32, NonZeroU64},
};

use crate::run::event::{MetadataValue, OpaqueId};

use super::{
    AttemptReason, AttemptStatus, DefinitionError, DependencyMetadata, EdgeAction, EdgeDefinition,
    EdgeId, EdgePayloadPolicy, ExecutionFence, ExecutorPolicy, GraphDefinition, GraphLayout,
    GraphRunId, GraphState, InputReceipt, NodeAttempt,
    NodeAttemptDurableInput, NodeDefinition, NodeExecutionHistory, NodeId, NodeKind, NodePosition,
    ReadyQueueItem, RestoreError, ReviewAssignment, StartTrigger, WorkAssignment,
    BlockedRework, ReworkCounterKey,
    restore::validate_execution_state,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphDurableSnapshot {
    pub graph_id: String,
    pub workflow_plan_id: String,
    pub run_id: String,
    pub title: String,
    pub metadata: BTreeMap<OpaqueId, MetadataValue>,
    pub layout: DurableGraphLayout,
    pub nodes: Vec<DurableNodeDefinition>,
    pub edges: Vec<DurableEdgeDefinition>,
    pub executions: Vec<DurableNodeExecution>,
    pub ready_queue: Vec<DurableReadyQueueItem>,
    pub next_batch_id: u64,
    pub rework_counts: Vec<DurableReworkCounter>,
    pub blocked_reworks: Vec<DurableBlockedRework>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableGraphLayout {
    pub node_positions: Vec<DurableNodePosition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableNodePosition {
    pub node_id: String,
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableNodeDefinition {
    pub order: u32,
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    pub rework_limits: BTreeMap<String, u32>,
    pub is_control: bool,
    pub trigger: Option<DurableStartTrigger>,
    pub work: Option<DurableWorkAssignment>,
    pub review: Option<DurableReviewAssignment>,
    pub approval_prompt: Option<String>,
    pub script_review_rule: Option<crate::ScriptReviewRule>,
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableReviewAssignment {
    pub role_id: String,
    pub session_ref: String,
    pub prompt: String,
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
    pub batch_id: u64,
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
pub struct DurableReworkCounter {
    pub batch_id: u64,
    pub source_node_id: String,
    pub source_port: String,
    pub used: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableBlockedRework {
    pub batch_id: u64,
    pub source_node_id: String,
    pub source_port: String,
    pub source_fence: DurableExecutionFence,
    pub scope: Vec<String>,
    pub edge_ids: Vec<String>,
    pub used: u32,
    pub max_reworks: u32,
    pub blocked_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableRestoreError {
    InvalidExecutionControl,
    NonCanonicalNodeOrder,
    NonCanonicalEdgeOrder,
    NonCanonicalLayout,
    NonCanonicalExecutions,
    InvalidAttemptNumber {
        node_id: String,
        number: u32,
    },
    InvalidNodeSnapshot {
        node_id: String,
    },
    InvalidLayoutNodePosition,
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
            layout: DurableGraphLayout {
                node_positions: self
                    .layout()
                    .node_positions()
                    .iter()
                    .map(|(node_id, position)| DurableNodePosition {
                        node_id: node_id.as_str().to_owned(),
                        x: position.x(),
                        y: position.y(),
                    })
                    .collect(),
            },
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
                    rework_limits: node.rework_limits().clone(),
                    is_control: node.is_control(),
                    trigger: node.trigger().map(durable_trigger),
                    approval_prompt: node.approval_prompt().map(ToOwned::to_owned),
                    script_review_rule: node.script_review_rule(),
                    work: node.work_assignment().map(|work| DurableWorkAssignment {
                        task_id: work.task_id().to_owned(),
                        prompt: work.prompt().to_owned(),
                        role_id: work.role_id().to_owned(),
                        session_ref: work.session_ref().as_str().to_owned(),
                        output_artifact_kind: work.output_artifact_kind().map(ToOwned::to_owned),
                    }),
                    review: node
                        .review_assignment()
                        .map(|review| DurableReviewAssignment {
                            role_id: review.role_id().to_owned(),
                            session_ref: review.session_ref().as_str().to_owned(),
                            prompt: review.prompt().to_owned(),
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
            next_batch_id: self.next_batch_id().get(),
            rework_counts: self.rework_counts().iter().map(|(key, used)| DurableReworkCounter {
                batch_id: key.batch_id.get(), source_node_id: key.source_node_id.as_str().to_owned(),
                source_port: key.source_port.clone(), used: *used,
            }).collect(),
            blocked_reworks: self.blocked_reworks().values().map(|blocked| DurableBlockedRework {
                batch_id: blocked.batch_id.get(), source_node_id: blocked.source_node_id.as_str().to_owned(),
                source_port: blocked.source_port.clone(), source_fence: durable_fence(&blocked.source_fence),
                scope: blocked.scope.iter().map(|id| id.as_str().to_owned()).collect(),
                edge_ids: blocked.edge_ids.iter().map(|id| id.as_str().to_owned()).collect(),
                used: blocked.used, max_reworks: blocked.max_reworks, blocked_at: blocked.blocked_at,
            }).collect(),
        }
    }

    pub fn restore_durable(snapshot: GraphDurableSnapshot) -> Result<Self, DurableRestoreError> {
        let definition = restore_definition(&snapshot)?;
        let executions = restore_executions(&snapshot.executions)?;
        let layout = restore_layout(&snapshot)?;
        let next_batch_id = NonZeroU64::new(snapshot.next_batch_id)
            .ok_or(DurableRestoreError::InvalidExecutionControl)?;
        let mut rework_counts = BTreeMap::new();
        let mut previous_key = None;
        for counter in &snapshot.rework_counts {
            let key = ReworkCounterKey {
                batch_id: NonZeroU64::new(counter.batch_id).ok_or(DurableRestoreError::InvalidExecutionControl)?,
                source_node_id: NodeId::new(counter.source_node_id.clone()), source_port: counter.source_port.clone(),
            };
            if previous_key.as_ref().is_some_and(|previous| previous >= &key) {
                return Err(DurableRestoreError::InvalidExecutionControl);
            }
            previous_key = Some(key.clone());
            rework_counts.insert(key, counter.used);
        }
        let mut blocked_reworks = BTreeMap::new();
        let mut previous_source = None;
        for blocked in &snapshot.blocked_reworks {
            let source_node_id = NodeId::new(blocked.source_node_id.clone());
            if previous_source.as_ref().is_some_and(|previous| previous >= &source_node_id) {
                return Err(DurableRestoreError::InvalidExecutionControl);
            }
            previous_source = Some(source_node_id.clone());
            blocked_reworks.insert(source_node_id.clone(), BlockedRework {
                batch_id: NonZeroU64::new(blocked.batch_id).ok_or(DurableRestoreError::InvalidExecutionControl)?,
                source_node_id, source_port: blocked.source_port.clone(),
                source_fence: restore_fence(blocked.source_fence.clone()),
                scope: blocked.scope.iter().cloned().map(NodeId::new).collect(),
                edge_ids: blocked.edge_ids.iter().cloned().map(EdgeId::new).collect(),
                used: blocked.used, max_reworks: blocked.max_reworks, blocked_at: blocked.blocked_at,
            });
        }
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
        let state = GraphState::from_durable(
            definition,
            snapshot.metadata,
            layout,
            executions,
            ready_queue,
            next_batch_id,
            rework_counts,
            blocked_reworks,
        );
        validate_cross_references(&state)?;
        validate_execution_state(&state).map_err(DurableRestoreError::InvalidState)?;
        Ok(state)
    }

    pub(crate) fn validate_durable(&self) -> Result<(), DurableRestoreError> {
        for node in self.definition().nodes() {
            if node.is_control() && node.kind() == NodeKind::Work {
                return Err(DurableRestoreError::InvalidNodeSnapshot {
                    node_id: node.id().as_str().to_owned(),
                });
            }
            validate_rework_limits(node.id().as_str(), node.kind(), node.rework_limits())?;
        }
        self.definition()
            .validate_structure()
            .map_err(DurableRestoreError::InvalidDefinition)?;
        for node_id in self.layout().node_positions().keys() {
            if self.definition().node(node_id).is_none() {
                return Err(DurableRestoreError::InvalidLayoutNodePosition);
            }
        }
        validate_cross_references(self)?;
        validate_execution_state(self).map_err(DurableRestoreError::InvalidState)
    }
}

fn restore_layout(snapshot: &GraphDurableSnapshot) -> Result<GraphLayout, DurableRestoreError> {
    let node_ids = snapshot
        .nodes
        .iter()
        .map(|node| NodeId::new(node.id.clone()))
        .collect::<BTreeSet<_>>();
    let mut previous = None;
    let mut node_positions = BTreeMap::new();
    for position in &snapshot.layout.node_positions {
        if previous
            .as_ref()
            .is_some_and(|last: &String| last >= &position.node_id)
        {
            return Err(DurableRestoreError::NonCanonicalLayout);
        }
        previous = Some(position.node_id.clone());
        let node_id = NodeId::new(position.node_id.clone());
        if !node_ids.contains(&node_id)
            || node_positions
                .insert(node_id, NodePosition::new(position.x, position.y))
                .is_some()
        {
            return Err(DurableRestoreError::InvalidLayoutNodePosition);
        }
    }
    Ok(GraphLayout::from_durable(node_positions))
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
        batch_id: attempt.batch_id().get(),
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
            let definition = if node.approval_prompt.is_some() {
                if node.kind != NodeKind::HumanDecision || !node.is_control
                    || node.trigger.is_some() || node.work.is_some() || node.review.is_some()
                    || node.script_review_rule.is_some()
                {
                    return Err(DurableRestoreError::InvalidNodeSnapshot { node_id: node.id.clone() });
                }
                Ok(NodeDefinition::human_decision(id, node.title.clone(), node.approval_prompt.clone()))
            } else if let Some(rule) = node.script_review_rule {
                if node.kind != NodeKind::ScriptReview || !node.is_control
                    || node.trigger.is_some() || node.work.is_some() || node.review.is_some()
                {
                    return Err(DurableRestoreError::InvalidNodeSnapshot { node_id: node.id.clone() });
                }
                Ok(NodeDefinition::script_review(id, node.title.clone(), rule))
            } else {
                match (
                    node.kind,
                    node.is_control,
                    &node.trigger,
                    &node.work,
                    &node.review,
                ) {
                    (NodeKind::Start, false, trigger, None, None) => Ok(NodeDefinition::start(
                        id,
                        node.title.clone(),
                        trigger.as_ref().map(restore_trigger),
                    )),
                    (NodeKind::Work, false, None, Some(work), None) => Ok(NodeDefinition::work(
                        id,
                        node.title.clone(),
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
                        ),
                    )),
                    (NodeKind::Review, false, None, None, Some(review)) => {
                        Ok(NodeDefinition::review(
                            id,
                            node.title.clone(),
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
                    (NodeKind::Join, false, None, None, None) => Ok(NodeDefinition::join(
                        id,
                        node.title.clone(),
                    )),
                    (NodeKind::Start, true, None, None, None)
                    | (NodeKind::Review, true, None, None, None)
                    | (NodeKind::Join, true, None, None, None)
                    | (NodeKind::HumanDecision, true, None, None, None)
                    | (NodeKind::ScriptReview, true, None, None, None)
                    | (NodeKind::End, true, None, None, None) => Ok(NodeDefinition::control(
                        id,
                        node.kind,
                        node.title.clone(),
                    )),
                    _ => Err(DurableRestoreError::InvalidNodeSnapshot {
                        node_id: node.id.clone(),
                    }),
                }
            }?;
            validate_rework_limits(&node.id, node.kind, &node.rework_limits)?;
            Ok(definition.with_rework_limits(node.rework_limits.clone()))
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
    GraphDefinition::from_durable(
        snapshot.graph_id.clone(),
        snapshot.workflow_plan_id.clone(),
        GraphRunId::new(snapshot.run_id.clone()),
        snapshot.title.clone(),
        nodes,
        edges,
    )
    .map_err(DurableRestoreError::InvalidDefinition)
}

fn validate_rework_limits(
    node_id: &str,
    kind: NodeKind,
    limits: &BTreeMap<String, u32>,
) -> Result<(), DurableRestoreError> {
    let expected = kind.source_ports().iter()
        .map(|port| port.as_str())
        .filter(|port| kind.accepts_edge_action(port, EdgeAction::Rework))
        .collect::<BTreeSet<_>>();
    if limits.keys().map(String::as_str).ne(expected) {
        return Err(DurableRestoreError::InvalidNodeSnapshot {
            node_id: node_id.to_owned(),
        });
    }
    Ok(())
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
        batch_id: NonZeroU64::new(snapshot.batch_id).ok_or(DurableRestoreError::InvalidExecutionControl)?,
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

pub(super) fn validate_attempt(state: &GraphState, node_id: &NodeId, attempt: &NodeAttempt) -> Result<(), DurableRestoreError> {
    validate_reason(state, node_id, attempt)?;
    for receipt in attempt.inputs() { validate_input(state, node_id, attempt, receipt)?; }
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
            if reason_edge.action() == EdgeAction::Gate && attempt.status() == AttemptStatus::Pending {
                let received = actual.iter().copied().collect::<BTreeSet<_>>();
                let ordered = expected.iter().copied().filter(|edge| received.contains(edge)).collect::<Vec<_>>();
                (!actual.is_empty() && actual.len() < expected.len()
                    && actual.len() == received.len() && actual == ordered && received.contains(edge_id))
                    .then_some(())
                    .ok_or_else(invalid_inputs)
            } else {
                (actual == expected)
                    .then_some(())
                    .ok_or_else(invalid_inputs)
            }
        }
        AttemptReason::Rework => {
            let actual = attempt.inputs();
            if actual.is_empty() {
                return Ok(());
            }
            let mut edge_ids = BTreeSet::new();
            actual
                .iter()
                .all(|receipt| {
                    edge_ids.insert(receipt.edge_id())
                        && state.definition().edges().iter().any(|edge| {
                            edge.id() == receipt.edge_id()
                                && edge.target_node_id() == node_id
                                && edge.action() == EdgeAction::Rework
                        })
                })
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
    if !source.status().is_terminal() || source.output_port() != Some(receipt.source_port())
        || source.batch_id() != attempt.batch_id()
        || (edge.action() == EdgeAction::Gate && source.status() != AttemptStatus::Completed)
    {
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
