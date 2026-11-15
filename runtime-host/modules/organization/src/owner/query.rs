use std::path::PathBuf;

use organization::{
    DeliveryId, GraphDefinition, GraphRunId, NativeTerminalReceiptTarget,
    ResumeOutcome, TeamGraphContextQuery, TeamGraphContextResult, TeamId, TeamRunQuery,
    TeamRunQueryOutcome,
    package::{TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionId},
    run::{
        public_projection::{TeamPublicQueryOutcome, TeamRunPublicSnapshotQueryOutcome},
        scheduler::NodePromptRetryDueQueryOutcome,
        task_board::TaskBoardFacts,
    },
};

use crate::application::start_gate_control::{StartGatePromptPlan, StartGateRuntimeBindingLookup};

use super::team_run::ArmedTrigger;

pub(crate) enum OrganizationQuery {
    TeamPromptSettings {
        reply: crate::call::CallReply<Result<crate::prompts::TeamPromptSettings, crate::TeamPromptSettingsError>>,
    },
    WorkflowRunTeam {
        run_id: GraphRunId,
        reply: tokio::sync::oneshot::Sender<Option<TeamId>>,
    },
    TeamSkillValidate {
        package_root: PathBuf,
        reply: crate::call::CallReply<TeamSkillPackageValidation>,
    },
    TeamSkillDependencyPlan {
        package_root: PathBuf,
        reply: crate::call::CallReply<TeamSkillDependencyPlanResult>,
    },
    TeamSkillSelectionValidate {
        selection_id: TeamSkillSelectionId,
        reply: crate::call::CallReply<TeamSkillPackageValidation>,
    },
    TeamSkillSelectionDependencyPlan {
        selection_id: TeamSkillSelectionId,
        endpoint: organization::RuntimeEndpointReference,
        source_agent: Option<organization::ManagedAgentReference>,
        reply: crate::call::CallReply<TeamSkillDependencyPlanResult>,
    },
    RunList {
        team_id: TeamId,
        reply: crate::call::CallReply<Result<Vec<crate::TeamRunListEntry>, crate::StoreFault>>,
    },
    RunWorkspaceBinding {
        team_id: TeamId,
        run_id: GraphRunId,
        endpoint: crate::RuntimeEndpointReference,
        access: crate::RunWorkspaceAccess,
        reply: tokio::sync::oneshot::Sender<Result<Option<crate::RunWorkspaceBinding>, crate::StoreFault>>,
    },
    TeamMessageFileValidation {
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
        delivery_context: Option<(DeliveryId, crate::EndpointSessionId)>,
        native_request_id: Option<String>,
        assistant_texts: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Result<Option<crate::run::workspace::RunFileValidationPlan>, crate::StoreFault>>,
    },
    TaskInspect {
        identity: crate::task_execution::TaskExecutionIdentity,
        reply: crate::call::CallReply<(
            crate::task_execution::TaskExecutionReceipt,
            Vec<crate::ActivityExecutionRequest>,
        )>,
    },
    RunSnapshot {
        query: TeamRunQuery,
        reply: crate::call::CallReply<TeamRunQueryOutcome>,
    },
    TeamRunPublicProjection {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: crate::call::CallReply<TeamPublicQueryOutcome>,
    },
    TeamRunPublicSnapshot {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
        message_cursor: Option<crate::run::public_projection::TeamRunMessageCursor>,
        reply: crate::call::CallReply<(
            Option<TeamRunPublicSnapshotQueryOutcome>,
            Option<crate::TeamCreationFailure>,
            Option<Vec<crate::RoleSessionReceipt>>,
        )>,
    },
    NodeReviewHistory {
        team_id: TeamId,
        run_id: GraphRunId,
        node_id: crate::NodeId,
        query: crate::run::public_projection::TeamNodeReviewHistoryQuery,
        reply: crate::call::CallReply<Result<Option<crate::run::public_projection::TeamNodeReviewHistoryResult>, crate::StoreFault>>,
    },
    TeamRunDiagnostics {
        run_id: GraphRunId,
        reply: crate::call::CallReply<organization::TeamRunDiagnosticsQueryOutcome>,
    },
    RoleSessions {
        team_id: TeamId,
        reply: crate::call::CallReply<organization::TeamRoleSessionQueryOutcome>,
    },
    RoleSessionReceipts {
        reply: crate::call::CallReply<
            Result<Vec<organization::RoleSessionReceipt>, organization::StoreFault>,
        >,
    },
    StartGatePromptPlan {
        lookup: StartGateRuntimeBindingLookup,
        inject_prompt: bool,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        trace_id: Option<String>,
        reply: tokio::sync::oneshot::Sender<
            Result<Option<StartGatePromptPlan>, organization::StoreFault>,
        >,
    },
    TriggerList {
        team_id: Option<TeamId>,
        reply: crate::call::CallReply<Vec<ArmedTrigger>>,
    },
    RuntimeGraphContext {
        scope: crate::TeamRunExecutionScope,
        reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, crate::StoreFault>>,
    },
    GraphContext {
        query: TeamGraphContextQuery,
        reply: crate::call::CallReply<TeamGraphContextResult>,
    },
    GraphDefinition {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: crate::call::CallReply<Option<GraphDefinition>>,
    },
    GraphYaml {
        run_id: GraphRunId,
        reply: crate::call::CallReply<Option<String>>,
    },
    TaskBoardRead {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: crate::call::CallReply<TaskBoardFacts>,
    },
    PendingApprovals {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: crate::call::CallReply<organization::run::TeamPendingApprovalsQueryOutcome>,
    },
    NodePromptRetryDue {
        run_id: GraphRunId,
        reply: crate::call::CallReply<NodePromptRetryDueQueryOutcome>,
    },
    Resume {
        team_id: TeamId,
        reply: crate::call::CallReply<Vec<ResumeOutcome>>,
    },
    NativeDeliveryByRun {
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
        reply: tokio::sync::oneshot::Sender<Option<DeliveryId>>,
    },
    TeamMessageTerminalContext {
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
        reply: tokio::sync::oneshot::Sender<Option<organization::TeamMessageTerminalContext>>,
    },
    PendingTeamMessageRepairs {
        reply: tokio::sync::oneshot::Sender<bool>,
    },
    ActiveRunIds {
        reply: tokio::sync::oneshot::Sender<Vec<GraphRunId>>,
    },
    MatchaTerminalTarget {
        delivery_id: DeliveryId,
        reply: tokio::sync::oneshot::Sender<Option<NativeTerminalReceiptTarget>>,
    },
}
