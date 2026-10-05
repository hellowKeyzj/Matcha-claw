#![forbid(unsafe_code)]

extern crate self as organization;

pub mod adapters;
mod api;
mod call;
pub mod application;
pub mod capability;
pub mod owner;
pub mod package;
pub mod ports;
pub mod store;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

const MODULE_ID: ModuleId = ModuleId::new("organization");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("organization"),
    CapabilityKey::new("team.runtime"),
];
const REQUIRES: &[CapabilityKey] = &[];
const ROUTES: &[&str] = &[
    "organization.loopback.team",
    "organization.loopback.team-runtime",
];
const EVENTS: &[&str] = &["sessions.run-terminal"];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::EventSubscription,
];

pub mod team {
    #[path = "command.rs"]
    pub mod command;
    #[path = "definition.rs"]
    pub mod definition;
    #[path = "event.rs"]
    pub mod event;
    #[path = "lifecycle.rs"]
    pub mod lifecycle;
    #[path = "materialization.rs"]
    pub mod materialization;
    #[path = "member.rs"]
    pub mod member;
    #[path = "query.rs"]
    pub mod query;
    #[path = "role.rs"]
    pub mod role;

    pub use command::{CreateTeam, InvalidReplaceTeam, RemoveTeam, ReplaceTeam, TeamCommand};
    pub use definition::{InvalidTeamDefinition, InvalidTeamId, TeamDefinition, TeamId};
    pub use event::{
        InvalidTeamCreated, InvalidTeamReplaced, InvalidTeamRevision, TeamCreated, TeamEvent,
        TeamRemoved, TeamReplaced, TeamRevision, TeamRevisionOverflow,
    };
    pub use lifecycle::{
        MaterializationLifecycleError, MaterializationRecordOutcome, TeamMaterializationCleanup,
        TeamMaterializationLifecycle, TombstonedMaterialization,
    };
    pub use materialization::{
        ManualTeamRoleBinding, TeamMaterialization, TeamMaterializationError,
        compile_manual_team_materialization, compile_team_skill_materialization,
    };
    pub use member::{InvalidMemberId, InvalidMemberName, MemberId, TeamMember};
    pub use query::{
        InvalidTeamListPage, InvalidTeamPageSize, ListTeams, MAX_TEAM_PAGE_SIZE, TeamListPage,
        TeamPageSize, TeamProjection, TeamQuery,
    };
    pub use role::{
        InvalidRoleId, InvalidTeamRole, LEADER_ROLE_ID, RoleAssignment, RoleId, RoleKind, TeamRole,
    };
}

pub mod run {
    #[path = "activity/mod.rs"]
    pub mod activity;
    #[path = "approval/mod.rs"]
    pub mod approval;
    #[path = "approval_projection.rs"]
    pub mod approval_projection;
    #[path = "artifact/mod.rs"]
    pub mod artifact;
    #[path = "attempt/mod.rs"]
    pub mod attempt;
    #[path = "context.rs"]
    pub mod context;
    #[path = "control/mod.rs"]
    pub mod control;
    #[path = "decision/mod.rs"]
    pub mod decision;
    #[path = "delivery/mod.rs"]
    pub mod delivery;
    #[path = "diagnostics.rs"]
    pub mod diagnostics;
    #[path = "event/mod.rs"]
    pub mod event;
    #[path = "evidence/mod.rs"]
    pub mod evidence;
    #[path = "graph/mod.rs"]
    pub mod graph;
    #[path = "lifecycle.rs"]
    pub mod lifecycle;
    #[path = "public_projection.rs"]
    pub mod public_projection;
    #[path = "purge.rs"]
    pub mod purge;
    #[path = "query.rs"]
    pub mod query;
    #[path = "recovery.rs"]
    pub mod recovery;
    #[path = "review/mod.rs"]
    pub mod review;
    #[path = "scheduler/mod.rs"]
    pub mod scheduler;
    #[path = "task_board/mod.rs"]
    pub mod task_board;
    #[path = "trigger/mod.rs"]
    pub mod trigger;

    pub use activity::{
        Activity, ActivityClaim, ActivityClaimOutcome, ActivityClaimSnapshot, ActivityDispatch,
        ActivityDispatchOutcome, ActivityDispatchSnapshot, ActivityFailure, ActivityId,
        ActivityIdError, ActivityKind, ActivityLedger, ActivityLedgerSnapshot, ActivityPhase,
        ActivityPhaseSnapshot, ActivityRegistrationOutcome, ActivityRequest, ActivityRequestError,
        ActivitySettlement, ActivitySettlementOutcome, ActivitySnapshot, ActivityTarget,
        ActivityTargetError, ActivityTransitionError, RestoreActivityError,
        RestoreActivityLedgerError, claim_activity, dispatch_activity,
        recover_interrupted_activity, settle_activity,
    };
    pub use approval::{
        Approval, ApprovalDecision, ApprovalEffect, ApprovalOrigin, ApprovalRequest,
        ApprovalResolution, ApprovalResolutionError, ApprovalStatus, ApprovalSubject,
        ResolveApprovalError, abort_pending_approvals, resolve_approval,
    };
    pub use approval_projection::{
        TeamPendingApproval, TeamPendingApprovals, TeamPendingApprovalsQueryOutcome,
        query_team_pending_approvals,
    };
    pub use artifact::{
        ArtifactEvidenceProvenance, ArtifactId, ArtifactIdError, ArtifactKindError, ArtifactLedger,
        ArtifactRecord, ArtifactRecordError, ArtifactRecordOutcome, AssertArtifactExists,
        CompletionMetadata, DownstreamInputContext, DownstreamInputContextInput,
        GraphCompletionArtifactReceipt, PublicArtifactProjection, RestoreArtifactLedgerError,
        build_graph_completion_artifact, build_graph_delivery_input_context,
        project_public_artifact,
    };
    pub use attempt::{
        Attempt, AttemptIdentity, AttemptOutcome, AttemptPhase, AttemptReceipt,
        InvalidAttemptIdentity, RecoveryAction, RecoveryFault, SettleOutcome, StartOutcome,
        WaitOutcome, recovery_oracle,
    };
    pub use context::{
        ContextEdge, ContextNode, TeamGraphContext, TeamGraphContextQuery,
        TeamGraphContextQueryError, TeamGraphContextResult, TeamGraphContextView,
        query_team_graph_context,
    };
    pub use control::{
        AgentNodeEvent, AgentNodeEventResolution, AgentNodeEventResolutionError, ControlAuthority,
        ControlExecutionStep, ControlNodeResolution, ControlNodeResolutionError,
        ControlNodeResolutionOutcome, HumanDecision, ScriptReviewRule, TeamNodeEvent,
        TeamNodeEventKind, TeamNodeEventOutcome, TeamNodeEventProducer, TeamNodeEventProducerError,
        TeamNodeNonTerminalEvent, TeamNodeTerminalEvent,
    };
    pub use decision::{
        TeamDecision, TeamDecisionCommand, TeamDecisionCommandError, TeamDecisionLedger,
        TeamDecisionLedgerRestoreError, TeamDecisionLedgerSnapshot, TeamDecisionReceipt,
        TeamDecisionRecordError, TeamDecisionSnapshot, TeamDecisionType,
    };
    pub use delivery::{
        AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionError,
        AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionReceipt, Delivery,
        DeliveryClaim, DeliveryClaimSnapshot, DeliveryDispatch, DeliveryFailure, DeliveryId,
        DeliveryIdError, DeliveryLedger, DeliveryLedgerSnapshot, DeliveryPhase,
        DeliveryPhaseSnapshot, DeliveryReceipt, DeliveryReceiptError, DeliveryRecovery,
        DeliveryRequest, DeliveryRequestError, DeliveryResolution, DeliverySnapshot, DeliveryStart,
        InvalidAuthorizedGraphResolution, InvalidAuthorizedGraphResolutionReceipt,
        NativeDeliveryCorrelation, NativeRunOutputResolutionError, RegisterDeliveryError,
        RegisterOutcome, RestoreDeliveryError, RestoreLedgerError, TeamNodeOutput,
        TeamNodeOutputDispatch, TeamNodeOutputError, TerminalObservationError,
        TerminalObservationOutcome, begin_delivery, recover_interrupted_delivery,
        register_delivery, settle_delivery,
    };
    pub use diagnostics::{
        MAX_DIAGNOSTICS_COUNT, MAX_DIAGNOSTICS_STALE_EXECUTIONS, TeamRunDiagnosticsApprovalSummary,
        TeamRunDiagnosticsBudgets, TeamRunDiagnosticsConfidence,
        TeamRunDiagnosticsDeliveryFailureSummary, TeamRunDiagnosticsDeliverySummary,
        TeamRunDiagnosticsFailureSummary, TeamRunDiagnosticsGraphStatus,
        TeamRunDiagnosticsLifecycleStatus, TeamRunDiagnosticsLimits, TeamRunDiagnosticsProjection,
        TeamRunDiagnosticsQueryOutcome, TeamRunDiagnosticsRetrySummary,
        TeamRunDiagnosticsStaleExecution, TeamRunDiagnosticsStatus,
        TeamRunDiagnosticsUnavailableReason, TeamRunDiagnosticsUnavailableSection,
        query_team_run_diagnostics,
    };
    pub use event::{
        ApprovalAction, CommandPayload, CommandReceipt, CommandRejection, NodeEventKind,
        NodeProgressCommand, RecordCommandError, RunCommand,
    };
    pub use evidence::{
        EvidenceId, EvidenceIdError, EvidenceLedger, EvidenceRecord, EvidenceRecordError,
        EvidenceReference, EvidenceReferenceError, EvidenceReferenceKind, RecordOutcome,
        RestoreLedgerError as RestoreEvidenceLedgerError,
    };
    pub use graph::{
        AttemptId, AttemptProjection, AttemptReason, AttemptStatus, DefinitionError,
        DependencyMetadata, DurableDependencyMetadata, DurableEdgeDefinition, DurableGraphLayout,
        DurableNodeDefinition, DurableNodePosition, DurableWorkAssignment, DurableWorkGroup,
        EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, EdgeProjection, EdgeStatus,
        ExecutionFence, ExecutorPolicy, GraphDefinition, GraphEvent, GraphLayout, GraphPatch,
        GraphPatchError, GraphPatchOperation, GraphProjection, GraphRunId, GraphState, GraphStatus,
        GraphYamlError, GroupId, InputProjection, InputReceipt, JoinPolicy, NodeAttempt,
        NodeDefinition, NodeExecutionHistory, NodeExecutionId, NodeId, NodeKind, NodePosition,
        NodeProjection, ReadyQueueItem, ReduceError, RestoreError, ReviewAssignment, StartTrigger,
        WorkAssignment, WorkGroup, WorkflowGroup, WorkflowJoinPolicy, WorkflowPlan,
        WorkflowPlanCompilation, WorkflowPlanCompileError, WorkflowTask, apply_graph_patch,
        compile_workflow_plan, export_yaml, import_for_run, import_yaml, project, reduce,
        restore_oracle,
    };
    pub use lifecycle::{
        BeginCancellationOutcome, CancellationPlan, CreateGraphRunOutcome, GraphRunLifecycle,
        GraphRunLifecycleState, ResumeOutcome, RoleAbortOutcome, SettleCancellationOutcome,
        TombstoneOutcome,
    };
    pub use public_projection::{
        TeamPublicApprovalDecision, TeamPublicApprovalResolutionCause, TeamPublicApprovalStatus,
        TeamPublicAttempt, TeamPublicAttemptReason, TeamPublicAttemptStatus,
        TeamPublicDecisionType, TeamPublicDeliveryFailure, TeamPublicEdge, TeamPublicEdgeAction,
        TeamPublicEdgeStatus, TeamPublicEventAction, TeamPublicEventType, TeamPublicGraph,
        TeamPublicGraphLayout, TeamPublicGraphStatus, TeamPublicNode, TeamPublicNodeKind,
        TeamPublicNodePosition, TeamPublicProjection, TeamPublicQueryOutcome,
        TeamPublicTerminalResolution, TeamRunPublicApproval, TeamRunPublicArtifact,
        TeamRunPublicAttempt, TeamRunPublicCounts, TeamRunPublicDecision, TeamRunPublicDelivery,
        TeamRunPublicDeliveryPhase, TeamRunPublicDiagnostics, TeamRunPublicDiagnosticsQueryOutcome,
        TeamRunPublicEvent, TeamRunPublicLifecycle, TeamRunPublicRun, TeamRunPublicSnapshot,
        TeamRunPublicSnapshotQueryOutcome, TeamRunPublicSnapshotUnavailable,
        TeamRunPublicStartGate, TeamRunPublicUnavailableSection, TeamRuntimeState,
        project_team_run_public_event, query_team_public_projection,
        query_team_run_public_diagnostics, query_team_run_public_snapshot,
    };
    pub use purge::{
        GraphRunPurgeOutcome, GraphRunPurgeRejection, GraphRunPurgeUnknown, NativeDeletionEvidence,
        NativeDeletionProof, NativeDeletionProofError, RoleSessionDeletionConfirmation,
        TeamRunPurgeRequest, purge_team_run,
    };
    pub use query::{
        TeamRoleSessionQueryOutcome, TeamRunProjection, TeamRunQuery, TeamRunQueryOutcome,
        query_team_role_sessions, query_team_run,
    };
    pub use recovery::{
        AttemptRecoveryItem, CancellationRecoveryAction, DeliveryRecoveryAction,
        DeliveryRecoveryItem, DeliveryRecoverySummary, LedgerRecoverySummary,
        OrganizationRecoveryApply, OrganizationRecoveryPlan, RecoveryQueryError,
        ReviewRecoveryStatus, ReviewRecoverySummary, RunRecoveryStatus, TeamRunRecoveryPlan,
        TeamRunRecoveryQuery, apply_organization_recovery, plan_organization_recovery,
        query_team_run_recovery,
    };
    pub use scheduler::{
        ArmedCronTrigger, CronScheduleError, CronTriggerScheduleError, DueCronTriggerPlan,
        NodePromptRetryDueInvalidReason, NodePromptRetryDueItem, NodePromptRetryDuePlan,
        NodePromptRetryDueQuery, NodePromptRetryDueQueryError, NodePromptRetryDueQueryOutcome,
        NodePromptRetryDueResolution, NodePromptRetryDueUnknownReason, ReadyNodeSchedule,
        ReadyScheduleError, TerminalObservationPlan, next_cron_slot_after, plan_due_cron_trigger,
        plan_terminal_observations, produce_node_prompt_retry_due, query_node_prompt_retry_due,
        schedule_ready_nodes,
    };
    pub use task_board::{
        AutoRunnerFacts, MailboxKind, MailboxMessage, RunnerStatus, TaskBoardError, TaskBoardFacts,
        TaskId, TaskPlanInput, TaskRecord, TaskStatus, claim_next, close_runner, heartbeat,
        pause_runner, post, pull, reclaim_expired, release, start_runner, transition, upsert_plan,
    };
    pub use trigger::{
        ArmedTriggerFacts, ArmedWebhookTrigger, RestoreTriggerLedgerError, TeamTriggerFireOutcome,
        TeamTriggerFireRequest, TeamTriggerFireRequestError, TriggerFireError, TriggerFireRequest,
        TriggerFireRequestError, TriggerLedger, TriggerRegistration, TriggerSource,
        WebhookTriggerResolution, WebhookTriggerResolutionError, resolve_webhook_trigger,
    };
}

pub use adapters::mcp::TeamRunMcpFacade;
pub use adapters::session_terminal::{
    OrganizationRunPhase, OrganizationRunTerminalSnapshot, OrganizationSessionTerminal,
    TeamMessageRepairSessionOutcome, TeamMessageRepairSessionPort, TeamMessageRepairSessionRequest,
};
pub use adapters::start_gate_send_hook::{
    PreparedStartGateSend, StartGateNativeEndpoint, StartGateRegistry, StartGateSendHook,
    StartGateSendRequest, StartGateSendState,
};
pub use api::{
    OrganizationModule, OrganizationOwnerInput, StartGatePromptPlan, StartGateRuntimeBindingLookup,
    TeamMessageRepairDispatch, TeamMessageTerminalContext, TeamMessageTerminalObservation,
    TeamMessageTerminalPlan, plan_team_message_terminal,
};
pub use application::{
    ManualTeamProvision, TEAM_PUBLIC_PLACEHOLDER_PATH, TeamDecisionCompositionError,
    TeamDecisionFacade, TeamDecisionReceiptProjection, TeamDecisionRequest, TeamGraphPatchDraft,
    TeamNodeEventCommandOutcome, TeamRuntimeCapabilityRequest, TeamRuntimeCommand,
    TeamRuntimeCommandOutcome, TeamRuntimeControlOutcome, TeamRuntimeCreateSource,
    TeamRuntimeDecodeError, TeamRuntimeStatus, decode_team_runtime_capability_request,
    decode_team_runtime_command, execute_team_runtime_capability_request,
    is_team_runtime_facade_scope, project_team_runtime_outcome,
    summarize_team_runtime_control_outcome, team_public_unavailable_section_name,
};
pub use owner::{
    AdmissionState, ArmedTrigger, ManualTeamCreateOutcome, OrganizationCommand, OrganizationHandle,
    OrganizationOwner, OrganizationPhase, OrganizationQuery, RequestAdmissionClosed,
    TeamDeleteOutcome, TeamMaterializationCommandOutcome, TeamNodeTerminalResolution,
    TeamNodeTerminalResult, TeamRunAdmission, TeamRunCommandOutcome, TeamRunCoordinator,
    TeamRunCoordinatorHandle, TeamRunCoordinatorInput, TeamRunTriggerOutcome, TeamTrigger,
};
pub use package::{
    Dependency, DependencyKind, InvalidTeamSkillPackage, PackageRole, TeamSkillPackage,
    TeamSkillPackageError, TeamSkillPackageInput, TeamSkillPackageReader, TeamSkillPackageRoot,
};

pub use ports::{
    ActivityExecutionOutcome, ActivityExecutionRequest, ActivityExecutionRequestError,
    DeliveryReceiptReference, DeliveryReference, DeliveryRejection, EndpointSessionId,
    IdempotencyKey, InvalidMaterializationReceipt, InvalidOrganizationReference,
    InvalidRoleAgentMaterialization, InvalidRoleSessionRef, InvalidRunRuntimeReceipt,
    InvalidTeamMaterializationIntent, ManagedAgentReference, MaterializationOperationOutcome,
    MaterializationOperationReceipt, MaterializationReceipt, MaterializationRejection,
    MaterializationSource, MemberIntroductionError, MemberIntroductionRequest, MemberProfile,
    NativeEffectFailure, NativeRunSettled, NativeWorkspaceReceipt,
    OrganizationNativeRuntime, OrganizationRuntimeDirectory, ROLE_SESSION_REF_INITIAL,
    RoleAgentMaterialization, RoleMaterializationAgent, RoleMaterializationOwnership,
    RoleMaterializationReceipt, RoleSessionAbortOutcome, RoleSessionAbortReceipt,
    RoleSessionDeleteOutcome, RoleSessionDeleteReceipt, RoleSessionIdentityResolver,
    RoleSessionPort, RoleSessionReadbackOutcome, RoleSessionReadbackReceipt, RoleSessionReceipt,
    RoleSessionRef, RoleSessionSlot, RoleSessionWindow, RunRuntimeReceipt,
    RuntimeEndpointReference, RuntimeReceiptOutcome, SessionWindowReference, TeamActivityExecutor,
    TeamMaterializationIntent, TeamMaterializationPort, TeamMaterializationRemoval,
    TeamMaterializationRequest, TeamMemberIntroductions, TeamNativeEffectsPort,
    TeamProvisionMemberStatus, TeamProvisionObserver, TeamProvisionProgress,
    TeamProvisionReporter, TeamProvisionStage, TeamProvisionUpdate,
};
pub use run::delivery::{NativeRunReceiptReference, NativeTerminalStatus};
pub use run::event::ApprovalAction;
pub use run::lifecycle::{
    BeginCancellationOutcome, CancellationPlan, CreateGraphRunOutcome, GraphRunLifecycle,
    GraphRunLifecycleState, ResumeOutcome, RoleAbortOutcome, SettleCancellationOutcome,
    TombstoneOutcome,
};
pub use run::{
    Activity, ActivityClaim, ActivityClaimOutcome, ActivityClaimSnapshot, ActivityDispatch,
    ActivityDispatchOutcome, ActivityDispatchSnapshot, ActivityFailure, ActivityId,
    ActivityIdError, ActivityKind, ActivityLedger, ActivityLedgerSnapshot, ActivityPhase,
    ActivityPhaseSnapshot, ActivityRegistrationOutcome, ActivityRequest, ActivityRequestError,
    ActivitySettlement, ActivitySettlementOutcome, ActivitySnapshot, ActivityTarget,
    ActivityTargetError, ActivityTransitionError, AgentNodeEvent, AgentNodeEventResolution,
    AgentNodeEventResolutionError, Approval, ApprovalDecision, ApprovalEffect, ApprovalOrigin,
    ApprovalRequest, ApprovalResolution, ApprovalResolutionError, ApprovalStatus, ApprovalSubject,
    ArmedCronTrigger, ArmedTriggerFacts, ArmedWebhookTrigger, Attempt, AttemptId, AttemptIdentity,
    AttemptOutcome, AttemptPhase, AttemptProjection, AttemptReason, AttemptReceipt,
    AttemptRecoveryItem, AttemptStatus, AuthorizedGraphOutcome, AuthorizedGraphResolution,
    AuthorizedGraphResolutionError, AuthorizedGraphResolutionOutcome,
    AuthorizedGraphResolutionReceipt, CancellationRecoveryAction, CommandPayload, CommandReceipt,
    CommandRejection, ContextEdge, ContextNode, ControlAuthority, ControlExecutionStep,
    ControlNodeResolution, ControlNodeResolutionError, ControlNodeResolutionOutcome,
    CronScheduleError, CronTriggerScheduleError, DefinitionError, Delivery, DeliveryClaim,
    DeliveryClaimSnapshot, DeliveryDispatch, DeliveryFailure, DeliveryId, DeliveryIdError,
    DeliveryLedger, DeliveryLedgerSnapshot, DeliveryPhase, DeliveryPhaseSnapshot, DeliveryReceipt,
    DeliveryReceiptError, DeliveryRecovery, DeliveryRecoveryAction, DeliveryRecoveryItem,
    DeliveryRecoverySummary, DeliveryRequest, DeliveryRequestError, DeliveryResolution,
    DeliverySnapshot, DeliveryStart, DependencyMetadata, DueCronTriggerPlan, EdgeAction,
    EdgeDefinition, EdgeId, EdgePayloadPolicy, EdgeProjection, EdgeStatus, EvidenceId,
    EvidenceIdError, EvidenceLedger, EvidenceRecord, EvidenceRecordError, EvidenceReference,
    EvidenceReferenceError, EvidenceReferenceKind, ExecutionFence, ExecutorPolicy, GraphDefinition,
    GraphEvent, GraphPatch, GraphPatchError, GraphPatchOperation, GraphProjection, GraphRunId,
    GraphRunPurgeOutcome, GraphRunPurgeRejection, GraphRunPurgeUnknown, GraphState, GraphStatus,
    GraphYamlError, GroupId, HumanDecision, InputProjection, InputReceipt, InvalidAttemptIdentity,
    InvalidAuthorizedGraphResolution, InvalidAuthorizedGraphResolutionReceipt, JoinPolicy,
    LedgerRecoverySummary, MAX_DIAGNOSTICS_COUNT, MAX_DIAGNOSTICS_STALE_EXECUTIONS,
    NativeDeletionEvidence, NativeDeletionProof, NativeDeletionProofError,
    NativeDeliveryCorrelation, NativeRunOutputResolutionError, NodeAttempt, NodeDefinition,
    NodeExecutionHistory, NodeExecutionId, NodeId, NodeKind, NodeProjection,
    OrganizationRecoveryApply, OrganizationRecoveryPlan, ReadyQueueItem, RecordCommandError,
    RecordOutcome, RecoveryAction, RecoveryFault, RecoveryQueryError, ReduceError,
    RegisterDeliveryError, RegisterOutcome, ResolveApprovalError, RestoreActivityError,
    RestoreActivityLedgerError, RestoreDeliveryError, RestoreError, RestoreEvidenceLedgerError,
    RestoreLedgerError, RestoreTriggerLedgerError, ReviewAssignment, ReviewRecoveryStatus,
    ReviewRecoverySummary, RoleSessionDeletionConfirmation, RunCommand, RunRecoveryStatus,
    ScriptReviewRule, SettleOutcome, StartOutcome, StartTrigger, TeamDecision, TeamDecisionCommand,
    TeamDecisionCommandError, TeamDecisionLedger, TeamDecisionLedgerRestoreError,
    TeamDecisionLedgerSnapshot, TeamDecisionReceipt, TeamDecisionRecordError, TeamDecisionSnapshot,
    TeamDecisionType, TeamGraphContext, TeamGraphContextQuery, TeamGraphContextQueryError,
    TeamGraphContextResult, TeamGraphContextView, TeamNodeEvent, TeamNodeEventKind,
    TeamNodeEventOutcome, TeamNodeEventProducer, TeamNodeEventProducerError,
    TeamNodeNonTerminalEvent, TeamNodeOutput, TeamNodeOutputError, TeamNodeTerminalEvent,
    TeamPublicAttempt, TeamPublicAttemptStatus, TeamPublicEdge, TeamPublicEdgeAction,
    TeamPublicEdgeStatus, TeamPublicGraph, TeamPublicGraphStatus, TeamPublicNode,
    TeamPublicNodeKind, TeamPublicProjection, TeamPublicQueryOutcome, TeamRoleSessionQueryOutcome,
    TeamRunDiagnosticsApprovalSummary, TeamRunDiagnosticsBudgets, TeamRunDiagnosticsConfidence,
    TeamRunDiagnosticsDeliveryFailureSummary, TeamRunDiagnosticsDeliverySummary,
    TeamRunDiagnosticsFailureSummary, TeamRunDiagnosticsGraphStatus,
    TeamRunDiagnosticsLifecycleStatus, TeamRunDiagnosticsLimits, TeamRunDiagnosticsProjection,
    TeamRunDiagnosticsQueryOutcome, TeamRunDiagnosticsRetrySummary,
    TeamRunDiagnosticsStaleExecution, TeamRunDiagnosticsStatus,
    TeamRunDiagnosticsUnavailableReason, TeamRunDiagnosticsUnavailableSection, TeamRunProjection,
    TeamRunPublicStartGate, TeamRunPurgeRequest, TeamRunQuery, TeamRunQueryOutcome,
    TeamRunRecoveryPlan, TeamRunRecoveryQuery, TeamRuntimeState, TeamTriggerFireOutcome,
    TeamTriggerFireRequest, TeamTriggerFireRequestError, TerminalObservationError,
    TerminalObservationOutcome, TerminalObservationPlan, TriggerFireError, TriggerFireRequest,
    TriggerFireRequestError, TriggerLedger, TriggerRegistration, TriggerSource, WaitOutcome,
    WebhookTriggerResolution, WebhookTriggerResolutionError, WorkAssignment, WorkGroup,
    WorkflowGroup, WorkflowJoinPolicy, WorkflowPlan, WorkflowTask, abort_pending_approvals,
    apply_graph_patch, apply_organization_recovery, begin_delivery, claim_activity,
    dispatch_activity, export_yaml, import_for_run, import_yaml, next_cron_slot_after,
    plan_due_cron_trigger, plan_organization_recovery, plan_terminal_observations, project,
    query_team_graph_context, query_team_public_projection, query_team_run,
    query_team_run_diagnostics, query_team_run_recovery, recover_interrupted_activity,
    recover_interrupted_delivery, recovery_oracle, reduce, register_delivery, resolve_approval,
    resolve_webhook_trigger, restore_oracle, settle_activity, settle_delivery,
};
pub use store::{
    ConfirmRunStartOutcome, ContinueRunDiscussionOutcome, GraphRunFacts,
    NativeTerminalReceiptTarget, OrganizationFacts, OrganizationFactsError, OrganizationStore,
    PendingWorkflowPlanAdmission, RunStartGate, SetRunStartProposalOutcome, StoreFault, TeamFacts,
    TeamTombstoneOutcome, WorkflowPlanAdmissionOutcome, WorkflowPlanSubmitOutcome,
    WorkflowTemplateFacts,
};
const ORGANIZATION_FACTS_FILE: &str = "organization-facts.log";

pub fn open_organization_store(
    state_dir: &std::path::Path,
) -> Result<OrganizationStore, StoreFault> {
    OrganizationStore::open(state_dir.join(ORGANIZATION_FACTS_FILE))
}

pub use team::{
    CreateTeam, InvalidMemberId, InvalidMemberName, InvalidReplaceTeam, InvalidRoleId,
    InvalidTeamCreated, InvalidTeamDefinition, InvalidTeamId, InvalidTeamListPage,
    InvalidTeamPageSize, InvalidTeamReplaced, InvalidTeamRevision, InvalidTeamRole, LEADER_ROLE_ID,
    ListTeams, MAX_TEAM_PAGE_SIZE, ManualTeamRoleBinding, MaterializationLifecycleError,
    MaterializationRecordOutcome, MemberId, RemoveTeam, ReplaceTeam, RoleAssignment, RoleId,
    RoleKind, TeamCommand, TeamCreated, TeamDefinition, TeamEvent, TeamId, TeamListPage,
    TeamMaterialization, TeamMaterializationCleanup, TeamMaterializationError,
    TeamMaterializationLifecycle, TeamMember, TeamPageSize, TeamProjection, TeamQuery, TeamRemoved,
    TeamReplaced, TeamRevision, TeamRevisionOverflow, TeamRole, TombstonedMaterialization,
    compile_manual_team_materialization, compile_team_skill_materialization,
};

impl OrganizationModule {
    pub fn descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        webhook_token: adapters::loopback::trigger::WebhookToken,
        role_session_identity: Arc<dyn RoleSessionIdentityResolver>,
    ) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(
                    verifier,
                    self.handle().clone(),
                    webhook_token,
                    role_session_identity,
                ).with_call_workflows(self.call_workflows.clone()),
            )),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: OrganizationOwnerInput,
) -> (OrganizationModule, OwnedTask<()>) {
    let owner = owner::actor::OrganizationOwner::new(input);
    let command_target = owner.command_target();
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(256, owner::actor::OrganizationOwner::lane_retention()),
    );
    let _ = command_target.set(handle.clone());
    (
        OrganizationModule::new(OrganizationHandle::new(handle)),
        task,
    )
}
