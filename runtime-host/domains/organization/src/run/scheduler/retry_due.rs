use crate::{
    OrganizationFacts,
    run::{
        delivery::{DeliveryId, DeliveryPhase},
        graph::{GraphRunId, NodeId},
        lifecycle::GraphRunLifecycleState,
    },
};

/// Read-only input for the durable Team node-prompt retry wake query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodePromptRetryDueQuery {
    run_id: GraphRunId,
    now: u64,
}

impl NodePromptRetryDueQuery {
    pub fn new(run_id: GraphRunId, now: u64) -> Result<Self, NodePromptRetryDueQueryError> {
        if run_id.as_str().trim().is_empty() {
            return Err(NodePromptRetryDueQueryError::InvalidRunId);
        }
        Ok(Self { run_id, now })
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub const fn now(&self) -> u64 {
        self.now
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodePromptRetryDueQueryError {
    InvalidRunId,
}

/// Durable identity and retry timing for one node-prompt delivery.
///
/// The item intentionally contains no prompt payload, role session, runtime receipt, or native
/// binding. It is a scheduling fact, not a dispatch request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodePromptRetryDueItem {
    delivery_id: DeliveryId,
    node_id: NodeId,
    node_execution_id: String,
    resolution: NodePromptRetryDueResolution,
}

impl NodePromptRetryDueItem {
    fn new(
        delivery_id: DeliveryId,
        node_id: NodeId,
        node_execution_id: String,
        resolution: NodePromptRetryDueResolution,
    ) -> Self {
        Self {
            delivery_id,
            node_id,
            node_execution_id,
            resolution,
        }
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub fn resolution(&self) -> &NodePromptRetryDueResolution {
        &self.resolution
    }
}

/// Classification of durable delivery facts for a retry wake.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodePromptRetryDueResolution {
    Due { retry_at: u64 },
    NotDue { retry_at: u64 },
    Unknown(NodePromptRetryDueUnknownReason),
    Invalid(NodePromptRetryDueInvalidReason),
}

impl NodePromptRetryDueResolution {
    pub const fn retry_at(&self) -> Option<u64> {
        match self {
            Self::Due { retry_at } | Self::NotDue { retry_at } => Some(*retry_at),
            Self::Unknown(_) | Self::Invalid(_) => None,
        }
    }

    pub const fn is_due(&self) -> bool {
        matches!(self, Self::Due { .. })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodePromptRetryDueUnknownReason {
    RunUnavailable,
    RunLifecycleUncertain,
    RuntimeReceiptUnavailable,
    DeliveryPending,
    DeliveryInFlight,
    DeliveryOutcomeUnknown,
    DeliveryTerminalObserved,
    DeliveryTerminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodePromptRetryDueInvalidReason {
    InvalidFacts,
    StaleDeliveryIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodePromptRetryDuePlan {
    run_id: GraphRunId,
    items: Vec<NodePromptRetryDueItem>,
    next_retry_at: Option<u64>,
}

impl NodePromptRetryDuePlan {
    fn new(run_id: GraphRunId, items: Vec<NodePromptRetryDueItem>) -> Self {
        let next_retry_at = items
            .iter()
            .filter_map(|item| item.resolution().retry_at())
            .min();
        Self {
            run_id,
            items,
            next_retry_at,
        }
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn items(&self) -> &[NodePromptRetryDueItem] {
        &self.items
    }

    pub fn due_items(&self) -> impl Iterator<Item = &NodePromptRetryDueItem> {
        self.items.iter().filter(|item| item.resolution().is_due())
    }

    pub const fn next_retry_at(&self) -> Option<u64> {
        self.next_retry_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodePromptRetryDueQueryOutcome {
    Available(NodePromptRetryDuePlan),
    Unknown(NodePromptRetryDueUnknownReason),
    Invalid(NodePromptRetryDueInvalidReason),
}

/// Produces a retry wake plan directly from Organization durable facts.
///
/// Only `DeliveryPhase::RetryScheduled { retry_at, .. }` can produce `Due` or `NotDue`. Pending,
/// in-flight, terminal-observed, terminal, and outcome-unknown phases remain explicit `Unknown`
/// facts; this producer never claims that a scheduler loop or a native dispatch succeeded.
pub fn produce_node_prompt_retry_due(
    facts: &OrganizationFacts,
    query: &NodePromptRetryDueQuery,
) -> NodePromptRetryDueQueryOutcome {
    if facts.validate().is_err() {
        return NodePromptRetryDueQueryOutcome::Invalid(
            NodePromptRetryDueInvalidReason::InvalidFacts,
        );
    }

    let Some(run) = facts.run(query.run_id()) else {
        return NodePromptRetryDueQueryOutcome::Unknown(
            NodePromptRetryDueUnknownReason::RunUnavailable,
        );
    };

    if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
        return NodePromptRetryDueQueryOutcome::Unknown(
            NodePromptRetryDueUnknownReason::RunLifecycleUncertain,
        );
    }
    if run.runtime().is_none() {
        return NodePromptRetryDueQueryOutcome::Unknown(
            NodePromptRetryDueUnknownReason::RuntimeReceiptUnavailable,
        );
    }

    let mut items = Vec::new();
    for delivery in facts
        .deliveries()
        .deliveries()
        .filter(|delivery| delivery.facts().run_id == query.run_id().as_str())
    {
        let delivery_facts = delivery.facts();
        let node_id = NodeId::new(delivery_facts.node_id.clone());
        let resolution =
            if !delivery_identity_matches_run(run, &node_id, &delivery_facts.node_execution_id) {
                NodePromptRetryDueResolution::Invalid(
                    NodePromptRetryDueInvalidReason::StaleDeliveryIdentity,
                )
            } else {
                match delivery.phase() {
                    DeliveryPhase::RetryScheduled { retry_at, .. } if query.now() >= *retry_at => {
                        NodePromptRetryDueResolution::Due {
                            retry_at: *retry_at,
                        }
                    }
                    DeliveryPhase::RetryScheduled { retry_at, .. } => {
                        NodePromptRetryDueResolution::NotDue {
                            retry_at: *retry_at,
                        }
                    }
                    DeliveryPhase::Pending => NodePromptRetryDueResolution::Unknown(
                        NodePromptRetryDueUnknownReason::DeliveryPending,
                    ),
                    DeliveryPhase::Delivering(_) => NodePromptRetryDueResolution::Unknown(
                        NodePromptRetryDueUnknownReason::DeliveryInFlight,
                    ),
                    DeliveryPhase::OutcomeUnknown { .. } => NodePromptRetryDueResolution::Unknown(
                        NodePromptRetryDueUnknownReason::DeliveryOutcomeUnknown,
                    ),
                    DeliveryPhase::TerminalObserved { .. } => {
                        NodePromptRetryDueResolution::Unknown(
                            NodePromptRetryDueUnknownReason::DeliveryTerminalObserved,
                        )
                    }
                    DeliveryPhase::Delivered { .. }
                    | DeliveryPhase::Failed { .. }
                    | DeliveryPhase::Cancelled { .. } => NodePromptRetryDueResolution::Unknown(
                        NodePromptRetryDueUnknownReason::DeliveryTerminal,
                    ),
                }
            };
        items.push(NodePromptRetryDueItem::new(
            delivery_facts.delivery_id.clone(),
            node_id,
            delivery_facts.node_execution_id.clone(),
            resolution,
        ));
    }

    NodePromptRetryDueQueryOutcome::Available(NodePromptRetryDuePlan::new(
        query.run_id().clone(),
        items,
    ))
}

/// Query alias for callers that name this read-only producer as a query.
pub fn query_node_prompt_retry_due(
    facts: &OrganizationFacts,
    query: &NodePromptRetryDueQuery,
) -> NodePromptRetryDueQueryOutcome {
    produce_node_prompt_retry_due(facts, query)
}

fn delivery_identity_matches_run(
    run: &crate::GraphRunFacts,
    node_id: &NodeId,
    node_execution_id: &str,
) -> bool {
    run.graph()
        .current_attempt(node_id)
        .is_some_and(|attempt| attempt.fence().node_execution_id().as_str() == node_execution_id)
}
