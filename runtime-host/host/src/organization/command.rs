use std::path::PathBuf;

use matcha_agent::session::receipt::TerminalRunStatus;
use organization::{
    ActivityClaim, ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId,
    GraphDefinition, GraphRunId, IdempotencyKey, RoleChatAdmission, RoleChatAdmissionOutcome,
    RunCommand, StoreFault, TeamDecisionCommand, TeamDecisionReceipt, TeamId, TeamNodeEvent,
    TeamNodeEventOutcome, TeamTriggerFireOutcome, TombstoneOutcome, TriggerFireRequest,
    package::{TeamSkillSelectionError, TeamSkillSelectionId},
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
    },
};
use tokio::sync::oneshot;

use super::{
    team_run::{
        ManualTeamCreateOutcome, MatchaTerminalObservationError, MatchaTerminalObservationOutcome,
        TeamDeleteOutcome, TeamMaterializationCommandOutcome, TeamNodePromptSettledResult,
        TeamNodeTerminalResolution, TeamNodeTerminalResult, TeamRunActivityError,
        TeamRunActivityOutcome, TeamRunActivityStart, TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
    team_runtime::{TeamRuntimePromptPhase, TeamRuntimeStatus},
};

pub enum OrganizationCommand {
    TeamSkillAuthorize {
        package_root: PathBuf,
        reply: oneshot::Sender<Result<TeamSkillSelectionId, TeamSkillSelectionError>>,
    },
    TeamSkillMaterialize {
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        reply: oneshot::Sender<TeamMaterializationCommandOutcome>,
    },
    ManualTeamMaterialize {
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        idempotency_key: IdempotencyKey,
        reply: oneshot::Sender<TeamMaterializationCommandOutcome>,
    },
    ManualTeamCreate {
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        materialization_idempotency_key: IdempotencyKey,
        run: organization::GraphRunFacts,
        run_idempotency_key: String,
        reply: oneshot::Sender<ManualTeamCreateOutcome>,
    },
    TeamDelete {
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
        reply: oneshot::Sender<Result<TeamDeleteOutcome, StoreFault>>,
    },
    RunCreate {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
        reply: oneshot::Sender<Result<CreateGraphRunOutcome, StoreFault>>,
    },
    RunCreateFromTeamTemplate {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
        reply: oneshot::Sender<Result<CreateGraphRunOutcome, TeamRuntimeStatus>>,
    },
    RunCancel {
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
        reply: oneshot::Sender<Result<BeginCancellationOutcome, StoreFault>>,
    },
    RunDelete {
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
        reply: oneshot::Sender<Result<TombstoneOutcome, StoreFault>>,
    },
    RunDeleteAndPurge {
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
        reply: oneshot::Sender<Result<organization::GraphRunPurgeOutcome, StoreFault>>,
    },
    RunPurge {
        request: organization::TeamRunPurgeRequest,
        reply: oneshot::Sender<Result<organization::GraphRunPurgeOutcome, StoreFault>>,
    },
    TriggerFire {
        request: TriggerFireRequest,
        fired_at: u64,
        reply: oneshot::Sender<Result<TeamRunTriggerOutcome, StoreFault>>,
    },
    WebhookTriggerFire {
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
        reply: oneshot::Sender<Result<TeamTriggerFireOutcome, TeamRuntimeStatus>>,
    },
    GraphSave {
        command: RunCommand,
        definition: GraphDefinition,
        reply: oneshot::Sender<Result<TeamRunCommandOutcome, StoreFault>>,
    },
    GraphPatch {
        patch: super::team_runtime::TeamGraphPatchDraft,
        reply: oneshot::Sender<Result<TeamRunCommandOutcome, StoreFault>>,
    },
    RoleMessageSubmit {
        admission: RoleChatAdmission,
        reply: oneshot::Sender<Result<RoleChatAdmissionOutcome, StoreFault>>,
    },
    RoleMessageSubmitForRun {
        run_id: GraphRunId,
        role_id: organization::RoleId,
        message: String,
        idempotency_key: String,
        requested_at: u64,
        reply: oneshot::Sender<Result<RoleChatAdmissionOutcome, StoreFault>>,
    },
    NodeEvent {
        command: RunCommand,
        event: TeamNodeEvent,
        reply: oneshot::Sender<Result<TeamNodeEventOutcome, StoreFault>>,
    },
    NodePromptSettled {
        session_key: String,
        prompt_run_id: String,
        phase: TeamRuntimePromptPhase,
        settled_at: u64,
        reply: oneshot::Sender<Result<TeamNodePromptSettledResult, TeamRuntimeStatus>>,
    },
    NodeTerminalResolve {
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: String,
        terminal: Option<TeamNodeTerminalResolution>,
        summary: String,
        output_port: Option<String>,
        idempotency_key: String,
        resolved_at: u64,
        reply: oneshot::Sender<Result<TeamNodeTerminalResult, StoreFault>>,
    },
    ApprovalResolve {
        command: HumanDecisionCommand,
        reply: oneshot::Sender<Result<HumanDecisionOutcome, StoreFault>>,
    },
    DecisionSubmit {
        command: TeamDecisionCommand,
        reply: oneshot::Sender<Result<TeamDecisionReceipt, StoreFault>>,
    },
    TaskBoardMutate {
        team_id: TeamId,
        run_id: GraphRunId,
        operation: super::task_board::TaskBoardMutation,
        reply: oneshot::Sender<Result<super::task_board::MutationResult, StoreFault>>,
    },
    ScheduleReadyNodes {
        run_id: GraphRunId,
        now: u64,
        reply: oneshot::Sender<Result<Vec<ActivityId>, StoreFault>>,
    },
    ClaimActivity {
        run_id: GraphRunId,
        activity_id: ActivityId,
        claimed_at: u64,
        reply: oneshot::Sender<Result<TeamRunActivityStart, TeamRunActivityError>>,
    },
    SettleActivity {
        run_id: GraphRunId,
        claim: ActivityClaim,
        outcome: crate::runtime::driver::ActivityExecutionOutcome,
        reply: oneshot::Sender<Result<TeamRunActivityOutcome, TeamRunActivityError>>,
    },
    ObserveMatchaTerminal {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        status: TerminalRunStatus,
        observed_at: u64,
        reply: oneshot::Sender<
            Result<MatchaTerminalObservationOutcome, MatchaTerminalObservationError>,
        >,
    },
    RecoverMaterializationReceipts {
        reply: oneshot::Sender<()>,
    },
}
