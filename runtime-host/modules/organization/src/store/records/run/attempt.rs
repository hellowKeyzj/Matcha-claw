use std::num::NonZeroU32;
use serde::{Deserialize, Serialize};
use crate::{
    GraphRunId, TeamId,
    run::graph::{AttemptReason, AttemptStatus, EdgeAction, EdgeId, ExecutionFence, InputReceipt,
        NodeAttempt, NodeAttemptDurableInput, NodeId, NodeKind, ReadyQueueItem},
    store::{StoreFault, schema::{RecordKind, StoredRecord}},
};
use super::{decode, record};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attempt {
    fence: Fence,
    number: u32,
    node: String,
    #[serde(with = "Kind")]
    kind: NodeKind,
    #[serde(with = "Status")]
    status: AttemptStatus,
    reason: Reason,
    inputs: Vec<Input>,
    output: Option<String>,
    created: u64,
    updated: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Fence(pub(super) String, pub(super) String);
impl Fence {
    pub(super) fn from_domain(value: &ExecutionFence) -> Self { Self(value.attempt_id().as_str().to_owned(), value.node_execution_id().as_str().to_owned()) }
    pub(super) fn into_domain(self) -> ExecutionFence { ExecutionFence::from_durable(self.0, self.1) }
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "NodeKind")]
enum Kind { Start, Work, Review, HumanDecision, ScriptReview, Join, End }
#[derive(Serialize, Deserialize)]
#[serde(remote = "AttemptStatus")]
enum Status { Pending, Ready, Running, Waiting, Completed, Failed, Cancelled }
#[derive(Serialize, Deserialize)]
enum Reason { Initial, Trigger, Edge(String), Rework }
#[derive(Serialize, Deserialize)]
#[serde(remote = "EdgeAction")]
enum Action { Activate, Rework, Gate, Finish }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input { edge: String, #[serde(with = "Action")] action: EdgeAction, source: String, source_port: String, target_port: String, fence: Fence, arrived: u64 }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready { node: String, fence: Fence, enqueued: u64 }

pub(super) fn encode_attempt(team: &TeamId, run: &GraphRunId, attempt: &NodeAttempt) -> Result<StoredRecord, StoreFault> {
    let reason = match attempt.reason() { AttemptReason::Initial => Reason::Initial, AttemptReason::Trigger => Reason::Trigger, AttemptReason::Edge(edge) => Reason::Edge(edge.as_str().to_owned()), AttemptReason::Rework => Reason::Rework };
    let inputs = attempt.inputs().iter().map(|input| Input {
        edge: input.edge_id().as_str().to_owned(),
        action: input.action(),
        source: input.source_node_id().as_str().to_owned(), source_port: input.source_port().to_owned(), target_port: input.target_port().to_owned(), fence: Fence::from_domain(input.source_fence()), arrived: input.arrived_at(),
    }).collect();
    record(team, run, RecordKind::Attempt, attempt.fence().node_execution_id().as_str(), &Attempt {
        fence: Fence::from_domain(attempt.fence()), number: attempt.number().get(), node: attempt.node_id().as_str().to_owned(), kind: attempt.node_kind(), status: attempt.status(), reason, inputs, output: attempt.output_port().map(str::to_owned), created: attempt.created_at(), updated: attempt.updated_at(),
    })
}

pub(super) fn decode_attempt(row: &StoredRecord) -> Result<NodeAttempt, StoreFault> {
    let value: Attempt = decode(row, RecordKind::Attempt)?;
    if row.key.id != value.fence.1 { return Err(StoreFault::InvalidFacts); }
    let number = NonZeroU32::new(value.number).ok_or(StoreFault::InvalidFacts)?;
    let node_id = NodeId::new(value.node);
    if value.fence.0 != crate::AttemptId::for_node(&node_id, number).as_str()
        || !crate::NodeExecutionId::from_durable(value.fence.1.clone())
            .matches_attempt(&node_id, number)
    {
        return Err(StoreFault::InvalidFacts);
    }
    if value.updated < value.created || (matches!(value.status, AttemptStatus::Completed | AttemptStatus::Failed) != value.output.is_some()) { return Err(StoreFault::InvalidFacts); }
    let reason = match value.reason { Reason::Initial => AttemptReason::Initial, Reason::Trigger => AttemptReason::Trigger, Reason::Edge(edge) => AttemptReason::Edge(EdgeId::new(edge)), Reason::Rework => AttemptReason::Rework };
    let inputs = value.inputs.into_iter().map(|input| InputReceipt::from_durable(
        EdgeId::new(input.edge), input.action,
        NodeId::new(input.source), input.source_port, input.target_port, input.fence.into_domain(), input.arrived,
    )).collect();
    Ok(NodeAttempt::from_durable(NodeAttemptDurableInput { fence: value.fence.into_domain(), number, node_id, node_kind: value.kind, status: value.status, reason, inputs, output_port: value.output, created_at: value.created, updated_at: value.updated }))
}

pub(super) fn encode_ready(team: &TeamId, run: &GraphRunId, item: &ReadyQueueItem) -> Result<StoredRecord, StoreFault> {
    record(team, run, RecordKind::ReadyQueue, item.node_id().as_str(), &Ready { node: item.node_id().as_str().to_owned(), fence: Fence::from_domain(item.fence()), enqueued: item.enqueued_at() })
}

pub(super) fn decode_ready(row: &StoredRecord) -> Result<ReadyQueueItem, StoreFault> {
    let item: Ready = decode(row, RecordKind::ReadyQueue)?;
    if row.key.id != item.node { return Err(StoreFault::InvalidFacts); }
    Ok(ReadyQueueItem::from_durable(NodeId::new(item.node), item.fence.into_domain(), item.enqueued))
}
