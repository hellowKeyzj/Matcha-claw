use std::collections::BTreeMap;

use serde::Serialize;

use crate::{
    GraphRunId, OrganizationFacts, TeamId,
    run::{
        approval::{ApprovalDecision, ApprovalResolutionCause, ApprovalStatus},
        decision::TeamDecisionType,
        delivery::{DeliveryFailure, DeliveryPhase, TerminalObservationResolution},
        graph::{AttemptReason, AttemptStatus, GraphStatus, project},
        lifecycle::GraphRunLifecycleState,
    },
};

/// Maximum number represented by a diagnostics count.
///
/// Diagnostics are an observation surface, not an unbounded ledger export. A producer that has
/// more facts than this reports the cap; the missing source domain remains explicit in
/// `unavailable_sections` rather than being represented by private or guessed data.
pub const MAX_DIAGNOSTICS_COUNT: u64 = 10_000;

/// Maximum number of stale execution records exposed by one diagnostics projection.
pub const MAX_DIAGNOSTICS_STALE_EXECUTIONS: usize = 128;

/// Confidence of a durable diagnostics fact.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunDiagnosticsConfidence {
    Confirmed,
    Unknown,
    Unavailable,
}

/// Renderer-safe status derived from the durable graph and run lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsStatus {
    graph: TeamRunDiagnosticsGraphStatus,
    lifecycle: TeamRunDiagnosticsLifecycleStatus,
    confidence: TeamRunDiagnosticsConfidence,
}

impl TeamRunDiagnosticsStatus {
    pub const fn graph(&self) -> TeamRunDiagnosticsGraphStatus {
        self.graph
    }

    pub const fn lifecycle(&self) -> TeamRunDiagnosticsLifecycleStatus {
        self.lifecycle
    }

    pub const fn confidence(&self) -> TeamRunDiagnosticsConfidence {
        self.confidence
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunDiagnosticsGraphStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunDiagnosticsLifecycleStatus {
    Active,
    Cancelling,
    Cancelled,
    OutcomeUnknown,
    Tombstoned,
}

/// Failure facts are classifications only; no message, prompt, receipt, or native payload is
/// included.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsFailureSummary {
    total: u64,
    failed_attempts: u64,
    delivery_failures: TeamRunDiagnosticsDeliveryFailureSummary,
    unknown_outcomes: u64,
}

impl TeamRunDiagnosticsFailureSummary {
    pub const fn total(&self) -> u64 {
        self.total
    }

    pub const fn failed_attempts(&self) -> u64 {
        self.failed_attempts
    }

    pub const fn delivery_failures(&self) -> &TeamRunDiagnosticsDeliveryFailureSummary {
        &self.delivery_failures
    }

    pub const fn unknown_outcomes(&self) -> u64 {
        self.unknown_outcomes
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsDeliveryFailureSummary {
    total: u64,
    receiver_rejected: u64,
    policy_rejected: u64,
    unavailable: u64,
    timed_out: u64,
}

impl TeamRunDiagnosticsDeliveryFailureSummary {
    pub const fn total(&self) -> u64 {
        self.total
    }

    pub const fn receiver_rejected(&self) -> u64 {
        self.receiver_rejected
    }

    pub const fn policy_rejected(&self) -> u64 {
        self.policy_rejected
    }

    pub const fn unavailable(&self) -> u64 {
        self.unavailable
    }

    pub const fn timed_out(&self) -> u64 {
        self.timed_out
    }
}

/// Retry information is limited to durable attempt, delivery, and decision classifications.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsRetrySummary {
    rework_attempts: u64,
    retry_scheduled: u64,
    retryable_failures: u64,
    non_retryable_failures: u64,
    retry_decisions: u64,
}

impl TeamRunDiagnosticsRetrySummary {
    pub const fn rework_attempts(&self) -> u64 {
        self.rework_attempts
    }

    pub const fn retry_scheduled(&self) -> u64 {
        self.retry_scheduled
    }

    pub const fn retryable_failures(&self) -> u64 {
        self.retryable_failures
    }

    pub const fn non_retryable_failures(&self) -> u64 {
        self.non_retryable_failures
    }

    pub const fn retry_decisions(&self) -> u64 {
        self.retry_decisions
    }
}

/// Approval state and decision counts only. Approval reason, risk, note, fence, and idempotency
/// fields are deliberately absent.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsApprovalSummary {
    total: u64,
    pending: u64,
    approved: u64,
    denied: u64,
    aborted: u64,
    resolutions: u64,
    approve_decisions: u64,
    deny_decisions: u64,
    abort_decisions: u64,
    human_decisions: u64,
    run_cancelled: u64,
}

impl TeamRunDiagnosticsApprovalSummary {
    pub const fn total(&self) -> u64 {
        self.total
    }

    pub const fn pending(&self) -> u64 {
        self.pending
    }

    pub const fn approved(&self) -> u64 {
        self.approved
    }

    pub const fn denied(&self) -> u64 {
        self.denied
    }

    pub const fn aborted(&self) -> u64 {
        self.aborted
    }

    pub const fn resolutions(&self) -> u64 {
        self.resolutions
    }

    pub const fn approve_decisions(&self) -> u64 {
        self.approve_decisions
    }

    pub const fn deny_decisions(&self) -> u64 {
        self.deny_decisions
    }

    pub const fn abort_decisions(&self) -> u64 {
        self.abort_decisions
    }

    pub const fn human_decisions(&self) -> u64 {
        self.human_decisions
    }

    pub const fn run_cancelled(&self) -> u64 {
        self.run_cancelled
    }
}

/// Delivery phases and failure classes are exposed without delivery content or native identity.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsDeliverySummary {
    total: u64,
    pending: u64,
    delivering: u64,
    retry_scheduled: u64,
    delivered: u64,
    terminal_observed: u64,
    failed: u64,
    outcome_unknown: u64,
    cancelled: u64,
    failures: TeamRunDiagnosticsDeliveryFailureSummary,
}

impl TeamRunDiagnosticsDeliverySummary {
    pub const fn total(&self) -> u64 {
        self.total
    }

    pub const fn pending(&self) -> u64 {
        self.pending
    }

    pub const fn delivering(&self) -> u64 {
        self.delivering
    }

    pub const fn retry_scheduled(&self) -> u64 {
        self.retry_scheduled
    }

    pub const fn delivered(&self) -> u64 {
        self.delivered
    }

    pub const fn terminal_observed(&self) -> u64 {
        self.terminal_observed
    }

    pub const fn failed(&self) -> u64 {
        self.failed
    }

    pub const fn outcome_unknown(&self) -> u64 {
        self.outcome_unknown
    }

    pub const fn cancelled(&self) -> u64 {
        self.cancelled
    }

    pub const fn failures(&self) -> &TeamRunDiagnosticsDeliveryFailureSummary {
        &self.failures
    }
}

/// A renderer-safe TeamRun diagnostics projection derived only from Organization durable facts.
///
/// Storage provenance, storage roots, workspace paths, runtime bindings, prompts, messages,
/// dispatch payloads, receipts, and native session identities have no representation in this
/// type. Domains that are not owned by Organization are listed in `unavailable_sections`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsProjection {
    run_id: String,
    status: TeamRunDiagnosticsStatus,
    failure: TeamRunDiagnosticsFailureSummary,
    retry: TeamRunDiagnosticsRetrySummary,
    approval: TeamRunDiagnosticsApprovalSummary,
    delivery: TeamRunDiagnosticsDeliverySummary,
    recovered_from_storage: Option<bool>,
    budgets: TeamRunDiagnosticsBudgets,
    limits: TeamRunDiagnosticsLimits,
    stale_dispatch_executions: Vec<TeamRunDiagnosticsStaleExecution>,
    counts: BTreeMap<String, u64>,
    unavailable_sections: Vec<TeamRunDiagnosticsUnavailableSection>,
}

impl TeamRunDiagnosticsProjection {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn status(&self) -> &TeamRunDiagnosticsStatus {
        &self.status
    }

    pub const fn failure(&self) -> &TeamRunDiagnosticsFailureSummary {
        &self.failure
    }

    pub const fn retry(&self) -> &TeamRunDiagnosticsRetrySummary {
        &self.retry
    }

    pub const fn approval(&self) -> &TeamRunDiagnosticsApprovalSummary {
        &self.approval
    }

    pub const fn delivery(&self) -> &TeamRunDiagnosticsDeliverySummary {
        &self.delivery
    }

    /// Storage recovery is unavailable because OrganizationFacts carries no storage provenance.
    pub const fn recovered_from_storage(&self) -> Option<bool> {
        self.recovered_from_storage
    }

    pub const fn budgets(&self) -> &TeamRunDiagnosticsBudgets {
        &self.budgets
    }

    pub const fn limits(&self) -> &TeamRunDiagnosticsLimits {
        &self.limits
    }

    pub fn stale_dispatch_executions(&self) -> &[TeamRunDiagnosticsStaleExecution] {
        &self.stale_dispatch_executions
    }

    pub fn counts(&self) -> &BTreeMap<String, u64> {
        &self.counts
    }

    pub fn unavailable_sections(&self) -> &[TeamRunDiagnosticsUnavailableSection] {
        &self.unavailable_sections
    }
}

/// Budget facts are optional because no budget owner currently contributes durable Organization
/// facts. The maps are intentionally bounded when populated by a future owner.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsBudgets {
    total_wall_clock_budget_ms: Option<u64>,
    total_token_budget: Option<u64>,
    role_wall_clock_budget_ms: BTreeMap<String, u64>,
    role_token_budget: BTreeMap<String, u64>,
    elapsed_ms: Option<u64>,
    wall_clock_exceeded: Option<bool>,
}

impl TeamRunDiagnosticsBudgets {
    pub fn total_wall_clock_budget_ms(&self) -> Option<u64> {
        self.total_wall_clock_budget_ms
    }

    pub fn total_token_budget(&self) -> Option<u64> {
        self.total_token_budget
    }

    pub fn role_wall_clock_budget_ms(&self) -> &BTreeMap<String, u64> {
        &self.role_wall_clock_budget_ms
    }

    pub fn role_token_budget(&self) -> &BTreeMap<String, u64> {
        &self.role_token_budget
    }

    pub fn elapsed_ms(&self) -> Option<u64> {
        self.elapsed_ms
    }

    pub fn wall_clock_exceeded(&self) -> Option<bool> {
        self.wall_clock_exceeded
    }
}

/// Runtime and payload limits are optional because their owners are outside Organization.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsLimits {
    max_artifact_content_bytes: Option<u64>,
    max_message_body_bytes: Option<u64>,
    stale_dispatch_execution_ms: Option<u64>,
}

impl TeamRunDiagnosticsLimits {
    pub fn max_artifact_content_bytes(&self) -> Option<u64> {
        self.max_artifact_content_bytes
    }

    pub fn max_message_body_bytes(&self) -> Option<u64> {
        self.max_message_body_bytes
    }

    pub fn stale_dispatch_execution_ms(&self) -> Option<u64> {
        self.stale_dispatch_execution_ms
    }
}

/// The only stale execution shape this module could safely expose would have to be backed by a
/// durable Organization fact. The current durable model has no dispatch-execution record, so this
/// type is retained for the contract while the producer reports the section as unavailable.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDiagnosticsStaleExecution {
    execution_id: String,
    observed_at: u64,
}

impl TeamRunDiagnosticsStaleExecution {
    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub const fn observed_at(&self) -> u64 {
        self.observed_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunDiagnosticsUnavailableSection {
    StorageRecovery,
    StorageRoot,
    Budgets,
    Limits,
    StaleDispatchExecutions,
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
    NodeInputStates,
    Workspace,
    Prompts,
    NativeSessions,
    RuntimeBindings,
    Receipts,
    Tokens,
    Transcripts,
    RawPayloads,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunDiagnosticsUnavailableReason {
    MissingTeam,
    TombstonedTeam,
    MissingRun,
    ForeignRun,
    TombstonedRun,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamRunDiagnosticsQueryOutcome {
    Available(TeamRunDiagnosticsProjection),
    Unavailable(TeamRunDiagnosticsUnavailableReason),
}

/// Produces the bounded diagnostics view for an existing TeamRun.
///
/// The query is read-only. It does not consult Host state, runtime state, workspace state, or
/// in-memory dispatch registries; every available fact comes from Organization durable facts.
pub fn query_team_run_diagnostics(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> TeamRunDiagnosticsQueryOutcome {
    let Some(team) = facts.team(team_id) else {
        return TeamRunDiagnosticsQueryOutcome::Unavailable(
            TeamRunDiagnosticsUnavailableReason::MissingTeam,
        );
    };
    if team.tombstoned() {
        return TeamRunDiagnosticsQueryOutcome::Unavailable(
            TeamRunDiagnosticsUnavailableReason::TombstonedTeam,
        );
    }

    let Some(run) = facts.run(run_id) else {
        return TeamRunDiagnosticsQueryOutcome::Unavailable(
            TeamRunDiagnosticsUnavailableReason::MissingRun,
        );
    };
    if run.team() != team_id {
        return TeamRunDiagnosticsQueryOutcome::Unavailable(
            TeamRunDiagnosticsUnavailableReason::ForeignRun,
        );
    }
    if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::Tombstoned { .. }
    ) {
        return TeamRunDiagnosticsQueryOutcome::Unavailable(
            TeamRunDiagnosticsUnavailableReason::TombstonedRun,
        );
    }

    TeamRunDiagnosticsQueryOutcome::Available(project_diagnostics(facts, run_id, run))
}

fn project_diagnostics(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    run: &crate::GraphRunFacts,
) -> TeamRunDiagnosticsProjection {
    let delivery = project_delivery_summary(facts, run_id);
    let failed_attempts = bounded_count(
        run.graph()
            .executions()
            .values()
            .flat_map(|history| history.attempts().iter())
            .filter(|attempt| attempt.status() == AttemptStatus::Failed),
    );
    let failure = TeamRunDiagnosticsFailureSummary {
        total: capped_sum(&[
            failed_attempts,
            delivery.failures.total,
            delivery.outcome_unknown,
        ]),
        failed_attempts,
        delivery_failures: delivery.failures.clone(),
        unknown_outcomes: delivery.outcome_unknown,
    };
    let retry = project_retry_summary(facts, run_id, run, &delivery);
    let approval = project_approval_summary(facts, run_id);
    let status = TeamRunDiagnosticsStatus {
        graph: diagnostics_graph_status(project(run.graph()).status),
        lifecycle: diagnostics_lifecycle_status(run.lifecycle().state()),
        confidence: runtime_confidence(facts, run_id, run),
    };

    let mut counts = BTreeMap::new();
    counts.insert(
        "attempts".to_owned(),
        bounded_count(
            run.graph()
                .executions()
                .values()
                .flat_map(|history| history.attempts().iter()),
        ),
    );
    counts.insert("deliveries".to_owned(), delivery.total);
    counts.insert("approvals".to_owned(), approval.total);
    counts.insert(
        "decisions".to_owned(),
        bounded_count(
            facts
                .decisions()
                .filter(|decision| decision.run_id() == run_id.as_str()),
        ),
    );
    counts.insert(
        "evidence".to_owned(),
        bounded_count(
            facts
                .evidence_records()
                .filter(|record| record.run_id() == run_id.as_str()),
        ),
    );
    counts.insert(
        "artifacts".to_owned(),
        bounded_count(
            facts
                .artifacts()
                .filter(|record| record.run_id() == run_id.as_str()),
        ),
    );
    counts.insert(
        "events".to_owned(),
        bounded_count(facts.events_for_run(run_id.as_str()).into_iter()),
    );

    TeamRunDiagnosticsProjection {
        run_id: run_id.as_str().to_owned(),
        status,
        failure,
        retry,
        approval,
        delivery,
        recovered_from_storage: None,
        budgets: TeamRunDiagnosticsBudgets::default(),
        limits: TeamRunDiagnosticsLimits::default(),
        stale_dispatch_executions: Vec::new(),
        counts,
        unavailable_sections: unavailable_sections(),
    }
}

fn project_delivery_summary(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
) -> TeamRunDiagnosticsDeliverySummary {
    let mut summary = TeamRunDiagnosticsDeliverySummary::default();
    for delivery in facts
        .deliveries()
        .deliveries()
        .filter(|delivery| delivery.facts().run_id == run_id.as_str())
        .take(MAX_DIAGNOSTICS_COUNT as usize)
    {
        increment(&mut summary.total);
        match delivery.phase() {
            DeliveryPhase::Pending => increment(&mut summary.pending),
            DeliveryPhase::Delivering(_) => increment(&mut summary.delivering),
            DeliveryPhase::RetryScheduled { failure, .. } => {
                increment(&mut summary.retry_scheduled);
                add_delivery_failure(&mut summary.failures, *failure);
            }
            DeliveryPhase::Delivered { .. } => increment(&mut summary.delivered),
            DeliveryPhase::TerminalObserved { observation } => {
                increment(&mut summary.terminal_observed);
                if matches!(
                    observation.resolution(),
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution
                ) {
                    increment(&mut summary.outcome_unknown);
                }
            }
            DeliveryPhase::Failed { failure, .. } => {
                increment(&mut summary.failed);
                add_delivery_failure(&mut summary.failures, *failure);
            }
            DeliveryPhase::OutcomeUnknown { .. } => increment(&mut summary.outcome_unknown),
            DeliveryPhase::Cancelled { .. } => increment(&mut summary.cancelled),
        }
    }
    summary
}

fn project_retry_summary(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    run: &crate::GraphRunFacts,
    delivery: &TeamRunDiagnosticsDeliverySummary,
) -> TeamRunDiagnosticsRetrySummary {
    let rework_attempts = bounded_count(
        run.graph()
            .executions()
            .values()
            .flat_map(|history| history.attempts().iter())
            .filter(|attempt| matches!(attempt.reason(), AttemptReason::Rework)),
    );
    let retry_decisions = bounded_count(facts.decisions().filter(|decision| {
        decision.run_id() == run_id.as_str() && decision.decision() == TeamDecisionType::Retry
    }));
    TeamRunDiagnosticsRetrySummary {
        rework_attempts,
        retry_scheduled: delivery.retry_scheduled,
        retryable_failures: delivery
            .failures
            .total
            .saturating_sub(delivery.failures.policy_rejected),
        non_retryable_failures: delivery.failures.policy_rejected,
        retry_decisions,
    }
}

fn project_approval_summary(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
) -> TeamRunDiagnosticsApprovalSummary {
    let mut summary = TeamRunDiagnosticsApprovalSummary::default();
    for approval in facts
        .approvals()
        .filter(|approval| approval.facts().run_id == run_id.as_str())
        .take(MAX_DIAGNOSTICS_COUNT as usize)
    {
        increment(&mut summary.total);
        match approval.status() {
            ApprovalStatus::Pending => increment(&mut summary.pending),
            ApprovalStatus::Approved => increment(&mut summary.approved),
            ApprovalStatus::Denied => increment(&mut summary.denied),
            ApprovalStatus::Aborted => increment(&mut summary.aborted),
        }
        for resolution in approval
            .resolutions()
            .iter()
            .take(MAX_DIAGNOSTICS_COUNT as usize)
        {
            increment(&mut summary.resolutions);
            match resolution.decision {
                ApprovalDecision::Approve => increment(&mut summary.approve_decisions),
                ApprovalDecision::Deny => increment(&mut summary.deny_decisions),
                ApprovalDecision::Abort => increment(&mut summary.abort_decisions),
            }
            match resolution.cause {
                ApprovalResolutionCause::HumanDecision => increment(&mut summary.human_decisions),
                ApprovalResolutionCause::RunCancelled => increment(&mut summary.run_cancelled),
            }
        }
    }
    summary
}

fn runtime_confidence(
    facts: &OrganizationFacts,
    run_id: &GraphRunId,
    run: &crate::GraphRunFacts,
) -> TeamRunDiagnosticsConfidence {
    if run.runtime().is_none()
        || matches!(
            run.lifecycle().state(),
            GraphRunLifecycleState::Cancelling { .. }
                | GraphRunLifecycleState::OutcomeUnknown { .. }
        )
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
        TeamRunDiagnosticsConfidence::Unknown
    } else {
        TeamRunDiagnosticsConfidence::Confirmed
    }
}

fn diagnostics_graph_status(status: GraphStatus) -> TeamRunDiagnosticsGraphStatus {
    match status {
        GraphStatus::Pending => TeamRunDiagnosticsGraphStatus::Pending,
        GraphStatus::Ready => TeamRunDiagnosticsGraphStatus::Ready,
        GraphStatus::Running => TeamRunDiagnosticsGraphStatus::Running,
        GraphStatus::Waiting => TeamRunDiagnosticsGraphStatus::Waiting,
        GraphStatus::Completed => TeamRunDiagnosticsGraphStatus::Completed,
        GraphStatus::Failed => TeamRunDiagnosticsGraphStatus::Failed,
        GraphStatus::Cancelled => TeamRunDiagnosticsGraphStatus::Cancelled,
    }
}

fn diagnostics_lifecycle_status(
    state: &GraphRunLifecycleState,
) -> TeamRunDiagnosticsLifecycleStatus {
    match state {
        GraphRunLifecycleState::Active => TeamRunDiagnosticsLifecycleStatus::Active,
        GraphRunLifecycleState::Cancelling { .. } => TeamRunDiagnosticsLifecycleStatus::Cancelling,
        GraphRunLifecycleState::Cancelled { .. } => TeamRunDiagnosticsLifecycleStatus::Cancelled,
        GraphRunLifecycleState::OutcomeUnknown { .. } => {
            TeamRunDiagnosticsLifecycleStatus::OutcomeUnknown
        }
        GraphRunLifecycleState::Tombstoned { .. } => TeamRunDiagnosticsLifecycleStatus::Tombstoned,
    }
}

fn add_delivery_failure(
    summary: &mut TeamRunDiagnosticsDeliveryFailureSummary,
    failure: DeliveryFailure,
) {
    increment(&mut summary.total);
    match failure {
        DeliveryFailure::ReceiverRejected => increment(&mut summary.receiver_rejected),
        DeliveryFailure::PolicyRejected => increment(&mut summary.policy_rejected),
        DeliveryFailure::Unavailable => increment(&mut summary.unavailable),
        DeliveryFailure::TimedOut => increment(&mut summary.timed_out),
    }
}

fn increment(value: &mut u64) {
    *value = value.saturating_add(1).min(MAX_DIAGNOSTICS_COUNT);
}

fn capped_sum(values: &[u64]) -> u64 {
    values.iter().fold(0, |total, value| {
        total.saturating_add(*value).min(MAX_DIAGNOSTICS_COUNT)
    })
}

fn bounded_count<I>(items: I) -> u64
where
    I: IntoIterator,
{
    items
        .into_iter()
        .take(MAX_DIAGNOSTICS_COUNT as usize)
        .count() as u64
}

fn unavailable_sections() -> Vec<TeamRunDiagnosticsUnavailableSection> {
    vec![
        TeamRunDiagnosticsUnavailableSection::StorageRecovery,
        TeamRunDiagnosticsUnavailableSection::StorageRoot,
        TeamRunDiagnosticsUnavailableSection::Budgets,
        TeamRunDiagnosticsUnavailableSection::Limits,
        TeamRunDiagnosticsUnavailableSection::StaleDispatchExecutions,
        TeamRunDiagnosticsUnavailableSection::Roles,
        TeamRunDiagnosticsUnavailableSection::Stages,
        TeamRunDiagnosticsUnavailableSection::WorkflowPlan,
        TeamRunDiagnosticsUnavailableSection::DispatchGroups,
        TeamRunDiagnosticsUnavailableSection::DispatchTasks,
        TeamRunDiagnosticsUnavailableSection::Dispatches,
        TeamRunDiagnosticsUnavailableSection::DispatchExecutions,
        TeamRunDiagnosticsUnavailableSection::Messages,
        TeamRunDiagnosticsUnavailableSection::NodePromptDeliveries,
        TeamRunDiagnosticsUnavailableSection::Gates,
        TeamRunDiagnosticsUnavailableSection::Kickbacks,
        TeamRunDiagnosticsUnavailableSection::NodeInputStates,
        TeamRunDiagnosticsUnavailableSection::Workspace,
        TeamRunDiagnosticsUnavailableSection::Prompts,
        TeamRunDiagnosticsUnavailableSection::NativeSessions,
        TeamRunDiagnosticsUnavailableSection::RuntimeBindings,
        TeamRunDiagnosticsUnavailableSection::Receipts,
        TeamRunDiagnosticsUnavailableSection::Tokens,
        TeamRunDiagnosticsUnavailableSection::Transcripts,
        TeamRunDiagnosticsUnavailableSection::RawPayloads,
    ]
}
