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
use tokio::sync::oneshot;

use crate::application::start_gate_control::{StartGatePromptPlan, StartGateRuntimeBindingLookup};

use super::team_run::{ArmedTrigger, TeamRunActivityTarget};

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
    StartGatePromptPlan {
        lookup: StartGateRuntimeBindingLookup,
        proposal_id_seed: Option<String>,
        requested_at: u64,
        reply: oneshot::Sender<Option<StartGatePromptPlan>>,
    },
    TriggerList {
        team_id: Option<TeamId>,
        reply: oneshot::Sender<Vec<ArmedTrigger>>,
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
    PendingRunActivityIds {
        run_id: GraphRunId,
        now: u64,
        reply: oneshot::Sender<Vec<ActivityId>>,
    },
    NativeDeliveryByRun {
        native_run_id: String,
        reply: oneshot::Sender<Option<DeliveryId>>,
    },
    TeamMessageTerminalContext {
        native_run_id: String,
        reply: oneshot::Sender<Option<organization::TeamMessageTerminalContext>>,
    },
    ActiveRunIds {
        reply: oneshot::Sender<Vec<GraphRunId>>,
    },
    ActivityTarget {
        activity_id: ActivityId,
        reply: oneshot::Sender<Option<TeamRunActivityTarget>>,
    },
    MatchaTerminalTarget {
        delivery_id: DeliveryId,
        reply: oneshot::Sender<Option<NativeTerminalReceiptTarget>>,
    },
}
