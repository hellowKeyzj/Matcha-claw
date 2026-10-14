use std::{collections::{BTreeMap, BTreeSet}, num::NonZeroU32};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NodePosition {
    x: i64,
    y: i64,
}

impl NodePosition {
    pub const fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }

    pub const fn x(&self) -> i64 {
        self.x
    }

    pub const fn y(&self) -> i64 {
        self.y
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GraphLayout {
    node_positions: BTreeMap<NodeId, NodePosition>,
}

impl GraphLayout {
    pub fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn from_durable(node_positions: BTreeMap<NodeId, NodePosition>) -> Self {
        Self { node_positions }
    }

    pub fn node_positions(&self) -> &BTreeMap<NodeId, NodePosition> {
        &self.node_positions
    }

    pub(crate) fn set_node_position(&mut self, node_id: NodeId, position: NodePosition) {
        self.node_positions.insert(node_id, position);
    }

    pub(crate) fn remove_node(&mut self, node_id: &NodeId) {
        self.node_positions.remove(node_id);
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct GraphChanges {
    pub(crate) definition: bool,
    pub(crate) metadata: BTreeSet<OpaqueId>,
    pub(crate) layout: BTreeSet<NodeId>,
    pub(crate) attempts: BTreeSet<(NodeId, u32)>,
    pub(crate) ready: BTreeSet<NodeId>,
    pub(crate) removed_nodes: BTreeSet<NodeId>,
}

#[derive(Clone, Debug, Default)]
struct GraphMutation {
    changes: GraphChanges,
    definition: Option<GraphDefinition>,
    metadata: BTreeMap<OpaqueId, Option<MetadataValue>>,
    layout: BTreeMap<NodeId, Option<NodePosition>>,
    attempts: BTreeMap<(NodeId, u32), Option<NodeAttempt>>,
    histories: BTreeMap<NodeId, Option<NodeExecutionHistory>>,
    ready: BTreeMap<NodeId, Option<ReadyQueueItem>>,
}

#[derive(Clone, Debug)]
pub struct GraphState {
    definition: GraphDefinition,
    metadata: BTreeMap<OpaqueId, MetadataValue>,
    layout: GraphLayout,
    executions: BTreeMap<NodeId, NodeExecutionHistory>,
    ready_queue: Vec<ReadyQueueItem>,
    mutation: Option<GraphMutation>,
}

impl PartialEq for GraphState {
    fn eq(&self, other: &Self) -> bool {
        self.definition == other.definition
            && self.metadata == other.metadata
            && self.layout == other.layout
            && self.executions == other.executions
            && self.ready_queue == other.ready_queue
    }
}

impl Eq for GraphState {}

impl GraphState {
    pub fn initialize(definition: GraphDefinition, now: u64) -> Self {
        Self::initialize_with_layout(definition, GraphLayout::empty(), now)
    }

    pub(crate) fn initialize_with_layout(
        definition: GraphDefinition,
        layout: GraphLayout,
        now: u64,
    ) -> Self {
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
            layout,
            executions,
            ready_queue,
            mutation: None,
        }
    }

    pub(crate) fn from_durable(
        definition: GraphDefinition,
        metadata: BTreeMap<OpaqueId, MetadataValue>,
        layout: GraphLayout,
        executions: BTreeMap<NodeId, NodeExecutionHistory>,
        ready_queue: Vec<ReadyQueueItem>,
    ) -> Self {
        Self {
            definition,
            metadata,
            layout,
            executions,
            ready_queue,
            mutation: None,
        }
    }

    pub(crate) fn begin_mutation(&mut self) {
        if self.mutation.is_none() {
            self.mutation = Some(GraphMutation::default());
        }
    }

    pub(crate) fn changes(&self) -> Option<&GraphChanges> {
        self.mutation.as_ref().map(|mutation| &mutation.changes)
    }

    pub(crate) fn commit_mutation(&mut self) {
        self.mutation = None;
    }

    pub(crate) fn rollback_mutation(&mut self) {
        let Some(mutation) = self.mutation.take() else { return };
        if let Some(definition) = mutation.definition {
            self.definition = definition;
        }
        for (key, value) in mutation.metadata {
            match value {
                Some(value) => { self.metadata.insert(key, value); }
                None => { self.metadata.remove(&key); }
            }
        }
        for (node, position) in mutation.layout {
            match position {
                Some(position) => { self.layout.node_positions.insert(node, position); }
                None => { self.layout.node_positions.remove(&node); }
            }
        }
        for (node, history) in mutation.histories {
            match history {
                Some(history) => { self.executions.insert(node, history); }
                None => { self.executions.remove(&node); }
            }
        }
        for ((node, number), attempt) in mutation.attempts.into_iter().rev() {
            let Some(history) = self.executions.get_mut(&node) else { continue };
            let index = number as usize - 1;
            match attempt {
                Some(attempt) => history.attempts[index] = attempt,
                None => history.attempts.truncate(index),
            }
        }
        self.ready_queue.retain(|item| !mutation.ready.contains_key(item.node_id()));
        self.ready_queue.extend(mutation.ready.into_values().flatten());
        self.ready_queue.sort_by(|left, right| {
            left.enqueued_at.cmp(&right.enqueued_at).then_with(|| left.node_id.cmp(&right.node_id))
        });
    }

    pub(crate) fn apply_event(&mut self, event: super::GraphEvent) -> Result<(), super::ReduceError> {
        let standalone = self.mutation.is_none();
        self.begin_mutation();
        let result = super::reducer::reduce_in_place(self, event);
        if standalone {
            if result.is_ok() { self.commit_mutation(); } else { self.rollback_mutation(); }
        }
        result
    }

    pub(crate) fn settle_superseded(&mut self, event: super::GraphEvent) -> Result<(), super::ReduceError> {
        let standalone = self.mutation.is_none();
        self.begin_mutation();
        let result = super::reducer::settle_superseded_in_place(self, event);
        if standalone {
            if result.is_ok() { self.commit_mutation(); } else { self.rollback_mutation(); }
        }
        result
    }

    fn remember_attempt(&mut self, node: &NodeId, number: u32) {
        if let Some(mutation) = &mut self.mutation {
            let key = (node.clone(), number);
            mutation.changes.attempts.insert(key.clone());
            if !mutation.histories.contains_key(node) {
                mutation.attempts.entry(key).or_insert_with(|| {
                    self.executions.get(node).and_then(|history| history.attempts.get(number as usize - 1)).cloned()
                });
            }
        }
    }

    fn remember_ready(&mut self, node: &NodeId) {
        if let Some(mutation) = &mut self.mutation {
            mutation.changes.ready.insert(node.clone());
            mutation.ready.entry(node.clone()).or_insert_with(|| {
                self.ready_queue.iter().find(|item| item.node_id() == node).cloned()
            });
        }
    }

    pub(super) fn remember_metadata(&mut self, key: &OpaqueId) {
        if let Some(mutation) = &mut self.mutation {
            mutation.changes.metadata.insert(key.clone());
            mutation.metadata.entry(key.clone()).or_insert_with(|| self.metadata.get(key).cloned());
        }
    }

    pub(super) fn remember_position(&mut self, node: &NodeId) {
        if let Some(mutation) = &mut self.mutation {
            mutation.changes.layout.insert(node.clone());
            mutation.layout.entry(node.clone()).or_insert_with(|| self.layout.node_positions.get(node).copied());
        }
    }

    pub(super) fn take_history(&mut self, node: &NodeId) -> Option<NodeExecutionHistory> {
        self.executions.remove(node)
    }

    pub(super) fn remember_new_history(&mut self, node: &NodeId) {
        if let Some(mutation) = &mut self.mutation {
            mutation.histories.entry(node.clone()).or_insert(None);
            mutation.changes.attempts.insert((node.clone(), 1));
        }
    }

    pub(super) fn finish_patch(
        &mut self,
        definition: GraphDefinition,
        metadata: BTreeMap<OpaqueId, MetadataValue>,
        layout: GraphLayout,
        executions: BTreeMap<NodeId, NodeExecutionHistory>,
        ready_queue: Vec<ReadyQueueItem>,
    ) {
        if let Some(mutation) = &mut self.mutation {
            if definition != self.definition {
                mutation.changes.definition = true;
                mutation.definition.get_or_insert_with(|| self.definition.clone());
            }
            for (node, history) in std::mem::take(&mut self.executions) {
                mutation.changes.removed_nodes.insert(node.clone());
                mutation.histories.entry(node).or_insert(Some(history));
            }
            for node in self.ready_queue.iter().chain(ready_queue.iter()).map(ReadyQueueItem::node_id) {
                let old = self.ready_queue.iter().find(|item| item.node_id() == node);
                let new = ready_queue.iter().find(|item| item.node_id() == node);
                if old != new {
                    mutation.changes.ready.insert(node.clone());
                    mutation.ready.entry(node.clone()).or_insert_with(|| old.cloned());
                }
            }
        }
        self.definition = definition;
        self.metadata = metadata;
        self.layout = layout;
        self.executions = executions;
        self.ready_queue = ready_queue;
    }

    pub(crate) fn replace_with(&mut self, replacement: GraphState) {
        if let Some(mutation) = &mut self.mutation {
            mutation.changes.definition = true;
            mutation.definition.get_or_insert_with(|| self.definition.clone());
            for key in self.metadata.keys().chain(replacement.metadata.keys()) {
                mutation.changes.metadata.insert(key.clone());
                mutation.metadata.entry(key.clone()).or_insert_with(|| self.metadata.get(key).cloned());
            }
            for node in self.layout.node_positions.keys().chain(replacement.layout.node_positions.keys()) {
                mutation.changes.layout.insert(node.clone());
                mutation.layout.entry(node.clone()).or_insert_with(|| self.layout.node_positions.get(node).copied());
            }
            for (node, history) in std::mem::take(&mut self.executions) {
                mutation.changes.removed_nodes.insert(node.clone());
                mutation.histories.entry(node).or_insert(Some(history));
            }
            for (node, history) in &replacement.executions {
                mutation.histories.entry(node.clone()).or_insert(None);
                mutation.changes.attempts.extend(history.attempts().iter().map(|attempt| (node.clone(), attempt.number().get())));
            }
            for node in self.ready_queue.iter().chain(replacement.ready_queue.iter()).map(ReadyQueueItem::node_id) {
                mutation.changes.ready.insert(node.clone());
                mutation.ready.entry(node.clone()).or_insert_with(|| self.ready_queue.iter().find(|item| item.node_id() == node).cloned());
            }
        }
        self.definition = replacement.definition;
        self.metadata = replacement.metadata;
        self.layout = replacement.layout;
        self.executions = replacement.executions;
        self.ready_queue = replacement.ready_queue;
    }

    pub(crate) fn validate_changes(&self) -> Result<(), ()> {
        let Some(mutation) = &self.mutation else { return Ok(()) };
        let changes = &mutation.changes;
        if changes.definition {
            self.definition.validate_structure().map_err(|_| ())?;
            if self.definition.nodes().len() != self.executions.len()
                || self.definition.nodes().iter().any(|node| !self.executions.contains_key(node.id()))
            { return Err(()); }
        }
        for (node, number) in &changes.attempts {
            let Some(history) = self.executions.get(node) else { continue };
            let attempt = history.attempts.get(*number as usize - 1).ok_or(())?;
            let definition = self.definition.node(node).ok_or(())?;
            let fence = AttemptId::for_node(node, attempt.number());
            if attempt.number().get() != *number || attempt.node_id() != node
                || attempt.node_kind() != definition.kind() || attempt.number() > definition.max_attempts()
                || attempt.fence().attempt_id() != &fence
                || attempt.fence().node_execution_id() != &NodeExecutionId::for_attempt(&fence)
                || attempt.updated_at() < attempt.created_at()
                || (matches!(attempt.status(), AttemptStatus::Completed | AttemptStatus::Failed) != attempt.output_port().is_some())
            { return Err(()); }
            super::durable::validate_attempt(self, node, attempt).map_err(|_| ())?;
        }
        if changes.definition {
            for (node, history) in &self.executions {
                let definition = self.definition.node(node).ok_or(())?;
                for attempt in history.attempts() {
                    if attempt.number() > definition.max_attempts() { return Err(()); }
                    super::durable::validate_attempt(self, node, attempt).map_err(|_| ())?;
                }
            }
        }
        for node in &changes.layout {
            if self.layout.node_positions.contains_key(node) && self.definition.node(node).is_none() { return Err(()); }
        }
        for node in changes.ready.iter().chain(changes.attempts.iter().map(|(node, _)| node)) {
            let current = self.current_attempt(node);
            let mut ready = self.ready_queue.iter().filter(|item| item.node_id() == node);
            match (current, ready.next()) {
                (Some(attempt), Some(item)) if attempt.status() == AttemptStatus::Ready && attempt.fence() == item.fence() => {}
                (Some(attempt), None) if attempt.status() != AttemptStatus::Ready => {}
                (None, None) => {}
                _ => return Err(()),
            }
            if ready.next().is_some() { return Err(()); }
        }
        Ok(())
    }

    pub(crate) fn import_definition(&mut self, definition: GraphDefinition) {
        self.definition = definition;
    }

    pub(crate) fn import_metadata(&mut self, key: OpaqueId, value: Option<MetadataValue>) {
        match value {
            Some(value) => { self.metadata.insert(key, value); }
            None => { self.metadata.remove(&key); }
        }
    }

    pub(crate) fn import_position(&mut self, node: NodeId, value: Option<NodePosition>) {
        match value {
            Some(value) => { self.layout.node_positions.insert(node, value); }
            None => { self.layout.node_positions.remove(&node); }
        }
    }

    pub(crate) fn import_attempt(&mut self, attempt: NodeAttempt) -> Result<(), ()> {
        let history = self.executions.entry(attempt.node_id().clone()).or_insert_with(|| NodeExecutionHistory::from_durable(Vec::new()));
        let index = attempt.number().get() as usize - 1;
        if index == history.attempts.len() { history.attempts.push(attempt); }
        else if index < history.attempts.len() { history.attempts[index] = attempt; }
        else { return Err(()); }
        Ok(())
    }

    pub(crate) fn remove_attempt_record(&mut self, execution_id: &str) {
        let Some((node, number)) = execution_id.rsplit_once(":attempt:") else { return };
        let Ok(number) = number.parse::<u32>() else { return };
        let node = NodeId::new(node);
        if let Some(history) = self.executions.get_mut(&node) {
            history.attempts.retain(|attempt| attempt.number().get() != number);
            if history.attempts.is_empty() { self.executions.remove(&node); }
        }
    }

    pub(crate) fn import_ready(&mut self, node: &NodeId, value: Option<ReadyQueueItem>) {
        self.ready_queue.retain(|item| item.node_id() != node);
        if let Some(value) = value { self.ready_queue.push(value); }
        self.ready_queue.sort_by(|left, right| left.enqueued_at.cmp(&right.enqueued_at).then_with(|| left.node_id.cmp(&right.node_id)));
    }

    pub(crate) fn previous_attempt(&self, node: &NodeId, number: u32) -> Option<&NodeAttempt> {
        let mutation = self.mutation.as_ref()?;
        if let Some(previous) = mutation.attempts.get(&(node.clone(), number)) { return previous.as_ref(); }
        if let Some(previous) = mutation.histories.get(node) {
            return previous.as_ref().and_then(|history| history.attempts.get(number as usize - 1));
        }
        self.executions.get(node).and_then(|history| history.attempts.get(number as usize - 1))
    }

    pub(crate) fn removed_attempts(&self) -> impl Iterator<Item = &NodeAttempt> {
        self.mutation.iter().flat_map(|mutation| {
            mutation.changes.removed_nodes.iter().filter_map(|node| mutation.histories.get(node).and_then(Option::as_ref))
                .flat_map(|history| history.attempts())
        })
    }

    pub fn definition(&self) -> &GraphDefinition {
        &self.definition
    }

    pub fn metadata(&self) -> &BTreeMap<OpaqueId, MetadataValue> {
        &self.metadata
    }

    pub fn layout(&self) -> &GraphLayout {
        &self.layout
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
        let number = self.current_attempt(node_id)?.number().get();
        self.remember_attempt(node_id, number);
        self.executions
            .get_mut(node_id)
            .map(NodeExecutionHistory::current_mut)
    }

    pub(crate) fn superseded_attempt_mut(
        &mut self,
        node_id: &NodeId,
        fence: &ExecutionFence,
    ) -> Option<&mut NodeAttempt> {
        let history = self.executions.get(node_id)?;
        let (_, superseded) = history.attempts.split_last()?;
        let number = superseded.iter().find(|attempt| attempt.fence() == fence)?.number().get();
        self.remember_attempt(node_id, number);
        let history = self.executions.get_mut(node_id)?;
        let (_, superseded) = history.attempts.split_last_mut()?;
        superseded
            .iter_mut()
            .find(|attempt| attempt.fence() == fence)
    }

    pub(crate) fn append_attempt(&mut self, node_id: &NodeId, attempt: NodeAttempt) {
        self.remember_attempt(node_id, attempt.number().get());
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
            self.remember_ready(attempt.node_id());
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
        if self.ready_queue.iter().any(|item| item.node_id() == node_id) {
            self.remember_ready(node_id);
            self.ready_queue.retain(|item| item.node_id != *node_id);
        }
    }

    pub(crate) fn remove_ready_items(&mut self, node_ids: &[NodeId]) {
        for node in node_ids { self.remove_ready_item(node); }
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
