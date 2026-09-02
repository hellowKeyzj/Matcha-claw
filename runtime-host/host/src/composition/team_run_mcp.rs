use organization::run::event::{
    ApprovalAction, ApprovalCommand, CommandPayload, GraphEdgeAction, GraphNodeKind,
    GraphPatch as CommandGraphPatch, GraphPatchOperation as CommandGraphPatchOperation,
    NodeProgressCommand, OpaqueId, RunCommand,
};
use organization::run::{
    control::AgentNodeEventResolution,
    delivery::{
        AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionReceipt, DeliveryId,
        DeliveryPhase, NativeTerminalStatus,
    },
};
use organization::{
    EdgeAction, EvidenceId, EvidenceRecord, EvidenceReference, EvidenceReferenceKind, GraphPatch,
    GraphPatchOperation, GraphRunId, NodeKind, OrganizationStore, RecordOutcome, StoreFault,
    TeamDecisionCommand, TeamDecisionType, TeamGraphContextQuery, TeamGraphContextResult,
    TeamGraphContextView, TeamId, TeamNodeEvent, TeamNodeEventKind,
};

/// The fixed semantic boundary for the independent local TeamRun MCP artifact.
///
/// The facade owns one process-local handle on the canonical `OrganizationStore` durable log. It
/// intentionally exposes only its fixed TeamRun operations, never Organization facts or a general
/// store API.
///
/// The artifact's verified local authorization is consumed at its stdio edge. This facade receives no
/// authority material and therefore cannot widen that boundary through a semantic command.
pub struct TeamRunMcpFacade {
    store: OrganizationStore,
}

/// The standalone stdio process opens the canonical durable log during composition and transfers
/// that process-local handle into this facade; it does not receive a Host process's in-memory store.
impl TeamRunMcpFacade {
    pub(crate) fn from_canonical_store(store: OrganizationStore) -> Self {
        Self { store }
    }

    pub fn graph_context(
        &self,
        request: TeamGraphContextRequest,
    ) -> Result<TeamGraphContextOutcome, TeamRunMcpError> {
        let team = TeamId::try_new(request.team_id).map_err(|_| TeamRunMcpError::Invalid)?;
        let view = match request.view {
            TeamGraphContextRequestView::CurrentNode => TeamGraphContextView::CurrentNode,
            TeamGraphContextRequestView::GraphSummary => TeamGraphContextView::GraphSummary,
        };
        let query = TeamGraphContextQuery::new(
            team,
            GraphRunId::new(request.run_id),
            view,
            request.node_execution_id,
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;

        Ok(
            match organization::query_team_graph_context(self.store.facts(), &query) {
                TeamGraphContextResult::Available(context) => TeamGraphContextOutcome::Available {
                    team_id: context.team().as_str().to_owned(),
                    run_id: context.run().as_str().to_owned(),
                    graph_status: format!("{:?}", context.graph_status()).to_lowercase(),
                    nodes: context
                        .nodes()
                        .iter()
                        .map(|node| TeamGraphContextNode {
                            node_id: node.node_id().to_owned(),
                            node_execution_id: node.node_execution_id().to_owned(),
                            status: format!("{:?}", node.status()).to_lowercase(),
                            output_port: node.output_port().map(ToOwned::to_owned),
                        })
                        .collect(),
                    edges: context
                        .edges()
                        .iter()
                        .map(|edge| TeamGraphContextEdge {
                            edge_id: edge.edge_id().to_owned(),
                            source_node_id: edge.source_node_id().to_owned(),
                            target_node_id: edge.target_node_id().to_owned(),
                        })
                        .collect(),
                    pending_approval_ids: context.pending_approval_ids().to_vec(),
                    recent_event_ids: context.recent_event_ids().to_vec(),
                },
                TeamGraphContextResult::Unavailable => TeamGraphContextOutcome::Unavailable,
                TeamGraphContextResult::OutcomeUnknown => TeamGraphContextOutcome::OutcomeUnknown,
            },
        )
    }

    pub fn graph_patch(
        &mut self,
        request: TeamGraphPatchCommand,
        applied_at: u64,
    ) -> Result<TeamGraphPatchOutcome, TeamRunMcpError> {
        let run_id = opaque(request.run_id)?;
        let command_id = opaque(request.command_id)?;
        let idempotency_key = opaque(request.idempotency_key)?;
        let patch = GraphPatch::new(
            request.base_graph_id.clone(),
            request.base_workflow_plan_id.clone(),
            request.operations,
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;
        let command_patch = CommandGraphPatch::try_new(
            request.base_graph_id,
            request.base_workflow_plan_id,
            patch
                .operations()
                .iter()
                .map(command_graph_patch_operation)
                .collect::<Vec<_>>(),
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;
        let command = RunCommand::new(
            run_id,
            command_id,
            idempotency_key,
            CommandPayload::GraphPatch(command_patch),
            applied_at,
        );
        let receipt = self
            .store
            .team_graph_patch(command, patch)
            .map_err(|_| TeamRunMcpError::Unavailable)?;
        Ok(TeamGraphPatchOutcome {
            accepted: receipt.record().is_accepted(),
            replayed: receipt.is_replay(),
            sequence: receipt.record().sequence(),
        })
    }

    pub fn node_event(
        &mut self,
        request: TeamNodeEventCommand,
        occurred_at: u64,
    ) -> Result<TeamNodeEventOutcome, TeamRunMcpError> {
        let run_id = opaque(request.run_id)?;
        let command_id = opaque(request.command_id)?;
        let idempotency_key = opaque(request.idempotency_key)?;
        let node_execution_id = opaque(request.node_execution_id)?;
        let role_id = request.role_id.map(opaque).transpose()?;
        if matches!(
            request.event,
            TeamNodeEventCommandKind::Complete | TeamNodeEventCommandKind::Reject
        ) {
            let terminal = request
                .terminal_resolution
                .ok_or(TeamRunMcpError::Invalid)?;
            let receipt = AuthorizedGraphResolutionReceipt::try_new(terminal.receipt)
                .map_err(|_| TeamRunMcpError::Invalid)?;
            let delivery_id =
                DeliveryId::new(terminal.delivery_id).map_err(|_| TeamRunMcpError::Invalid)?;
            let node_id = organization::NodeId::new(terminal.node_id);
            let run = self
                .store
                .facts()
                .run(&GraphRunId::new(run_id.as_str()))
                .ok_or(TeamRunMcpError::Invalid)?;
            let attempt = run
                .graph()
                .current_attempt(&node_id)
                .filter(|attempt| attempt.number() == terminal.attempt_number)
                .ok_or(TeamRunMcpError::Invalid)?;
            let fence = attempt.fence().clone();
            if fence.node_execution_id().as_str() != node_execution_id.as_str() {
                return Err(TeamRunMcpError::Invalid);
            }
            let resolution = match request.event {
                TeamNodeEventCommandKind::Complete => {
                    AgentNodeEventResolution::complete_with_summary(
                        receipt,
                        delivery_id,
                        run_id.as_str(),
                        fence,
                        terminal.summary.clone(),
                        command_id.as_str(),
                        idempotency_key.as_str(),
                        Some(terminal.output_port.clone()),
                        occurred_at,
                    )
                }
                TeamNodeEventCommandKind::Reject => AgentNodeEventResolution::reject_with_summary(
                    receipt,
                    delivery_id,
                    run_id.as_str(),
                    fence,
                    terminal.summary.clone(),
                    command_id.as_str(),
                    idempotency_key.as_str(),
                    Some(terminal.output_port.clone()),
                    occurred_at,
                ),
                TeamNodeEventCommandKind::Progress
                | TeamNodeEventCommandKind::RequestInput
                | TeamNodeEventCommandKind::RequestApproval(_) => unreachable!(),
            }
            .map_err(|_| TeamRunMcpError::Invalid)?;
            let outcome = self
                .store
                .apply_agent_node_event_resolution(resolution)
                .map_err(|error| match error {
                    StoreFault::AgentNodeEventResolution(_) | StoreFault::InvalidFacts => {
                        TeamRunMcpError::Invalid
                    }
                    _ => TeamRunMcpError::Unavailable,
                })?;
            return Ok(TeamNodeEventOutcome::TerminalResolved {
                outcome: match outcome {
                    AuthorizedGraphResolutionOutcome::Recorded => "recorded",
                    AuthorizedGraphResolutionOutcome::Replayed => "replayed",
                },
                summary: terminal.summary,
                output_port: terminal.output_port,
            });
        }
        let event = match request.event {
            TeamNodeEventCommandKind::Progress => {
                TeamNodeEvent::progress(node_execution_id.clone(), role_id.clone())
            }
            TeamNodeEventCommandKind::RequestInput => {
                TeamNodeEvent::request_input(node_execution_id.clone(), role_id.clone())
            }
            TeamNodeEventCommandKind::RequestApproval(action) => {
                TeamNodeEvent::request_approval(node_execution_id.clone(), role_id.clone(), action)
            }
            TeamNodeEventCommandKind::Complete | TeamNodeEventCommandKind::Reject => unreachable!(),
        };
        let payload = match event.kind() {
            TeamNodeEventKind::Progress => {
                CommandPayload::NodeProgress(NodeProgressCommand::progress(node_execution_id))
            }
            TeamNodeEventKind::RequestInput => {
                CommandPayload::NodeProgress(NodeProgressCommand::request_input(node_execution_id))
            }
            TeamNodeEventKind::RequestApproval { action } => {
                CommandPayload::ApprovalRequest(ApprovalCommand::new(
                    opaque(format!("team-approval-{}", idempotency_key.as_str()))?,
                    node_execution_id,
                    role_id.ok_or(TeamRunMcpError::Invalid)?,
                    action,
                ))
            }
            TeamNodeEventKind::Complete | TeamNodeEventKind::Reject => unreachable!(),
        };
        let command = RunCommand::new(run_id, command_id, idempotency_key, payload, occurred_at);
        self.store
            .team_node_event(command, event)
            .map(node_event_outcome)
            .map_err(|_| TeamRunMcpError::Unavailable)
    }

    pub fn record_evidence(
        &mut self,
        request: TeamEvidenceRecordCommand,
        recorded_at: u64,
    ) -> Result<TeamEvidenceRecordOutcome, TeamRunMcpError> {
        let evidence_id = EvidenceId::new(opaque(request.evidence_id)?.as_str().to_owned())
            .map_err(|_| TeamRunMcpError::Invalid)?;
        let run_id = opaque(request.run_id)?;
        let node_execution_id = opaque(request.node_execution_id)?;
        let reference = opaque(request.reference)?;
        let reference_kind = match request.reference_kind {
            TeamEvidenceReferenceKind::Artifact => EvidenceReferenceKind::Artifact,
        };
        let label = request
            .label
            .map(|label| opaque(label).map(|label| label.as_str().to_owned()))
            .transpose()?;
        let record = EvidenceRecord::new(
            evidence_id,
            run_id.as_str(),
            node_execution_id.as_str(),
            EvidenceReference::opaque(reference_kind, reference.as_str(), label)
                .map_err(|_| TeamRunMcpError::Invalid)?,
            recorded_at,
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;
        let outcome =
            self.store
                .record_evidence(record)
                .map_err(|error| match error {
                    organization::StoreFault::InvalidFacts
                    | organization::StoreFault::Evidence(_) => TeamRunMcpError::Invalid,
                    _ => TeamRunMcpError::Unavailable,
                })?;
        Ok(match outcome {
            RecordOutcome::Recorded(_) => TeamEvidenceRecordOutcome::Recorded,
            RecordOutcome::Replayed(_) => TeamEvidenceRecordOutcome::Replayed,
            RecordOutcome::ConflictingEvidenceId { .. } => return Err(TeamRunMcpError::Invalid),
        })
    }

    pub fn submit_decision(
        &mut self,
        request: TeamDecisionSubmitCommand,
        created_at: u64,
    ) -> Result<TeamDecisionSubmitOutcome, TeamRunMcpError> {
        let decision_id = format!("team-decision-{}", request.idempotency_key);
        let command = TeamDecisionCommand::try_new(
            decision_id,
            request.run_id,
            request.stage_id.unwrap_or_else(|| "run".to_owned()),
            request.decision,
            request.note,
            request.idempotency_key,
            created_at,
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;
        let receipt = self
            .store
            .record_decision(command)
            .map_err(|_| TeamRunMcpError::Unavailable)?;
        Ok(TeamDecisionSubmitOutcome {
            recorded: !receipt.is_replay(),
            replayed: receipt.is_replay(),
            sequence: receipt.decision().sequence(),
        })
    }

    pub fn prompt_settled(
        &mut self,
        request: TeamNodePromptSettledCommand,
        settled_at: u64,
    ) -> Result<TeamNodePromptSettledOutcome, TeamRunMcpError> {
        let session_key = opaque(request.session_key)?;
        let prompt_run_id = opaque(request.prompt_run_id)?;
        let native_terminal = request.phase.native_terminal();
        let mut matches = self
            .store
            .facts()
            .deliveries()
            .deliveries()
            .filter_map(|delivery| {
                let correlation = match delivery.phase() {
                    DeliveryPhase::Delivered {
                        matcha_correlation: Some(correlation),
                        ..
                    } => correlation,
                    DeliveryPhase::TerminalObserved { observation } => observation.correlation(),
                    _ => return None,
                };
                let run = self
                    .store
                    .facts()
                    .run(&GraphRunId::new(delivery.facts().run_id.clone()))?;
                let binding = run
                    .runtime()?
                    .bindings()
                    .iter()
                    .find(|binding| binding.role().as_str() == delivery.facts().role_id)?;
                (binding.local_session().as_str() == session_key.as_str()
                    && correlation.native_run_receipt().as_str() == prompt_run_id.as_str())
                .then_some(delivery)
            })
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(TeamRunMcpError::Invalid);
        }
        let Some(delivery) = matches.pop() else {
            return Ok(TeamNodePromptSettledOutcome::NotFound);
        };
        if let DeliveryPhase::TerminalObserved { observation } = delivery.phase() {
            return if observation.native_terminal() == native_terminal {
                Ok(TeamNodePromptSettledOutcome::Replayed)
            } else {
                Err(TeamRunMcpError::Invalid)
            };
        }
        let delivery_id = DeliveryId::new(delivery.facts().delivery_id.as_str().to_owned())
            .map_err(|_| TeamRunMcpError::Invalid)?;
        let target = self
            .store
            .matcha_terminal_target(&delivery_id)
            .ok_or(TeamRunMcpError::Invalid)?;
        let outcome = self
            .store
            .observe_matcha_terminal(target, native_terminal, settled_at)
            .map_err(|error| match error {
                StoreFault::TerminalObservation(
                    organization::TerminalObservationError::ConflictingObservation
                    | organization::TerminalObservationError::SessionMismatch
                    | organization::TerminalObservationError::NativeReceiptMismatch,
                ) => TeamRunMcpError::Invalid,
                StoreFault::TerminalObservation(_) | StoreFault::InvalidFacts => {
                    TeamRunMcpError::Invalid
                }
                _ => TeamRunMcpError::Unavailable,
            })?;
        Ok(match outcome {
            organization::TerminalObservationOutcome::Replayed => {
                TeamNodePromptSettledOutcome::Replayed
            }
            organization::TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution
            | organization::TerminalObservationOutcome::RecordedNodeCancelled => {
                TeamNodePromptSettledOutcome::Recorded
            }
        })
    }

    pub fn resolve_approval(
        &mut self,
        request: TeamApprovalResolutionCommand,
        resolved_at: u64,
    ) -> Result<TeamApprovalResolutionOutcome, TeamRunMcpError> {
        let command = organization::run::approval::HumanDecisionCommand::new(
            GraphRunId::new(opaque(request.run_id)?.as_str()),
            opaque(request.approval_id)?,
            request.decision.into(),
            request
                .note
                .map(|note| {
                    let note = note.trim().to_owned();
                    (note.len() <= 256 && !note.is_empty())
                        .then_some(note)
                        .ok_or(TeamRunMcpError::Invalid)
                })
                .transpose()?,
            opaque(request.idempotency_key)?,
            resolved_at,
        )
        .map_err(|_| TeamRunMcpError::Invalid)?;
        let outcome = self
            .store
            .resolve_human_decision(command)
            .map_err(|error| match error {
                organization::StoreFault::InvalidFacts => TeamRunMcpError::Invalid,
                _ => TeamRunMcpError::Unavailable,
            })?;
        Ok(match outcome {
            organization::run::approval::HumanDecisionOutcome::Recorded => {
                TeamApprovalResolutionOutcome::Recorded
            }
            organization::run::approval::HumanDecisionOutcome::Replayed => {
                TeamApprovalResolutionOutcome::Replayed
            }
        })
    }
}

pub struct TeamGraphContextRequest {
    pub team_id: String,
    pub run_id: String,
    pub view: TeamGraphContextRequestView,
    pub node_execution_id: Option<String>,
}

pub enum TeamGraphContextRequestView {
    CurrentNode,
    GraphSummary,
}

pub enum TeamGraphContextOutcome {
    Available {
        team_id: String,
        run_id: String,
        graph_status: String,
        nodes: Vec<TeamGraphContextNode>,
        edges: Vec<TeamGraphContextEdge>,
        pending_approval_ids: Vec<String>,
        recent_event_ids: Vec<String>,
    },
    Unavailable,
    OutcomeUnknown,
}

pub struct TeamGraphContextNode {
    pub node_id: String,
    pub node_execution_id: String,
    pub status: String,
    pub output_port: Option<String>,
}

pub struct TeamGraphContextEdge {
    pub edge_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

pub struct TeamGraphPatchCommand {
    pub run_id: String,
    pub command_id: String,
    pub idempotency_key: String,
    pub base_graph_id: String,
    pub base_workflow_plan_id: String,
    pub operations: Vec<GraphPatchOperation>,
}

pub struct TeamGraphPatchOutcome {
    pub accepted: bool,
    pub replayed: bool,
    pub sequence: u64,
}

pub struct TeamNodeEventCommand {
    pub run_id: String,
    pub command_id: String,
    pub idempotency_key: String,
    pub node_execution_id: String,
    pub role_id: Option<String>,
    pub event: TeamNodeEventCommandKind,
    pub terminal_resolution: Option<TeamNodeTerminalResolution>,
}

pub struct TeamNodePromptSettledCommand {
    pub session_key: String,
    pub prompt_run_id: String,
    pub phase: TeamNodePromptSettledPhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodePromptSettledPhase {
    Final,
    Error,
    Aborted,
}

impl TeamNodePromptSettledPhase {
    const fn native_terminal(self) -> NativeTerminalStatus {
        match self {
            Self::Final => NativeTerminalStatus::Completed,
            Self::Error => NativeTerminalStatus::Failed,
            Self::Aborted => NativeTerminalStatus::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodePromptSettledOutcome {
    Recorded,
    Replayed,
    NotFound,
}

pub struct TeamNodeTerminalResolution {
    pub delivery_id: String,
    pub receipt: String,
    pub node_id: String,
    pub attempt_number: std::num::NonZeroU32,
    pub summary: String,
    pub output_port: String,
}

pub enum TeamNodeEventCommandKind {
    Progress,
    RequestInput,
    RequestApproval(ApprovalAction),
    Complete,
    Reject,
}

pub enum TeamNodeEventOutcome {
    Progressed,
    WaitingForInput,
    ApprovalRequested,
    TerminalResolved {
        outcome: &'static str,
        summary: String,
        output_port: String,
    },
}

pub struct TeamEvidenceRecordCommand {
    pub evidence_id: String,
    pub run_id: String,
    pub node_execution_id: String,
    pub reference_kind: TeamEvidenceReferenceKind,
    pub reference: String,
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamEvidenceReferenceKind {
    Artifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamEvidenceRecordOutcome {
    Recorded,
    Replayed,
}

pub struct TeamDecisionSubmitCommand {
    pub run_id: String,
    pub stage_id: Option<String>,
    pub decision: TeamDecisionType,
    pub note: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TeamDecisionSubmitOutcome {
    pub recorded: bool,
    pub replayed: bool,
    pub sequence: u64,
}

pub struct TeamApprovalResolutionCommand {
    pub run_id: String,
    pub approval_id: String,
    pub decision: TeamApprovalDecision,
    pub note: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamApprovalDecision {
    Approve,
    Deny,
    Abort,
}

impl From<TeamApprovalDecision> for organization::run::approval::ApprovalDecision {
    fn from(value: TeamApprovalDecision) -> Self {
        match value {
            TeamApprovalDecision::Approve => Self::Approve,
            TeamApprovalDecision::Deny => Self::Deny,
            TeamApprovalDecision::Abort => Self::Abort,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamApprovalResolutionOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRunMcpError {
    Invalid,
    Unavailable,
}

fn opaque(value: impl Into<String>) -> Result<OpaqueId, TeamRunMcpError> {
    OpaqueId::try_new(value).map_err(|_| TeamRunMcpError::Invalid)
}

fn command_graph_patch_operation(operation: &GraphPatchOperation) -> CommandGraphPatchOperation {
    match operation {
        GraphPatchOperation::AddNode(node) => CommandGraphPatchOperation::AddNode {
            node_id: node.id().as_str().to_owned(),
            kind: command_node_kind(node.kind()),
            role_id: node.work_assignment().map(|work| work.role_id().to_owned()),
        },
        GraphPatchOperation::ReplaceNode(node) => CommandGraphPatchOperation::ReplaceNode {
            node_id: node.id().as_str().to_owned(),
            kind: command_node_kind(node.kind()),
            role_id: node.work_assignment().map(|work| work.role_id().to_owned()),
        },
        GraphPatchOperation::RemoveNode(node_id) => CommandGraphPatchOperation::RemoveNode {
            node_id: node_id.as_str().to_owned(),
        },
        GraphPatchOperation::AddEdge(edge) => CommandGraphPatchOperation::AddEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: command_edge_action(edge.action()),
        },
        GraphPatchOperation::ReplaceEdge(edge) => CommandGraphPatchOperation::ReplaceEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: command_edge_action(edge.action()),
        },
        GraphPatchOperation::RemoveEdge(edge_id) => CommandGraphPatchOperation::RemoveEdge {
            edge_id: edge_id.as_str().to_owned(),
        },
        GraphPatchOperation::SetMetadata { key, value } => {
            CommandGraphPatchOperation::SetMetadata {
                key: key.clone(),
                value: value.clone(),
            }
        }
    }
}

const fn command_node_kind(kind: NodeKind) -> GraphNodeKind {
    match kind {
        NodeKind::Start => GraphNodeKind::Start,
        NodeKind::Work => GraphNodeKind::Work,
        NodeKind::Review => GraphNodeKind::Review,
        NodeKind::HumanDecision => GraphNodeKind::HumanDecision,
        NodeKind::ScriptReview => GraphNodeKind::ScriptReview,
        NodeKind::Join => GraphNodeKind::Join,
        NodeKind::End => GraphNodeKind::End,
    }
}

const fn command_edge_action(action: EdgeAction) -> GraphEdgeAction {
    match action {
        EdgeAction::Activate => GraphEdgeAction::Activate,
        EdgeAction::Rework => GraphEdgeAction::Rework,
        EdgeAction::Gate => GraphEdgeAction::Gate,
        EdgeAction::Finish => GraphEdgeAction::Finish,
    }
}

fn node_event_outcome(outcome: organization::TeamNodeEventOutcome) -> TeamNodeEventOutcome {
    match outcome {
        organization::TeamNodeEventOutcome::Progressed => TeamNodeEventOutcome::Progressed,
        organization::TeamNodeEventOutcome::WaitingForInput => {
            TeamNodeEventOutcome::WaitingForInput
        }
        organization::TeamNodeEventOutcome::ApprovalRequested => {
            TeamNodeEventOutcome::ApprovalRequested
        }
        organization::TeamNodeEventOutcome::TerminalReceiptRequired => unreachable!(),
    }
}
