use std::path::PathBuf;

use crate::{
    ActivityExecutionOutcome, NativeRunSettled, application::team_runtime::TeamRuntimeStatus,
};

use organization::{
    ActivityClaim, ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId,
    GraphDefinition, GraphRunId, IdempotencyKey, RunCommand, StoreFault, TeamDecisionCommand,
    TeamDecisionReceipt, TeamId, TeamNodeEvent, TeamNodeEventOutcome, TeamTriggerFireOutcome,
    TombstoneOutcome, TriggerFireRequest,
    package::{TeamSkillSelectionError, TeamSkillSelectionId},
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
    },
};

use super::team_run::{
    ManualTeamCreateOutcome, TeamDeleteOutcome, TeamMaterializationCommandOutcome,
    TeamNodeTerminalResolution, TeamNodeTerminalResult, TeamRunActivityError,
    TeamRunActivityOutcome, TeamRunActivityStart, TeamRunCommandOutcome, TeamRunTriggerOutcome,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDeleteRunNativeSettlement {
    Cancellation,
    Cancelled,
    Tombstoned,
}

pub enum OrganizationCommand {
    TeamSkillAuthorize {
        package_root: PathBuf,
        reply: crate::call::CallReply<Result<TeamSkillSelectionId, TeamSkillSelectionError>>,
    },
    TeamSkillMaterialize {
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        reply: crate::call::CallReply<TeamMaterializationCommandOutcome>,
    },
    ManualTeamMaterialize {
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        idempotency_key: IdempotencyKey,
        reply: crate::call::CallReply<TeamMaterializationCommandOutcome>,
    },
    ManualTeamCreate {
        team_id: TeamId,
        team_name: String,
        endpoint: organization::RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        materialization_idempotency_key: IdempotencyKey,
        run: organization::GraphRunFacts,
        run_idempotency_key: String,
        reply: crate::call::CallReply<ManualTeamCreateOutcome>,
    },
    TeamDelete {
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
        reply: crate::call::CallReply<Result<TeamDeleteOutcome, StoreFault>>,
    },
    TeamDeleteRunNativeSettled {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        settlement: TeamDeleteRunNativeSettlement,
        native: organization::NativeDeletionEvidence,
        observed_at: u64,
    },
    TeamDeleteRemovalSettled {
        team_id: TeamId,
        outcome: organization::MaterializationOperationOutcome,
    },
    RunCreate {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
        reply: crate::call::CallReply<Result<CreateGraphRunOutcome, StoreFault>>,
    },
    RunCreateFromTeamTemplate {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
        reply: crate::call::CallReply<Result<CreateGraphRunOutcome, TeamRuntimeStatus>>,
    },
    RunCancel {
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
        reply: crate::call::CallReply<Result<BeginCancellationOutcome, StoreFault>>,
    },
    RunDelete {
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
        reply: crate::call::CallReply<Result<TombstoneOutcome, StoreFault>>,
    },
    RunDeleteAndPurge {
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
        reply: crate::call::CallReply<Result<organization::GraphRunPurgeOutcome, StoreFault>>,
    },
    RunPurge {
        request: organization::TeamRunPurgeRequest,
        reply: crate::call::CallReply<Result<organization::GraphRunPurgeOutcome, StoreFault>>,
    },
    TriggerFire {
        request: TriggerFireRequest,
        fired_at: u64,
        reply: crate::call::CallReply<Result<TeamRunTriggerOutcome, StoreFault>>,
    },
    WebhookTriggerFire {
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
        reply: crate::call::CallReply<Result<TeamTriggerFireOutcome, TeamRuntimeStatus>>,
    },
    GraphSave {
        command: RunCommand,
        definition: GraphDefinition,
        reply: crate::call::CallReply<Result<TeamRunCommandOutcome, StoreFault>>,
    },
    GraphPatch {
        patch: crate::application::team_runtime::TeamGraphPatchDraft,
        reply: crate::call::CallReply<Result<TeamRunCommandOutcome, StoreFault>>,
    },
    StartGateTerminalProposalSet {
        run_id: GraphRunId,
        proposal_id: String,
        source_delivery_id: String,
        final_assistant_text: String,
        reply:
            tokio::sync::oneshot::Sender<Result<Option<organization::SetRunStartProposalOutcome>, StoreFault>>,
    },
    RunStartConfirm {
        run_id: GraphRunId,
        proposal_id: String,
        reply: crate::call::CallReply<Result<organization::ConfirmRunStartOutcome, StoreFault>>,
    },
    RunStartContinue {
        run_id: GraphRunId,
        proposal_id: String,
        reply: crate::call::CallReply<Result<organization::ContinueRunDiscussionOutcome, StoreFault>>,
    },
    NodeEvent {
        command: RunCommand,
        event: TeamNodeEvent,
        reply: crate::call::CallReply<Result<TeamNodeEventOutcome, StoreFault>>,
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
        reply: crate::call::CallReply<Result<TeamNodeTerminalResult, StoreFault>>,
    },
    ApprovalResolve {
        command: HumanDecisionCommand,
        reply: crate::call::CallReply<Result<HumanDecisionOutcome, StoreFault>>,
    },
    DecisionSubmit {
        command: TeamDecisionCommand,
        reply: crate::call::CallReply<Result<TeamDecisionReceipt, StoreFault>>,
    },
    TaskBoardMutate {
        team_id: TeamId,
        run_id: GraphRunId,
        operation: crate::application::task_board::TaskBoardMutation,
        reply: crate::call::CallReply<Result<crate::application::task_board::MutationResult, StoreFault>>,
    },
    ScheduleReadyNodes {
        run_id: GraphRunId,
        now: u64,
        reply: tokio::sync::oneshot::Sender<Result<Vec<ActivityId>, StoreFault>>,
    },
    ClaimActivity {
        run_id: GraphRunId,
        activity_id: ActivityId,
        claimed_at: u64,
        reply: tokio::sync::oneshot::Sender<Result<TeamRunActivityStart, TeamRunActivityError>>,
    },
    SettleActivity {
        run_id: GraphRunId,
        claim: ActivityClaim,
        outcome: ActivityExecutionOutcome,
        reply: tokio::sync::oneshot::Sender<Result<TeamRunActivityOutcome, TeamRunActivityError>>,
    },
    NativeRunSettled {
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        settled: NativeRunSettled,
        settled_at: u64,
        reply: tokio::sync::oneshot::Sender<Result<TeamNodeTerminalResult, StoreFault>>,
    },
    TeamMessageTerminalObserved {
        native_run_id: String,
        delivery_context: Option<(DeliveryId, crate::EndpointSessionId)>,
        status: organization::NativeTerminalStatus,
        final_assistant_text: Option<String>,
        settled_at: u64,
        reply: tokio::sync::oneshot::Sender<Result<organization::TeamMessageTerminalObservation, StoreFault>>,
    },
    TeamMessageRepairQueued {
        requested_run_id: String,
        repair: organization::TeamMessageRepairDispatch,
        reply: tokio::sync::oneshot::Sender<()>,
    },
    TeamMessageRepairRejected {
        repair: organization::TeamMessageRepairDispatch,
        reply: tokio::sync::oneshot::Sender<Result<(), StoreFault>>,
    },
    RecoverMaterializationReceipts {
        reply: tokio::sync::oneshot::Sender<()>,
    },
    DrainTeamDeleteTasks {
        reply: tokio::sync::oneshot::Sender<Vec<foundation::execution::OwnedTask<()>>>,
    },
}

impl OrganizationCommand {
    pub(crate) async fn call_running(&self) -> bool {
        match self {
            Self::TeamSkillAuthorize { reply, .. } => reply.running().await,
            Self::TeamSkillMaterialize { reply, .. } => reply.running().await,
            Self::ManualTeamMaterialize { reply, .. } => reply.running().await,
            Self::ManualTeamCreate { reply, .. } => reply.running().await,
            Self::TeamDelete { reply, .. } => reply.running().await,
            Self::RunCreate { reply, .. } => reply.running().await,
            Self::RunCreateFromTeamTemplate { reply, .. } => reply.running().await,
            Self::RunCancel { reply, .. } => reply.running().await,
            Self::RunDelete { reply, .. } => reply.running().await,
            Self::RunDeleteAndPurge { reply, .. } => reply.running().await,
            Self::RunPurge { reply, .. } => reply.running().await,
            Self::TriggerFire { reply, .. } => reply.running().await,
            Self::WebhookTriggerFire { reply, .. } => reply.running().await,
            Self::GraphSave { reply, .. } => reply.running().await,
            Self::GraphPatch { reply, .. } => reply.running().await,
            Self::RunStartConfirm { reply, .. } => reply.running().await,
            Self::RunStartContinue { reply, .. } => reply.running().await,
            Self::NodeEvent { reply, .. } => reply.running().await,
            Self::NodeTerminalResolve { reply, .. } => reply.running().await,
            Self::ApprovalResolve { reply, .. } => reply.running().await,
            Self::DecisionSubmit { reply, .. } => reply.running().await,
            Self::TaskBoardMutate { reply, .. } => reply.running().await,
            _ => true
        }
    }
}
