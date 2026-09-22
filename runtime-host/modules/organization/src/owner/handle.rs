use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{ActivityExecutionOutcome, NativeRunSettled};
use foundation::execution::OwnerRuntimeHandle;
use runtime_directory::RuntimeDriverIdentity;

use organization::{
    ActivityClaim, ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId,
    GraphDefinition, GraphRunId, IdempotencyKey, NativeTerminalReceiptTarget, ResumeOutcome,
    RunCommand, StoreFault, TeamDecisionCommand, TeamDecisionReceipt, TeamGraphContextQuery,
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

use crate::{
    OrganizationPhase, RequestAdmissionClosed,
    application::{
        start_gate_control::{StartGatePromptPlan, StartGateRuntimeBindingLookup},
        team_runtime::{
            TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
            TeamRuntimeCreateSource, TeamRuntimeStatus,
        },
    },
};

use super::{
    OrganizationCommand, OrganizationQuery,
    team_run::{
        ArmedTrigger, ManualTeamCreateOutcome, TeamDeleteOutcome,
        TeamMaterializationCommandOutcome, TeamNodeTerminalResolution, TeamNodeTerminalResult,
        TeamRunActivityError, TeamRunActivityOutcome, TeamRunActivityStart, TeamRunActivityTarget,
        TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
};

#[derive(Clone)]
pub struct OrganizationHandle {
    inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>,
}

impl OrganizationHandle {
    pub fn new(inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>) -> Self {
        Self { inner }
    }

    pub async fn execute_team_runtime(
        &self,
        command: TeamRuntimeCommand,
    ) -> Result<TeamRuntimeCommandOutcome, RequestAdmissionClosed> {
        execute_team_runtime(self, command)
            .await
            .ok_or_else(closed_error)
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

    pub async fn start_gate_prompt_plan(
        &self,
        lookup: StartGateRuntimeBindingLookup,
        proposal_id_seed: Option<String>,
        requested_at: u64,
    ) -> Result<Option<StartGatePromptPlan>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::StartGatePromptPlan {
                lookup,
                proposal_id_seed,
                requested_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn start_gate_terminal_proposal_set(
        &self,
        run_id: GraphRunId,
        proposal_id: String,
        source_delivery_id: String,
        final_assistant_text: String,
    ) -> Result<
        Result<Option<organization::SetRunStartProposalOutcome>, StoreFault>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::StartGateTerminalProposalSet {
                run_id,
                proposal_id,
                source_delivery_id,
                final_assistant_text,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_start_confirm(
        &self,
        run_id: GraphRunId,
        proposal_id: String,
    ) -> Result<Result<organization::ConfirmRunStartOutcome, StoreFault>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunStartConfirm {
                run_id,
                proposal_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_start_continue(
        &self,
        run_id: GraphRunId,
        proposal_id: String,
    ) -> Result<
        Result<organization::ContinueRunDiscussionOutcome, StoreFault>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::RunStartContinue {
                run_id,
                proposal_id,
                reply,
            })
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
    ) -> Result<Vec<ArmedTrigger>, RequestAdmissionClosed> {
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
        patch: crate::application::team_runtime::TeamGraphPatchDraft,
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

    pub async fn node_terminal_resolve(
        &self,
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: String,
        terminal: Option<TeamNodeTerminalResolution>,
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
        operation: crate::application::task_board::TaskBoardMutation,
    ) -> Result<
        Result<crate::application::task_board::MutationResult, StoreFault>,
        RequestAdmissionClosed,
    > {
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

    pub async fn native_delivery_by_run(
        &self,
        native_run_id: String,
    ) -> Result<Option<DeliveryId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::NativeDeliveryByRun {
                native_run_id,
                reply,
            })
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
    ) -> Result<Option<TeamRunActivityTarget>, RequestAdmissionClosed> {
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
    ) -> Result<Result<TeamRunActivityStart, TeamRunActivityError>, RequestAdmissionClosed> {
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
        outcome: ActivityExecutionOutcome,
    ) -> Result<Result<TeamRunActivityOutcome, TeamRunActivityError>, RequestAdmissionClosed> {
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

    pub async fn team_message_terminal_observed(
        &self,
        native_run_id: String,
        status: organization::NativeTerminalStatus,
        final_assistant_text: Option<String>,
        settled_at: u64,
    ) -> Result<
        Result<organization::TeamMessageTerminalObservation, StoreFault>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamMessageTerminalObserved {
                native_run_id,
                status,
                final_assistant_text,
                settled_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_message_repair_queued(
        &self,
        requested_run_id: String,
        repair: organization::TeamMessageRepairDispatch,
    ) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamMessageRepairQueued {
                requested_run_id,
                repair,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_message_repair_rejected(
        &self,
        repair: organization::TeamMessageRepairDispatch,
    ) -> Result<Result<(), StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::TeamMessageRepairRejected { repair, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn native_run_settled(
        &self,
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        settled: NativeRunSettled,
        settled_at: u64,
    ) -> Result<Result<TeamNodeTerminalResult, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_command(OrganizationCommand::NativeRunSettled {
                run_id,
                delivery_id,
                settled,
                settled_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    /// Settles a team node terminal by native run id alone, resolving the owning delivery first.
    /// Native run ids without a team delivery are not team dispatches and settle nothing.
    pub async fn team_message_terminal_context(
        &self,
        native_run_id: String,
    ) -> Result<Option<organization::TeamMessageTerminalContext>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::TeamMessageTerminalContext {
                native_run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn native_run_settled_by_native_run_id(
        &self,
        native_run_id: String,
        settled: NativeRunSettled,
        settled_at: u64,
    ) -> Result<(), RequestAdmissionClosed> {
        let Some(delivery_id) = self.native_delivery_by_run(native_run_id).await? else {
            return Ok(());
        };
        let Some(target) = self.native_terminal_target(delivery_id.clone()).await? else {
            return Ok(());
        };
        let _ = self
            .native_run_settled(
                target.graph_run_id().clone(),
                delivery_id,
                settled,
                settled_at,
            )
            .await?;
        Ok(())
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

    pub async fn native_terminal_target(
        &self,
        delivery_id: DeliveryId,
    ) -> Result<Option<NativeTerminalReceiptTarget>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.inner
            .send_query(OrganizationQuery::MatchaTerminalTarget { delivery_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }
}

async fn execute_team_runtime(
    owner: &OrganizationHandle,
    command: TeamRuntimeCommand,
) -> Option<TeamRuntimeCommandOutcome> {
    Some(match command {
        TeamRuntimeCommand::PackageValidate { package_root } => {
            TeamRuntimeCommandOutcome::PackageValidate(
                owner.team_skill_validate(package_root).await.ok()?,
            )
        }
        TeamRuntimeCommand::DependencyPlan { package_root } => {
            TeamRuntimeCommandOutcome::DependencyPlan(
                owner.team_skill_dependency_plan(package_root).await.ok()?,
            )
        }
        TeamRuntimeCommand::ProvisionAgents {
            package_root,
            team_id: Some(team_id),
            idempotency_key,
            endpoint,
            source: TeamRuntimeCreateSource::TeamSkill,
            manual_team: None,
        } if endpoint.as_str()
            == RuntimeDriverIdentity::open_claw().runtime_endpoint_reference() =>
        {
            let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                Ok(selection_id) => selection_id,
                Err(TeamSkillSelectionError::InvalidSelection) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Rejected,
                    ));
                }
                Err(TeamSkillSelectionError::Unavailable) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Unavailable,
                    ));
                }
            };
            TeamRuntimeCommandOutcome::ProvisionAgents(
                owner
                    .team_skill_materialize(selection_id, team_id, idempotency_key)
                    .await
                    .ok()?,
            )
        }
        TeamRuntimeCommand::ProvisionAgents {
            team_id: Some(team_id),
            idempotency_key,
            endpoint,
            source: TeamRuntimeCreateSource::Manual,
            manual_team: Some(manual_team),
            ..
        } => TeamRuntimeCommandOutcome::ProvisionAgents(
            owner
                .manual_team_materialize(
                    team_id,
                    manual_team.team_name,
                    endpoint,
                    manual_team.roles,
                    idempotency_key,
                )
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::ProvisionAgents { .. } => {
            TeamRuntimeCommandOutcome::ProvisionAgents(TeamMaterializationCommandOutcome::Rejected)
        }
        TeamRuntimeCommand::Delete {
            team_id,
            idempotency_key,
            observed_at,
        } => TeamRuntimeCommandOutcome::Delete(
            owner
                .team_delete(team_id, idempotency_key, observed_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunCreate {
            team_id,
            package_root,
            run_id,
            idempotency_key,
            source,
        } => {
            let run_id = run_id.unwrap_or_else(|| {
                GraphRunId::new(format!("team-run:{}", idempotency_key.as_str()))
            });
            match source {
                TeamRuntimeCreateSource::TeamSkill => {
                    let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                        Ok(selection_id) => selection_id,
                        Err(TeamSkillSelectionError::InvalidSelection) => {
                            return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Rejected,
                            )));
                        }
                        Err(TeamSkillSelectionError::Unavailable) => {
                            return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Unavailable,
                            )));
                        }
                    };
                    let team_id = match team_id {
                        Some(team_id) => team_id,
                        None => match owner
                            .team_skill_selection_validate(selection_id.clone())
                            .await
                            .ok()?
                        {
                            TeamSkillPackageValidation::Valid { package } => {
                                match TeamId::try_new(package.name().to_owned()) {
                                    Ok(team_id) => team_id,
                                    Err(_) => {
                                        return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                            TeamRuntimeStatus::Rejected,
                                        )));
                                    }
                                }
                            }
                            TeamSkillPackageValidation::Invalid => {
                                return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Rejected,
                                )));
                            }
                            TeamSkillPackageValidation::Unavailable => {
                                return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Unavailable,
                                )));
                            }
                        },
                    };
                    match owner
                        .team_skill_materialize(
                            selection_id,
                            team_id.clone(),
                            idempotency_key.clone(),
                        )
                        .await
                        .ok()?
                    {
                        TeamMaterializationCommandOutcome::Materialized { .. } => {
                            TeamRuntimeCommandOutcome::RunCreate(
                                owner
                                    .run_create_from_team_template(
                                        team_id,
                                        run_id,
                                        idempotency_key,
                                        now_millis(),
                                    )
                                    .await
                                    .ok()?,
                            )
                        }
                        outcome => TeamRuntimeCommandOutcome::RunCreate(Err(
                            team_materialization_status(outcome),
                        )),
                    }
                }
                TeamRuntimeCreateSource::Manual => {
                    let Some(team_id) = team_id else {
                        return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                            TeamRuntimeStatus::Rejected,
                        )));
                    };
                    TeamRuntimeCommandOutcome::RunCreate(
                        owner
                            .run_create_from_team_template(
                                team_id,
                                run_id,
                                idempotency_key,
                                now_millis(),
                            )
                            .await
                            .ok()?,
                    )
                }
            }
        }
        TeamRuntimeCommand::RunList { team_id } => {
            TeamRuntimeCommandOutcome::RunList(owner.run_list(team_id).await.ok()?)
        }
        TeamRuntimeCommand::TriggerList { team_id } => {
            TeamRuntimeCommandOutcome::TriggerList(owner.trigger_list(team_id).await.ok()?)
        }
        TeamRuntimeCommand::WebhookTriggerFire {
            webhook_path,
            idempotency_key,
            fired_at,
        } => TeamRuntimeCommandOutcome::WebhookTriggerFire(
            owner
                .webhook_trigger_fire(webhook_path, idempotency_key, fired_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunSnapshot {
            team_id,
            run_id,
            event_cursor,
            event_limit,
        } => match owner
            .team_run_public_snapshot(team_id.clone(), run_id.clone(), event_cursor, event_limit)
            .await
            .ok()?
        {
            Some(snapshot) => {
                let query_team_id = match (&team_id, &snapshot) {
                    (Some(team_id), _) => Some(team_id.clone()),
                    (None, TeamRunPublicSnapshotQueryOutcome::Available(snapshot)) => {
                        TeamId::try_new(snapshot.run().team_id().to_owned()).ok()
                    }
                    (None, TeamRunPublicSnapshotQueryOutcome::Unavailable(_)) => None,
                };
                let role_sessions =
                    match query_team_id {
                        Some(team_id) => owner.role_sessions(team_id).await.ok().and_then(
                            |outcome| match outcome {
                                organization::TeamRoleSessionQueryOutcome::Available(sessions) => {
                                    Some(
                                        sessions
                                            .into_iter()
                                            .filter(|session| session.team_run() == &run_id)
                                            .collect(),
                                    )
                                }
                                organization::TeamRoleSessionQueryOutcome::Unavailable
                                | organization::TeamRoleSessionQueryOutcome::OutcomeUnknown => None,
                            },
                        ),
                        None => None,
                    };
                TeamRuntimeCommandOutcome::RunSnapshot {
                    snapshot,
                    role_sessions,
                }
            }
            None => TeamRuntimeCommandOutcome::RunSnapshotInvalidInput,
        },
        TeamRuntimeCommand::GraphSave {
            command,
            definition,
        } => {
            TeamRuntimeCommandOutcome::GraphSave(owner.graph_save(*command, definition).await.ok()?)
        }
        TeamRuntimeCommand::GraphPatch { patch } => {
            TeamRuntimeCommandOutcome::GraphPatch(owner.graph_patch(patch).await.ok()?)
        }
        TeamRuntimeCommand::GraphContext {
            team_id,
            run_id,
            view,
            node_execution_id,
        } => {
            let outcome = if let Some(team_id) = team_id {
                match TeamGraphContextQuery::new(team_id, run_id, view, node_execution_id) {
                    Ok(query) => owner
                        .graph_context(query)
                        .await
                        .unwrap_or(TeamGraphContextResult::Unavailable),
                    Err(_) => TeamGraphContextResult::Unavailable,
                }
            } else {
                TeamGraphContextResult::Unavailable
            };
            TeamRuntimeCommandOutcome::GraphContext(outcome)
        }
        TeamRuntimeCommand::GraphExportYaml { run_id } => {
            let outcome = owner
                .graph_yaml(run_id)
                .await
                .ok()?
                .ok_or(TeamRuntimeStatus::Unavailable);
            TeamRuntimeCommandOutcome::GraphExportYaml(outcome)
        }
        TeamRuntimeCommand::GraphImportYaml {
            command,
            definition,
        } => TeamRuntimeCommandOutcome::GraphImportYaml(
            owner.graph_save(*command, definition).await.ok()?,
        ),
        TeamRuntimeCommand::TriggerFire { request, fired_at } => {
            TeamRuntimeCommandOutcome::TriggerFire(
                owner.trigger_fire(request, fired_at).await.ok()?,
            )
        }
        TeamRuntimeCommand::RunStartConfirm {
            run_id,
            proposal_id,
        } => TeamRuntimeCommandOutcome::RunStartConfirm(
            owner.run_start_confirm(run_id, proposal_id).await.ok()?,
        ),
        TeamRuntimeCommand::RunStartContinue {
            run_id,
            proposal_id,
        } => TeamRuntimeCommandOutcome::RunStartContinue(
            owner.run_start_continue(run_id, proposal_id).await.ok()?,
        ),
        TeamRuntimeCommand::NodePromptRetryDue { run_id } => {
            TeamRuntimeCommandOutcome::NodePromptRetryDue(
                owner.node_prompt_retry_due(run_id).await.ok()?,
            )
        }
        TeamRuntimeCommand::NodeEvent {
            run_id,
            node_execution_id,
            event,
            summary,
            role_id,
            requested_action,
            idempotency_key,
            terminal_resolution,
            output_port,
        } => TeamRuntimeCommandOutcome::NodeEvent(
            execute_team_node_event(
                owner,
                run_id,
                node_execution_id,
                event,
                summary,
                role_id,
                requested_action,
                idempotency_key,
                terminal_resolution,
                output_port,
            )
            .await,
        ),
        TeamRuntimeCommand::RunDiagnostics { run_id } => TeamRuntimeCommandOutcome::RunDiagnostics(
            owner.team_run_diagnostics(run_id).await.ok()?,
        ),
        TeamRuntimeCommand::RunDecisionSubmit {
            run_id,
            decision,
            note,
            idempotency_key,
            resolved_at,
        } => {
            let command = TeamDecisionCommand::try_new(
                format!("team-decision-{}", idempotency_key.as_str()),
                run_id.as_str().to_owned(),
                "run",
                decision,
                note,
                idempotency_key.as_str().to_owned(),
                resolved_at,
            );
            TeamRuntimeCommandOutcome::RunDecisionSubmit(match command {
                Ok(command) => owner
                    .decision_submit(command)
                    .await
                    .ok()?
                    .map_err(|_| TeamRuntimeStatus::Unavailable),
                Err(_) => Err(TeamRuntimeStatus::Rejected),
            })
        }
        TeamRuntimeCommand::Resume { team_id } => {
            let outcomes = owner.resume(team_id.clone()).await.ok()?;
            let runs = owner.run_list(team_id.clone()).await.ok()?;
            TeamRuntimeCommandOutcome::Resume {
                team_id,
                outcomes,
                runs,
            }
        }
        TeamRuntimeCommand::ApprovalResolve { command } => {
            TeamRuntimeCommandOutcome::ApprovalResolve(owner.approval_resolve(command).await.ok()?)
        }
        TeamRuntimeCommand::RunCancel {
            run_id,
            idempotency_key,
            requested_at,
        } => TeamRuntimeCommandOutcome::RunCancel(
            owner
                .run_cancel(run_id, idempotency_key.as_str().to_owned(), requested_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunDelete {
            run_id,
            idempotency_key,
            tombstoned_at,
        } => TeamRuntimeCommandOutcome::RunDelete(
            owner
                .run_delete_and_purge(run_id, idempotency_key.as_str().to_owned(), tombstoned_at)
                .await
                .ok()?,
        ),
    })
}

async fn execute_team_node_event(
    owner: &OrganizationHandle,
    run_id: GraphRunId,
    node_execution_id: OpaqueId,
    event: OpaqueId,
    summary: String,
    role_id: Option<OpaqueId>,
    requested_action: Option<String>,
    idempotency_key: IdempotencyKey,
    terminal_resolution: Option<TeamNodeTerminalResolution>,
    output_port: Option<String>,
) -> Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus> {
    if matches!(event.as_str(), "complete" | "reject") {
        let Some(terminal) = terminal_resolution else {
            return Err(TeamRuntimeStatus::Rejected);
        };
        return owner
            .node_terminal_resolve(
                run_id,
                node_execution_id,
                event.as_str().to_owned(),
                Some(terminal),
                summary,
                output_port,
                idempotency_key.as_str().to_owned(),
                now_millis(),
            )
            .await
            .map_err(|_| TeamRuntimeStatus::Unavailable)?
            .map(TeamNodeEventCommandOutcome::Terminal)
            .map_err(|_| TeamRuntimeStatus::Unavailable);
    }
    let event = match event.as_str() {
        "progress" => TeamNodeEvent::progress(node_execution_id, role_id),
        "request_input" => TeamNodeEvent::request_input(node_execution_id, role_id),
        "request_approval" => match requested_action.as_deref().and_then(team_approval_action) {
            Some(action) => TeamNodeEvent::request_approval(node_execution_id, role_id, action),
            None => return Err(TeamRuntimeStatus::Rejected),
        },
        _ => return Err(TeamRuntimeStatus::Rejected),
    };
    let command_id = bounded_team_node_event_command_id(idempotency_key.as_str())?;
    let event = organization::TeamNodeEventProducer::non_terminal(
        OpaqueId::try_new(run_id.as_str()).map_err(|_| TeamRuntimeStatus::Rejected)?,
        command_id,
        OpaqueId::try_new(idempotency_key.as_str().to_owned())
            .map_err(|_| TeamRuntimeStatus::Rejected)?,
        event,
        now_millis(),
    )
    .map_err(|_| TeamRuntimeStatus::Rejected)?;
    let (command, event) = event.into_parts();
    owner
        .node_event(command, event)
        .await
        .map_err(|_| TeamRuntimeStatus::Unavailable)?
        .map(TeamNodeEventCommandOutcome::NonTerminal)
        .map_err(|_| TeamRuntimeStatus::Unavailable)
}

fn team_approval_action(value: &str) -> Option<organization::ApprovalAction> {
    match value {
        "continue_node" => Some(organization::ApprovalAction::ContinueNode),
        "execute_tool" => Some(organization::ApprovalAction::ExecuteTool),
        "publish_result" => Some(organization::ApprovalAction::PublishResult),
        "external_action" => Some(organization::ApprovalAction::ExternalAction),
        _ => None,
    }
}

fn team_materialization_status(outcome: TeamMaterializationCommandOutcome) -> TeamRuntimeStatus {
    match outcome {
        TeamMaterializationCommandOutcome::Materialized { .. } => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Rejected => TeamRuntimeStatus::Rejected,
        TeamMaterializationCommandOutcome::OutcomeUnknown => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Unavailable => TeamRuntimeStatus::Unavailable,
    }
}

fn bounded_team_node_event_command_id(
    idempotency_key: &str,
) -> Result<OpaqueId, TeamRuntimeStatus> {
    let candidate = format!("team-node-event:{idempotency_key}");
    if let Ok(command_id) = OpaqueId::try_new(candidate) {
        return Ok(command_id);
    }

    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(idempotency_key.as_bytes());
    let mut value = String::with_capacity("team-node-event".len() + 65);
    value.push_str("team-node-event");
    value.push(':');
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    OpaqueId::try_new(value).map_err(|_| TeamRuntimeStatus::Rejected)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn closed(_error: foundation::execution::OwnerRuntimeSendError) -> RequestAdmissionClosed {
    closed_error()
}

fn closed_error() -> RequestAdmissionClosed {
    RequestAdmissionClosed::new(OrganizationPhase::ShutDown)
}
