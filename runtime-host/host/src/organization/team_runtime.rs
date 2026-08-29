use std::path::PathBuf;

use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, GraphDefinition, GraphPatch, GraphRunId,
    GraphRunPurgeOutcome, IdempotencyKey, ResumeOutcome, RoleChatAdmission,
    RoleChatAdmissionOutcome, StoreFault, TeamDecisionReceipt, TeamDecisionType,
    TeamGraphContextResult, TeamGraphContextView, TeamId, TeamNodeEventOutcome,
    TeamRunDiagnosticsQueryOutcome, TeamRunQueryOutcome, TeamTriggerFireOutcome,
    TriggerFireRequest,
    package::{TeamSkillDependencyPlanResult, TeamSkillPackageValidation},
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
        public_projection::TeamRunPublicSnapshotQueryOutcome,
        scheduler::NodePromptRetryDueQueryOutcome,
    },
};

use crate::composition::{TeamMaterializationCommandOutcome, TeamRunCommandOutcome};

pub(crate) enum TeamRuntimeStatus {
    Rejected,
    Unavailable,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamNodeEventCommandOutcome {
    NonTerminal(TeamNodeEventOutcome),
    Terminal(crate::composition::TeamNodeTerminalResult),
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
        source: TeamRuntimeCreateSource,
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
        command: Box<organization::RunCommand>,
        patch: GraphPatch,
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
    NodePromptRetryDue {
        run_id: GraphRunId,
    },
    NodePromptSettled {
        run_id: GraphRunId,
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
        terminal_resolution: Option<crate::composition::team_run_mcp::TeamNodeTerminalResolution>,
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
    Delete(Result<crate::composition::TeamDeleteOutcome, StoreFault>),
    RunCreate(Result<CreateGraphRunOutcome, TeamRuntimeStatus>),
    RunList(Vec<TeamRunQueryOutcome>),
    TriggerList(Vec<crate::composition::ArmedTrigger>),
    WebhookTriggerFire(Result<TeamTriggerFireOutcome, TeamRuntimeStatus>),
    RunSnapshot(TeamRunPublicSnapshotQueryOutcome),
    RunSnapshotInvalidInput,
    GraphSave(Result<TeamRunCommandOutcome, StoreFault>),
    GraphPatch(Result<TeamRunCommandOutcome, StoreFault>),
    GraphContext(TeamGraphContextResult),
    GraphExportYaml(Result<String, TeamRuntimeStatus>),
    GraphImportYaml(Result<TeamRunCommandOutcome, StoreFault>),
    TriggerFire(Result<crate::composition::TeamRunTriggerOutcome, StoreFault>),
    RoleMessageSubmit(Result<RoleChatAdmissionOutcome, StoreFault>),
    RoleMessageSubmitForRun(Result<RoleChatAdmissionOutcome, StoreFault>),
    NodePromptRetryDue(NodePromptRetryDueQueryOutcome),
    NodePromptSettled(Result<crate::composition::TeamNodePromptSettledResult, TeamRuntimeStatus>),
    NodeEvent(Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus>),
    RunDiagnostics(TeamRunDiagnosticsQueryOutcome),
    RunDecisionSubmit(Result<TeamDecisionReceipt, TeamRuntimeStatus>),
    Resume(Vec<ResumeOutcome>),
    ApprovalResolve(Result<HumanDecisionOutcome, StoreFault>),
    RunCancel(Result<BeginCancellationOutcome, StoreFault>),
    RunDelete(Result<GraphRunPurgeOutcome, StoreFault>),
}
