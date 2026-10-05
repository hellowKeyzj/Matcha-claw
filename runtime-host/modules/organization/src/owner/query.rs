use std::path::PathBuf;

use organization::{
    ActivityId, DeliveryId, GraphDefinition, GraphRunId, NativeTerminalReceiptTarget,
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

use super::team_run::{ArmedTrigger, TeamRunActivityTarget};

pub enum OrganizationQuery {
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
        reply: crate::call::CallReply<TeamSkillDependencyPlanResult>,
    },
    RunList {
        team_id: TeamId,
        reply: crate::call::CallReply<Vec<TeamRunQueryOutcome>>,
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
        reply: crate::call::CallReply<Option<TeamRunPublicSnapshotQueryOutcome>>,
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
        proposal_id_seed: Option<String>,
        requested_at: u64,
        reply: tokio::sync::oneshot::Sender<
            Result<Option<StartGatePromptPlan>, organization::StoreFault>,
        >,
    },
    TriggerList {
        team_id: Option<TeamId>,
        reply: crate::call::CallReply<Vec<ArmedTrigger>>,
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
    PendingRunActivityIds {
        run_id: GraphRunId,
        now: u64,
        reply: tokio::sync::oneshot::Sender<Vec<ActivityId>>,
    },
    NativeDeliveryByRun {
        native_run_id: String,
        reply: tokio::sync::oneshot::Sender<Option<DeliveryId>>,
    },
    TeamMessageTerminalContext {
        native_run_id: String,
        reply: tokio::sync::oneshot::Sender<Option<organization::TeamMessageTerminalContext>>,
    },
    ActiveRunIds {
        reply: tokio::sync::oneshot::Sender<Vec<GraphRunId>>,
    },
    ActivityTarget {
        activity_id: ActivityId,
        reply: tokio::sync::oneshot::Sender<Option<TeamRunActivityTarget>>,
    },
    MatchaTerminalTarget {
        delivery_id: DeliveryId,
        reply: tokio::sync::oneshot::Sender<Option<NativeTerminalReceiptTarget>>,
    },
}

impl OrganizationQuery {
    pub(crate) async fn call_running(&self) -> bool {
        match self {
            Self::TeamSkillValidate { reply, .. } => reply.running().await,
            Self::TeamSkillDependencyPlan { reply, .. } => reply.running().await,
            Self::TeamSkillSelectionValidate { reply, .. } => reply.running().await,
            Self::TeamSkillSelectionDependencyPlan { reply, .. } => reply.running().await,
            Self::RunList { reply, .. } => reply.running().await,
            Self::RunSnapshot { reply, .. } => reply.running().await,
            Self::TeamRunPublicProjection { reply, .. } => reply.running().await,
            Self::TeamRunPublicSnapshot { reply, .. } => reply.running().await,
            Self::TeamRunDiagnostics { reply, .. } => reply.running().await,
            Self::RoleSessions { reply, .. } => reply.running().await,
            Self::RoleSessionReceipts { reply, .. } => reply.running().await,
            Self::TriggerList { reply, .. } => reply.running().await,
            Self::GraphContext { reply, .. } => reply.running().await,
            Self::GraphDefinition { reply, .. } => reply.running().await,
            Self::GraphYaml { reply, .. } => reply.running().await,
            Self::TaskBoardRead { reply, .. } => reply.running().await,
            Self::PendingApprovals { reply, .. } => reply.running().await,
            Self::NodePromptRetryDue { reply, .. } => reply.running().await,
            Self::Resume { reply, .. } => reply.running().await,
            _ => true
        }
    }
}
