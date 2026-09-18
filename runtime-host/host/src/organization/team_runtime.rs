use std::path::PathBuf;

use organization::{
    BeginCancellationOutcome, CommandPayload, CreateGraphRunOutcome, EdgeAction, GraphDefinition,
    GraphPatch, GraphPatchOperation, GraphRunId, GraphRunPurgeOutcome, IdempotencyKey, NodeKind,
    ResumeOutcome, RoleChatAdmission, RoleChatAdmissionOutcome, RunCommand, StoreFault,
    TeamDecisionReceipt, TeamDecisionType, TeamGraphContextResult, TeamGraphContextView, TeamId,
    TeamNodeEventOutcome, TeamRunDiagnosticsQueryOutcome, TeamRunQueryOutcome,
    TeamTriggerFireOutcome, TriggerFireRequest,
    package::{TeamSkillDependencyPlanResult, TeamSkillPackageValidation},
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::{
            GraphEdgeAction, GraphNodeKind, GraphPatch as EventGraphPatch,
            GraphPatchOperation as EventGraphPatchOperation, InvalidEventInput, OpaqueId,
        },
        public_projection::TeamRunPublicSnapshotQueryOutcome,
        scheduler::NodePromptRetryDueQueryOutcome,
    },
};

use super::team_run::{
    ArmedTrigger, TeamDeleteOutcome, TeamMaterializationCommandOutcome,
    TeamNodePromptSettledResult, TeamNodeTerminalResolution, TeamNodeTerminalResult,
    TeamRunCommandOutcome, TeamRunTriggerOutcome,
};

pub(crate) enum TeamRuntimeStatus {
    Rejected,
    Unavailable,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamNodeEventCommandOutcome {
    NonTerminal(TeamNodeEventOutcome),
    Terminal(TeamNodeTerminalResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamRuntimeCreateSource {
    TeamSkill,
    Manual,
}

/// Typed owner ingress for the legacy `team.runtime` operation family.
///
/// This is deliberately an owner request, not a public DTO. Public adapters must construct the
/// domain inputs below before entering the Host actor; unsupported legacy projections remain an
/// explicit status rather than an invented success payload.
pub(crate) struct ManualTeamProvision {
    pub(crate) team_name: String,
    pub(crate) roles: Vec<organization::ManualTeamRoleBinding>,
}

pub(crate) struct TeamGraphPatchDraft {
    pub(crate) run_id: GraphRunId,
    pub(crate) audit_run_id: OpaqueId,
    pub(crate) command_id: OpaqueId,
    pub(crate) idempotency_key: OpaqueId,
    pub(crate) base_graph_id: Option<String>,
    pub(crate) base_workflow_plan_id: Option<String>,
    pub(crate) operations: Vec<GraphPatchOperation>,
    pub(crate) created_at: u64,
}

pub(crate) enum TeamGraphPatchResolveError {
    InvalidInput,
}

impl TeamGraphPatchDraft {
    pub(crate) fn resolve(
        self,
        current: &GraphDefinition,
    ) -> Result<(RunCommand, GraphPatch), TeamGraphPatchResolveError> {
        let base_graph_id = self
            .base_graph_id
            .unwrap_or_else(|| current.graph_id().to_owned());
        let base_workflow_plan_id = self
            .base_workflow_plan_id
            .unwrap_or_else(|| current.workflow_plan_id().to_owned());
        let patch = GraphPatch::new(
            base_graph_id.clone(),
            base_workflow_plan_id.clone(),
            self.operations,
        )
        .map_err(|_| TeamGraphPatchResolveError::InvalidInput)?;
        let command_patch = EventGraphPatch::try_new(
            base_graph_id,
            base_workflow_plan_id,
            patch
                .operations()
                .iter()
                .map(team_event_graph_patch_operation)
                .collect::<Vec<_>>(),
        )
        .map_err(map_event_input)?;
        Ok((
            RunCommand::new(
                self.audit_run_id,
                self.command_id,
                self.idempotency_key,
                CommandPayload::GraphPatch(command_patch),
                self.created_at,
            ),
            patch,
        ))
    }
}

fn map_event_input(_: InvalidEventInput) -> TeamGraphPatchResolveError {
    TeamGraphPatchResolveError::InvalidInput
}

fn team_event_graph_patch_operation(operation: &GraphPatchOperation) -> EventGraphPatchOperation {
    match operation {
        GraphPatchOperation::AddNode(node) => EventGraphPatchOperation::AddNode {
            node_id: node.id().as_str().to_owned(),
            kind: team_event_graph_node_kind(node.kind()),
            role_id: team_event_graph_node_role_id(node),
        },
        GraphPatchOperation::ReplaceNode(node) => EventGraphPatchOperation::ReplaceNode {
            node_id: node.id().as_str().to_owned(),
            kind: team_event_graph_node_kind(node.kind()),
            role_id: team_event_graph_node_role_id(node),
        },
        GraphPatchOperation::RemoveNode(node_id) => EventGraphPatchOperation::RemoveNode {
            node_id: node_id.as_str().to_owned(),
        },
        GraphPatchOperation::AddEdge(edge) => EventGraphPatchOperation::AddEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: team_event_graph_edge_action(edge.action()),
        },
        GraphPatchOperation::ReplaceEdge(edge) => EventGraphPatchOperation::ReplaceEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: team_event_graph_edge_action(edge.action()),
        },
        GraphPatchOperation::RemoveEdge(edge_id) => EventGraphPatchOperation::RemoveEdge {
            edge_id: edge_id.as_str().to_owned(),
        },
        GraphPatchOperation::SetMetadata { key, value } => EventGraphPatchOperation::SetMetadata {
            key: key.clone(),
            value: value.clone(),
        },
    }
}

fn team_event_graph_node_kind(kind: NodeKind) -> GraphNodeKind {
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

fn team_event_graph_edge_action(action: EdgeAction) -> GraphEdgeAction {
    match action {
        EdgeAction::Activate => GraphEdgeAction::Activate,
        EdgeAction::Rework => GraphEdgeAction::Rework,
        EdgeAction::Gate => GraphEdgeAction::Gate,
        EdgeAction::Finish => GraphEdgeAction::Finish,
    }
}

fn team_event_graph_node_role_id(node: &organization::NodeDefinition) -> Option<String> {
    node.work_assignment()
        .map(|assignment| assignment.role_id())
        .or_else(|| {
            node.review_assignment()
                .map(|assignment| assignment.role_id())
        })
        .map(str::to_owned)
}

pub(crate) enum TeamRuntimeCommand {
    PackageValidate {
        package_root: PathBuf,
    },
    DependencyPlan {
        package_root: PathBuf,
    },
    ProvisionAgents {
        package_root: PathBuf,
        team_id: Option<TeamId>,
        idempotency_key: IdempotencyKey,
        endpoint: organization::RuntimeEndpointReference,
        source: TeamRuntimeCreateSource,
        manual_team: Option<ManualTeamProvision>,
    },
    Delete {
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
    },
    RunCreate {
        team_id: Option<TeamId>,
        package_root: PathBuf,
        run_id: Option<GraphRunId>,
        idempotency_key: IdempotencyKey,
        source: TeamRuntimeCreateSource,
    },
    RunList {
        team_id: TeamId,
    },
    TriggerList {
        team_id: Option<TeamId>,
    },
    WebhookTriggerFire {
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
    },
    RunSnapshot {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
    },
    GraphSave {
        command: Box<organization::RunCommand>,
        definition: GraphDefinition,
    },
    GraphPatch {
        patch: TeamGraphPatchDraft,
    },
    GraphContext {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        view: TeamGraphContextView,
        node_execution_id: Option<String>,
    },
    GraphExportYaml {
        run_id: GraphRunId,
    },
    GraphImportYaml {
        command: Box<organization::RunCommand>,
        definition: GraphDefinition,
    },
    TriggerFire {
        request: TriggerFireRequest,
        fired_at: u64,
    },
    RoleMessageSubmit {
        admission: RoleChatAdmission,
    },
    RoleMessageSubmitForRun {
        run_id: GraphRunId,
        role_id: organization::RoleId,
        message: String,
        idempotency_key: String,
        requested_at: u64,
    },
    RunStartConfirm {
        run_id: GraphRunId,
        proposal_id: String,
    },
    RunStartContinue {
        run_id: GraphRunId,
        proposal_id: String,
    },
    NodePromptRetryDue {
        run_id: GraphRunId,
    },
    NodePromptSettled {
        session_key: OpaqueId,
        prompt_run_id: OpaqueId,
        phase: TeamRuntimePromptPhase,
    },
    NodeEvent {
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: OpaqueId,
        summary: String,
        role_id: Option<OpaqueId>,
        requested_action: Option<String>,
        idempotency_key: IdempotencyKey,
        terminal_resolution: Option<TeamNodeTerminalResolution>,
        output_port: Option<String>,
    },
    RunDiagnostics {
        run_id: GraphRunId,
    },
    RunDecisionSubmit {
        run_id: GraphRunId,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: OpaqueId,
        resolved_at: u64,
    },
    Resume {
        team_id: TeamId,
    },
    ApprovalResolve {
        command: HumanDecisionCommand,
    },
    RunCancel {
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        requested_at: u64,
    },
    RunDelete {
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        tombstoned_at: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamRuntimePromptPhase {
    Final,
    Error,
    Aborted,
}

pub(crate) enum TeamRuntimeCommandOutcome {
    PackageValidate(TeamSkillPackageValidation),
    DependencyPlan(TeamSkillDependencyPlanResult),
    ProvisionAgents(TeamMaterializationCommandOutcome),
    Delete(Result<TeamDeleteOutcome, StoreFault>),
    RunCreate(Result<CreateGraphRunOutcome, TeamRuntimeStatus>),
    RunList(Vec<TeamRunQueryOutcome>),
    TriggerList(Vec<ArmedTrigger>),
    WebhookTriggerFire(Result<TeamTriggerFireOutcome, TeamRuntimeStatus>),
    RunSnapshot {
        snapshot: TeamRunPublicSnapshotQueryOutcome,
        role_sessions: Option<Vec<organization::TeamRoleSessionProjection>>,
    },
    RunSnapshotInvalidInput,
    GraphSave(Result<TeamRunCommandOutcome, StoreFault>),
    GraphPatch(Result<TeamRunCommandOutcome, StoreFault>),
    GraphContext(TeamGraphContextResult),
    GraphExportYaml(Result<String, TeamRuntimeStatus>),
    GraphImportYaml(Result<TeamRunCommandOutcome, StoreFault>),
    TriggerFire(Result<TeamRunTriggerOutcome, StoreFault>),
    RoleMessageSubmit(Result<RoleChatAdmissionOutcome, StoreFault>),
    RoleMessageSubmitForRun(Result<RoleChatAdmissionOutcome, StoreFault>),
    RunStartConfirm(Result<organization::ConfirmRunStartOutcome, StoreFault>),
    RunStartContinue(Result<organization::ContinueRunDiscussionOutcome, StoreFault>),
    NodePromptRetryDue(NodePromptRetryDueQueryOutcome),
    NodePromptSettled(Result<TeamNodePromptSettledResult, TeamRuntimeStatus>),
    NodeEvent(Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus>),
    RunDiagnostics(TeamRunDiagnosticsQueryOutcome),
    RunDecisionSubmit(Result<TeamDecisionReceipt, TeamRuntimeStatus>),
    Resume {
        team_id: TeamId,
        outcomes: Vec<ResumeOutcome>,
        runs: Vec<TeamRunQueryOutcome>,
    },
    ApprovalResolve(Result<HumanDecisionOutcome, StoreFault>),
    RunCancel(Result<BeginCancellationOutcome, StoreFault>),
    RunDelete(Result<GraphRunPurgeOutcome, StoreFault>),
}
