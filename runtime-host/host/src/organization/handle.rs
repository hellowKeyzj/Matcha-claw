use std::path::PathBuf;

use foundation::execution::OwnerRuntimeHandle;
use matcha_agent::session::receipt::TerminalRunStatus;
use organization::{
    ActivityClaim, ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId,
    GraphDefinition, GraphRunId, IdempotencyKey, MatchaTerminalReceiptTarget, ResumeOutcome,
    RoleChatAdmission, RoleChatAdmissionOutcome, RunCommand, StoreFault, TeamDecisionCommand,
    TeamDecisionReceipt, TeamGraphContextQuery, TeamGraphContextResult, TeamId, TeamNodeEvent,
    TeamNodeEventOutcome, TeamRunQuery, TeamRunQueryOutcome, TeamTriggerFireOutcome,
    TombstoneOutcome, TriggerFireRequest,
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

use crate::{
    HostPhase, RequestAdmissionClosed,
    composition::{
        ManualTeamCreateOutcome, TeamDeleteOutcome, TeamMaterializationCommandOutcome,
        TeamNodePromptSettledResult, TeamNodeTerminalResult, TeamRunCommandOutcome,
        TeamRunTriggerOutcome,
    },
    transport::team_task_board,
};

use super::{
    OrganizationCommand, OrganizationQuery,
    team_runtime::{TeamRuntimePromptPhase, TeamRuntimeStatus},
};

#[derive(Clone)]
pub struct OrganizationHandle {
    inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>,
}

impl OrganizationHandle {
    pub(crate) fn new(inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>) -> Self {
        Self { inner }
    }

    pub async fn team_skill_authorize(
        &self,
        package_root: PathBuf,
    ) -> Result<Result<TeamSkillSelectionId, TeamSkillSelectionError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamSkillAuthorize {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_validate(
        &self,
        package_root: PathBuf,
    ) -> Result<TeamSkillPackageValidation, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamSkillValidate {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_dependency_plan(
        &self,
        package_root: PathBuf,
    ) -> Result<TeamSkillDependencyPlanResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamSkillDependencyPlan {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_selection_validate(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> Result<TeamSkillPackageValidation, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamSkillSelectionValidate {
                selection_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_selection_dependency_plan(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> Result<TeamSkillDependencyPlanResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamSkillSelectionDependencyPlan {
                selection_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_materialize(
        &self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> Result<TeamMaterializationCommandOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamSkillMaterialize {
                selection_id,
                team_id,
                idempotency_key,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn manual_team_materialize(
        &self,
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        idempotency_key: IdempotencyKey,
    ) -> Result<TeamMaterializationCommandOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ManualTeamMaterialize {
                team_id,
                team_name,
                endpoint,
                roles,
                idempotency_key,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn manual_team_create(
        &self,
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        materialization_idempotency_key: IdempotencyKey,
        run: organization::GraphRunFacts,
        run_idempotency_key: String,
    ) -> Result<ManualTeamCreateOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ManualTeamCreate {
                team_id,
                team_name,
                endpoint,
                roles,
                materialization_idempotency_key,
                run,
                run_idempotency_key,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_delete(
        &self,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
    ) -> Result<Result<TeamDeleteOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamDelete {
                team_id,
                idempotency_key,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_create(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<Result<CreateGraphRunOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunCreate {
                team_id,
                run_id,
                idempotency_key,
                workflow_plan,
                source_identity,
                template_revision,
                created_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_create_from_team_template(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
    ) -> Result<Result<CreateGraphRunOutcome, TeamRuntimeStatus>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunCreateFromTeamTemplate {
                team_id,
                run_id,
                idempotency_key,
                created_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_list(
        &self,
        team_id: TeamId,
    ) -> Result<Vec<TeamRunQueryOutcome>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::RunList { team_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_snapshot(
        &self,
        query: TeamRunQuery,
    ) -> Result<TeamRunQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::RunSnapshot { query, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_public_projection(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<TeamPublicQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamRunPublicProjection {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_public_snapshot(
        &self,
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
    ) -> Result<Option<TeamRunPublicSnapshotQueryOutcome>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamRunPublicSnapshot {
                team_id,
                run_id,
                event_cursor,
                event_limit,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_diagnostics(
        &self,
        run_id: GraphRunId,
    ) -> Result<organization::TeamRunDiagnosticsQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamRunDiagnostics { run_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn role_sessions(
        &self,
        team_id: TeamId,
    ) -> Result<organization::TeamRoleSessionQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::RoleSessions { team_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_cancel(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<Result<BeginCancellationOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunCancel {
                run_id,
                idempotency_key,
                requested_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_delete(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
    ) -> Result<Result<TombstoneOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunDelete {
                run_id,
                idempotency_key,
                tombstoned_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_delete_and_purge(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
    ) -> Result<Result<organization::GraphRunPurgeOutcome, StoreFault>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunDeleteAndPurge {
                run_id,
                idempotency_key,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_purge(
        &self,
        request: organization::TeamRunPurgeRequest,
    ) -> Result<Result<organization::GraphRunPurgeOutcome, StoreFault>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunPurge { request, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn trigger_list(
        &self,
        team_id: Option<TeamId>,
    ) -> Result<Vec<crate::composition::ArmedTrigger>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TriggerList { team_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn trigger_fire(
        &self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<Result<TeamRunTriggerOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TriggerFire {
                request,
                fired_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn webhook_trigger_fire(
        &self,
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
    ) -> Result<Result<TeamTriggerFireOutcome, TeamRuntimeStatus>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::WebhookTriggerFire {
                webhook_path,
                idempotency_key,
                fired_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_save(
        &self,
        command: RunCommand,
        definition: GraphDefinition,
    ) -> Result<Result<TeamRunCommandOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::GraphSave {
                command,
                definition,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_patch(
        &self,
        patch: super::team_runtime::TeamGraphPatchDraft,
    ) -> Result<Result<TeamRunCommandOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::GraphPatch { patch, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_context(
        &self,
        query: TeamGraphContextQuery,
    ) -> Result<TeamGraphContextResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::GraphContext { query, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_definition(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<Option<GraphDefinition>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::GraphDefinition {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_yaml(
        &self,
        run_id: GraphRunId,
    ) -> Result<Option<String>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::GraphYaml { run_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn role_message_submit(
        &self,
        admission: RoleChatAdmission,
    ) -> Result<Result<RoleChatAdmissionOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RoleMessageSubmit { admission, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn role_message_submit_for_run(
        &self,
        run_id: GraphRunId,
        role_id: organization::RoleId,
        message: String,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<Result<RoleChatAdmissionOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RoleMessageSubmitForRun {
                run_id,
                role_id,
                message,
                idempotency_key,
                requested_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_event(
        &self,
        command: RunCommand,
        event: TeamNodeEvent,
    ) -> Result<Result<TeamNodeEventOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::NodeEvent {
                command,
                event,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_prompt_retry_due(
        &self,
        run_id: GraphRunId,
    ) -> Result<NodePromptRetryDueQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::NodePromptRetryDue { run_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_prompt_settled(
        &self,
        session_key: String,
        prompt_run_id: String,
        phase: TeamRuntimePromptPhase,
        settled_at: u64,
    ) -> Result<Result<TeamNodePromptSettledResult, TeamRuntimeStatus>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::NodePromptSettled {
                session_key,
                prompt_run_id,
                phase,
                settled_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_terminal_resolve(
        &self,
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: String,
        terminal: Option<crate::composition::team_run_mcp::TeamNodeTerminalResolution>,
        summary: String,
        output_port: Option<String>,
        idempotency_key: String,
        resolved_at: u64,
    ) -> Result<Result<TeamNodeTerminalResult, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::NodeTerminalResolve {
                run_id,
                node_execution_id,
                event,
                terminal,
                summary,
                output_port,
                idempotency_key,
                resolved_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn approval_resolve(
        &self,
        command: HumanDecisionCommand,
    ) -> Result<Result<HumanDecisionOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ApprovalResolve { command, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn decision_submit(
        &self,
        command: TeamDecisionCommand,
    ) -> Result<Result<TeamDecisionReceipt, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::DecisionSubmit { command, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn task_board_read(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<TaskBoardFacts, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TaskBoardRead {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn task_board_mutate(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        operation: team_task_board::Operation,
    ) -> Result<Result<team_task_board::MutationResult, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TaskBoardMutate {
                team_id,
                run_id,
                operation,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn pending_approvals(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<organization::run::TeamPendingApprovalsQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::PendingApprovals {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn resume(
        &self,
        team_id: TeamId,
    ) -> Result<Vec<ResumeOutcome>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::Resume { team_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn terminal_observation_deliveries(
        &self,
    ) -> Result<Vec<DeliveryId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TerminalObservationDeliveries { reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn schedule_ready_nodes(
        &self,
        run_id: GraphRunId,
        now: u64,
    ) -> Result<Result<Vec<ActivityId>, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ScheduleReadyNodes { run_id, now, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn pending_run_activity_ids(
        &self,
        run_id: GraphRunId,
        now: u64,
    ) -> Result<Vec<ActivityId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::PendingRunActivityIds { run_id, now, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn activity_target(
        &self,
        activity_id: ActivityId,
    ) -> Result<Option<crate::composition::TeamRunActivityTarget>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::ActivityTarget { activity_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn claim_activity(
        &self,
        run_id: GraphRunId,
        activity_id: ActivityId,
        claimed_at: u64,
    ) -> Result<
        Result<crate::composition::TeamRunActivityStart, crate::composition::TeamRunActivityError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ClaimActivity {
                run_id,
                activity_id,
                claimed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn settle_activity(
        &self,
        run_id: GraphRunId,
        claim: ActivityClaim,
        outcome: crate::runtime_driver::ActivityExecutionOutcome,
    ) -> Result<
        Result<
            crate::composition::TeamRunActivityOutcome,
            crate::composition::TeamRunActivityError,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::SettleActivity {
                run_id,
                claim,
                outcome,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn observe_matcha_terminal(
        &self,
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        status: TerminalRunStatus,
        observed_at: u64,
    ) -> Result<
        Result<
            crate::composition::MatchaTerminalObservationOutcome,
            crate::composition::MatchaTerminalObservationError,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::ObserveMatchaTerminal {
                run_id,
                delivery_id,
                status,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn recover_materialization_receipts(&self) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RecoverMaterializationReceipts { reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn active_run_ids(&self) -> Result<Vec<GraphRunId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::ActiveRunIds { reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn matcha_terminal_target(
        &self,
        delivery_id: DeliveryId,
    ) -> Result<Option<MatchaTerminalReceiptTarget>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::MatchaTerminalTarget { delivery_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }
}

fn closed(_error: foundation::execution::OwnerRuntimeSendError) -> RequestAdmissionClosed {
    closed_error()
}

fn closed_error() -> RequestAdmissionClosed {
    RequestAdmissionClosed::new(HostPhase::ShutDown)
}
