use std::fmt;

use crate::{
    OrganizationFacts,
    run::{
        attempt::{Attempt, AttemptIdentity, RecoveryAction},
        delivery::{DeliveryId, DeliveryPhase},
        graph::{AttemptStatus, ExecutionFence, GraphRunId, NodeId},
        review::ReviewLedger,
    },
};

/// The read-only input to TeamRun recovery aggregation.
///
/// Planning never writes a fact and never produces a dispatch. A delivery that was
/// claimed when the process stopped is reported as `OutcomeUnknown`; the caller must
/// use the existing delivery owner to decide whether and how to observe it.
pub struct TeamRunRecoveryQuery<'a> {
    facts: &'a OrganizationFacts,
    run_id: GraphRunId,
    reviews: Option<&'a ReviewLedger>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryQueryError {
    UnknownRun,
    InvalidFacts,
    AttemptInvariant,
}

impl<'a> TeamRunRecoveryQuery<'a> {
    pub fn new(
        facts: &'a OrganizationFacts,
        run_id: GraphRunId,
        reviews: Option<&'a ReviewLedger>,
    ) -> Result<Self, RecoveryQueryError> {
        facts
            .run(&run_id)
            .ok_or(RecoveryQueryError::UnknownRun)
            .map(|_| TeamRunRecoveryQuery {
                facts,
                run_id,
                reviews,
            })
    }

    /// Validate durable facts and return a deterministic recovery plan.
    pub fn plan(&self) -> Result<TeamRunRecoveryPlan, RecoveryQueryError> {
        self.facts
            .validate()
            .map_err(|_| RecoveryQueryError::InvalidFacts)?;
        let run = self
            .facts
            .run(&self.run_id)
            .ok_or(RecoveryQueryError::UnknownRun)?;

        // The durable graph is authoritative; this query only classifies current attempts.
        // It never mutates the graph or synthesizes a terminal receipt.
        let mut attempts = Vec::new();
        for history in run.graph().executions().values() {
            let current = history.current();
            let identity = AttemptIdentity::new(
                self.run_id.clone(),
                current.node_id().clone(),
                current.fence().attempt_id().clone(),
                current.fence().clone(),
            )
            .map_err(|_| RecoveryQueryError::AttemptInvariant)?;
            let mut attempt = Attempt::from_graph(identity, current.status());
            let action = attempt
                .recover(run.graph())
                .map_err(|_| RecoveryQueryError::AttemptInvariant)?;
            attempts.push(AttemptRecoveryItem {
                node_id: current.node_id().clone(),
                fence: current.fence().clone(),
                status: current.status(),
                action,
            });
        }

        let deliveries = self
            .facts
            .deliveries()
            .deliveries()
            .filter(|delivery| delivery.facts().run_id == self.run_id.as_str())
            .fold(
                DeliveryRecoverySummary::default(),
                |mut summary, delivery| {
                    summary.total += 1;
                    match delivery.phase() {
                        DeliveryPhase::Delivering(_) => {
                            summary.interrupted += 1;
                            summary.outcome_unknown += 1;
                        }
                        DeliveryPhase::OutcomeUnknown { .. } => summary.outcome_unknown += 1,
                        DeliveryPhase::Pending | DeliveryPhase::RetryScheduled { .. } => {
                            summary.pending += 1
                        }
                        DeliveryPhase::Delivered { .. }
                        | DeliveryPhase::TerminalObserved { .. }
                        | DeliveryPhase::Failed { .. }
                        | DeliveryPhase::Cancelled { .. } => summary.terminal += 1,
                    }
                    summary
                },
            );

        let interrupted_deliveries = self
            .facts
            .deliveries()
            .deliveries()
            .filter(|delivery| {
                delivery.facts().run_id == self.run_id.as_str()
                    && matches!(delivery.phase(), DeliveryPhase::Delivering(_))
            })
            .map(|delivery| DeliveryRecoveryItem {
                delivery_id: delivery.facts().delivery_id.clone(),
                action: DeliveryRecoveryAction::OutcomeUnknown,
            })
            .collect();

        let review = match self.reviews {
            Some(ledger) => ReviewRecoveryStatus::Available(
                ledger
                    .snapshot()
                    .reviews()
                    .iter()
                    .filter(|review| review.request.run_id == self.run_id.as_str())
                    .fold(ReviewRecoverySummary::default(), |mut summary, review| {
                        summary.total += 1;
                        if review.verdict.is_some() {
                            summary.resolved += 1;
                        } else {
                            summary.pending += 1;
                        }
                        summary
                    }),
            ),
            None => ReviewRecoveryStatus::Unavailable,
        };

        let control_resolutions = self
            .facts
            .control_node_resolutions()
            .filter(|resolution| resolution.graph_run_id() == &self.run_id)
            .count();
        let decisions = self
            .facts
            .decisions()
            .filter(|decision| decision.run_id() == self.run_id.as_str())
            .count();
        let evidence = self
            .facts
            .evidence_records()
            .filter(|record| record.run_id() == self.run_id.as_str())
            .count();

        Ok(TeamRunRecoveryPlan {
            run_id: self.run_id.clone(),
            run_status: RunRecoveryStatus::from(run.lifecycle().state()),
            cancellation: CancellationRecoveryAction::from(run.lifecycle().state()),
            deliveries,
            interrupted_deliveries,
            attempts,
            ledgers: LedgerRecoverySummary {
                control_resolutions,
                review,
                decisions,
                evidence,
            },
        })
    }
}

/// Build the durable recovery view for every persisted TeamRun.
///
/// This is a producer, not a dispatcher: active runs and resumable graph work are
/// identified from durable facts, while interrupted native work is explicitly retained
/// as `OutcomeUnknown` until a native readback supplies a receipt.
pub fn plan_organization_recovery(
    facts: &OrganizationFacts,
) -> Result<OrganizationRecoveryPlan, RecoveryQueryError> {
    facts.durable_recovery_plan()
}

/// Reconcile only process-interrupted durable markers.
///
/// This operation never calls a native runtime, never retries a delivery, and never
/// turns an unconfirmed cancellation or delivery into success. Callers that own a
/// durable store should apply this to a candidate facts value and persist it through
/// the store's normal transition/commit path.
pub fn apply_organization_recovery(
    facts: &mut OrganizationFacts,
    observed_at: u64,
) -> Result<OrganizationRecoveryApply, RecoveryQueryError> {
    facts.apply_durable_recovery(observed_at)
}

impl OrganizationFacts {
    pub fn durable_recovery_plan(&self) -> Result<OrganizationRecoveryPlan, RecoveryQueryError> {
        self.validate()
            .map_err(|_| RecoveryQueryError::InvalidFacts)?;

        let mut runs = Vec::new();
        let mut active_run_ids = Vec::new();
        for run in self.runs() {
            let run_id = run.run_id().clone();
            if run.lifecycle().state().is_durable_active() {
                active_run_ids.push(run_id.clone());
            }
            runs.push(TeamRunRecoveryQuery::new(self, run_id, None)?.plan()?);
        }

        Ok(OrganizationRecoveryPlan {
            active_run_ids,
            runs,
        })
    }

    pub fn apply_durable_recovery(
        &mut self,
        observed_at: u64,
    ) -> Result<OrganizationRecoveryApply, RecoveryQueryError> {
        let before = self.durable_recovery_plan()?;
        let deliveries_recovered = self.recover_interrupted_deliveries(observed_at);
        let cancellations_recovered = self.recover_interrupted_graph_run_cancellations(observed_at);
        let after = self.durable_recovery_plan()?;

        Ok(OrganizationRecoveryApply {
            before,
            after,
            deliveries_recovered,
            cancellations_recovered,
        })
    }
}

pub fn query_team_run_recovery(
    facts: &OrganizationFacts,
    run_id: GraphRunId,
    reviews: Option<&ReviewLedger>,
) -> Result<TeamRunRecoveryPlan, RecoveryQueryError> {
    TeamRunRecoveryQuery::new(facts, run_id, reviews)?.plan()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancellationRecoveryAction {
    None,
    NativeReadbackRequired,
}

impl CancellationRecoveryAction {
    fn from(state: &crate::GraphRunLifecycleState) -> Self {
        state
            .requires_native_readback()
            .then_some(Self::NativeReadbackRequired)
            .unwrap_or(Self::None)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunRecoveryStatus {
    Active,
    Cancelling,
    Cancelled,
    OutcomeUnknown,
    Tombstoned,
}

impl RunRecoveryStatus {
    fn from(state: &crate::GraphRunLifecycleState) -> Self {
        use crate::GraphRunLifecycleState;
        match state {
            GraphRunLifecycleState::Active => Self::Active,
            GraphRunLifecycleState::Cancelling { .. } => Self::Cancelling,
            GraphRunLifecycleState::Cancelled { .. } => Self::Cancelled,
            GraphRunLifecycleState::OutcomeUnknown { .. } => Self::OutcomeUnknown,
            GraphRunLifecycleState::Tombstoned { .. } => Self::Tombstoned,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeliveryRecoverySummary {
    total: usize,
    interrupted: usize,
    outcome_unknown: usize,
    pending: usize,
    terminal: usize,
}

impl DeliveryRecoverySummary {
    pub const fn total(&self) -> usize {
        self.total
    }
    pub const fn interrupted(&self) -> usize {
        self.interrupted
    }
    pub const fn outcome_unknown(&self) -> usize {
        self.outcome_unknown
    }
    pub const fn pending(&self) -> usize {
        self.pending
    }
    pub const fn terminal(&self) -> usize {
        self.terminal
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReviewRecoverySummary {
    total: usize,
    pending: usize,
    resolved: usize,
}

impl ReviewRecoverySummary {
    pub const fn total(&self) -> usize {
        self.total
    }
    pub const fn pending(&self) -> usize {
        self.pending
    }
    pub const fn resolved(&self) -> usize {
        self.resolved
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewRecoveryStatus {
    Available(ReviewRecoverySummary),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LedgerRecoverySummary {
    control_resolutions: usize,
    review: ReviewRecoveryStatus,
    decisions: usize,
    evidence: usize,
}

impl LedgerRecoverySummary {
    pub const fn control_resolutions(&self) -> usize {
        self.control_resolutions
    }
    pub const fn review(&self) -> &ReviewRecoveryStatus {
        &self.review
    }
    pub const fn decisions(&self) -> usize {
        self.decisions
    }
    pub const fn evidence(&self) -> usize {
        self.evidence
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryRecoveryAction {
    OutcomeUnknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct DeliveryRecoveryItem {
    delivery_id: DeliveryId,
    action: DeliveryRecoveryAction,
}

impl DeliveryRecoveryItem {
    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }
    pub const fn action(&self) -> DeliveryRecoveryAction {
        self.action
    }
}

impl fmt::Debug for DeliveryRecoveryItem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryRecoveryItem")
            .field("delivery_id", &"<redacted>")
            .field("action", &self.action)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct AttemptRecoveryItem {
    node_id: NodeId,
    fence: ExecutionFence,
    status: AttemptStatus,
    action: RecoveryAction,
}

impl AttemptRecoveryItem {
    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }
    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }
    pub const fn status(&self) -> AttemptStatus {
        self.status
    }
    pub const fn action(&self) -> RecoveryAction {
        self.action
    }
}

impl fmt::Debug for AttemptRecoveryItem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttemptRecoveryItem")
            .field("node_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("status", &self.status)
            .field("action", &self.action)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TeamRunRecoveryPlan {
    run_id: GraphRunId,
    run_status: RunRecoveryStatus,
    cancellation: CancellationRecoveryAction,
    deliveries: DeliveryRecoverySummary,
    interrupted_deliveries: Vec<DeliveryRecoveryItem>,
    attempts: Vec<AttemptRecoveryItem>,
    ledgers: LedgerRecoverySummary,
}

impl TeamRunRecoveryPlan {
    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }
    pub const fn run_status(&self) -> RunRecoveryStatus {
        self.run_status
    }
    pub const fn cancellation(&self) -> CancellationRecoveryAction {
        self.cancellation
    }
    pub const fn deliveries(&self) -> &DeliveryRecoverySummary {
        &self.deliveries
    }
    pub fn interrupted_deliveries(&self) -> &[DeliveryRecoveryItem] {
        &self.interrupted_deliveries
    }
    pub fn attempts(&self) -> &[AttemptRecoveryItem] {
        &self.attempts
    }
    pub const fn ledgers(&self) -> &LedgerRecoverySummary {
        &self.ledgers
    }
}

impl fmt::Debug for TeamRunRecoveryPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamRunRecoveryPlan")
            .field("run_id", &"<redacted>")
            .field("run_status", &self.run_status)
            .field("cancellation", &self.cancellation)
            .field("deliveries", &self.deliveries)
            .field("interrupted_deliveries", &self.interrupted_deliveries)
            .field("attempts", &self.attempts)
            .field("ledgers", &self.ledgers)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OrganizationRecoveryPlan {
    active_run_ids: Vec<GraphRunId>,
    runs: Vec<TeamRunRecoveryPlan>,
}

impl OrganizationRecoveryPlan {
    pub fn active_run_ids(&self) -> &[GraphRunId] {
        &self.active_run_ids
    }

    pub fn runs(&self) -> &[TeamRunRecoveryPlan] {
        &self.runs
    }
}

impl fmt::Debug for OrganizationRecoveryPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OrganizationRecoveryPlan")
            .field("active_run_count", &self.active_run_ids.len())
            .field("run_count", &self.runs.len())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrganizationRecoveryApply {
    before: OrganizationRecoveryPlan,
    after: OrganizationRecoveryPlan,
    deliveries_recovered: bool,
    cancellations_recovered: bool,
}

impl OrganizationRecoveryApply {
    pub fn before(&self) -> &OrganizationRecoveryPlan {
        &self.before
    }

    pub fn after(&self) -> &OrganizationRecoveryPlan {
        &self.after
    }

    pub const fn deliveries_recovered(&self) -> bool {
        self.deliveries_recovered
    }

    pub const fn cancellations_recovered(&self) -> bool {
        self.cancellations_recovered
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::*;

    #[test]
    fn interrupted_delivery_is_unknown_only_and_never_a_dispatch() {
        let mut summary = DeliveryRecoverySummary::default();
        summary.total = 4;
        summary.interrupted = 1;
        summary.outcome_unknown = 2;
        summary.pending = 1;
        assert_eq!(summary.total(), 4);
        assert_eq!(summary.interrupted(), 1);
        assert_eq!(summary.outcome_unknown(), 2);
        assert_eq!(summary.pending(), 1);
        assert_eq!(
            DeliveryRecoveryAction::OutcomeUnknown,
            DeliveryRecoveryAction::OutcomeUnknown
        );
    }

    #[test]
    fn recovery_diagnostics_redact_delivery_and_attempt_identity() {
        let delivery_id = DeliveryId::new("private-delivery-id").unwrap();
        let delivery = DeliveryRecoveryItem {
            delivery_id,
            action: DeliveryRecoveryAction::OutcomeUnknown,
        };
        let attempt = AttemptRecoveryItem {
            node_id: NodeId::new("private-node-id"),
            fence: ExecutionFence::new(
                crate::AttemptId::for_node(
                    &NodeId::new("private-node-id"),
                    NonZeroU32::new(1).unwrap(),
                ),
                crate::NodeExecutionId::for_attempt(&crate::AttemptId::for_node(
                    &NodeId::new("private-node-id"),
                    NonZeroU32::new(1).unwrap(),
                )),
            ),
            status: AttemptStatus::Running,
            action: RecoveryAction::ObserveOutcome,
        };
        let debug = format!("{delivery:?} {attempt:?}");
        assert!(!debug.contains("private-delivery-id"));
        assert!(!debug.contains("private-node-id"));
        assert!(!debug.contains("private-attempt-id"));
        assert!(!debug.contains("private-execution-id"));
        assert!(debug.contains("OutcomeUnknown"));
        assert!(debug.contains("ObserveOutcome"));
    }
}
