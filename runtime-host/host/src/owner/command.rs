use std::path::PathBuf;
use std::time::SystemTime;

use tokio::sync::oneshot;

use super::lifecycle::{
    RestartMatchaError, RestartOpenClawError, StartMatchaError, StartOpenClawError,
    StopMatchaError, StopOpenClawError,
};
use crate::{
    Host, HostState, RequestAdmissionClosed, RuntimeSessionError, RuntimeState,
    channel_status::{
        ChannelPairingOutcome, ChannelSnapshotOutcome, ChannelStatusFailure, ChannelStatusOutcome,
    },
    composition::{
        ControlLease, OpenClawGatewayHealthObservation, OpenClawGatewayStatusObservation,
        OpenClawLogSnapshot, TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
    diagnostics::{
        DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    },
    external_connectors::{
        CatalogOutcome as ConnectorCatalogOutcome, GetOutcome as ConnectorGetOutcome,
        ListOutcome as ConnectorListOutcome, MutationOutcome as ConnectorMutationOutcome,
        ProbeOutcome as ConnectorProbeOutcome,
    },
    matcha_history::{Command as MatchaHistoryCommand, Outcome as MatchaHistoryOutcome},
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    session_create::{SessionCreateCommand, SessionCreateOutcome},
    session_delete::{SessionDeleteCommand, SessionDeleteOutcome},
    session_model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
    session_rename::{SessionRenameCommand, SessionRenameOutcome},
    session_send::{SessionSendCommand, SessionSendOutcome},
    session_state::{SessionApplyResult, SessionChange, SessionIdentity, SessionView},
    session_timeline::{Command as SessionTimelineCommand, Outcome as SessionTimelineOutcome},
};
use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult, SessionsListParams, SessionsListResult,
    },
};
use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId, GraphDefinition, GraphPatch,
    GraphRunId, IdempotencyKey, ResumeOutcome, RoleChatAdmission, RoleChatAdmissionOutcome,
    RunCommand, StoreFault, TeamDecisionReceipt, TeamGraphContextResult, TeamGraphContextView,
    TeamId, TeamNodeEventOutcome, TeamRunQueryOutcome, TeamTriggerFireOutcome, TombstoneOutcome,
    TriggerFireRequest,
    package::{
        TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionError,
        TeamSkillSelectionId,
    },
    run::scheduler::NodePromptRetryDueQueryOutcome,
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
        public_projection::{TeamPublicQueryOutcome, TeamRunPublicSnapshotQueryOutcome},
    },
};
use platform::exchange::InvocationOutcome;

pub(super) enum Command {
    State(oneshot::Sender<HostState>),
    PeerAutostart {
        open_claw_auto_start: bool,
        reply: oneshot::Sender<()>,
    },
    Diagnostics(DiagnosticsCommand),
    Matcha(MatchaCommand),
    SessionAbort {
        command: SessionAbortCommand,
        reply: oneshot::Sender<SessionAbortOutcome>,
    },
    SessionCreate {
        command: SessionCreateCommand,
        reply: oneshot::Sender<SessionCreateOutcome>,
    },
    SessionDelete {
        command: SessionDeleteCommand,
        reply: oneshot::Sender<SessionDeleteOutcome>,
    },
    SessionRename {
        command: SessionRenameCommand,
        reply: oneshot::Sender<SessionRenameOutcome>,
    },
    PendingApprovals {
        command: PendingApprovalsCommand,
        reply: oneshot::Sender<PendingApprovalsOutcome>,
    },
    SessionApproval {
        command: SessionApprovalCommand,
        reply: oneshot::Sender<SessionApprovalOutcome>,
    },
    SecurityEmergency {
        reply: oneshot::Sender<crate::security_emergency::SecurityEmergencyOutcome>,
    },
    SecurityAudit {
        query: crate::security_audit::Query,
        reply: oneshot::Sender<crate::security_audit::Outcome>,
    },
    SyncSecurityPolicy {
        policy: serde_json::Value,
        reply: oneshot::Sender<crate::security_delivery::Outcome>,
    },
    SecurityOperation {
        operation_id: String,
        input: serde_json::Value,
        reply: oneshot::Sender<openclaw::operations::SecurityActionEffect>,
    },
    SessionSend {
        command: SessionSendCommand,
        reply: oneshot::Sender<SessionSendOutcome>,
    },
    HostSessionRegister {
        identity: SessionIdentity,
        route_key: Option<String>,
        run_id: Option<String>,
        reply: oneshot::Sender<bool>,
    },
    HostSessionApply {
        session_key: String,
        route_key: Option<String>,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
        reply: oneshot::Sender<SessionApplyResult>,
    },
    HostSessionView {
        session_key: String,
        reply: oneshot::Sender<Option<SessionView>>,
    },
    HostSessionEpoch {
        reply: oneshot::Sender<u64>,
    },
    SessionModelSelection {
        command: SessionModelSelectionCommand,
        reply: oneshot::Sender<SessionModelSelectionOutcome>,
    },
    SessionTimeline {
        command: SessionTimelineCommand,
        reply: oneshot::Sender<SessionTimelineOutcome>,
    },
    ListMatchaSessions {
        reply: oneshot::Sender<crate::matcha_session_catalog::Outcome>,
    },
    MatchaHistory {
        command: MatchaHistoryCommand,
        reply: oneshot::Sender<MatchaHistoryOutcome>,
    },
    CronList {
        reply: oneshot::Sender<crate::cron::CronListOutcome>,
    },
    CronHistory {
        command: crate::cron::CronHistoryCommand,
        reply: oneshot::Sender<crate::cron::CronHistoryOutcome>,
    },
    CronCreate {
        command: crate::cron::CronCreateCommand,
        reply: oneshot::Sender<crate::cron::CronJobMutationOutcome>,
    },
    CronUpdate {
        command: crate::cron::CronUpdateCommand,
        reply: oneshot::Sender<crate::cron::CronJobMutationOutcome>,
    },
    CronDelete {
        command: crate::cron::CronDeleteCommand,
        reply: oneshot::Sender<crate::cron::CronDeleteOutcome>,
    },
    CronBroker {
        request: crate::cron::CronBrokerRequest,
        reply: oneshot::Sender<crate::cron::CronBrokerOutcome>,
    },
    Agents {
        command: crate::agents::Command,
        reply: oneshot::Sender<crate::agents::Outcome>,
    },
    PlatformTools {
        reply: oneshot::Sender<crate::platform_tools::Outcome>,
    },
    SkillInstall {
        command: crate::skill_install::Command,
        reply: oneshot::Sender<crate::skill_install::Outcome>,
    },
    SkillStatus {
        reply: oneshot::Sender<crate::skill_status::Outcome>,
    },
    SkillManagement {
        command: crate::skill_management::Command,
        reply: oneshot::Sender<crate::skill_management::Outcome>,
    },
    SkillBundle {
        command: crate::skill_bundle::Command,
        reply: oneshot::Sender<crate::skill_bundle::Outcome>,
    },
    ExternalConnectors(ExternalConnectorsCommand),
    ProviderAccounts(ProviderAccountsCommand),
    ProviderModels(ProviderModelsCommand),
    ProviderRouting(ProviderRoutingCommand),
    Fleet(FleetCommand),
    TaskManager {
        command: crate::task_manager::Command,
        reply: oneshot::Sender<crate::task_manager::Outcome>,
    },
    Runtime(RuntimeCommand),
    GetCompatibleRuntimeJob {
        job_id: String,
        reply: oneshot::Sender<
            Result<
                crate::projection::job_compatibility::JobCompatibilityLookup,
                RequestAdmissionClosed,
            >,
        >,
    },
    TeamSkill(TeamSkillCommand),
    TeamRun(Box<TeamRunCommand>),
    TeamRuntime {
        request: TeamRuntimeCommand,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
        command: Box<RunCommand>,
        definition: GraphDefinition,
    },
    GraphPatch {
        command: Box<RunCommand>,
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
        command: Box<RunCommand>,
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
        decision: organization::TeamDecisionType,
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
    ProvisionAgents(crate::composition::TeamMaterializationCommandOutcome),
    Delete(Result<crate::composition::TeamDeleteOutcome, StoreFault>),
    RunCreate(Result<CreateGraphRunOutcome, TeamRuntimeStatus>),
    RunList(Vec<TeamRunQueryOutcome>),
    TriggerList(Vec<crate::composition::ArmedTrigger>),
    WebhookTriggerFire(Result<TeamTriggerFireOutcome, TeamRuntimeStatus>),
    RunSnapshot(TeamRunPublicSnapshotQueryOutcome),
    RunSnapshotInvalidInput,
    GraphSave(Result<crate::composition::TeamRunCommandOutcome, StoreFault>),
    GraphPatch(Result<crate::composition::TeamRunCommandOutcome, StoreFault>),
    GraphContext(TeamGraphContextResult),
    GraphExportYaml(Result<String, TeamRuntimeStatus>),
    GraphImportYaml(Result<TeamRunCommandOutcome, StoreFault>),
    TriggerFire(Result<crate::composition::TeamRunTriggerOutcome, StoreFault>),
    RoleMessageSubmit(Result<RoleChatAdmissionOutcome, StoreFault>),
    RoleMessageSubmitForRun(Result<RoleChatAdmissionOutcome, StoreFault>),
    NodePromptRetryDue(NodePromptRetryDueQueryOutcome),
    NodePromptSettled(Result<crate::composition::TeamNodePromptSettledResult, TeamRuntimeStatus>),
    NodeEvent(Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus>),
    RunDiagnostics(organization::TeamRunDiagnosticsQueryOutcome),
    RunDecisionSubmit(Result<TeamDecisionReceipt, TeamRuntimeStatus>),
    Resume(Vec<ResumeOutcome>),
    ApprovalResolve(Result<HumanDecisionOutcome, StoreFault>),
    RunCancel(Result<BeginCancellationOutcome, StoreFault>),
    RunDelete(Result<organization::GraphRunPurgeOutcome, StoreFault>),
}

pub(super) enum DiagnosticsCommand {
    Submit {
        cancellation: DiagnosticsArchiveCancellation,
        reply: oneshot::Sender<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>>,
    },
    Download {
        archive_id: String,
        reply: oneshot::Sender<
            Result<Result<Vec<u8>, DiagnosticsArchiveError>, RequestAdmissionClosed>,
        >,
    },
}

pub(super) enum MatchaCommand {
    Start(oneshot::Sender<Result<RuntimeState, StartMatchaError>>),
    Stop(oneshot::Sender<Result<RuntimeState, StopMatchaError>>),
    Restart(oneshot::Sender<Result<RuntimeState, RestartMatchaError>>),
}

pub(super) enum TeamSkillCommand {
    Materialize {
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        reply: oneshot::Sender<crate::composition::TeamMaterializationCommandOutcome>,
    },
    Authorize {
        package_root: PathBuf,
        reply: oneshot::Sender<Result<TeamSkillSelectionId, TeamSkillSelectionError>>,
    },
    Validate {
        selection_id: TeamSkillSelectionId,
        reply: oneshot::Sender<TeamSkillPackageValidation>,
    },
    DependencyPlan {
        selection_id: TeamSkillSelectionId,
        reply: oneshot::Sender<TeamSkillDependencyPlanResult>,
    },
}

pub(super) enum TeamRunCommand {
    CreateForTeam {
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: Box<organization::WorkflowPlan>,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
        reply: oneshot::Sender<Result<CreateGraphRunOutcome, StoreFault>>,
    },
    MaterializeManualAndCreate {
        input: Box<crate::composition::ManualTeamMaterializationInput>,
        reply: oneshot::Sender<crate::composition::ManualTeamCreateOutcome>,
    },
    List {
        team_id: TeamId,
        reply: oneshot::Sender<Vec<TeamRunQueryOutcome>>,
    },
    RoleSessions {
        team_id: TeamId,
        reply: oneshot::Sender<organization::TeamRoleSessionQueryOutcome>,
    },
    Resume {
        team_id: TeamId,
        reply: oneshot::Sender<Vec<ResumeOutcome>>,
    },
    BeginCancellation {
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
        reply: oneshot::Sender<Result<BeginCancellationOutcome, StoreFault>>,
    },
    AbortAndSettleCancellation {
        plan: organization::CancellationPlan,
        idempotency_key: String,
        observed_at: u64,
        reply: oneshot::Sender<Result<BeginCancellationOutcome, StoreFault>>,
    },
    DeleteTeamAndRemove {
        team_id: TeamId,
        idempotency_key: String,
        observed_at: u64,
        reply: oneshot::Sender<Result<crate::composition::TeamDeleteOutcome, StoreFault>>,
    },
    Tombstone {
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
        reply: oneshot::Sender<Result<TombstoneOutcome, StoreFault>>,
    },
    DeleteRunAndPurge {
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
        reply: oneshot::Sender<Result<organization::GraphRunPurgeOutcome, StoreFault>>,
    },
    PublicProjection {
        team_id: organization::TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<TeamPublicQueryOutcome>,
    },
    TaskBoardRead {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<organization::run::task_board::TaskBoardFacts>,
    },
    TaskBoardMutate {
        team_id: TeamId,
        run_id: GraphRunId,
        operation: crate::transport::team_task_board::Operation,
        reply:
            oneshot::Sender<Result<crate::transport::team_task_board::MutationResult, StoreFault>>,
    },
    PendingApprovals {
        team_id: organization::TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<organization::run::TeamPendingApprovalsQueryOutcome>,
    },
    ResolveHumanDecision {
        command: HumanDecisionCommand,
        reply: oneshot::Sender<Result<HumanDecisionOutcome, StoreFault>>,
    },
    GraphDefinition {
        team_id: TeamId,
        run_id: GraphRunId,
        reply: oneshot::Sender<Option<GraphDefinition>>,
    },
    ArmedTriggers {
        team_id: Option<TeamId>,
        reply: oneshot::Sender<Vec<crate::composition::ArmedTrigger>>,
    },
    ReplaceGraph {
        command: Box<RunCommand>,
        definition: GraphDefinition,
        reply: oneshot::Sender<Result<TeamRunCommandOutcome, StoreFault>>,
    },
    FireTrigger {
        request: TriggerFireRequest,
        fired_at: u64,
        reply: oneshot::Sender<Result<TeamRunTriggerOutcome, StoreFault>>,
    },
    AdmitRoleChat {
        admission: RoleChatAdmission,
        reply: oneshot::Sender<Result<RoleChatAdmissionOutcome, StoreFault>>,
    },
    StartTerminalWatch {
        delivery_id: DeliveryId,
    },
    ObserveTerminalWatch {
        delivery_id: DeliveryId,
        terminal_status: matcha_agent::session::receipt::TerminalRunStatus,
        observed_at: u64,
    },
    ResolveAuthorizedGraphOutcome {
        resolution: organization::AuthorizedGraphResolution,
        reply: oneshot::Sender<Result<TeamRunCommandOutcome, StoreFault>>,
    },
}

pub(super) enum ExternalConnectorsCommand {
    Catalog {
        reply: oneshot::Sender<ConnectorCatalogOutcome>,
    },
    List {
        reply: oneshot::Sender<ConnectorListOutcome>,
    },
    Get {
        id: String,
        reply: oneshot::Sender<ConnectorGetOutcome>,
    },
    Upsert {
        connector: Box<environment::Connector>,
        reply: oneshot::Sender<ConnectorMutationOutcome>,
    },
    Remove {
        id: String,
        reply: oneshot::Sender<ConnectorMutationOutcome>,
    },
    Probe {
        id: String,
        reply: oneshot::Sender<ConnectorProbeOutcome>,
    },
    SessionStatus {
        identity: crate::external_connectors::SessionIdentity,
        reply: oneshot::Sender<crate::external_connectors::SessionStatusOutcome>,
    },
}

pub(super) enum ProviderAccountsCommand {
    ConfigurePrivateResolver {
        resolver: crate::transport::provider_accounts::private_auth::Resolver,
        reply: oneshot::Sender<()>,
    },
    List {
        reply: oneshot::Sender<crate::transport::provider_accounts::ProviderAccountsDelivery>,
    },
    Get {
        id: environment::ProviderAccountId,
        reply: oneshot::Sender<crate::transport::provider_accounts::ProviderAccountsDelivery>,
    },
    Replace {
        draft: crate::transport::provider_accounts::AccountDraft,
        reply: oneshot::Sender<crate::transport::provider_accounts::ProviderAccountsDelivery>,
    },
    Delete {
        id: environment::ProviderAccountId,
        revision: environment::ProviderAccountRevision,
        reply: oneshot::Sender<crate::transport::provider_accounts::ProviderAccountsDelivery>,
    },
}

pub(super) enum ProviderModelsCommand {
    List {
        reply: oneshot::Sender<crate::provider_models::ProviderModelListOutcome>,
    },
    Selectable {
        capability: environment::ProviderModelCapability,
        reply: oneshot::Sender<crate::provider_models::ProviderModelSelectableOutcome>,
    },
    Replace {
        account_id: String,
        drafts: Vec<crate::provider_models::ProviderModelDraft>,
        reply: oneshot::Sender<crate::provider_models::ProviderModelReplaceOutcome>,
    },
}

pub(super) enum FleetCommand {
    TerminalOpenAllocated {
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        dimensions: fleet::terminal::Dimensions,
        reply: oneshot::Sender<
            Result<
                crate::fleet::owner::FleetTerminalOpenResult,
                fleet::terminal::TerminalSessionError,
            >,
        >,
    },
    TerminalConsumeTicket {
        ticket: Vec<u8>,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalProviderOpen {
        context: crate::transport::fleet_terminal::TerminalContext,
        reply: oneshot::Sender<Result<crate::transport::fleet_terminal::TerminalProviderOpen, ()>>,
    },
    TerminalContext {
        summary: fleet::terminal::SessionSummary,
        reply: oneshot::Sender<Option<crate::transport::fleet_terminal::TerminalContext>>,
    },
    TerminalResolveContext {
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        summary: fleet::terminal::SessionSummary,
        reply: oneshot::Sender<Option<crate::transport::fleet_terminal::TerminalContext>>,
    },
    TerminalClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalBeginCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalFinishCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalReconnect {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::OpenedSession, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalBeginClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalFinishClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalList {
        reply: oneshot::Sender<Vec<fleet::terminal::SessionSummary>>,
    },
    QuerySnapshot {
        now: std::time::SystemTime,
        reply: oneshot::Sender<fleet::query::FleetQuerySnapshot>,
    },
    Snapshot {
        now: std::time::SystemTime,
        reply: oneshot::Sender<crate::fleet::owner::FleetSnapshot>,
    },
    SelectorPreview {
        constraints: fleet::query::SelectorConstraints,
        now: std::time::SystemTime,
        reply: oneshot::Sender<fleet::query::SelectorPreview>,
    },
    TargetSummaries {
        reply: oneshot::Sender<Vec<crate::fleet::owner::FleetTargetSummary>>,
    },
    TargetSelector {
        id: fleet::TargetId,
        revision: u64,
        kind: fleet::TargetKind,
        reply: oneshot::Sender<Option<fleet::FleetTargetSelector>>,
    },
    TopologySummary {
        reply: oneshot::Sender<crate::fleet::owner::FleetTopologySummary>,
    },
    PutTarget {
        id: fleet::TargetId,
        config: fleet::FleetTargetConfig,
        reply: oneshot::Sender<Result<fleet::TargetSnapshot, fleet::FleetDeliveryError>>,
    },
    RemoveTarget {
        id: fleet::TargetId,
        reply: oneshot::Sender<Result<bool, fleet::FleetDeliveryError>>,
    },
    Submit {
        request: fleet::FleetDeliveryRequest,
        reply: oneshot::Sender<Result<fleet::FleetSubmitOutcome, fleet::FleetDeliveryError>>,
    },
    NodeCommandRequest {
        request: crate::fleet::owner::FleetNodeCommandRequest,
        reply: oneshot::Sender<
            Result<crate::fleet::owner::FleetNodeCommandResolution, fleet::FleetDeliveryError>,
        >,
    },
    Begin {
        dispatch_id: fleet::outbox::DispatchId,
        reply: oneshot::Sender<
            Result<crate::fleet::owner::FleetDispatchResult, fleet::FleetDeliveryError>,
        >,
    },
    Accept {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Reject {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Unknown {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Replay {
        command_id: fleet::command::CommandId,
        dispatch_id: fleet::outbox::DispatchId,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    UpsertConnection {
        record: fleet::connection::ConnectionRecord,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    DeleteConnection {
        id: fleet::connection::ConnectionId,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    BeginConnectionProbe {
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    RunConnectionProbe {
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        reply: oneshot::Sender<
            Result<
                crate::fleet::lifecycle::FleetConnectionLifecycleOutcome,
                fleet::FleetDeliveryError,
            >,
        >,
    },
    RunEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    CompleteConnectionProbe {
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        outcome: fleet::connection::ProbeOutcome,
        message: Option<String>,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    RegisterEnvironment {
        record: fleet::environment::EnvironmentRecord,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    RegisterResource {
        request: super::ManagedResourceRegistrationRequest,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    UpsertNode {
        observation: fleet::topology::NodeObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertAgent {
        observation: fleet::topology::AgentObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    WriteCredential {
        request: crate::fleet::credentials::FleetCredentialWriteRequest,
        reply: oneshot::Sender<
            Result<
                crate::fleet::credentials::FleetCredentialWriteOutcome,
                crate::fleet::credentials::FleetCredentialVaultError,
            >,
        >,
    },
    RevokeAgent {
        id: platform::endpoint::NativeAgentId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertRuntime {
        observation: fleet::topology::RuntimeObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertEndpoint {
        observation: fleet::topology::EndpointObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireNode {
        id: fleet::topology::NodeId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginRuntimeStart {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteRuntimeStart {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginRuntimeStop {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteRuntimeStop {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireRuntime {
        id: fleet::topology::RuntimeId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    DrainEndpoint {
        id: platform::endpoint::EndpointId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireEndpoint {
        id: platform::endpoint::EndpointId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginEndpointProbe {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteEndpointProbe {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        health: fleet::topology::EndpointHealth,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginCapabilitySync {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteCapabilitySync {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        sync: fleet::topology::CapabilitySync,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    BeginEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    StartResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    StartResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    AuthenticateRuntimeAgentIngress {
        identity: fleet::store::AgentIngressIdentity,
        reply:
            oneshot::Sender<Result<fleet::store::IngressAuthentication, fleet::FleetDeliveryError>>,
    },
    RegisterRuntimeAgent {
        agent: fleet::runtime_agent::RuntimeAgent,
        reply: oneshot::Sender<Result<(), fleet::FleetDeliveryError>>,
    },
    RegisterRuntimeAgentCommand {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<(), fleet::FleetDeliveryError>>,
    },
    RecordRuntimeAgentHeartbeat {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RecordRuntimeAgentProgress {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RecordRuntimeAgentResult {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
}

pub(super) enum ProviderRoutingCommand {
    List {
        reply: oneshot::Sender<crate::provider_routing::ProviderRoutingListOutcome>,
    },
    Replace {
        routing: environment::ProviderRouting,
        reply: oneshot::Sender<crate::provider_routing::ProviderRoutingReplaceOutcome>,
    },
}

pub(super) enum RuntimeCommand {
    Environment(oneshot::Sender<Option<openclaw::projection::installation::Status>>),
    RuntimePaths(
        oneshot::Sender<
            Result<
                openclaw::projection::runtime_paths::RuntimePaths,
                openclaw::projection::runtime_paths::RuntimePathsError,
            >,
        >,
    ),
    CliCommand(
        oneshot::Sender<
            Result<
                openclaw::projection::runtime_paths::CliCommand,
                openclaw::projection::runtime_paths::CliCommandError,
            >,
        >,
    ),
    ToolPermissionMode(
        oneshot::Sender<
            Result<
                openclaw::projection::tool_permission::Mode,
                openclaw::projection::tool_permission::Error,
            >,
        >,
    ),
    SetToolPermissionMode {
        mode: openclaw::projection::tool_permission::Mode,
        reply: oneshot::Sender<
            Result<
                openclaw::projection::tool_permission::Effect,
                openclaw::projection::tool_permission::Error,
            >,
        >,
    },
    ToolchainStatus(
        oneshot::Sender<Result<openclaw::toolchain::ToolchainStatus, RequestAdmissionClosed>>,
    ),
    InstallToolchainUv(
        oneshot::Sender<Result<openclaw::toolchain::UvInstallOutcome, RequestAdmissionClosed>>,
    ),
    SubmitToolchainInstall(
        oneshot::Sender<
            Result<openclaw::toolchain::ToolchainJobSubmission, RequestAdmissionClosed>,
        >,
    ),
    GetToolchainJob {
        job_id: String,
        reply: oneshot::Sender<
            Result<openclaw::toolchain::ToolchainJobLookup, RequestAdmissionClosed>,
        >,
    },
    PluginsCatalog(oneshot::Sender<Result<crate::plugin::Catalog, crate::plugin::PluginError>>),
    PluginsRuntime(oneshot::Sender<Result<crate::plugin::Runtime, crate::plugin::PluginError>>),
    PluginsSetEnabled {
        plugin_id: String,
        enabled: bool,
        reply: oneshot::Sender<crate::plugin::ConfigurationOutcome>,
    },
    PluginsOperation {
        operation: crate::plugin::Operation,
        plugin_id: String,
        reply: oneshot::Sender<crate::plugin::OperationOutcome>,
    },
    ListSubagentTemplates(
        oneshot::Sender<
            Result<
                openclaw::projection::subagent_templates::Catalog,
                openclaw::projection::subagent_templates::SubagentTemplateError,
            >,
        >,
    ),
    SubagentTemplate {
        id: String,
        reply: oneshot::Sender<
            Result<
                openclaw::projection::subagent_templates::Detail,
                openclaw::projection::subagent_templates::SubagentTemplateError,
            >,
        >,
    },
    Start(oneshot::Sender<Result<RuntimeState, StartOpenClawError>>),
    Stop(oneshot::Sender<Result<RuntimeState, StopOpenClawError>>),
    Restart(oneshot::Sender<Result<RuntimeState, RestartOpenClawError>>),
    Logs {
        cursor: Option<u64>,
        reply: oneshot::Sender<Result<OpenClawLogSnapshot, ()>>,
    },
    GatewayHealth {
        probe: bool,
        reply: oneshot::Sender<Result<OpenClawGatewayHealthObservation, RequestAdmissionClosed>>,
    },
    GatewayStatus {
        include_channel_summary: bool,
        reply: oneshot::Sender<Result<OpenClawGatewayStatusObservation, RequestAdmissionClosed>>,
    },
    ControlUiUrl(oneshot::Sender<String>),
    ControlLease(oneshot::Sender<Result<ControlLease, RequestAdmissionClosed>>),
    TriggerCron {
        job_id: String,
        reply: oneshot::Sender<Result<openclaw::port::CronTriggerOutcome, RequestAdmissionClosed>>,
    },
    ChannelAccounts(oneshot::Sender<Result<ChannelStatusOutcome, ChannelStatusFailure>>),
    ChannelSnapshot(oneshot::Sender<Result<ChannelSnapshotOutcome, ChannelStatusFailure>>),
    ChannelConfigRead {
        channel: String,
        account_id: Option<String>,
        reply: oneshot::Sender<crate::channel_config_read::Outcome>,
    },
    ChannelCredentialsValidate {
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<crate::channel_credentials::Outcome>,
    },
    ChannelCatalog(oneshot::Sender<crate::channel_catalog::ChannelCatalogOutcome>),
    ChannelConfigureForm {
        channel: String,
        reply: oneshot::Sender<crate::channel_catalog::ChannelConfigureFormOutcome>,
    },
    ChannelConfigure {
        channel: String,
        account_id: String,
        values: zeroize::Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<crate::channel_catalog::ChannelConfigureOutcome>,
    },
    ChannelDeleteConfig {
        channel: String,
        account_id: String,
        reply: oneshot::Sender<crate::channel_delete::Outcome>,
    },
    ChannelControl {
        action: crate::channel_control::ChannelControlAction,
        channel: String,
        account: String,
        reply: oneshot::Sender<crate::channel_control::ChannelControlOutcome>,
    },
    ChannelLoginStart {
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        config: zeroize::Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<crate::channel_login::Outcome>,
    },
    ChannelLoginWait {
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
        reply: oneshot::Sender<crate::channel_login::Outcome>,
    },
    ChannelLoginCancel {
        channel: String,
        account_id: Option<String>,
        reply: oneshot::Sender<crate::channel_login::Outcome>,
    },
    ChannelLogout {
        channel: String,
        account_id: Option<String>,
        reply: oneshot::Sender<crate::channel_login::Outcome>,
    },
    ChannelPairing {
        channel: String,
        account: Option<String>,
        reply: oneshot::Sender<ChannelPairingOutcome>,
    },
    ApproveChannelPairing {
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<crate::channel_status::ChannelPairingApprovalOutcome>,
    },
    ListSessions {
        params: SessionsListParams,
        reply:
            oneshot::Sender<Result<SessionsListResult, RuntimeSessionError<OpenClawSessionError>>>,
    },
    ReadWorkspaceText {
        session_key: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<
            Result<openclaw::workspace::WorkspaceTextReceipt, crate::WorkspaceReadError>,
        >,
    },
    ReadWorkspaceBinary {
        session_key: String,
        relative_path: String,
        limit: usize,
        reply: oneshot::Sender<
            Result<openclaw::workspace::WorkspaceBinaryReceipt, crate::WorkspaceBinaryError>,
        >,
    },
    PrepareWorkspaceMedia {
        session_key: String,
        relative_path: String,
        mime_type: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::media::WorkspaceMediaReceipt, crate::WorkspaceMediaError>,
        >,
    },
    ResolveWorkspaceMedia {
        session_key: String,
        reference: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::media::ResolvedWorkspaceMedia, crate::WorkspaceMediaError>,
        >,
    },
    ThumbnailWorkspaceMedia {
        session_key: String,
        relative_path: String,
        mime_type: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::media::WorkspaceMediaThumbnail, crate::WorkspaceMediaError>,
        >,
    },
    ThumbnailWorkspaceMediaGateway {
        session_key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::media::WorkspaceMediaThumbnail, crate::WorkspaceMediaError>,
        >,
    },
    ThumbnailsWorkspaceMedia {
        session_key: String,
        paths: Vec<openclaw::workspace::media::WorkspaceMediaPath>,
        reply: oneshot::Sender<
            Result<
                Vec<openclaw::workspace::media::WorkspaceMediaThumbnailEntry>,
                crate::WorkspaceMediaError,
            >,
        >,
    },
    StagePathsWorkspaceMedia {
        session_key: String,
        paths: Vec<openclaw::workspace::media::WorkspaceMediaPath>,
        reply: oneshot::Sender<
            Result<
                Vec<openclaw::workspace::media::WorkspaceMediaReceipt>,
                crate::WorkspaceMediaError,
            >,
        >,
    },
    StageBufferWorkspaceMedia {
        session_key: String,
        base64: String,
        file_name: String,
        mime_type: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::media::WorkspaceMediaReceipt, crate::WorkspaceMediaError>,
        >,
    },
    StatWorkspaceFile {
        session_key: String,
        relative_path: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::WorkspaceStatReceipt, crate::WorkspaceStatError>,
        >,
    },
    ListWorkspaceDirectory {
        session_key: String,
        relative_path: String,
        include_hidden: bool,
        reply: oneshot::Sender<
            Result<openclaw::workspace::WorkspaceDirectoryReceipt, crate::WorkspaceListError>,
        >,
    },
    WriteWorkspaceText {
        session_key: String,
        relative_path: String,
        content: String,
        reply: oneshot::Sender<
            Result<openclaw::workspace::WorkspaceTextReceipt, crate::WorkspaceWriteError>,
        >,
    },
    HistoryChat {
        params: ChatHistoryParams,
        reply:
            oneshot::Sender<Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>>>,
    },
    UsageRecent {
        limit: usize,
        reply: oneshot::Sender<
            Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError>,
        >,
    },
    SendChat {
        params: ChatSendParams,
        reply: oneshot::Sender<
            Result<
                InvocationOutcome<ChatSendResult, OpenClawSessionError>,
                RuntimeSessionError<OpenClawSessionError>,
            >,
        >,
    },
    AbortChat {
        params: ChatAbortParams,
        reply: oneshot::Sender<
            Result<
                InvocationOutcome<ChatAbortResult, OpenClawSessionError>,
                RuntimeSessionError<OpenClawSessionError>,
            >,
        >,
    },
}

impl Command {
    pub(super) fn team_run(command: TeamRunCommand) -> Self {
        Self::TeamRun(Box::new(command))
    }

    pub(super) fn cancels_diagnostics(&self) -> bool {
        matches!(
            self,
            Self::Matcha(MatchaCommand::Restart(_)) | Self::Runtime(RuntimeCommand::Restart(_))
        )
    }

    pub(super) fn cancels_terminal_watches(&self) -> bool {
        matches!(
            self,
            Self::Matcha(MatchaCommand::Stop(_) | MatchaCommand::Restart(_))
        )
    }

    pub(super) async fn execute(self, host: &mut Host) -> Option<Self> {
        match self {
            Self::State(_) => {
                unreachable!("state reads use HostReadHandle")
            }
            Self::PeerAutostart {
                open_claw_auto_start,
                reply,
            } => {
                host.request_peer_autostart(open_claw_auto_start).await;
                let _ = reply.send(());
                None
            }
            Self::Diagnostics(_) => {
                unreachable!("diagnostics commands are owned by the host actor")
            }
            Self::Matcha(command) => {
                command.execute(host).await;
                None
            }
            Self::SessionAbort { command, reply } => {
                let _ = reply.send(host.abort_session(command).await);
                None
            }
            Self::SessionCreate { command, reply } => {
                let _ = reply.send(host.create_session(command).await);
                None
            }
            Self::SessionDelete { command, reply } => {
                let _ = reply.send(host.delete_open_claw_session(command).await);
                None
            }
            Self::SessionRename { command, reply } => {
                let _ = reply.send(host.rename_open_claw_session(command).await);
                None
            }
            Self::PendingApprovals { command, reply } => {
                let _ = reply.send(host.pending_session_approvals(command).await);
                None
            }
            Self::SessionApproval { command, reply } => {
                let _ = reply.send(host.respond_to_session_approval(command).await);
                None
            }
            Self::SecurityEmergency { reply } => {
                let _ = reply.send(host.run_security_emergency().await);
                None
            }
            Self::SecurityAudit { query, reply } => {
                let _ = reply.send(host.query_security_audit(query).await);
                None
            }
            Self::SyncSecurityPolicy { policy, reply } => {
                let _ = reply.send(host.sync_security_policy(policy).await);
                None
            }
            Self::SecurityOperation {
                operation_id,
                input,
                reply,
            } => {
                let _ = reply.send(host.security_operation(operation_id, input).await);
                None
            }
            Self::SessionSend { command, reply } => {
                let _ = reply.send(host.send_session(command).await);
                None
            }
            Self::HostSessionRegister {
                identity,
                route_key,
                run_id,
                reply,
            } => {
                let _ = reply.send(host.register_session_identity(identity, route_key, run_id));
                None
            }
            Self::HostSessionApply {
                session_key,
                route_key,
                run_id,
                cursor,
                changes,
                reply,
            } => {
                let _ = reply.send(host.apply_session_change(
                    session_key,
                    route_key,
                    run_id,
                    cursor,
                    changes,
                ));
                None
            }
            Self::HostSessionView { session_key, reply } => {
                let _ = reply.send(host.session_view(&session_key));
                None
            }
            Self::HostSessionEpoch { reply } => {
                let _ = reply.send(host.session_epoch());
                None
            }
            Self::SessionModelSelection { command, reply } => {
                let _ = reply.send(host.select_session_model(command).await);
                None
            }
            Self::SessionTimeline { command, reply } => {
                let _ = reply.send(host.load_session_timeline(command).await);
                None
            }
            Self::ListMatchaSessions { reply } => {
                let _ = reply.send(host.list_matcha_sessions().await);
                None
            }
            Self::MatchaHistory { command, reply } => {
                let _ = reply.send(host.load_matcha_history(command).await);
                None
            }
            Self::CronList { reply } => {
                let _ = reply.send(host.list_cron_jobs().await);
                None
            }
            Self::CronHistory { command, reply } => {
                let _ = reply.send(host.load_cron_history(command).await);
                None
            }
            Self::CronCreate { command, reply } => {
                let _ = reply.send(host.add_cron_job(command).await);
                None
            }
            Self::CronUpdate { command, reply } => {
                let _ = reply.send(host.update_cron_job(command).await);
                None
            }
            Self::CronDelete { command, reply } => {
                let _ = reply.send(host.delete_cron_job(command).await);
                None
            }
            Self::CronBroker { request, reply } => {
                let _ = reply.send(host.execute_cron_broker(request).await);
                None
            }
            Self::Agents { command, reply } => {
                let _ = reply.send(host.agents(command).await);
                None
            }
            Self::PlatformTools { reply } => {
                let _ = reply.send(host.platform_tools().await);
                None
            }
            Self::SkillInstall { command, reply } => {
                let _ = reply.send(host.install_clawhub_skill(command).await);
                None
            }
            Self::SkillStatus { reply } => {
                let _ = reply.send(host.skill_status().await);
                None
            }
            Self::SkillManagement { command, reply } => {
                let _ = reply.send(host.manage_skills(command).await);
                None
            }
            Self::SkillBundle { command, reply } => {
                let _ = reply.send(host.skill_bundles(command).await);
                None
            }
            Self::ExternalConnectors(command) => {
                command.execute(host).await;
                None
            }
            Self::ProviderAccounts(command) => {
                command.execute(host).await;
                None
            }
            Self::ProviderModels(command) => {
                command.execute(host).await;
                None
            }
            Self::ProviderRouting(command) => {
                command.execute(host).await;
                None
            }
            Self::Fleet(command) => {
                command.execute(host).await;
                None
            }
            Self::TaskManager { command, reply } => {
                let _ = reply.send(host.task_manager(command).await);
                None
            }
            Self::Runtime(command) => {
                command.execute(host).await;
                None
            }
            Self::GetCompatibleRuntimeJob { job_id, reply } => {
                let _ = reply.send(host.get_compatible_runtime_job(&job_id).await);
                None
            }
            Self::TeamSkill(_) | Self::TeamRun(_) | Self::TeamRuntime { .. } => {
                unreachable!("team commands are owned by host actor operation lanes")
            }
        }
    }
}

impl ExternalConnectorsCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::Catalog { reply } => {
                let _ = reply.send(host.external_connector_catalog());
            }
            Self::List { reply } => {
                let _ = reply.send(host.list_external_connectors());
            }
            Self::Get { id, reply } => {
                let _ = reply.send(host.get_external_connector(id));
            }
            Self::Upsert { connector, reply } => {
                let _ = reply.send(host.upsert_external_connector(*connector));
            }
            Self::Remove { id, reply } => {
                let _ = reply.send(host.remove_external_connector(id));
            }
            Self::Probe { id, reply } => {
                let _ = reply.send(host.probe_external_connector(id));
            }
            Self::SessionStatus { identity, reply } => {
                let _ = reply.send(host.session_connector_status(identity).await);
            }
        }
    }
}

impl FleetCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::TerminalOpenAllocated {
                selector,
                dimensions,
                reply,
            } => {
                let _ = reply.send(host.fleet_terminal_open_allocated(selector, dimensions));
            }
            Self::TerminalConsumeTicket { ticket, reply } => {
                let _ = reply.send(host.fleet_terminal_consume_ticket(ticket));
            }
            Self::TerminalProviderOpen { context, reply } => {
                let _ = reply.send(host.fleet_terminal_provider_open(context).await);
            }
            Self::TerminalContext { summary, reply } => {
                let _ = reply.send(host.fleet_terminal_context(summary));
            }
            Self::TerminalResolveContext {
                selector,
                summary,
                reply,
            } => {
                let _ = reply.send(host.fleet_terminal_resolve_context(selector, summary));
            }
            Self::TerminalClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(host.fleet_terminal_close(session, generation));
            }
            Self::TerminalCloseCurrent { session, reply } => {
                let _ = reply.send(host.fleet_terminal_close_current(session));
            }
            Self::TerminalBeginCloseCurrent { session, reply } => {
                let _ = reply.send(host.fleet_terminal_begin_close_current(session));
            }
            Self::TerminalFinishCloseCurrent { session, reply } => {
                let _ = reply.send(host.fleet_terminal_finish_close_current(session));
            }
            Self::TerminalReconnect { session, reply } => {
                let _ = reply.send(host.fleet_terminal_reconnect(session));
            }
            Self::TerminalBeginClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(host.fleet_terminal_begin_close(session, generation));
            }
            Self::TerminalFinishClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(host.fleet_terminal_finish_close(session, generation));
            }
            Self::TerminalList { reply } => {
                let _ = reply.send(host.fleet_terminal_list());
            }
            Self::QuerySnapshot { now, reply } => {
                let _ = reply.send(host.fleet_query_snapshot(now));
            }
            Self::Snapshot { now, reply } => {
                let _ = reply.send(host.fleet_snapshot(now));
            }
            Self::SelectorPreview {
                constraints,
                now,
                reply,
            } => {
                let _ = reply.send(host.fleet_selector_preview(constraints, now));
            }
            Self::TargetSummaries { reply } => {
                let _ = reply.send(host.fleet_target_summaries());
            }
            Self::TargetSelector {
                id,
                revision,
                kind,
                reply,
            } => {
                let _ = reply.send(host.fleet_target_selector(&id, revision, kind));
            }
            Self::TopologySummary { reply } => {
                let _ = reply.send(host.fleet_topology_summary());
            }
            Self::PutTarget { id, config, reply } => {
                let _ = reply.send(host.fleet_put_target(id, config));
            }
            Self::RemoveTarget { id, reply } => {
                let _ = reply.send(host.fleet_remove_target(&id));
            }
            Self::Submit { request, reply } => {
                let _ = reply.send(host.fleet_submit(request, std::time::SystemTime::now()));
            }
            Self::NodeCommandRequest { request, reply } => {
                let _ = reply
                    .send(host.fleet_node_command_request(request, std::time::SystemTime::now()));
            }
            Self::Begin { dispatch_id, reply } => {
                host.fleet_start_dispatch_operation(dispatch_id, reply);
            }
            Self::Accept {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_accept(
                    &dispatch_id,
                    &attempt,
                    std::time::SystemTime::now(),
                ));
            }
            Self::Reject {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_reject(
                    &dispatch_id,
                    &attempt,
                    std::time::SystemTime::now(),
                ));
            }
            Self::Unknown {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_unknown(
                    &dispatch_id,
                    &attempt,
                    std::time::SystemTime::now(),
                ));
            }
            Self::Replay {
                command_id,
                dispatch_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_replay(&command_id, &dispatch_id, SystemTime::now()));
            }
            Self::UpsertConnection { record, reply } => {
                let _ = reply.send(host.fleet_upsert_connection(record));
            }
            Self::DeleteConnection { id, reply } => {
                let _ = reply.send(host.fleet_delete_connection(id));
            }
            Self::BeginConnectionProbe {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_connection_probe(id, command_id));
            }
            Self::RunConnectionProbe {
                id,
                command_id,
                reply,
            } => {
                host.fleet_start_connection_probe_operation(id, command_id, reply);
            }
            Self::RunEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                host.fleet_start_environment_deployment_operation(id, command_id, phase, reply);
            }
            Self::RunEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                host.fleet_start_environment_deletion_operation(id, command_id, phase, reply);
            }
            Self::RunResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                host.fleet_start_resource_provisioning_operation(id, command_id, phase, reply);
            }
            Self::RunResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                host.fleet_start_resource_deletion_operation(id, command_id, phase, reply);
            }
            Self::CompleteConnectionProbe {
                id,
                command_id,
                outcome,
                message,
                reply,
            } => {
                let _ = reply
                    .send(host.fleet_complete_connection_probe(id, command_id, outcome, message));
            }
            Self::RegisterEnvironment { record, reply } => {
                let _ = reply.send(host.fleet_register_environment(record));
            }
            Self::RegisterResource { request, reply } => {
                host.fleet_start_resource_registration_operation(request, reply);
            }
            Self::UpsertNode { observation, reply } => {
                let _ = reply.send(host.fleet_upsert_node(observation));
            }
            Self::UpsertAgent { observation, reply } => {
                let _ = reply.send(host.fleet_upsert_agent(observation));
            }
            Self::WriteCredential { request, reply } => {
                let _ = reply.send(host.fleet_write_credential(request));
            }
            Self::RevokeAgent { id, reply } => {
                let _ = reply.send(host.fleet_revoke_agent(id));
            }
            Self::UpsertRuntime { observation, reply } => {
                let _ = reply.send(host.fleet_upsert_runtime(observation));
            }
            Self::UpsertEndpoint { observation, reply } => {
                let _ = reply.send(host.fleet_upsert_endpoint(observation));
            }
            Self::RetireNode { id, reply } => {
                let _ = reply.send(host.fleet_retire_node(id));
            }
            Self::BeginRuntimeStart {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_runtime_start(id, command_id));
            }
            Self::CompleteRuntimeStart {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_runtime_start(id, command_id));
            }
            Self::BeginRuntimeStop {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_runtime_stop(id, command_id));
            }
            Self::CompleteRuntimeStop {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_runtime_stop(id, command_id));
            }
            Self::RetireRuntime { id, reply } => {
                let _ = reply.send(host.fleet_retire_runtime(id));
            }
            Self::DrainEndpoint { id, reply } => {
                let _ = reply.send(host.fleet_drain_endpoint(id));
            }
            Self::RetireEndpoint { id, reply } => {
                let _ = reply.send(host.fleet_retire_endpoint(id));
            }
            Self::BeginEndpointProbe {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_endpoint_probe(id, command_id));
            }
            Self::CompleteEndpointProbe {
                id,
                command_id,
                health,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_endpoint_probe(id, command_id, health));
            }
            Self::BeginCapabilitySync {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_capability_sync(id, command_id));
            }
            Self::CompleteCapabilitySync {
                id,
                command_id,
                sync,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_capability_sync(id, command_id, sync));
            }
            Self::BeginEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_environment_deployment(id, command_id, phase));
            }
            Self::CompleteEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(host.fleet_complete_environment_deployment(id, command_id, phase));
            }
            Self::FailEnvironmentDeployment {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply
                    .send(host.fleet_fail_environment_deployment(id, command_id, phase, message));
            }
            Self::BeginEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_begin_environment_deletion(id, command_id, phase));
            }
            Self::CompleteEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_environment_deletion(id, command_id, phase));
            }
            Self::FailEnvironmentDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply
                    .send(host.fleet_fail_environment_deletion(id, command_id, phase, message));
            }
            Self::StartResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_start_resource_provisioning(id, command_id, phase));
            }
            Self::FailResourceProvisioning {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply
                    .send(host.fleet_fail_resource_provisioning(id, command_id, phase, message));
            }
            Self::CompleteResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(host.fleet_complete_resource_provisioning(id, command_id, phase));
            }
            Self::StartResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_start_resource_deletion(id, command_id, phase));
            }
            Self::CompleteResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(host.fleet_complete_resource_deletion(id, command_id, phase));
            }
            Self::FailResourceDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ =
                    reply.send(host.fleet_fail_resource_deletion(id, command_id, phase, message));
            }
            Self::AuthenticateRuntimeAgentIngress { identity, reply } => {
                let _ = reply.send(host.fleet_authenticate_runtime_agent_ingress(identity));
            }
            Self::RegisterRuntimeAgent { agent, reply } => {
                let _ = reply.send(host.fleet_register_runtime_agent(agent));
            }
            Self::RegisterRuntimeAgentCommand {
                agent_id,
                correlation,
                queued_at,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_register_runtime_agent_command(
                    agent_id,
                    correlation,
                    queued_at,
                    command_attempt,
                    dispatch_attempt,
                ));
            }
            Self::RecordRuntimeAgentHeartbeat {
                agent_id,
                heartbeat,
                reply,
            } => {
                let _ = reply.send(host.fleet_record_runtime_agent_heartbeat(agent_id, heartbeat));
            }
            Self::RecordRuntimeAgentProgress {
                agent_id,
                correlation,
                progress,
                reported_at,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_record_runtime_agent_progress(
                    agent_id,
                    correlation,
                    progress,
                    reported_at,
                    command_attempt,
                    dispatch_attempt,
                ));
            }
            Self::RecordRuntimeAgentResult {
                agent_id,
                correlation,
                result,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(host.fleet_record_runtime_agent_result(
                    agent_id,
                    correlation,
                    result,
                    command_attempt,
                    dispatch_attempt,
                ));
            }
        }
    }
}

impl ProviderAccountsCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::ConfigurePrivateResolver { resolver, reply } => {
                host.configure_provider_private_resolver(resolver);
                let _ = reply.send(());
            }
            Self::List { reply } => {
                let _ = reply.send(host.list_provider_accounts());
            }
            Self::Get { id, reply } => {
                let _ = reply.send(host.get_provider_account(id));
            }
            Self::Replace { draft, reply } => {
                let _ = reply.send(host.replace_provider_account(draft).await);
            }
            Self::Delete {
                id,
                revision,
                reply,
            } => {
                let _ = reply.send(host.delete_provider_account(id, revision).await);
            }
        }
    }
}

impl ProviderModelsCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::List { reply } => {
                let _ = reply.send(host.list_provider_models());
            }
            Self::Selectable { capability, reply } => {
                let _ = reply.send(host.selectable_provider_models(capability));
            }
            Self::Replace {
                account_id,
                drafts,
                reply,
            } => {
                let _ = reply.send(host.replace_provider_models(account_id, drafts).await);
            }
        }
    }
}

impl ProviderRoutingCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::List { reply } => {
                let _ = reply.send(host.list_provider_routing());
            }
            Self::Replace { routing, reply } => {
                let _ = reply.send(host.replace_provider_routing(routing).await);
            }
        }
    }
}

impl MatchaCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::Start(reply) => host.start_matcha_operation(reply),
            Self::Stop(reply) => host.stop_matcha_operation(reply),
            Self::Restart(reply) => host.restart_matcha_operation(reply),
        }
    }
}

impl RuntimeCommand {
    async fn execute(self, host: &mut Host) {
        match self {
            Self::Environment(reply) => {
                let _ = reply.send(host.open_claw_installation_status());
            }
            Self::RuntimePaths(reply) => {
                let _ = reply.send(host.open_claw_runtime_paths());
            }
            Self::CliCommand(reply) => {
                let _ = reply.send(host.open_claw_cli_command());
            }
            Self::ToolPermissionMode(reply) => {
                let _ = reply.send(host.open_claw_tool_permission_mode());
            }
            Self::SetToolPermissionMode { mode, reply } => {
                let _ = reply.send(host.set_open_claw_tool_permission_mode(mode));
            }
            Self::ToolchainStatus(reply) => {
                let _ = reply.send(host.open_claw_toolchain_status().await);
            }
            Self::InstallToolchainUv(reply) => {
                let _ = reply.send(host.install_open_claw_uv().await);
            }
            Self::SubmitToolchainInstall(reply) => {
                let _ = reply.send(host.submit_open_claw_toolchain_install().await);
            }
            Self::GetToolchainJob { job_id, reply } => {
                let _ = reply.send(host.get_open_claw_toolchain_job(&job_id).await);
            }
            Self::PluginsCatalog(reply) => {
                let _ = reply.send(host.plugins_catalog());
            }
            Self::PluginsRuntime(reply) => {
                let _ = reply.send(host.plugins_runtime());
            }
            Self::PluginsSetEnabled {
                plugin_id,
                enabled,
                reply,
            } => {
                let _ = reply.send(host.set_plugin_enabled(plugin_id, enabled).await);
            }
            Self::PluginsOperation {
                operation,
                plugin_id,
                reply,
            } => {
                let _ = reply.send(host.plugin_operation(operation, plugin_id).await);
            }
            Self::ListSubagentTemplates(reply) => {
                let _ = reply.send(host.list_subagent_templates());
            }
            Self::SubagentTemplate { id, reply } => {
                let _ = reply.send(host.subagent_template(&id));
            }
            Self::Start(reply) => host.start_open_claw_operation(reply),
            Self::Stop(reply) => host.stop_open_claw_operation(reply),
            Self::Restart(reply) => host.restart_open_claw_operation(reply),
            Self::Logs { cursor, reply } => {
                let _ = reply.send(host.open_claw_logs(cursor).await);
            }
            Self::GatewayHealth { probe, reply } => {
                let _ = reply.send(host.open_claw_gateway_health_observation(probe));
            }
            Self::GatewayStatus {
                include_channel_summary,
                reply,
            } => {
                let _ =
                    reply.send(host.open_claw_gateway_status_observation(include_channel_summary));
            }
            Self::ControlUiUrl(reply) => {
                let _ = reply.send(host.open_claw_control_ui_url());
            }
            Self::ControlLease(reply) => {
                let _ = reply.send(host.control_lease());
            }
            Self::TriggerCron { job_id, reply } => {
                let _ = reply.send(host.trigger_open_claw_cron(job_id).await);
            }
            Self::ChannelAccounts(reply) => {
                let _ = reply.send(host.observe_open_claw_channel_accounts().await);
            }
            Self::ChannelSnapshot(reply) => {
                let _ = reply.send(host.observe_open_claw_channel_snapshot().await);
            }
            Self::ChannelConfigRead {
                channel,
                account_id,
                reply,
            } => {
                let _ = reply.send(host.read_channel_config(channel, account_id).await);
            }
            Self::ChannelCredentialsValidate {
                channel,
                config,
                reply,
            } => {
                let _ = reply.send(host.validate_channel_credentials(channel, config).await);
            }
            Self::ChannelCatalog(reply) => {
                let _ = reply.send(host.channel_catalog().await);
            }
            Self::ChannelConfigureForm { channel, reply } => {
                let _ = reply.send(host.channel_configure_form(channel).await);
            }
            Self::ChannelConfigure {
                channel,
                account_id,
                values,
                reply,
            } => {
                let _ = reply.send(host.channel_configure(channel, account_id, values).await);
            }
            Self::ChannelDeleteConfig {
                channel,
                account_id,
                reply,
            } => {
                let _ = reply.send(host.channel_delete_config(channel, account_id).await);
            }
            Self::ChannelControl {
                action,
                channel,
                account,
                reply,
            } => {
                let _ = reply.send(
                    host.control_open_claw_channel_account(action, channel, account)
                        .await,
                );
            }
            Self::ChannelLoginStart {
                channel,
                force,
                timeout_ms,
                account_id,
                config,
                reply,
            } => {
                let _ = reply.send(
                    host.start_channel_login(channel, force, timeout_ms, account_id, config)
                        .await,
                );
            }
            Self::ChannelLoginWait { .. } => {
                unreachable!("channel login wait commands are owned by the host actor")
            }
            Self::ChannelLoginCancel {
                channel,
                account_id,
                reply,
            } => {
                let _ = reply.send(host.cancel_channel_login(channel, account_id).await);
            }
            Self::ChannelLogout {
                channel,
                account_id,
                reply,
            } => {
                let _ = reply.send(host.logout_channel(channel, account_id).await);
            }
            Self::ChannelPairing {
                channel,
                account,
                reply,
            } => {
                let _ = reply.send(host.list_open_claw_channel_pairing(channel, account).await);
            }
            Self::ApproveChannelPairing {
                channel,
                account,
                code,
                reply,
            } => {
                let _ = reply.send(
                    host.approve_open_claw_channel_pairing(channel, account, code)
                        .await,
                );
            }
            Self::ListSessions { params, reply } => {
                let _ = reply.send(host.list_open_claw_sessions(params).await);
            }
            Self::ReadWorkspaceText {
                session_key,
                relative_path,
                limit,
                reply,
            } => {
                let _ = reply.send(host.read_open_claw_workspace_text(
                    &session_key,
                    &relative_path,
                    limit,
                ));
            }
            Self::ReadWorkspaceBinary {
                session_key,
                relative_path,
                limit,
                reply,
            } => {
                let _ = reply.send(host.read_open_claw_workspace_binary(
                    &session_key,
                    &relative_path,
                    limit,
                ));
            }
            Self::PrepareWorkspaceMedia {
                session_key,
                relative_path,
                mime_type,
                reply,
            } => {
                let _ = reply.send(host.prepare_open_claw_workspace_media(
                    &session_key,
                    &relative_path,
                    &mime_type,
                ));
            }
            Self::ResolveWorkspaceMedia {
                session_key,
                reference,
                reply,
            } => {
                let _ =
                    reply.send(host.resolve_open_claw_workspace_media(&session_key, &reference));
            }
            Self::ThumbnailWorkspaceMedia {
                session_key,
                relative_path,
                mime_type,
                reply,
            } => {
                let _ = reply.send(host.thumbnail_open_claw_workspace_media(
                    &session_key,
                    &relative_path,
                    &mime_type,
                ));
            }
            Self::ThumbnailWorkspaceMediaGateway {
                session_key,
                gateway_url,
                mime_type,
                agent_id,
                reply,
            } => {
                let _ = reply.send(host.thumbnail_open_claw_workspace_media_gateway(
                    &session_key,
                    &gateway_url,
                    &mime_type,
                    &agent_id,
                ));
            }
            Self::ThumbnailsWorkspaceMedia {
                session_key,
                paths,
                reply,
            } => {
                let _ = reply.send(host.thumbnails_open_claw_workspace_media(&session_key, &paths));
            }
            Self::StagePathsWorkspaceMedia {
                session_key,
                paths,
                reply,
            } => {
                let _ =
                    reply.send(host.stage_paths_open_claw_workspace_media(&session_key, &paths));
            }
            Self::StageBufferWorkspaceMedia {
                session_key,
                base64,
                file_name,
                mime_type,
                reply,
            } => {
                let _ = reply.send(host.stage_buffer_open_claw_workspace_media(
                    &session_key,
                    &base64,
                    &file_name,
                    &mime_type,
                ));
            }
            Self::StatWorkspaceFile {
                session_key,
                relative_path,
                reply,
            } => {
                let _ =
                    reply.send(host.stat_open_claw_workspace_file(&session_key, &relative_path));
            }
            Self::ListWorkspaceDirectory {
                session_key,
                relative_path,
                include_hidden,
                reply,
            } => {
                let _ = reply.send(host.list_open_claw_workspace_directory(
                    &session_key,
                    &relative_path,
                    include_hidden,
                ));
            }
            Self::WriteWorkspaceText {
                session_key,
                relative_path,
                content,
                reply,
            } => {
                let _ = reply.send(host.write_open_claw_workspace_text(
                    &session_key,
                    &relative_path,
                    &content,
                ));
            }
            Self::HistoryChat { params, reply } => {
                let _ = reply.send(host.history_open_claw_chat(params).await);
            }
            Self::UsageRecent { limit, reply } => {
                let _ = reply.send(host.usage_open_claw_recent(limit));
            }
            Self::SendChat { params, reply } => {
                let _ = reply.send(host.send_open_claw_chat(params).await);
            }
            Self::AbortChat { params, reply } => {
                let _ = reply.send(host.abort_open_claw_chat(params).await);
            }
        }
    }
}
