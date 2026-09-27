use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::{
    DeliveryPhase, GraphRunId, GraphState, OrganizationFacts, RunStartGate, TeamId,
    run::{
        approval::{ApprovalDecision, ApprovalResolutionCause, ApprovalStatus},
        decision::TeamDecisionType,
        delivery::{
            AuthorizedGraphOutcome, DeliveryFailure, NativeTerminalStatus,
            TerminalObservationResolution,
        },
        event::TeamEventType,
        graph::{
            AttemptReason, AttemptStatus, EdgeAction, EdgeStatus, GraphStatus, NodeKind,
            StartTrigger, project,
        },
        lifecycle::GraphRunLifecycleState,
    },
};

#[path = "public_evidence_projection.rs"]
mod public_evidence_projection;

pub use public_evidence_projection::{
    PublicEvidenceProjection, PublicEvidenceType, project_public_evidence,
};

/// The fixed, renderer-safe TeamRun view. It is deliberately derived only from Organization
/// durable facts. Runtime bindings, workspace references, session identities, prompts, payloads,
/// receipts, and native errors have no representation here.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicProjection {
    team_id: String,
    run_id: String,
    team_revision: u64,
    runtime: TeamRuntimeState,
    start_gate: TeamRunPublicStartGate,
    proposal_id: Option<String>,
    proposal_summary: Option<String>,
    proposal_source_delivery_id: Option<String>,
    graph: TeamPublicGraph,
}

impl TeamPublicProjection {
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn team_revision(&self) -> u64 {
        self.team_revision
    }

    pub const fn runtime(&self) -> TeamRuntimeState {
        self.runtime
    }

    pub const fn start_gate(&self) -> TeamRunPublicStartGate {
        self.start_gate
    }

    pub fn proposal_id(&self) -> Option<&str> {
        self.proposal_id.as_deref()
    }

    pub fn proposal_summary(&self) -> Option<&str> {
        self.proposal_summary.as_deref()
    }

    pub fn proposal_source_delivery_id(&self) -> Option<&str> {
        self.proposal_source_delivery_id.as_deref()
    }

    pub fn graph(&self) -> &TeamPublicGraph {
        &self.graph
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRuntimeState {
    Confirmed,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicGraph {
    graph_id: String,
    workflow_plan_id: String,
    title: String,
    status: TeamPublicGraphStatus,
    layout: TeamPublicGraphLayout,
    nodes: Vec<TeamPublicNode>,
    edges: Vec<TeamPublicEdge>,
}

impl TeamPublicGraph {
    pub fn graph_id(&self) -> &str {
        &self.graph_id
    }

    pub fn workflow_plan_id(&self) -> &str {
        &self.workflow_plan_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub const fn status(&self) -> TeamPublicGraphStatus {
        self.status
    }

    pub const fn layout(&self) -> &TeamPublicGraphLayout {
        &self.layout
    }

    pub fn nodes(&self) -> &[TeamPublicNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[TeamPublicEdge] {
        &self.edges
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicGraphLayout {
    node_positions: BTreeMap<String, TeamPublicNodePosition>,
}

impl TeamPublicGraphLayout {
    pub fn node_positions(&self) -> &BTreeMap<String, TeamPublicNodePosition> {
        &self.node_positions
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicNodePosition {
    x: i64,
    y: i64,
}

impl TeamPublicNodePosition {
    pub const fn x(&self) -> i64 {
        self.x
    }

    pub const fn y(&self) -> i64 {
        self.y
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicGraphStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicNode {
    node_id: String,
    kind: TeamPublicNodeKind,
    title: String,
    role_id: Option<String>,
    task_id: Option<String>,
    max_attempts: u32,
    trigger: Option<TeamPublicStartTrigger>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_reason: Option<&'static str>,
    attempt: TeamPublicAttempt,
}

impl TeamPublicNode {
    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub const fn kind(&self) -> TeamPublicNodeKind {
        self.kind
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn role_id(&self) -> Option<&str> {
        self.role_id.as_deref()
    }

    pub fn task_id(&self) -> Option<&str> {
        self.task_id.as_deref()
    }

    pub const fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    pub fn trigger(&self) -> Option<&TeamPublicStartTrigger> {
        self.trigger.as_ref()
    }

    pub const fn status_reason(&self) -> Option<&'static str> {
        self.status_reason
    }

    pub fn attempt(&self) -> &TeamPublicAttempt {
        &self.attempt
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicNodeKind {
    Start,
    Work,
    Review,
    HumanDecision,
    ScriptReview,
    Join,
    End,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamPublicStartTrigger {
    Webhook,
    Cron { expression: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicAttempt {
    number: u32,
    status: TeamPublicAttemptStatus,
    updated_at: u64,
}

impl TeamPublicAttempt {
    pub const fn number(&self) -> u32 {
        self.number
    }

    pub const fn status(&self) -> TeamPublicAttemptStatus {
        self.status
    }

    pub const fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicAttemptStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublicEdge {
    edge_id: String,
    source_node_id: String,
    source_port: String,
    target_node_id: String,
    target_port: String,
    action: TeamPublicEdgeAction,
    status: TeamPublicEdgeStatus,
}

impl TeamPublicEdge {
    pub fn edge_id(&self) -> &str {
        &self.edge_id
    }

    pub fn source_node_id(&self) -> &str {
        &self.source_node_id
    }

    pub fn source_port(&self) -> &str {
        &self.source_port
    }

    pub fn target_node_id(&self) -> &str {
        &self.target_node_id
    }

    pub fn target_port(&self) -> &str {
        &self.target_port
    }

    pub const fn action(&self) -> TeamPublicEdgeAction {
        self.action
    }

    pub const fn status(&self) -> TeamPublicEdgeStatus {
        self.status
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicEdgeAction {
    Activate,
    Rework,
    Gate,
    Finish,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicEdgeStatus {
    Waiting,
    Satisfied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamPublicQueryOutcome {
    Available(TeamPublicProjection),
    Unavailable,
}

/// The complete Organization-owned TeamRun snapshot. It contains only durable facts that are
/// safe to expose to a renderer; runtime bindings, prompts, receipts, paths, and idempotency
/// material are intentionally not represented.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicSnapshot {
    run: TeamRunPublicRun,
    graph: TeamPublicGraph,
    attempts: Vec<TeamRunPublicAttempt>,
    deliveries: Vec<TeamRunPublicDelivery>,
    approvals: Vec<TeamRunPublicApproval>,
    decisions: Vec<TeamRunPublicDecision>,
    evidence: Vec<PublicEvidenceProjection>,
    artifacts: Vec<TeamRunPublicArtifact>,
    events: Vec<TeamRunPublicEvent>,
    next_event_cursor: u64,
    unavailable_sections: Vec<TeamRunPublicUnavailableSection>,
    diagnostics: TeamRunPublicDiagnostics,
}

impl TeamRunPublicSnapshot {
    pub fn run(&self) -> &TeamRunPublicRun {
        &self.run
    }

    pub fn graph(&self) -> &TeamPublicGraph {
        &self.graph
    }

    pub fn attempts(&self) -> &[TeamRunPublicAttempt] {
        &self.attempts
    }

    pub fn deliveries(&self) -> &[TeamRunPublicDelivery] {
        &self.deliveries
    }

    pub fn approvals(&self) -> &[TeamRunPublicApproval] {
        &self.approvals
    }

    pub fn decisions(&self) -> &[TeamRunPublicDecision] {
        &self.decisions
    }

    pub fn evidence(&self) -> &[PublicEvidenceProjection] {
        &self.evidence
    }

    pub fn artifacts(&self) -> &[TeamRunPublicArtifact] {
        &self.artifacts
    }

    pub fn events(&self) -> &[TeamRunPublicEvent] {
        &self.events
    }

    pub fn next_event_cursor(&self) -> u64 {
        self.next_event_cursor
    }

    pub fn unavailable_sections(&self) -> &[TeamRunPublicUnavailableSection] {
        &self.unavailable_sections
    }

    pub fn diagnostics(&self) -> &TeamRunPublicDiagnostics {
        &self.diagnostics
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicRun {
    team_id: String,
    run_id: String,
    team_revision: u64,
    runtime: TeamRuntimeState,
    lifecycle: TeamRunPublicLifecycle,
    start_gate: TeamRunPublicStartGate,
    proposal_id: Option<String>,
    proposal_summary: Option<String>,
    proposal_source_delivery_id: Option<String>,
}

impl TeamRunPublicRun {
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn team_revision(&self) -> u64 {
        self.team_revision
    }

    pub const fn runtime(&self) -> TeamRuntimeState {
        self.runtime
    }

    pub const fn lifecycle(&self) -> TeamRunPublicLifecycle {
        self.lifecycle
    }

    pub const fn start_gate(&self) -> TeamRunPublicStartGate {
        self.start_gate
    }

    pub fn proposal_id(&self) -> Option<&str> {
        self.proposal_id.as_deref()
    }

    pub fn proposal_summary(&self) -> Option<&str> {
        self.proposal_summary.as_deref()
    }

    pub fn proposal_source_delivery_id(&self) -> Option<&str> {
        self.proposal_source_delivery_id.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunPublicStartGate {
    Intake,
    ProposalPending,
    Started,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunPublicLifecycle {
    Active,
    Cancelling,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicAttempt {
    node_id: String,
    attempt_id: String,
    node_execution_id: String,
    number: u32,
    status: TeamPublicAttemptStatus,
    reason: TeamPublicAttemptReason,
    output_port: Option<String>,
    created_at: u64,
    updated_at: u64,
}

impl TeamRunPublicAttempt {
    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub const fn number(&self) -> u32 {
        self.number
    }

    pub const fn status(&self) -> TeamPublicAttemptStatus {
        self.status
    }

    pub fn reason(&self) -> &TeamPublicAttemptReason {
        &self.reason
    }

    pub fn output_port(&self) -> Option<&str> {
        self.output_port.as_deref()
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }

    pub const fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamPublicAttemptReason {
    Initial,
    Trigger,
    Edge { edge_id: String },
    Rework,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicDelivery {
    delivery_id: String,
    run_id: String,
    node_id: String,
    node_execution_id: String,
    task_id: String,
    role_id: String,
    requested_at: u64,
    max_attempts: u32,
    phase: TeamRunPublicDeliveryPhase,
}

impl TeamRunPublicDelivery {
    pub fn delivery_id(&self) -> &str {
        &self.delivery_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub const fn requested_at(&self) -> u64 {
        self.requested_at
    }

    pub const fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    pub fn phase(&self) -> &TeamRunPublicDeliveryPhase {
        &self.phase
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamRunPublicDeliveryPhase {
    Pending,
    Delivering {
        attempt: u32,
        claimed_at: u64,
    },
    RetryScheduled {
        retry_at: u64,
        failure: TeamPublicDeliveryFailure,
    },
    Delivered {
        accepted_at: u64,
    },
    TerminalObserved {
        resolution: TeamPublicTerminalResolution,
    },
    Failed {
        failed_at: u64,
        failure: TeamPublicDeliveryFailure,
    },
    OutcomeUnknown {
        observed_at: u64,
    },
    Cancelled {
        cancelled_at: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicDeliveryFailure {
    ReceiverRejected,
    PolicyRejected,
    Unavailable,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicTerminalResolution {
    AwaitingAuthorizedGraphResolution,
    GraphCompleted,
    GraphFailed,
    NodeCancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicApproval {
    approval_id: String,
    run_id: String,
    stage_id: String,
    role_id: String,
    reason: String,
    requested_action: String,
    status: TeamPublicApprovalStatus,
    decision: Option<TeamPublicApprovalDecision>,
    created_at: u64,
    resolved_at: Option<u64>,
    cause: Option<TeamPublicApprovalResolutionCause>,
}

impl TeamRunPublicApproval {
    pub fn approval_id(&self) -> &str {
        &self.approval_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn stage_id(&self) -> &str {
        &self.stage_id
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn requested_action(&self) -> &str {
        &self.requested_action
    }

    pub const fn status(&self) -> TeamPublicApprovalStatus {
        self.status
    }

    pub const fn decision(&self) -> Option<TeamPublicApprovalDecision> {
        self.decision
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }

    pub const fn resolved_at(&self) -> Option<u64> {
        self.resolved_at
    }

    pub const fn cause(&self) -> Option<TeamPublicApprovalResolutionCause> {
        self.cause
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicApprovalStatus {
    Pending,
    Approved,
    Denied,
    Aborted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicApprovalDecision {
    Approve,
    Deny,
    Abort,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicApprovalResolutionCause {
    HumanDecision,
    RunCancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicDecision {
    sequence: u64,
    decision_id: String,
    run_id: String,
    stage_id: String,
    decision: TeamPublicDecisionType,
    created_at: u64,
}

impl TeamRunPublicDecision {
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn stage_id(&self) -> &str {
        &self.stage_id
    }

    pub const fn decision(&self) -> TeamPublicDecisionType {
        self.decision
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicDecisionType {
    Retry,
    ProceedDegraded,
    Abort,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicArtifact {
    artifact_id: String,
    run_id: String,
    node_id: String,
    node_execution_id: String,
    role_id: String,
    kind: String,
    title: String,
    summary: Option<String>,
    evidence_count: usize,
    created_at: u64,
    updated_at: u64,
}

impl TeamRunPublicArtifact {
    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    pub const fn evidence_count(&self) -> usize {
        self.evidence_count
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }

    pub const fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicEvent {
    event_id: String,
    run_id: String,
    sequence: u64,
    event_type: TeamPublicEventType,
    created_at: u64,
    approval_id: Option<String>,
    node_execution_id: Option<String>,
    role_id: Option<String>,
    action: Option<TeamPublicEventAction>,
    decision: Option<TeamPublicApprovalDecision>,
    status: Option<TeamPublicApprovalStatus>,
    operation_count: Option<u64>,
    graph_id: Option<String>,
    workflow_plan_id: Option<String>,
}

impl TeamRunPublicEvent {
    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn event_type(&self) -> TeamPublicEventType {
        self.event_type
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicEventType {
    GraphPatchAccepted,
    GraphReplaced,
    NodeProgressed,
    ApprovalRequested,
    ApprovalResolved,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPublicEventAction {
    ContinueNode,
    ExecuteTool,
    PublishResult,
    ExternalAction,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicDiagnostics {
    run_id: String,
    runtime: TeamRuntimeState,
    counts: TeamRunPublicCounts,
    unavailable_sections: Vec<TeamRunPublicUnavailableSection>,
}

impl TeamRunPublicDiagnostics {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn runtime(&self) -> TeamRuntimeState {
        self.runtime
    }

    pub const fn counts(&self) -> &TeamRunPublicCounts {
        &self.counts
    }

    pub fn unavailable_sections(&self) -> &[TeamRunPublicUnavailableSection] {
        &self.unavailable_sections
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicCounts {
    attempts: usize,
    deliveries: usize,
    approvals: usize,
    decisions: usize,
    evidence: usize,
    artifacts: usize,
    events: usize,
}

impl TeamRunPublicCounts {
    pub const fn attempts(&self) -> usize {
        self.attempts
    }

    pub const fn deliveries(&self) -> usize {
        self.deliveries
    }

    pub const fn approvals(&self) -> usize {
        self.approvals
    }

    pub const fn decisions(&self) -> usize {
        self.decisions
    }

    pub const fn evidence(&self) -> usize {
        self.evidence
    }

    pub const fn artifacts(&self) -> usize {
        self.artifacts
    }

    pub const fn events(&self) -> usize {
        self.events
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunPublicUnavailableSection {
    NodeInputStates,
    Roles,
    Stages,
    WorkflowPlan,
    DispatchGroups,
    DispatchTasks,
    Dispatches,
    DispatchExecutions,
    Messages,
    NodePromptDeliveries,
    Gates,
    Kickbacks,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunPublicSnapshotUnavailable {
    MissingTeam,
    TombstonedTeam,
    MissingRun,
    ForeignRun,
    TombstonedRun,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamRunPublicSnapshotQueryOutcome {
    Available(TeamRunPublicSnapshot),
    Unavailable(TeamRunPublicSnapshotUnavailable),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamRunPublicDiagnosticsQueryOutcome {
    Available(TeamRunPublicDiagnostics),
    Unavailable(TeamRunPublicSnapshotUnavailable),
}

pub type TeamRunSnapshotProjection = TeamRunPublicSnapshot;
pub type TeamRunDiagnosticsProjection = TeamRunPublicDiagnostics;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamRunPublicSnapshotRequest {
    team_id: TeamId,
    run_id: GraphRunId,
    event_cursor: u64,
    event_limit: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRunPublicSnapshotRequestError {
    EventLimitOutOfRange,
}

impl TeamRunPublicSnapshotRequest {
    pub fn try_new(
        team_id: TeamId,
        run_id: GraphRunId,
        event_cursor: u64,
        event_limit: Option<u64>,
    ) -> Result<Self, TeamRunPublicSnapshotRequestError> {
        let event_limit = event_limit
            .map(usize::try_from)
            .transpose()
            .map_err(|_| TeamRunPublicSnapshotRequestError::EventLimitOutOfRange)?;
        Ok(Self {
            team_id,
            run_id,
            event_cursor,
            event_limit,
        })
    }

    fn unbounded(team_id: TeamId, run_id: GraphRunId) -> Self {
        Self {
            team_id,
            run_id,
            event_cursor: 0,
            event_limit: None,
        }
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub const fn event_cursor(&self) -> u64 {
        self.event_cursor
    }

    pub const fn event_limit(&self) -> Option<usize> {
        self.event_limit
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TeamRunPublicSnapshotProducer;

impl TeamRunPublicSnapshotProducer {
    pub fn produce(
        facts: &OrganizationFacts,
        request: &TeamRunPublicSnapshotRequest,
    ) -> TeamRunPublicSnapshotQueryOutcome {
        let Ok(run) = validated_public_run(facts, request.team_id(), request.run_id()) else {
            return TeamRunPublicSnapshotQueryOutcome::Unavailable(
                validated_public_run(facts, request.team_id(), request.run_id()).unwrap_err(),
            );
        };
        TeamRunPublicSnapshotQueryOutcome::Available(build_public_snapshot(
            facts,
            request.team_id(),
            request.run_id(),
            run,
            request,
        ))
    }
}

pub fn produce_team_run_public_snapshot(
    facts: &OrganizationFacts,
    request: &TeamRunPublicSnapshotRequest,
) -> TeamRunPublicSnapshotQueryOutcome {
    TeamRunPublicSnapshotProducer::produce(facts, request)
}

/// Queries a complete safe snapshot when the caller has only a run identity. The team association
/// comes from the same durable run fact that the pair-identity producer validates.
pub fn produce_team_run_public_snapshot_for_run(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    event_cursor: u64,
    event_limit: Option<u64>,
) -> Result<TeamRunPublicSnapshotQueryOutcome, TeamRunPublicSnapshotRequestError> {
    let Some(team_id) = facts.run(run_id).map(|run| run.team().clone()) else {
        return Ok(TeamRunPublicSnapshotQueryOutcome::Unavailable(
            TeamRunPublicSnapshotUnavailable::MissingRun,
        ));
    };
    let request =
        TeamRunPublicSnapshotRequest::try_new(team_id, run_id.clone(), event_cursor, event_limit)?;
    Ok(produce_team_run_public_snapshot(facts, &request))
}

/// Queries the complete safe TeamRun snapshot from Organization durable facts. This is separate
/// from `query_team_public_projection`: the compact graph view must never stand in for this API.
pub fn query_team_run_public_snapshot(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> TeamRunPublicSnapshotQueryOutcome {
    let request = TeamRunPublicSnapshotRequest::unbounded(team_id.clone(), run_id.clone());
    produce_team_run_public_snapshot(facts, &request)
}

pub fn query_team_run_public_diagnostics(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> TeamRunPublicDiagnosticsQueryOutcome {
    let Ok(run) = validated_public_run(facts, team_id, run_id) else {
        return TeamRunPublicDiagnosticsQueryOutcome::Unavailable(
            validated_public_run(facts, team_id, run_id).unwrap_err(),
        );
    };
    TeamRunPublicDiagnosticsQueryOutcome::Available(diagnostics_projection(
        facts,
        run_id,
        run,
        runtime_state(facts, run_id, run.runtime().is_some()),
    ))
}

fn validated_public_run<'a>(
    facts: &'a OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> Result<&'a crate::GraphRunFacts, TeamRunPublicSnapshotUnavailable> {
    let Some(team) = facts.team(team_id) else {
        return Err(TeamRunPublicSnapshotUnavailable::MissingTeam);
    };
    if team.tombstoned() {
        return Err(TeamRunPublicSnapshotUnavailable::TombstonedTeam);
    }
    let Some(run) = facts.run(run_id) else {
        return Err(TeamRunPublicSnapshotUnavailable::MissingRun);
    };
    if run.team() != team_id {
        return Err(TeamRunPublicSnapshotUnavailable::ForeignRun);
    }
    if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::Tombstoned { .. }
    ) {
        return Err(TeamRunPublicSnapshotUnavailable::TombstonedRun);
    }
    Ok(run)
}

fn build_public_snapshot(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
    run: &crate::GraphRunFacts,
    request: &TeamRunPublicSnapshotRequest,
) -> TeamRunPublicSnapshot {
    let runtime = runtime_state(facts, run_id, run.runtime().is_some());
    let graph = graph_projection(facts, run.graph());
    let attempts = run
        .graph()
        .executions()
        .values()
        .flat_map(|history| history.attempts().iter().map(public_attempt))
        .collect::<Vec<_>>();
    let deliveries = facts
        .deliveries()
        .deliveries()
        .filter(|delivery| delivery.facts().run_id == run_id.as_str())
        .map(public_delivery)
        .collect::<Vec<_>>();
    let approvals = facts
        .approvals()
        .filter(|approval| approval.facts().run_id == run_id.as_str())
        .map(public_approval)
        .collect::<Vec<_>>();
    let decisions = facts
        .decisions()
        .filter(|decision| decision.run_id() == run_id.as_str())
        .map(public_decision)
        .collect::<Vec<_>>();
    let evidence = facts
        .evidence_records()
        .filter(|record| record.run_id() == run_id.as_str())
        .map(project_public_evidence)
        .collect::<Vec<_>>();
    let artifacts = facts
        .artifacts()
        .filter(|record| record.run_id() == run_id.as_str())
        .map(public_artifact)
        .collect::<Vec<_>>();
    let events = facts
        .events_for_run(run_id.as_str())
        .into_iter()
        .filter(|event| event.sequence() >= request.event_cursor())
        .take(request.event_limit().unwrap_or(usize::MAX))
        .collect::<Vec<_>>();
    let next_event_cursor = events.last().map_or(request.event_cursor(), |event| {
        event.sequence().saturating_add(1)
    });
    let events = events
        .into_iter()
        .map(project_team_run_public_event)
        .collect::<Vec<_>>();
    let diagnostics = diagnostics_projection(facts, run_id, run, runtime);
    TeamRunPublicSnapshot {
        run: TeamRunPublicRun {
            team_id: team_id.as_str().to_owned(),
            run_id: run_id.as_str().to_owned(),
            team_revision: run.frozen_team_revision().get(),
            runtime,
            lifecycle: lifecycle_status(run.lifecycle().state()),
            start_gate: start_gate_status(run.start_gate()),
            proposal_id: run.start_gate().proposal_id().map(ToOwned::to_owned),
            proposal_summary: run.start_gate().summary().map(ToOwned::to_owned),
            proposal_source_delivery_id: run
                .start_gate()
                .source_delivery_id()
                .map(ToOwned::to_owned),
        },
        graph,
        attempts,
        deliveries,
        approvals,
        decisions,
        evidence,
        artifacts,
        next_event_cursor,
        events,
        unavailable_sections: unavailable_sections(),
        diagnostics,
    }
}

fn diagnostics_projection(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    run: &crate::GraphRunFacts,
    runtime: TeamRuntimeState,
) -> TeamRunPublicDiagnostics {
    let counts = TeamRunPublicCounts {
        attempts: run
            .graph()
            .executions()
            .values()
            .map(|history| history.attempts().len())
            .sum(),
        deliveries: facts
            .deliveries()
            .deliveries()
            .filter(|delivery| delivery.facts().run_id == run_id.as_str())
            .count(),
        approvals: facts
            .approvals()
            .filter(|approval| approval.facts().run_id == run_id.as_str())
            .count(),
        decisions: facts
            .decisions()
            .filter(|decision| decision.run_id() == run_id.as_str())
            .count(),
        evidence: facts
            .evidence_records()
            .filter(|record| record.run_id() == run_id.as_str())
            .count(),
        artifacts: facts
            .artifacts()
            .filter(|record| record.run_id() == run_id.as_str())
            .count(),
        events: facts.events_for_run(run_id.as_str()).len(),
    };
    TeamRunPublicDiagnostics {
        run_id: run_id.as_str().to_owned(),
        runtime,
        counts,
        unavailable_sections: unavailable_sections(),
    }
}

fn unavailable_sections() -> Vec<TeamRunPublicUnavailableSection> {
    vec![
        TeamRunPublicUnavailableSection::NodeInputStates,
        TeamRunPublicUnavailableSection::Roles,
        TeamRunPublicUnavailableSection::Stages,
        TeamRunPublicUnavailableSection::WorkflowPlan,
        TeamRunPublicUnavailableSection::DispatchGroups,
        TeamRunPublicUnavailableSection::DispatchTasks,
        TeamRunPublicUnavailableSection::Dispatches,
        TeamRunPublicUnavailableSection::DispatchExecutions,
        TeamRunPublicUnavailableSection::Messages,
        TeamRunPublicUnavailableSection::NodePromptDeliveries,
        TeamRunPublicUnavailableSection::Gates,
        TeamRunPublicUnavailableSection::Kickbacks,
    ]
}

fn public_attempt(attempt: &crate::run::graph::NodeAttempt) -> TeamRunPublicAttempt {
    TeamRunPublicAttempt {
        node_id: attempt.node_id().as_str().to_owned(),
        attempt_id: attempt.fence().attempt_id().as_str().to_owned(),
        node_execution_id: attempt.fence().node_execution_id().as_str().to_owned(),
        number: attempt.number().get(),
        status: attempt_status(attempt.status()),
        reason: attempt_reason(attempt.reason()),
        output_port: attempt.output_port().map(ToOwned::to_owned),
        created_at: attempt.created_at(),
        updated_at: attempt.updated_at(),
    }
}

fn public_delivery(delivery: &crate::run::delivery::Delivery) -> TeamRunPublicDelivery {
    let facts = delivery.facts();
    TeamRunPublicDelivery {
        delivery_id: facts.delivery_id.as_str().to_owned(),
        run_id: facts.run_id.clone(),
        node_id: facts.node_id.clone(),
        node_execution_id: facts.node_execution_id.clone(),
        task_id: facts.task_id.clone(),
        role_id: facts.role_id.clone(),
        requested_at: facts.requested_at,
        max_attempts: facts.max_attempts,
        phase: delivery_phase(delivery.phase()),
    }
}

fn public_approval(approval: &crate::run::approval::Approval) -> TeamRunPublicApproval {
    let facts = approval.facts();
    let resolution = approval.resolution();
    TeamRunPublicApproval {
        approval_id: facts.approval_id.clone(),
        run_id: facts.run_id.clone(),
        stage_id: facts.stage_id.clone(),
        role_id: facts.role_id.clone(),
        reason: facts.reason.clone(),
        requested_action: facts.requested_action.clone(),
        status: approval_status(approval.status()),
        decision: resolution.map(|item| approval_decision(item.decision)),
        created_at: facts.requested_at,
        resolved_at: resolution.map(|item| item.resolved_at),
        cause: resolution.map(|item| approval_cause(item.cause)),
    }
}

fn public_decision(decision: &crate::TeamDecision) -> TeamRunPublicDecision {
    TeamRunPublicDecision {
        sequence: decision.sequence(),
        decision_id: decision.decision_id().to_owned(),
        run_id: decision.run_id().to_owned(),
        stage_id: decision.stage_id().to_owned(),
        decision: decision_type(decision.decision()),
        created_at: decision.created_at(),
    }
}

fn public_artifact(record: &crate::run::artifact::ArtifactRecord) -> TeamRunPublicArtifact {
    let public = crate::run::artifact::project_public_artifact(record);
    TeamRunPublicArtifact {
        artifact_id: public.artifact_id.as_str().to_owned(),
        run_id: public.run_id,
        node_id: public.node_id,
        node_execution_id: public.node_execution_id,
        role_id: public.role_id,
        kind: public.kind,
        title: public.title,
        summary: public.summary,
        evidence_count: public.evidence_count,
        created_at: record.created_at(),
        updated_at: record.updated_at(),
    }
}

pub fn project_team_run_public_event(event: &crate::run::event::TeamEvent) -> TeamRunPublicEvent {
    let mut projection = TeamRunPublicEvent {
        event_id: event.event_id().to_owned(),
        run_id: event.run_id().to_owned(),
        sequence: event.sequence(),
        event_type: event_type(event.event_type()),
        created_at: event.created_at(),
        approval_id: None,
        node_execution_id: None,
        role_id: None,
        action: None,
        decision: None,
        status: None,
        operation_count: None,
        graph_id: None,
        workflow_plan_id: None,
    };
    match event.payload() {
        crate::run::event::TeamEventPayload::GraphPatchAccepted {
            base_graph_id,
            base_workflow_plan_id,
            operation_count,
        } => {
            projection.graph_id = Some(base_graph_id.clone());
            projection.workflow_plan_id = Some(base_workflow_plan_id.clone());
            projection.operation_count = Some(operation_count.get());
        }
        crate::run::event::TeamEventPayload::GraphReplaced {
            graph_id,
            workflow_plan_id,
        } => {
            projection.graph_id = Some(graph_id.clone());
            projection.workflow_plan_id = Some(workflow_plan_id.clone());
        }
        crate::run::event::TeamEventPayload::NodeProgressed { node_execution_id } => {
            projection.node_execution_id = Some(node_execution_id.as_str().to_owned());
        }
        crate::run::event::TeamEventPayload::ApprovalRequested {
            approval_id,
            node_execution_id,
            role_id,
            action,
        } => {
            projection.approval_id = Some(approval_id.as_str().to_owned());
            projection.node_execution_id = Some(node_execution_id.as_str().to_owned());
            projection.role_id = Some(role_id.as_str().to_owned());
            projection.action = Some(event_action(*action));
        }
        crate::run::event::TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => {
            projection.approval_id = Some(approval_id.as_str().to_owned());
            projection.decision = Some(approval_decision(*decision));
            projection.status = Some(approval_status(*status));
        }
    }
    projection
}

fn start_gate_status(start_gate: &RunStartGate) -> TeamRunPublicStartGate {
    match start_gate {
        RunStartGate::Intake => TeamRunPublicStartGate::Intake,
        RunStartGate::ProposalPending { .. } => TeamRunPublicStartGate::ProposalPending,
        RunStartGate::Started => TeamRunPublicStartGate::Started,
    }
}

fn lifecycle_status(state: &GraphRunLifecycleState) -> TeamRunPublicLifecycle {
    match state {
        GraphRunLifecycleState::Active => TeamRunPublicLifecycle::Active,
        GraphRunLifecycleState::Cancelling { .. } => TeamRunPublicLifecycle::Cancelling,
        GraphRunLifecycleState::Cancelled { .. } => TeamRunPublicLifecycle::Cancelled,
        GraphRunLifecycleState::OutcomeUnknown { .. } => TeamRunPublicLifecycle::OutcomeUnknown,
        GraphRunLifecycleState::Tombstoned { .. } => {
            unreachable!("tombstoned runs are rejected before projection")
        }
    }
}

fn attempt_reason(reason: &AttemptReason) -> TeamPublicAttemptReason {
    match reason {
        AttemptReason::Initial => TeamPublicAttemptReason::Initial,
        AttemptReason::Trigger => TeamPublicAttemptReason::Trigger,
        AttemptReason::Edge(edge_id) => TeamPublicAttemptReason::Edge {
            edge_id: edge_id.as_str().to_owned(),
        },
        AttemptReason::Rework => TeamPublicAttemptReason::Rework,
    }
}

fn delivery_phase(phase: &DeliveryPhase) -> TeamRunPublicDeliveryPhase {
    match phase {
        DeliveryPhase::Pending => TeamRunPublicDeliveryPhase::Pending,
        DeliveryPhase::Delivering(claim) => TeamRunPublicDeliveryPhase::Delivering {
            attempt: claim.attempt(),
            claimed_at: claim.claimed_at(),
        },
        DeliveryPhase::RetryScheduled { retry_at, failure } => {
            TeamRunPublicDeliveryPhase::RetryScheduled {
                retry_at: *retry_at,
                failure: delivery_failure(*failure),
            }
        }
        DeliveryPhase::Delivered { accepted_at, .. } => TeamRunPublicDeliveryPhase::Delivered {
            accepted_at: *accepted_at,
        },
        DeliveryPhase::TerminalObserved { observation } => {
            TeamRunPublicDeliveryPhase::TerminalObserved {
                resolution: terminal_resolution(observation.resolution()),
            }
        }
        DeliveryPhase::Failed { failed_at, failure } => TeamRunPublicDeliveryPhase::Failed {
            failed_at: *failed_at,
            failure: delivery_failure(*failure),
        },
        DeliveryPhase::OutcomeUnknown { observed_at } => {
            TeamRunPublicDeliveryPhase::OutcomeUnknown {
                observed_at: *observed_at,
            }
        }
        DeliveryPhase::Cancelled { cancelled_at } => TeamRunPublicDeliveryPhase::Cancelled {
            cancelled_at: *cancelled_at,
        },
    }
}

const fn delivery_failure(failure: DeliveryFailure) -> TeamPublicDeliveryFailure {
    match failure {
        DeliveryFailure::ReceiverRejected => TeamPublicDeliveryFailure::ReceiverRejected,
        DeliveryFailure::PolicyRejected => TeamPublicDeliveryFailure::PolicyRejected,
        DeliveryFailure::Unavailable => TeamPublicDeliveryFailure::Unavailable,
        DeliveryFailure::TimedOut => TeamPublicDeliveryFailure::TimedOut,
    }
}

const fn terminal_resolution(
    resolution: &TerminalObservationResolution,
) -> TeamPublicTerminalResolution {
    match resolution {
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution => {
            TeamPublicTerminalResolution::AwaitingAuthorizedGraphResolution
        }
        TerminalObservationResolution::GraphResolved(resolution) => match resolution.outcome() {
            AuthorizedGraphOutcome::Completed => TeamPublicTerminalResolution::GraphCompleted,
            AuthorizedGraphOutcome::Failed => TeamPublicTerminalResolution::GraphFailed,
        },
        TerminalObservationResolution::NodeCancelled => TeamPublicTerminalResolution::NodeCancelled,
    }
}

const fn approval_status(status: ApprovalStatus) -> TeamPublicApprovalStatus {
    match status {
        ApprovalStatus::Pending => TeamPublicApprovalStatus::Pending,
        ApprovalStatus::Approved => TeamPublicApprovalStatus::Approved,
        ApprovalStatus::Denied => TeamPublicApprovalStatus::Denied,
        ApprovalStatus::Aborted => TeamPublicApprovalStatus::Aborted,
    }
}

const fn approval_decision(decision: ApprovalDecision) -> TeamPublicApprovalDecision {
    match decision {
        ApprovalDecision::Approve => TeamPublicApprovalDecision::Approve,
        ApprovalDecision::Deny => TeamPublicApprovalDecision::Deny,
        ApprovalDecision::Abort => TeamPublicApprovalDecision::Abort,
    }
}

const fn approval_cause(cause: ApprovalResolutionCause) -> TeamPublicApprovalResolutionCause {
    match cause {
        ApprovalResolutionCause::HumanDecision => TeamPublicApprovalResolutionCause::HumanDecision,
        ApprovalResolutionCause::RunCancelled => TeamPublicApprovalResolutionCause::RunCancelled,
    }
}

const fn decision_type(decision: TeamDecisionType) -> TeamPublicDecisionType {
    match decision {
        TeamDecisionType::Retry => TeamPublicDecisionType::Retry,
        TeamDecisionType::ProceedDegraded => TeamPublicDecisionType::ProceedDegraded,
        TeamDecisionType::Abort => TeamPublicDecisionType::Abort,
    }
}

const fn event_type(event_type: TeamEventType) -> TeamPublicEventType {
    match event_type {
        TeamEventType::GraphPatchAccepted => TeamPublicEventType::GraphPatchAccepted,
        TeamEventType::GraphReplaced => TeamPublicEventType::GraphReplaced,
        TeamEventType::NodeProgressed => TeamPublicEventType::NodeProgressed,
        TeamEventType::ApprovalRequested => TeamPublicEventType::ApprovalRequested,
        TeamEventType::ApprovalResolved => TeamPublicEventType::ApprovalResolved,
    }
}

const fn event_action(action: crate::run::event::ApprovalAction) -> TeamPublicEventAction {
    match action {
        crate::run::event::ApprovalAction::ContinueNode => TeamPublicEventAction::ContinueNode,
        crate::run::event::ApprovalAction::ExecuteTool => TeamPublicEventAction::ExecuteTool,
        crate::run::event::ApprovalAction::PublishResult => TeamPublicEventAction::PublishResult,
        crate::run::event::ApprovalAction::ExternalAction => TeamPublicEventAction::ExternalAction,
    }
}

/// Queries the fixed public TeamRun view without making a runtime, delivery, or approval claim.
///
/// A missing/tombstoned Team or a run that belongs to another Team is unavailable. An absent
/// runtime receipt, an indeterminate delivery, or an unresolved terminal observation is retained
/// as the explicit `runtime: unknown` state while durable graph facts stay visible.
pub fn query_team_public_projection(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> TeamPublicQueryOutcome {
    let Some(team) = facts.team(team_id) else {
        return TeamPublicQueryOutcome::Unavailable;
    };
    if team.tombstoned() {
        return TeamPublicQueryOutcome::Unavailable;
    }

    let Some(run) = facts.run(run_id) else {
        return TeamPublicQueryOutcome::Unavailable;
    };
    if run.team() != team_id
        || matches!(
            run.lifecycle().state(),
            GraphRunLifecycleState::Tombstoned { .. }
        )
    {
        return TeamPublicQueryOutcome::Unavailable;
    }

    TeamPublicQueryOutcome::Available(TeamPublicProjection {
        team_id: team_id.as_str().to_owned(),
        run_id: run_id.as_str().to_owned(),
        team_revision: team.revision().get(),
        runtime: runtime_state(facts, run_id, run.runtime().is_some()),
        start_gate: start_gate_status(run.start_gate()),
        proposal_id: run.start_gate().proposal_id().map(ToOwned::to_owned),
        proposal_summary: run.start_gate().summary().map(ToOwned::to_owned),
        proposal_source_delivery_id: run.start_gate().source_delivery_id().map(ToOwned::to_owned),
        graph: graph_projection(facts, run.graph()),
    })
}

fn runtime_state(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    has_runtime_receipt: bool,
) -> TeamRuntimeState {
    if !has_runtime_receipt
        || facts.run(run_id).is_some_and(|run| {
            matches!(
                run.lifecycle().state(),
                GraphRunLifecycleState::Cancelling { .. }
                    | GraphRunLifecycleState::OutcomeUnknown { .. }
            )
        })
        || facts.deliveries().deliveries().any(|delivery| {
            delivery.facts().run_id == run_id.as_str()
                && match delivery.phase() {
                    DeliveryPhase::OutcomeUnknown { .. } => true,
                    DeliveryPhase::TerminalObserved { observation } => matches!(
                        observation.resolution(),
                        TerminalObservationResolution::AwaitingAuthorizedGraphResolution
                    ),
                    _ => false,
                }
        })
    {
        TeamRuntimeState::Unknown
    } else {
        TeamRuntimeState::Confirmed
    }
}

fn graph_projection(facts: &OrganizationFacts, graph: &GraphState) -> TeamPublicGraph {
    let projected = project(graph);
    let definition = graph.definition();
    let rework_limit_nodes: BTreeSet<_> = facts
        .deliveries()
        .deliveries()
        .filter_map(|delivery| {
            let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
                return None;
            };
            let TerminalObservationResolution::GraphResolved(resolution) = observation.resolution()
            else {
                return None;
            };
            if observation.graph_run_id() != definition.run_id().as_str()
                || observation.native_terminal() != NativeTerminalStatus::Completed
                || resolution.outcome() != AuthorizedGraphOutcome::Failed
                || !observation
                    .output()
                    .is_some_and(|output| output.decision() == "rework")
            {
                return None;
            }
            let node_id = crate::NodeId::new(observation.node_id());
            let current = graph.current_attempt(&node_id)?;
            (current.fence() == observation.fence() && current.status() == AttemptStatus::Failed)
                .then_some(node_id)
        })
        .collect();
    TeamPublicGraph {
        graph_id: definition.graph_id().to_owned(),
        workflow_plan_id: definition.workflow_plan_id().to_owned(),
        title: definition.title().to_owned(),
        status: graph_status(projected.status),
        layout: TeamPublicGraphLayout {
            node_positions: graph
                .layout()
                .node_positions()
                .iter()
                .map(|(node_id, position)| {
                    (
                        node_id.as_str().to_owned(),
                        TeamPublicNodePosition {
                            x: position.x(),
                            y: position.y(),
                        },
                    )
                })
                .collect(),
        },
        nodes: definition
            .nodes()
            .iter()
            .zip(projected.nodes)
            .map(|(definition, current)| TeamPublicNode {
                node_id: definition.id().as_str().to_owned(),
                kind: node_kind(definition.kind()),
                title: definition.title().to_owned(),
                role_id: definition
                    .work_assignment()
                    .map(|assignment| assignment.role_id().to_owned()),
                task_id: definition
                    .work_assignment()
                    .map(|assignment| assignment.task_id().to_owned()),
                max_attempts: definition.max_attempts().get(),
                trigger: definition.trigger().map(|trigger| match trigger {
                    StartTrigger::Webhook { .. } => TeamPublicStartTrigger::Webhook,
                    StartTrigger::Cron { expression } => TeamPublicStartTrigger::Cron {
                        expression: expression.clone(),
                    },
                }),
                status_reason: rework_limit_nodes
                    .contains(definition.id())
                    .then_some("rework_limit_exceeded"),
                attempt: TeamPublicAttempt {
                    number: current.current.number,
                    status: attempt_status(current.current.status),
                    updated_at: current.current.updated_at,
                },
            })
            .collect(),
        edges: definition
            .edges()
            .iter()
            .zip(projected.edges)
            .map(|(definition, state)| TeamPublicEdge {
                edge_id: definition.id().as_str().to_owned(),
                source_node_id: definition.source_node_id().as_str().to_owned(),
                source_port: definition.source_port().to_owned(),
                target_node_id: definition.target_node_id().as_str().to_owned(),
                target_port: definition.target_port().to_owned(),
                action: edge_action(definition.action()),
                status: edge_status(state.status),
            })
            .collect(),
    }
}

const fn graph_status(status: GraphStatus) -> TeamPublicGraphStatus {
    match status {
        GraphStatus::Pending => TeamPublicGraphStatus::Pending,
        GraphStatus::Ready => TeamPublicGraphStatus::Ready,
        GraphStatus::Running => TeamPublicGraphStatus::Running,
        GraphStatus::Waiting => TeamPublicGraphStatus::Waiting,
        GraphStatus::Completed => TeamPublicGraphStatus::Completed,
        GraphStatus::Failed => TeamPublicGraphStatus::Failed,
        GraphStatus::Cancelled => TeamPublicGraphStatus::Cancelled,
    }
}

const fn node_kind(kind: NodeKind) -> TeamPublicNodeKind {
    match kind {
        NodeKind::Start => TeamPublicNodeKind::Start,
        NodeKind::Work => TeamPublicNodeKind::Work,
        NodeKind::Review => TeamPublicNodeKind::Review,
        NodeKind::HumanDecision => TeamPublicNodeKind::HumanDecision,
        NodeKind::ScriptReview => TeamPublicNodeKind::ScriptReview,
        NodeKind::Join => TeamPublicNodeKind::Join,
        NodeKind::End => TeamPublicNodeKind::End,
    }
}

const fn attempt_status(status: AttemptStatus) -> TeamPublicAttemptStatus {
    match status {
        AttemptStatus::Pending => TeamPublicAttemptStatus::Pending,
        AttemptStatus::Ready => TeamPublicAttemptStatus::Ready,
        AttemptStatus::Running => TeamPublicAttemptStatus::Running,
        AttemptStatus::Waiting => TeamPublicAttemptStatus::Waiting,
        AttemptStatus::Completed => TeamPublicAttemptStatus::Completed,
        AttemptStatus::Failed => TeamPublicAttemptStatus::Failed,
        AttemptStatus::Cancelled => TeamPublicAttemptStatus::Cancelled,
    }
}

const fn edge_action(action: EdgeAction) -> TeamPublicEdgeAction {
    match action {
        EdgeAction::Activate => TeamPublicEdgeAction::Activate,
        EdgeAction::Rework => TeamPublicEdgeAction::Rework,
        EdgeAction::Gate => TeamPublicEdgeAction::Gate,
        EdgeAction::Finish => TeamPublicEdgeAction::Finish,
    }
}

const fn edge_status(status: EdgeStatus) -> TeamPublicEdgeStatus {
    match status {
        EdgeStatus::Waiting => TeamPublicEdgeStatus::Waiting,
        EdgeStatus::Satisfied => TeamPublicEdgeStatus::Satisfied,
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use crate::{
        BeginCancellationOutcome, Delivery, DeliveryId, DeliveryLedger, DeliveryRequest,
        GraphDefinition, GraphRunFacts, GraphState, MaterializationReceipt, MemberId,
        NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind,
        RoleMaterializationReceipt, RunRuntimeReceipt, RuntimeEndpointReference, TeamDefinition,
        TeamFacts, TeamMember, TeamRevision, TeamRole, begin_delivery,
    };

    use super::*;

    const PRIVATE_AGENT: &str = "private-agent-token";
    const PRIVATE_ENDPOINT: &str = "private-runtime-endpoint";

    #[test]
    fn durable_graph_projection_exposes_the_renderer_graph_fields_without_private_runtime_data() {
        let projection = available(facts(Some(runtime()), DeliveryLedger::default()));

        assert_eq!(projection.team_id(), "team:one");
        assert_eq!(projection.run_id(), "run:one");
        assert_eq!(projection.team_revision(), 1);
        assert_eq!(projection.runtime(), TeamRuntimeState::Confirmed);
        assert_eq!(projection.graph().graph_id(), "graph:one");
        assert_eq!(projection.graph().workflow_plan_id(), "plan:one");
        assert_eq!(projection.graph().title(), "Public graph title");
        assert_eq!(projection.graph().status(), TeamPublicGraphStatus::Ready);
        assert_eq!(projection.graph().nodes().len(), 2);
        assert_eq!(projection.graph().nodes()[1].role_id(), Some("writer"));
        assert_eq!(projection.graph().nodes()[1].task_id(), Some("draft"));
        assert_eq!(
            projection.graph().nodes()[1].attempt().status(),
            TeamPublicAttemptStatus::Pending
        );
        assert_eq!(
            projection.graph().edges()[0].action(),
            TeamPublicEdgeAction::Activate
        );

        let json = serde_json::to_string(&projection).unwrap();
        let document: serde_json::Value = serde_json::from_str(&json).unwrap();
        let object = document.as_object().unwrap();
        assert_eq!(object.len(), 9);
        for field in [
            "teamId",
            "runId",
            "teamRevision",
            "runtime",
            "startGate",
            "proposalId",
            "proposalSummary",
            "proposalSourceDeliveryId",
            "graph",
        ] {
            assert!(object.contains_key(field));
        }
        for omitted in [
            "diagnostics",
            "storageRoot",
            "budgets",
            "limits",
            "roles",
            "deliveries",
            "receipts",
            "approvals",
            "events",
            "artifacts",
            "messages",
        ] {
            assert!(!object.contains_key(omitted));
        }
        for private in [
            PRIVATE_AGENT,
            PRIVATE_ENDPOINT,
            "private prompt",
            "raw native error",
        ] {
            assert!(!json.contains(private));
        }
        assert!(!json.contains("session"));
        assert!(!json.contains("receipt"));
        assert!(!json.contains("workspace"));
    }

    #[test]
    fn absent_runtime_and_indeterminate_delivery_are_explicitly_unknown_without_hiding_graph_facts()
    {
        let without_runtime = available(facts(None, DeliveryLedger::default()));
        assert_eq!(without_runtime.runtime(), TeamRuntimeState::Unknown);
        assert_eq!(without_runtime.graph().nodes().len(), 2);

        let mut delivery = Delivery::request(DeliveryRequest {
            delivery_id: DeliveryId::new("delivery:one").unwrap(),
            team_id: "team:one".into(),
            run_id: "run:one".into(),
            node_id: "start".into(),
            node_execution_id: "start:attempt:1".into(),
            task_id: "task:one".into(),
            role_id: "writer".into(),
            session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
            idempotency_key: "delivery:one".into(),
            message: "private prompt".into(),
            requested_at: 1,
            max_attempts: 2,
        })
        .unwrap();
        let _ = begin_delivery(&mut delivery, 2);
        assert!(matches!(
            crate::recover_interrupted_delivery(&mut delivery, 3),
            crate::DeliveryRecovery::OutcomeUnknown
        ));
        let ledger = DeliveryLedger::restore(crate::DeliveryLedgerSnapshot::new(vec![
            delivery.snapshot(),
        ]))
        .unwrap();

        let indeterminate = available(facts(Some(runtime()), ledger));
        assert_eq!(indeterminate.runtime(), TeamRuntimeState::Unknown);
        assert_eq!(indeterminate.graph().status(), TeamPublicGraphStatus::Ready);
    }

    #[test]
    fn lifecycle_tombstone_hides_the_projection_and_cancellation_marks_runtime_unknown() {
        let mut tombstoned = facts(Some(runtime()), DeliveryLedger::default());
        let started = tombstoned
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        tombstoned
            .settle_graph_run_cancellation(
                &GraphRunId::new("run:one"),
                "cancel:one",
                crate::RoleAbortOutcome::Confirmed,
                3,
            )
            .unwrap();
        tombstoned
            .tombstone_graph_run(&GraphRunId::new("run:one"), "delete:one", 4)
            .unwrap();
        assert_eq!(
            query_team_public_projection(&tombstoned, &team(), &GraphRunId::new("run:one")),
            TeamPublicQueryOutcome::Unavailable
        );

        let mut cancelling = facts(Some(runtime()), DeliveryLedger::default());
        let started = cancelling
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        assert_eq!(available(cancelling).runtime(), TeamRuntimeState::Unknown);
    }

    #[test]
    fn query_is_unavailable_for_missing_tombstoned_or_foreign_team_run() {
        let facts = facts(Some(runtime()), DeliveryLedger::default());
        let missing = TeamId::try_new("team:missing").unwrap();
        assert_eq!(
            query_team_public_projection(&facts, &missing, &GraphRunId::new("run:one")),
            TeamPublicQueryOutcome::Unavailable
        );

        let tombstoned = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                true,
            )],
            Vec::<MaterializationReceipt>::new(),
            vec![
                GraphRunFacts::new(
                    TeamId::try_new("team:one").unwrap(),
                    TeamRevision::initial(),
                    graph(),
                    None,
                )
                .unwrap(),
            ],
            DeliveryLedger::default().snapshot(),
        )
        .unwrap();
        assert_eq!(
            query_team_public_projection(&tombstoned, &team(), &GraphRunId::new("run:one")),
            TeamPublicQueryOutcome::Unavailable
        );

        let foreign = TeamId::try_new("team:two").unwrap();
        assert_eq!(
            query_team_public_projection(&facts, &foreign, &GraphRunId::new("run:one")),
            TeamPublicQueryOutcome::Unavailable
        );
    }

    fn available(facts: OrganizationFacts) -> TeamPublicProjection {
        match query_team_public_projection(&facts, &team(), &GraphRunId::new("run:one")) {
            TeamPublicQueryOutcome::Available(projection) => projection,
            TeamPublicQueryOutcome::Unavailable => panic!("expected available projection"),
        }
    }

    fn team() -> TeamId {
        TeamId::try_new("team:one").unwrap()
    }

    fn team_definition() -> TeamDefinition {
        let member =
            TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader").unwrap();
        let role = TeamRole::try_new(
            RoleId::try_new("leader").unwrap(),
            "Leader",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            team(),
            "Test team",
            vec![member.clone()],
            vec![role.clone()],
            vec![RoleAssignment::new(
                member.member_id().clone(),
                role.role_id().clone(),
            )],
        )
        .unwrap()
    }

    fn facts(runtime: Option<RunRuntimeReceipt>, deliveries: DeliveryLedger) -> OrganizationFacts {
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            vec![materialization()],
            vec![GraphRunFacts::new(team(), TeamRevision::initial(), graph(), runtime).unwrap()],
            deliveries.snapshot(),
        )
        .unwrap()
    }

    fn graph() -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:one",
                "plan:one",
                GraphRunId::new("run:one"),
                "Public graph title",
                vec![
                    NodeDefinition::start(
                        NodeId::new("start"),
                        "Start work",
                        NonZeroU32::new(2).unwrap(),
                        None,
                    ),
                    NodeDefinition::work(
                        NodeId::new("draft"),
                        "Draft",
                        NonZeroU32::new(3).unwrap(),
                        crate::WorkAssignment::new("draft", "writer"),
                    ),
                ],
                vec![crate::EdgeDefinition::new(
                    crate::EdgeId::new("start-to-draft"),
                    NodeId::new("start"),
                    "done",
                    NodeId::new("draft"),
                    "input",
                    EdgeAction::Activate,
                )],
            )
            .unwrap(),
            1,
        )
    }

    fn materialization() -> MaterializationReceipt {
        let endpoint = RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap();
        MaterializationReceipt::try_new(
            team(),
            endpoint.clone(),
            vec![RoleMaterializationReceipt::new(
                RoleId::try_new("writer").unwrap(),
                crate::ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap(),
                endpoint,
            )],
        )
        .unwrap()
    }

    fn runtime() -> RunRuntimeReceipt {
        use crate::RoleSessionReceipt;

        let endpoint = RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap();
        RunRuntimeReceipt::try_new(
            GraphRunId::new("run:one"),
            vec![RoleSessionReceipt::with_endpoint_session_id(
                team(),
                GraphRunId::new("run:one"),
                RoleId::try_new("writer").unwrap(),
                crate::RoleSessionRef::initial(),
                crate::EndpointSessionId::try_new("tr-one-writer-rs0").unwrap(),
                crate::ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap(),
                endpoint,
            )],
        )
        .unwrap()
    }
}
