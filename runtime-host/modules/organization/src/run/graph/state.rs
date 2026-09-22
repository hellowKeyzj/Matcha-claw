use std::{collections::BTreeMap, num::NonZeroU32};

use crate::run::event::{MetadataValue, OpaqueId};

use super::definition::{EdgeAction, EdgeId, GraphDefinition, NodeId, NodeKind};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct AttemptId(String);

impl AttemptId {
    pub fn for_node(node_id: &NodeId, number: NonZeroU32) -> Self {
        Self(format!("{}:attempt:{}", node_id.as_str(), number))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NodeExecutionId(String);

impl NodeExecutionId {
    pub fn for_attempt(attempt_id: &AttemptId) -> Self {
        Self(attempt_id.as_str().to_owned())
    }

    pub(crate) fn from_durable(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ExecutionFence {
    attempt_id: AttemptId,
    node_execution_id: NodeExecutionId,
}

impl ExecutionFence {
    pub fn new(attempt_id: AttemptId, node_execution_id: NodeExecutionId) -> Self {
        Self {
            attempt_id,
            node_execution_id,
        }
    }

    pub(crate) fn from_durable(attempt_id: String, node_execution_id: String) -> Self {
        Self::new(AttemptId(attempt_id), NodeExecutionId(node_execution_id))
    }

    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }

    pub fn node_execution_id(&self) -> &NodeExecutionId {
        &self.node_execution_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl AttemptStatus {
    pub(crate) fn accepts_outcome(self) -> bool {
        matches!(self, Self::Ready | Self::Running | Self::Waiting)
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttemptReason {
    Initial,
    Trigger,
    Edge(EdgeId),
    Rework,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputReceipt {
    edge_id: EdgeId,
    action: EdgeAction,
    source_node_id: NodeId,
    source_port: String,
    target_port: String,
    source_fence: ExecutionFence,
    arrived_at: u64,
}

impl InputReceipt {
    pub(crate) fn new(
        edge_id: EdgeId,
        action: EdgeAction,
        source_node_id: NodeId,
        source_port: String,
        target_port: String,
        source_fence: ExecutionFence,
        arrived_at: u64,
    ) -> Self {
        Self {
            edge_id,
            action,
            source_node_id,
            source_port,
            target_port,
            source_fence,
            arrived_at,
        }
    }

    pub(crate) fn from_durable(
        edge_id: EdgeId,
        action: EdgeAction,
        source_node_id: NodeId,
        source_port: String,
        target_port: String,
        source_fence: ExecutionFence,
        arrived_at: u64,
    ) -> Self {
        Self::new(
            edge_id,
            action,
            source_node_id,
            source_port,
            target_port,
            source_fence,
            arrived_at,
        )
    }

    pub fn edge_id(&self) -> &EdgeId {
        &self.edge_id
    }

    pub fn action(&self) -> EdgeAction {
        self.action
    }

    pub fn source_node_id(&self) -> &NodeId {
        &self.source_node_id
    }

    pub fn source_port(&self) -> &str {
        &self.source_port
    }

    pub fn target_port(&self) -> &str {
        &self.target_port
    }

    pub fn source_fence(&self) -> &ExecutionFence {
        &self.source_fence
    }

    pub fn arrived_at(&self) -> u64 {
        self.arrived_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeAttempt {
    fence: ExecutionFence,
    number: NonZeroU32,
    node_id: NodeId,
    node_kind: NodeKind,
    status: AttemptStatus,
    reason: AttemptReason,
    inputs: Vec<InputReceipt>,
    output_port: Option<String>,
    created_at: u64,
    updated_at: u64,
}

/// Durable facts needed to restore a node attempt exactly as persisted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NodeAttemptDurableInput {
    pub(crate) fence: ExecutionFence,
    pub(crate) number: NonZeroU32,
    pub(crate) node_id: NodeId,
    pub(crate) node_kind: NodeKind,
    pub(crate) status: AttemptStatus,
    pub(crate) reason: AttemptReason,
    pub(crate) inputs: Vec<InputReceipt>,
    pub(crate) output_port: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

impl NodeAttempt {
    pub(crate) fn create(
        node_id: NodeId,
        node_kind: NodeKind,
        number: NonZeroU32,
        status: AttemptStatus,
        reason: AttemptReason,
        inputs: Vec<InputReceipt>,
        now: u64,
    ) -> Self {
        let attempt_id = AttemptId::for_node(&node_id, number);
        let node_execution_id = NodeExecutionId::for_attempt(&attempt_id);
        Self {
            fence: ExecutionFence::new(attempt_id, node_execution_id),
            number,
            node_id,
            node_kind,
            status,
            reason,
            inputs,
            output_port: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub(crate) fn from_durable(input: NodeAttemptDurableInput) -> Self {
        let NodeAttemptDurableInput {
            fence,
            number,
            node_id,
            node_kind,
            status,
            reason,
            inputs,
            output_port,
            created_at,
            updated_at,
        } = input;
        Self {
            fence,
            number,
            node_id,
            node_kind,
            status,
            reason,
            inputs,
            output_port,
            created_at,
            updated_at,
        }
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn number(&self) -> NonZeroU32 {
        self.number
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn node_kind(&self) -> NodeKind {
        self.node_kind
    }

    pub fn status(&self) -> AttemptStatus {
        self.status
    }

    pub fn reason(&self) -> &AttemptReason {
        &self.reason
    }

    pub fn inputs(&self) -> &[InputReceipt] {
        &self.inputs
    }

    pub fn output_port(&self) -> Option<&str> {
        self.output_port.as_deref()
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }

    pub(crate) fn transition_to(&mut self, status: AttemptStatus, now: u64) {
        self.status = status;
        self.updated_at = now;
    }

    pub(crate) fn activate(&mut self, reason: AttemptReason, inputs: Vec<InputReceipt>, now: u64) {
        self.status = AttemptStatus::Ready;
        self.reason = reason;
        self.inputs = inputs;
        self.updated_at = now;
    }

    pub(crate) fn resolve(&mut self, status: AttemptStatus, output_port: String, now: u64) {
        self.status = status;
        self.output_port = Some(output_port);
        self.updated_at = now;
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeExecutionHistory {
    attempts: Vec<NodeAttempt>,
}

impl NodeExecutionHistory {
    pub(crate) fn initial(attempt: NodeAttempt) -> Self {
        Self {
            attempts: vec![attempt],
        }
    }

    pub(crate) fn from_durable(attempts: Vec<NodeAttempt>) -> Self {
        Self { attempts }
    }

    pub fn attempts(&self) -> &[NodeAttempt] {
        &self.attempts
    }

    pub fn current(&self) -> &NodeAttempt {
        self.attempts
            .last()
            .expect("node execution history cannot be empty")
    }

    pub(crate) fn current_mut(&mut self) -> &mut NodeAttempt {
        self.attempts
            .last_mut()
            .expect("node execution history cannot be empty")
    }

    pub(crate) fn append(&mut self, attempt: NodeAttempt) {
        self.attempts.push(attempt);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadyQueueItem {
    node_id: NodeId,
    fence: ExecutionFence,
    enqueued_at: u64,
}

impl ReadyQueueItem {
    pub(crate) fn for_attempt(attempt: &NodeAttempt, enqueued_at: u64) -> Self {
        Self {
            node_id: attempt.node_id.clone(),
            fence: attempt.fence.clone(),
            enqueued_at,
        }
    }

    pub(crate) fn from_durable(node_id: NodeId, fence: ExecutionFence, enqueued_at: u64) -> Self {
        Self {
            node_id,
            fence,
            enqueued_at,
        }
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn enqueued_at(&self) -> u64 {
        self.enqueued_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphState {
    definition: GraphDefinition,
    metadata: BTreeMap<OpaqueId, MetadataValue>,
    executions: BTreeMap<NodeId, NodeExecutionHistory>,
    ready_queue: Vec<ReadyQueueItem>,
}

impl GraphState {
    pub fn initialize(definition: GraphDefinition, now: u64) -> Self {
        let root_ids = definition.execution_root_ids();
        let mut executions = BTreeMap::new();
        let mut ready_queue = Vec::new();
        for node in definition.nodes() {
            let status = if root_ids.contains(node.id()) && !node.is_armed_start() {
                AttemptStatus::Ready
            } else {
                AttemptStatus::Pending
            };
            let attempt = NodeAttempt::create(
                node.id().clone(),
                node.kind(),
                NonZeroU32::MIN,
                status,
                AttemptReason::Initial,
                Vec::new(),
                now,
            );
            if status == AttemptStatus::Ready {
                ready_queue.push(ReadyQueueItem::for_attempt(&attempt, now));
            }
            executions.insert(node.id().clone(), NodeExecutionHistory::initial(attempt));
        }
        ready_queue.sort_by(|left, right| {
            left.enqueued_at
                .cmp(&right.enqueued_at)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
        Self {
            definition,
            metadata: BTreeMap::new(),
            executions,
            ready_queue,
        }
    }

    pub(crate) fn from_durable(
        definition: GraphDefinition,
        metadata: BTreeMap<OpaqueId, MetadataValue>,
        executions: BTreeMap<NodeId, NodeExecutionHistory>,
        ready_queue: Vec<ReadyQueueItem>,
    ) -> Self {
        Self {
            definition,
            metadata,
            executions,
            ready_queue,
        }
    }

    pub fn definition(&self) -> &GraphDefinition {
        &self.definition
    }

    pub fn metadata(&self) -> &BTreeMap<OpaqueId, MetadataValue> {
        &self.metadata
    }

    pub fn executions(&self) -> &BTreeMap<NodeId, NodeExecutionHistory> {
        &self.executions
    }

    pub fn current_attempt(&self, node_id: &NodeId) -> Option<&NodeAttempt> {
        self.executions
            .get(node_id)
            .map(NodeExecutionHistory::current)
    }

    pub fn ready_queue(&self) -> &[ReadyQueueItem] {
        &self.ready_queue
    }

    pub(crate) fn current_attempt_mut(&mut self, node_id: &NodeId) -> Option<&mut NodeAttempt> {
        self.executions
            .get_mut(node_id)
            .map(NodeExecutionHistory::current_mut)
    }

    pub(crate) fn append_attempt(&mut self, node_id: &NodeId, attempt: NodeAttempt) {
        self.executions
            .get_mut(node_id)
            .expect("definition nodes always have an execution history")
            .append(attempt);
    }

    pub(crate) fn enqueue(&mut self, attempt: &NodeAttempt, now: u64) {
        if self
            .ready_queue
            .iter()
            .all(|item| item.node_id != attempt.node_id)
        {
            self.ready_queue
                .push(ReadyQueueItem::for_attempt(attempt, now));
            self.ready_queue.sort_by(|left, right| {
                left.enqueued_at
                    .cmp(&right.enqueued_at)
                    .then_with(|| left.node_id.cmp(&right.node_id))
            });
        }
    }

    pub(crate) fn remove_ready_item(&mut self, node_id: &NodeId) {
        self.ready_queue.retain(|item| item.node_id != *node_id);
    }

    pub(crate) fn remove_ready_items(&mut self, node_ids: &[NodeId]) {
        self.ready_queue
            .retain(|item| !node_ids.contains(&item.node_id));
    }

    #[cfg(test)]
    pub(crate) fn reverse_ready_queue_for_test(&mut self) {
        self.ready_queue.reverse();
    }

    #[cfg(test)]
    pub(crate) fn replace_attempt_fence_for_test(
        &mut self,
        node_id: &NodeId,
        index: usize,
        fence: ExecutionFence,
    ) {
        self.attempt_for_test_mut(node_id, index).fence = fence;
    }

    #[cfg(test)]
    pub(crate) fn set_attempt_output_port_for_test(
        &mut self,
        node_id: &NodeId,
        index: usize,
        output_port: Option<&str>,
    ) {
        self.attempt_for_test_mut(node_id, index).output_port = output_port.map(str::to_owned);
    }

    #[cfg(test)]
    fn attempt_for_test_mut(&mut self, node_id: &NodeId, index: usize) -> &mut NodeAttempt {
        &mut self
            .executions
            .get_mut(node_id)
            .expect("test node exists")
            .attempts[index]
    }
}
