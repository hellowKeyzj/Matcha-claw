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
    kind: Kind,
    status: Status,
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
enum Kind { Start, Work, Review, HumanDecision, ScriptReview, Join, End }
#[derive(Serialize, Deserialize)]
enum Status { Pending, Ready, Running, Waiting, Completed, Failed, Cancelled }
#[derive(Serialize, Deserialize)]
enum Reason { Initial, Trigger, Edge(String), Rework }
#[derive(Serialize, Deserialize)]
enum Action { Activate, Rework, Gate, Finish }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input { edge: String, action: Action, source: String, source_port: String, target_port: String, fence: Fence, arrived: u64 }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready { node: String, fence: Fence, enqueued: u64 }

pub(super) fn encode_attempt(team: &TeamId, run: &GraphRunId, attempt: &NodeAttempt) -> Result<StoredRecord, StoreFault> {
    let kind = match attempt.node_kind() { NodeKind::Start => Kind::Start, NodeKind::Work => Kind::Work, NodeKind::Review => Kind::Review, NodeKind::HumanDecision => Kind::HumanDecision, NodeKind::ScriptReview => Kind::ScriptReview, NodeKind::Join => Kind::Join, NodeKind::End => Kind::End };
    let status = match attempt.status() { AttemptStatus::Pending => Status::Pending, AttemptStatus::Ready => Status::Ready, AttemptStatus::Running => Status::Running, AttemptStatus::Waiting => Status::Waiting, AttemptStatus::Completed => Status::Completed, AttemptStatus::Failed => Status::Failed, AttemptStatus::Cancelled => Status::Cancelled };
    let reason = match attempt.reason() { AttemptReason::Initial => Reason::Initial, AttemptReason::Trigger => Reason::Trigger, AttemptReason::Edge(edge) => Reason::Edge(edge.as_str().to_owned()), AttemptReason::Rework => Reason::Rework };
    let inputs = attempt.inputs().iter().map(|input| Input {
        edge: input.edge_id().as_str().to_owned(),
        action: match input.action() { EdgeAction::Activate => Action::Activate, EdgeAction::Rework => Action::Rework, EdgeAction::Gate => Action::Gate, EdgeAction::Finish => Action::Finish },
        source: input.source_node_id().as_str().to_owned(), source_port: input.source_port().to_owned(), target_port: input.target_port().to_owned(), fence: Fence::from_domain(input.source_fence()), arrived: input.arrived_at(),
    }).collect();
    record(team, run, RecordKind::Attempt, attempt.fence().node_execution_id().as_str(), &Attempt {
        fence: Fence::from_domain(attempt.fence()), number: attempt.number().get(), node: attempt.node_id().as_str().to_owned(), kind, status, reason, inputs, output: attempt.output_port().map(str::to_owned), created: attempt.created_at(), updated: attempt.updated_at(),
    })
}

pub(super) fn decode_attempt(row: &StoredRecord) -> Result<NodeAttempt, StoreFault> {
    let value: Attempt = decode(row, RecordKind::Attempt)?;
    if row.key.id != value.fence.1 { return Err(StoreFault::InvalidFacts); }
    let number = NonZeroU32::new(value.number).ok_or(StoreFault::InvalidFacts)?;
    let node_id = NodeId::new(value.node);
    if value.fence.0 != crate::AttemptId::for_node(&node_id, number).as_str() || value.fence.1 != value.fence.0 { return Err(StoreFault::InvalidFacts); }
    let kind = match value.kind { Kind::Start => NodeKind::Start, Kind::Work => NodeKind::Work, Kind::Review => NodeKind::Review, Kind::HumanDecision => NodeKind::HumanDecision, Kind::ScriptReview => NodeKind::ScriptReview, Kind::Join => NodeKind::Join, Kind::End => NodeKind::End };
    let status = match value.status { Status::Pending => AttemptStatus::Pending, Status::Ready => AttemptStatus::Ready, Status::Running => AttemptStatus::Running, Status::Waiting => AttemptStatus::Waiting, Status::Completed => AttemptStatus::Completed, Status::Failed => AttemptStatus::Failed, Status::Cancelled => AttemptStatus::Cancelled };
    if value.updated < value.created || (matches!(status, AttemptStatus::Completed | AttemptStatus::Failed) != value.output.is_some()) { return Err(StoreFault::InvalidFacts); }
    let reason = match value.reason { Reason::Initial => AttemptReason::Initial, Reason::Trigger => AttemptReason::Trigger, Reason::Edge(edge) => AttemptReason::Edge(EdgeId::new(edge)), Reason::Rework => AttemptReason::Rework };
    let inputs = value.inputs.into_iter().map(|input| InputReceipt::from_durable(
        EdgeId::new(input.edge), match input.action { Action::Activate => EdgeAction::Activate, Action::Rework => EdgeAction::Rework, Action::Gate => EdgeAction::Gate, Action::Finish => EdgeAction::Finish },
        NodeId::new(input.source), input.source_port, input.target_port, input.fence.into_domain(), input.arrived,
    )).collect();
    Ok(NodeAttempt::from_durable(NodeAttemptDurableInput { fence: value.fence.into_domain(), number, node_id, node_kind: kind, status, reason, inputs, output_port: value.output, created_at: value.created, updated_at: value.updated }))
}

pub(super) fn encode_ready(team: &TeamId, run: &GraphRunId, item: &ReadyQueueItem) -> Result<StoredRecord, StoreFault> {
    record(team, run, RecordKind::ReadyQueue, item.node_id().as_str(), &Ready { node: item.node_id().as_str().to_owned(), fence: Fence::from_domain(item.fence()), enqueued: item.enqueued_at() })
}

pub(super) fn decode_ready(row: &StoredRecord) -> Result<ReadyQueueItem, StoreFault> {
    let item: Ready = decode(row, RecordKind::ReadyQueue)?;
    if row.key.id != item.node { return Err(StoreFault::InvalidFacts); }
    Ok(ReadyQueueItem::from_durable(NodeId::new(item.node), item.fence.into_domain(), item.enqueued))
}
