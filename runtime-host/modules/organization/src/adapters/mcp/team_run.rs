use organization::run::event::{
    ApprovalAction, ApprovalCommand, CommandPayload, NodeProgressCommand, OpaqueId, RunCommand,
};
use organization::{
    EvidenceId, EvidenceRecord, EvidenceReference, EvidenceReferenceKind, GraphPatchOperation,
    GraphRunId, OrganizationStore, RecordOutcome, StoreFault, TeamDecisionCommand,
    TeamDecisionType, TeamGraphContextQuery, TeamGraphContextResult, TeamGraphContextView, TeamId,
    TeamNodeEvent, TeamNodeEventKind,
};

use crate::{TeamGraphPatchDraft, owner::team_run::TeamRunOwner};

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
    team_run: TeamRunOwner,
}

/// The standalone stdio process opens the canonical durable log during artifact startup and transfers
/// that process-local handle into this facade; it does not receive a Host process's in-memory store.
impl TeamRunMcpFacade {
    pub fn from_canonical_store(store: OrganizationStore) -> Self {
        Self {
            store,
            team_run: TeamRunOwner::new(),
        }
    }

    pub fn graph_context(
        &self,
        request: TeamGraphContextRequest,
    ) -> Result<TeamGraphContextOutcome, TeamRunMcpError> {
        Ok(TeamGraphContextOutcome(
            self.team_run.graph_context(&self.store, request.query()),
        ))
    }

    pub fn graph_patch(
        &mut self,
        request: TeamGraphPatchCommand,
    ) -> Result<TeamGraphPatchOutcome, TeamRunMcpError> {
        let draft = TeamGraphPatchDraft {
            run_id: request.run_id,
            audit_run_id: request.audit_run_id,
            command_id: request.command_id,
            idempotency_key: request.idempotency_key,
            base_graph_id: Some(request.base_graph_id),
            base_workflow_plan_id: Some(request.base_workflow_plan_id),
            operations: request.operations,
            created_at: request.applied_at,
        };
        let current = self
            .store
            .facts()
            .run(&draft.run_id)
            .ok_or(TeamRunMcpError::Invalid)?
            .clone();
        let (command, patch) = draft
            .resolve(current.graph().definition())
            .map_err(|_| TeamRunMcpError::Invalid)?;
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
    ) -> Result<TeamNodeEventOutcome, TeamRunMcpError> {
        if request.event.is_terminal() {
            let terminal = request
                .terminal_resolution
                .ok_or(TeamRunMcpError::Invalid)?;
            let TeamNodeTerminalResolution {
                delivery_id: _,
                receipt: _,
                node_id: _,
                attempt_number: _,
                summary,
                output_port,
            } = terminal;
            return Ok(TeamNodeEventOutcome::legacy_terminal_evidence(
                summary,
                output_port,
            ));
        }
        let event = match request.event.value {
            TeamNodeEventCommandKindValue::Progress => {
                TeamNodeEvent::progress(request.node_execution_id.clone(), request.role_id.clone())
            }
            TeamNodeEventCommandKindValue::RequestInput => TeamNodeEvent::request_input(
                request.node_execution_id.clone(),
                request.role_id.clone(),
            ),
            TeamNodeEventCommandKindValue::RequestApproval(action) => {
                TeamNodeEvent::request_approval(
                    request.node_execution_id.clone(),
                    request.role_id.clone(),
                    action,
                )
            }
            TeamNodeEventCommandKindValue::Complete | TeamNodeEventCommandKindValue::Reject => {
                unreachable!()
            }
        };
        let payload = match event.kind() {
            TeamNodeEventKind::Progress => CommandPayload::NodeProgress(
                NodeProgressCommand::progress(request.node_execution_id.clone()),
            ),
            TeamNodeEventKind::RequestInput => CommandPayload::NodeProgress(
                NodeProgressCommand::request_input(request.node_execution_id.clone()),
            ),
            TeamNodeEventKind::RequestApproval { action } => {
                CommandPayload::ApprovalRequest(ApprovalCommand::new(
                    opaque(format!(
                        "team-approval-{}",
                        request.idempotency_key.as_str()
                    ))?,
                    request.node_execution_id.clone(),
                    request.role_id.ok_or(TeamRunMcpError::Invalid)?,
                    action,
                ))
            }
            TeamNodeEventKind::Complete | TeamNodeEventKind::Reject => unreachable!(),
        };
        let command = RunCommand::new(
            request.audit_run_id,
            request.command_id,
            request.idempotency_key,
            payload,
            request.occurred_at,
        );
        self.team_run
            .record_node_event(&mut self.store, command, event)
            .map(TeamNodeEventOutcome::from_domain)
            .map_err(|_| TeamRunMcpError::Unavailable)
    }

    pub fn record_evidence(
        &mut self,
        request: TeamEvidenceRecordCommand,
    ) -> Result<TeamEvidenceRecordOutcome, TeamRunMcpError> {
        let reference_kind = match request.reference_kind {
            TeamEvidenceReferenceKind::Artifact => EvidenceReferenceKind::Artifact,
        };
        let record = EvidenceRecord::new(
            request.evidence_id,
            request.run_id.as_str(),
            request.node_execution_id.as_str(),
            EvidenceReference::opaque(reference_kind, request.reference.as_str(), request.label)
                .map_err(|_| TeamRunMcpError::Invalid)?,
            request.recorded_at,
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
    ) -> Result<TeamDecisionSubmitOutcome, TeamRunMcpError> {
        let receipt = self
            .team_run
            .record_decision(&mut self.store, request.command)
            .map_err(|_| TeamRunMcpError::Unavailable)?;
        Ok(TeamDecisionSubmitOutcome {
            recorded: !receipt.is_replay(),
            replayed: receipt.is_replay(),
            sequence: receipt.decision().sequence(),
        })
    }

    pub fn resolve_approval(
        &mut self,
        request: TeamApprovalResolutionCommand,
    ) -> Result<TeamApprovalResolutionOutcome, TeamRunMcpError> {
        let outcome = self
            .team_run
            .resolve_human_decision(&mut self.store, request.command)
            .map_err(|error| match error {
                StoreFault::InvalidFacts => TeamRunMcpError::Invalid,
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
    query: TeamGraphContextQuery,
}

impl TeamGraphContextRequest {
    pub fn try_new(
        team_id: String,
        run_id: String,
        view: TeamGraphContextRequestView,
        node_execution_id: Option<String>,
    ) -> Result<Self, TeamRunMcpError> {
        let team = TeamId::try_new(team_id).map_err(|_| TeamRunMcpError::Invalid)?;
        let view = match view {
            TeamGraphContextRequestView::CurrentNode => TeamGraphContextView::CurrentNode,
            TeamGraphContextRequestView::GraphSummary => TeamGraphContextView::GraphSummary,
        };
        TeamGraphContextQuery::new(team, GraphRunId::new(run_id), view, node_execution_id)
            .map(|query| Self { query })
            .map_err(|_| TeamRunMcpError::Invalid)
    }

    fn query(&self) -> &TeamGraphContextQuery {
        &self.query
    }
}

pub enum TeamGraphContextRequestView {
    CurrentNode,
    GraphSummary,
}

pub struct TeamGraphContextOutcome(TeamGraphContextResult);

impl TeamGraphContextOutcome {
    pub fn into_result(self) -> TeamGraphContextResult {
        self.0
    }
}

pub struct TeamGraphPatchCommand {
    run_id: GraphRunId,
    audit_run_id: OpaqueId,
    command_id: OpaqueId,
    idempotency_key: OpaqueId,
    base_graph_id: String,
    base_workflow_plan_id: String,
    operations: Vec<GraphPatchOperation>,
    applied_at: u64,
}

impl TeamGraphPatchCommand {
    pub fn try_new(
        run_id: String,
        command_id: String,
        idempotency_key: String,
        base_graph_id: String,
        base_workflow_plan_id: String,
        operations: Vec<GraphPatchOperation>,
        applied_at: u64,
    ) -> Result<Self, TeamRunMcpError> {
        let audit_run_id = opaque(run_id)?;
        Ok(Self {
            run_id: GraphRunId::new(audit_run_id.as_str()),
            audit_run_id,
            command_id: opaque(command_id)?,
            idempotency_key: opaque(idempotency_key)?,
            base_graph_id,
            base_workflow_plan_id,
            operations,
            applied_at,
        })
    }
}

pub struct TeamGraphPatchOutcome {
    accepted: bool,
    replayed: bool,
    sequence: u64,
}

impl TeamGraphPatchOutcome {
    pub const fn accepted(&self) -> bool {
        self.accepted
    }

    pub const fn replayed(&self) -> bool {
        self.replayed
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub struct TeamNodeEventCommand {
    run_id: GraphRunId,
    audit_run_id: OpaqueId,
    command_id: OpaqueId,
    idempotency_key: OpaqueId,
    node_execution_id: OpaqueId,
    role_id: Option<OpaqueId>,
    event: TeamNodeEventCommandKind,
    terminal_resolution: Option<TeamNodeTerminalResolution>,
    occurred_at: u64,
}

impl TeamNodeEventCommand {
    pub fn try_new(
        run_id: String,
        command_id: String,
        idempotency_key: String,
        node_execution_id: String,
        role_id: Option<String>,
        event: TeamNodeEventCommandKind,
        terminal_resolution: Option<TeamNodeTerminalResolution>,
        occurred_at: u64,
    ) -> Result<Self, TeamRunMcpError> {
        let audit_run_id = opaque(run_id)?;
        Ok(Self {
            run_id: GraphRunId::new(audit_run_id.as_str()),
            audit_run_id,
            command_id: opaque(command_id)?,
            idempotency_key: opaque(idempotency_key)?,
            node_execution_id: opaque(node_execution_id)?,
            role_id: role_id.map(opaque).transpose()?,
            event,
            terminal_resolution,
            occurred_at,
        })
    }
}

pub struct TeamNodeTerminalResolution {
    delivery_id: String,
    receipt: String,
    node_id: String,
    attempt_number: std::num::NonZeroU32,
    summary: String,
    output_port: String,
}

impl TeamNodeTerminalResolution {
    pub fn new(
        delivery_id: String,
        receipt: String,
        node_id: String,
        attempt_number: std::num::NonZeroU32,
        summary: String,
        output_port: String,
    ) -> Self {
        Self {
            delivery_id,
            receipt,
            node_id,
            attempt_number,
            summary,
            output_port,
        }
    }
}

pub struct TeamNodeEventCommandKind {
    value: TeamNodeEventCommandKindValue,
}

enum TeamNodeEventCommandKindValue {
    Progress,
    RequestInput,
    RequestApproval(ApprovalAction),
    Complete,
    Reject,
}

impl TeamNodeEventCommandKind {
    pub fn progress() -> Self {
        Self {
            value: TeamNodeEventCommandKindValue::Progress,
        }
    }

    pub fn request_input() -> Self {
        Self {
            value: TeamNodeEventCommandKindValue::RequestInput,
        }
    }

    pub fn request_approval(action: ApprovalAction) -> Self {
        Self {
            value: TeamNodeEventCommandKindValue::RequestApproval(action),
        }
    }

    pub fn complete() -> Self {
        Self {
            value: TeamNodeEventCommandKindValue::Complete,
        }
    }

    pub fn reject() -> Self {
        Self {
            value: TeamNodeEventCommandKindValue::Reject,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.value,
            TeamNodeEventCommandKindValue::Complete | TeamNodeEventCommandKindValue::Reject
        )
    }
}

pub struct TeamNodeEventOutcome {
    kind: TeamNodeEventOutcomeKind,
}

pub enum TeamNodeEventOutcomeKind {
    Progressed,
    WaitingForInput,
    ApprovalRequested,
    LegacyTerminalEvidence {
        summary: String,
        output_port: String,
    },
}

impl TeamNodeEventOutcome {
    fn from_domain(outcome: organization::TeamNodeEventOutcome) -> Self {
        let kind = match outcome {
            organization::TeamNodeEventOutcome::Progressed => TeamNodeEventOutcomeKind::Progressed,
            organization::TeamNodeEventOutcome::WaitingForInput => {
                TeamNodeEventOutcomeKind::WaitingForInput
            }
            organization::TeamNodeEventOutcome::ApprovalRequested => {
                TeamNodeEventOutcomeKind::ApprovalRequested
            }
            organization::TeamNodeEventOutcome::TerminalReceiptRequired => unreachable!(),
        };
        Self { kind }
    }

    fn legacy_terminal_evidence(summary: String, output_port: String) -> Self {
        Self {
            kind: TeamNodeEventOutcomeKind::LegacyTerminalEvidence {
                summary,
                output_port,
            },
        }
    }

    pub fn into_kind(self) -> TeamNodeEventOutcomeKind {
        self.kind
    }
}

pub struct TeamEvidenceRecordCommand {
    evidence_id: EvidenceId,
    run_id: OpaqueId,
    node_execution_id: OpaqueId,
    reference_kind: TeamEvidenceReferenceKind,
    reference: OpaqueId,
    label: Option<String>,
    recorded_at: u64,
}

impl TeamEvidenceRecordCommand {
    pub fn try_new(
        evidence_id: String,
        run_id: String,
        node_execution_id: String,
        reference_kind: TeamEvidenceReferenceKind,
        reference: String,
        label: Option<String>,
        recorded_at: u64,
    ) -> Result<Self, TeamRunMcpError> {
        Ok(Self {
            evidence_id: EvidenceId::new(opaque(evidence_id)?.as_str().to_owned())
                .map_err(|_| TeamRunMcpError::Invalid)?,
            run_id: opaque(run_id)?,
            node_execution_id: opaque(node_execution_id)?,
            reference_kind,
            reference: opaque(reference)?,
            label: label
                .map(|label| opaque(label).map(|label| label.as_str().to_owned()))
                .transpose()?,
            recorded_at,
        })
    }
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
    command: TeamDecisionCommand,
}

impl TeamDecisionSubmitCommand {
    pub fn try_new(
        run_id: String,
        stage_id: Option<String>,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: String,
        created_at: u64,
    ) -> Result<Self, TeamRunMcpError> {
        TeamDecisionCommand::try_new(
            format!("team-decision-{idempotency_key}"),
            run_id,
            stage_id.unwrap_or_else(|| "run".to_owned()),
            decision,
            note,
            idempotency_key,
            created_at,
        )
        .map(|command| Self { command })
        .map_err(|_| TeamRunMcpError::Invalid)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TeamDecisionSubmitOutcome {
    recorded: bool,
    replayed: bool,
    sequence: u64,
}

impl TeamDecisionSubmitOutcome {
    pub const fn recorded(&self) -> bool {
        self.recorded
    }

    pub const fn replayed(&self) -> bool {
        self.replayed
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub struct TeamApprovalResolutionCommand {
    command: organization::run::approval::HumanDecisionCommand,
}

impl TeamApprovalResolutionCommand {
    pub fn try_new(
        run_id: String,
        approval_id: String,
        decision: TeamApprovalDecision,
        note: Option<String>,
        idempotency_key: String,
        resolved_at: u64,
    ) -> Result<Self, TeamRunMcpError> {
        let run_id = opaque(run_id)?;
        organization::run::approval::HumanDecisionCommand::new(
            GraphRunId::new(run_id.as_str()),
            opaque(approval_id)?,
            decision.into(),
            note.map(|note| {
                let note = note.trim().to_owned();
                (note.len() <= 256 && !note.is_empty())
                    .then_some(note)
                    .ok_or(TeamRunMcpError::Invalid)
            })
            .transpose()?,
            opaque(idempotency_key)?,
            resolved_at,
        )
        .map(|command| Self { command })
        .map_err(|_| TeamRunMcpError::Invalid)
    }
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
