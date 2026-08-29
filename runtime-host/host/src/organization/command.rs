use std::path::PathBuf;

use matcha_agent::session::receipt::TerminalRunStatus;
use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryClaim, DeliveryId, GraphDefinition,
    GraphPatch, GraphRunId, IdempotencyKey, MatchaTerminalReceiptTarget, PromptDeliveryOutcome,
    PromptDeliveryRequest, ResumeOutcome, RoleChatAdmission, RoleChatAdmissionOutcome, RunCommand,
    StoreFault, TeamDecisionCommand, TeamDecisionReceipt, TeamGraphContextQuery,
    TeamGraphContextResult, TeamId, TeamNodeEvent, TeamNodeEventOutcome, TeamRunQuery,
    TeamRunQueryOutcome, TeamTriggerFireOutcome, TombstoneOutcome, TriggerFireRequest,
    package::{
        TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionError,
        TeamSkillSelectionId,
    },
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
        public_projection::{TeamPublicQueryOutcome, TeamRunPublicSnapshotQueryOutcome},
        scheduler::NodePromptRetryDueQueryOutcome,
        task_board::TaskBoardFacts,
    },
};
use tokio::sync::oneshot;

use crate::{
    composition::{
        ManualTeamCreateOutcome, TeamDeleteOutcome, TeamNodePromptSettledResult,
        TeamNodeTerminalResult, TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
    transport::team_task_board,
};

use super::team_runtime::{TeamRuntimePromptPhase, TeamRuntimeStatus};

pub enum OrganizationCommand {
    TeamSkillAuthorize {
        package_root: PathBuf,
        reply: oneshot::Sender<Result<TeamSkillSelectionId, TeamSkillSelectionError>>,
    },
    TeamSkillMaterialize {
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        reply: oneshot::Sender<crate::composition::TeamMaterializationCommandOutcome>,
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
        command: RunCommand,
        patch: GraphPatch,
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
        run_id: GraphRunId,
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
        terminal: Option<crate::composition::team_run_mcp::TeamNodeTerminalResolution>,
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
        operation: team_task_board::Operation,
        reply: oneshot::Sender<Result<team_task_board::MutationResult, StoreFault>>,
    },
    ScheduleReadyNodes {
        run_id: GraphRunId,
        now: u64,
        reply: oneshot::Sender<Result<Vec<DeliveryId>, StoreFault>>,
    },
    ClaimOpenClawDelivery {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        claimed_at: u64,
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawDeliveryStart,
                crate::composition::OpenClawDeliveryError,
            >,
        >,
    },
    ClaimMatchaDelivery {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        claimed_at: u64,
        reply: oneshot::Sender<
            Result<
                crate::composition::MatchaDeliveryStartOutcome,
                crate::composition::MatchaDeliveryError,
            >,
        >,
    },
    SettleOpenClawDelivery {
        run_id: GraphRunId,
        claim: DeliveryClaim,
        outcome: PromptDeliveryOutcome,
        retry_at: u64,
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawDeliveryOutcome,
                crate::composition::OpenClawDeliveryError,
            >,
        >,
    },
    SettleMatchaDelivery {
        run_id: GraphRunId,
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
        outcome: PromptDeliveryOutcome,
        retry_at: u64,
        reply: oneshot::Sender<
            Result<
                crate::composition::MatchaDeliveryOutcome,
                crate::composition::MatchaDeliveryError,
            >,
        >,
    },
    ObserveMatchaTerminal {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        status: TerminalRunStatus,
        observed_at: u64,
        reply: oneshot::Sender<
            Result<
                crate::composition::MatchaTerminalObservationOutcome,
                crate::composition::MatchaTerminalObservationError,
            >,
        >,
    },
    RecoverMaterializationReceipts {
        reply: oneshot::Sender<()>,
    },
}

pub enum OrganizationQuery {
    TeamSkillValidate {
        package_root: PathBuf,
        reply: oneshot::Sender<TeamSkillPackageValidation>,
    },
    TeamSkillDependencyPlan {
        package_root: PathBuf,
        reply: oneshot::Sender<TeamSkillDependencyPlanResult>,
    },
    TeamSkillSelectionValidate {
        selection_id: TeamSkillSelectionId,
        reply: oneshot::Sender<TeamSkillPackageValidation>,
    },
    TeamSkillSelectionDependencyPlan {
        selection_id: TeamSkillSelectionId,
        reply: oneshot::Sender<TeamSkillDependencyPlanResult>,
    },
    RunList {
        team_id: TeamId,
        reply: oneshot::Sender<Vec<TeamRunQueryOutcome>>,
    },
    RunSnapshot {
        query: TeamRunQuery,
        reply: oneshot::Sender<TeamRunQueryOutcome>,
    },
    TeamRunPublicProjection {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<TeamPublicQueryOutcome>,
    },
    TeamRunPublicSnapshot {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
        reply: oneshot::Sender<Option<TeamRunPublicSnapshotQueryOutcome>>,
    },
    TeamRunDiagnostics {
        run_id: GraphRunId,
        reply: oneshot::Sender<organization::TeamRunDiagnosticsQueryOutcome>,
    },
    RoleSessions {
        team_id: TeamId,
        reply: oneshot::Sender<organization::TeamRoleSessionQueryOutcome>,
    },
    TriggerList {
        team_id: Option<TeamId>,
        reply: oneshot::Sender<Vec<crate::composition::ArmedTrigger>>,
    },
    GraphContext {
        query: TeamGraphContextQuery,
        reply: oneshot::Sender<TeamGraphContextResult>,
    },
    GraphDefinition {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<Option<GraphDefinition>>,
    },
    GraphYaml {
        run_id: GraphRunId,
        reply: oneshot::Sender<Option<String>>,
    },
    TaskBoardRead {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<TaskBoardFacts>,
    },
    PendingApprovals {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<organization::run::TeamPendingApprovalsQueryOutcome>,
    },
    NodePromptRetryDue {
        run_id: GraphRunId,
        reply: oneshot::Sender<NodePromptRetryDueQueryOutcome>,
    },
    Resume {
        team_id: TeamId,
        reply: oneshot::Sender<Vec<ResumeOutcome>>,
    },
    PendingDeliveryIds {
        now: u64,
        reply: oneshot::Sender<Vec<DeliveryId>>,
    },
    TerminalObservationDeliveries {
        reply: oneshot::Sender<Vec<DeliveryId>>,
    },
    ActiveRunIds {
        reply: oneshot::Sender<Vec<GraphRunId>>,
    },
    DeliveryTarget {
        delivery_id: DeliveryId,
        reply: oneshot::Sender<Option<crate::composition::TeamRunDeliveryTarget>>,
    },
    MatchaTerminalTarget {
        delivery_id: DeliveryId,
        reply: oneshot::Sender<Option<MatchaTerminalReceiptTarget>>,
    },
}
