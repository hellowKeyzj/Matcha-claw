use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{
    NativeTerminalReceiptTarget, OrganizationFacts, StoreFault,
    codec::{HEADER_LEN, MAX_LOG_BYTES, RecoveredFacts, encode_frame, initialize_log, recover_log},
    facts::{
        ApprovalResolutionInput, PendingWorkflowPlanAdmission, WorkflowPlanAdmissionOutcome,
        WorkflowPlanSubmitOutcome,
    },
};
use crate::{
    ActivityClaim, ActivityClaimOutcome, ActivityDispatchOutcome, ActivityId,
    ActivityRegistrationOutcome, ActivityRequest, ActivitySettlement, ActivitySettlementOutcome,
    AgentNodeEventResolution, AuthorizedGraphResolution, AuthorizedGraphResolutionOutcome,
    ConfirmRunStartOutcome, ContinueRunDiscussionOutcome, ControlExecutionStep,
    ControlNodeResolution, ControlNodeResolutionOutcome, DeliveryClaim, DeliveryId,
    DeliveryReceipt, DeliveryResolution, DeliveryStart, EvidenceRecord, GraphDefinition,
    GraphEvent, GraphPatch, GraphRunFacts, GraphRunId, IdempotencyKey, NativeTerminalStatus,
    RecordOutcome, SetRunStartProposalOutcome, TeamId, TerminalObservationOutcome,
    TriggerFireRequest, TriggerRegistration,
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        artifact::{ArtifactRecord, ArtifactRecordOutcome},
        lifecycle::{
            BeginCancellationOutcome, CreateGraphRunOutcome, ResumeOutcome, RoleAbortOutcome,
            SettleCancellationOutcome, TombstoneOutcome,
        },
    },
};
use crate::{TeamDecisionCommand, TeamDecisionReceipt};

const WRITER_LOCK_TIMEOUT: Duration = Duration::from_millis(500);
const WRITER_LOCK_POLL: Duration = Duration::from_millis(1);

pub struct OrganizationStore {
    path: PathBuf,
    lock_path: PathBuf,
    facts: OrganizationFacts,
    epoch: u64,
    requires_reopen: bool,
}

impl OrganizationStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        let mut recovered = recover_or_initialize(&path)?;
        if recovered.truncated_tail {
            truncate_to_recovered_prefix(&path, recovered.committed_len)?;
        }
        let observed_at = now_seconds()?;
        let recovered_interrupted_materialization =
            recovered.facts.recover_interrupted_materializations();
        let recovered_interrupted_work = recovered.had_interrupted_delivery
            && recovered.facts.recover_interrupted_deliveries(observed_at);
        let recovered_interrupted_activity = recovered.had_interrupted_activity
            && recovered.facts.recover_interrupted_activities(observed_at);
        let recovered_interrupted_cancellation = recovered
            .facts
            .recover_interrupted_graph_run_cancellations(observed_at);
        let epoch = if recovered_interrupted_materialization
            || recovered_interrupted_work
            || recovered_interrupted_activity
            || recovered_interrupted_cancellation
        {
            commit_recovered_facts(&path, recovered.epoch, &recovered.facts)?
        } else {
            recovered.epoch
        };

        Ok(Self {
            path,
            lock_path,
            facts: recovered.facts,
            epoch,
            requires_reopen: false,
        })
    }

    pub fn open_live(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let recovered = match File::open(&path) {
            Ok(file) => recover_log(file)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Self::open(path),
            Err(error) => return Err(StoreFault::Read(error.kind())),
        };
        Ok(Self {
            path,
            lock_path,
            facts: recovered.facts,
            epoch: recovered.epoch,
            requires_reopen: false,
        })
    }

    pub fn facts(&self) -> &OrganizationFacts {
        &self.facts
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn reopen(&mut self) -> Result<(), StoreFault> {
        let reopened = Self::open(self.path.clone())?;
        *self = reopened;
        Ok(())
    }

    pub fn refresh(&mut self) -> Result<(), StoreFault> {
        let recovered =
            recover_log(File::open(&self.path).map_err(|error| StoreFault::Read(error.kind()))?)?;
        self.facts = recovered.facts;
        self.epoch = recovered.epoch;
        self.requires_reopen = false;
        Ok(())
    }

    pub fn task_board(&self) -> &crate::run::TaskBoardFacts {
        self.facts.task_board()
    }

    pub fn task_board_mutate<T>(
        &mut self,
        mutation: impl FnOnce(&mut crate::run::TaskBoardFacts) -> Result<T, crate::run::TaskBoardError>,
    ) -> Result<T, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let result = mutation(candidate.task_board_mut()).map_err(|_| StoreFault::InvalidFacts)?;
        candidate
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.commit_locked(&lock, candidate)?;
        Ok(result)
    }

    pub fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&crate::TeamDecision> {
        self.facts.decision(run_id, idempotency_key)
    }

    pub fn decisions(&self) -> impl Iterator<Item = &crate::TeamDecision> {
        self.facts.decisions()
    }

    pub fn record_decision(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let receipt = candidate
            .record_decision(command)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if !receipt.is_replay() {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(receipt)
    }

    pub fn replace_facts(&mut self, facts: OrganizationFacts) -> Result<(), StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        facts
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.commit_locked(&lock, facts)
    }

    pub fn replace_workflow_template(
        &mut self,
        template: crate::WorkflowTemplateFacts,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .replace_workflow_template(template)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub fn purge_graph_run(
        &mut self,
        request: crate::TeamRunPurgeRequest,
    ) -> Result<crate::GraphRunPurgeOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .purge_graph_run(
                request,
                now_seconds().map_err(|_| StoreFault::Read(io::ErrorKind::Other))?,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, crate::GraphRunPurgeOutcome::Purged) {
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn replace_workflow_plan_template(
        &mut self,
        team: crate::TeamId,
        source_identity: impl Into<String>,
        revision: u64,
        plan: crate::run::WorkflowPlan,
    ) -> Result<(), StoreFault> {
        let template = crate::WorkflowTemplateFacts::new(team, source_identity, revision, plan)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.replace_workflow_template(template)
    }

    pub fn create_graph_run(
        &mut self,
        run: GraphRunFacts,
        creation_idempotency_key: &str,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .create_graph_run(run, creation_idempotency_key)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, CreateGraphRunOutcome::Created(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn admit_workflow_plan_run(
        &mut self,
        admission: PendingWorkflowPlanAdmission,
    ) -> Result<WorkflowPlanAdmissionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .admit_workflow_plan_run(admission)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, WorkflowPlanAdmissionOutcome::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn submit_workflow_plan(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        source_identity: String,
        team_revision: crate::TeamRevision,
        plan: crate::run::WorkflowPlan,
    ) -> Result<WorkflowPlanSubmitOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .submit_workflow_plan(
                team,
                run_id,
                creation_idempotency_key,
                source_identity,
                team_revision,
                plan,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, WorkflowPlanSubmitOutcome::Submitted(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn create_workflow_plan_run(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        plan: crate::run::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .create_workflow_plan_run(
                team,
                run_id,
                creation_idempotency_key,
                plan,
                source_identity,
                template_revision,
                created_at,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, CreateGraphRunOutcome::Created(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn set_run_start_proposal(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: String,
        summary: String,
        source_delivery_id: String,
    ) -> Result<SetRunStartProposalOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .set_run_start_proposal(run_id, proposal_id, summary, source_delivery_id)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, SetRunStartProposalOutcome::Recorded) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn confirm_run_start(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: &str,
    ) -> Result<ConfirmRunStartOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .confirm_run_start(run_id, proposal_id)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, ConfirmRunStartOutcome::Started) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn continue_run_discussion(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: &str,
    ) -> Result<ContinueRunDiscussionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .continue_run_discussion(run_id, proposal_id)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, ContinueRunDiscussionOutcome::Intake) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn begin_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        requested_at: u64,
    ) -> Result<BeginCancellationOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .begin_graph_run_cancellation(run_id, idempotency_key, requested_at)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, BeginCancellationOutcome::Started(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn settle_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let settled = candidate
            .settle_graph_run_cancellation(run_id, idempotency_key, outcome, observed_at)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(
            settled,
            SettleCancellationOutcome::Cancelled | SettleCancellationOutcome::OutcomeUnknown
        ) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(settled)
    }

    pub fn tombstone_graph_run(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> Result<TombstoneOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .tombstone_graph_run(run_id, idempotency_key, tombstoned_at)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, TombstoneOutcome::Tombstoned) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn resume_graph_runs(&self, team_id: &crate::TeamId) -> Vec<ResumeOutcome> {
        self.facts.resume_graph_runs(team_id)
    }

    pub fn register_delivery(
        &mut self,
        request: crate::DeliveryRequest,
    ) -> Result<crate::RegisterOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .register_delivery(request)
            .map_err(StoreFault::DeliveryRequest)?;
        if matches!(&outcome, crate::RegisterOutcome::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn register_activity_and_start_attempt(
        &mut self,
        request: ActivityRequest,
        started_at: u64,
    ) -> Result<ActivityRegistrationOutcome, StoreFault> {
        self.transact(|facts| {
            let run_id = request.run_id.clone();
            let node_id = request.node_id.clone();
            let fence = request.fence.clone();
            let outcome = facts
                .register_activity(request)
                .map_err(|_| StoreFault::InvalidFacts)?;
            if matches!(&outcome, ActivityRegistrationOutcome::Recorded(_)) {
                let run = facts
                    .run(&run_id)
                    .cloned()
                    .ok_or(StoreFault::InvalidFacts)?;
                let graph = crate::reduce(
                    run.graph().clone(),
                    GraphEvent::AttemptStarted {
                        node_id,
                        fence,
                        started_at,
                    },
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
                facts
                    .replace_run_graph(&run_id, graph)
                    .map_err(|_| StoreFault::InvalidFacts)?;
            }
            Ok(outcome)
        })
    }

    pub fn register_activity(
        &mut self,
        request: ActivityRequest,
    ) -> Result<ActivityRegistrationOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .register_activity(request)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(&outcome, ActivityRegistrationOutcome::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn resolve_human_decision(
        &mut self,
        command: HumanDecisionCommand,
    ) -> Result<HumanDecisionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .resolve_human_decision(command)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if outcome == HumanDecisionOutcome::Recorded {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn record_artifact(
        &mut self,
        record: ArtifactRecord,
    ) -> Result<ArtifactRecordOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .record_artifact(record)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, ArtifactRecordOutcome::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn record_evidence(&mut self, record: EvidenceRecord) -> Result<RecordOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .record_evidence(record)
            .map_err(StoreFault::Evidence)?;
        if matches!(outcome, RecordOutcome::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    /// Tombstone is the Organization lifecycle boundary: facts remain durable and
    /// provider cleanup is not implied by this local transition.
    pub fn tombstone_team(
        &mut self,
        team_id: &TeamId,
        cleanup_idempotency_key: IdempotencyKey,
    ) -> Result<super::facts::TeamTombstoneOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .tombstone_team(team_id, cleanup_idempotency_key)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, super::facts::TeamTombstoneOutcome::Tombstoned) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    /// Returns only materializations which may be settled by native readback.
    /// These requests must never be replayed as mutations after process recovery.
    pub fn materialization_receipt_recovery_teams(&self) -> Vec<TeamId> {
        self.facts
            .materialization_lifecycles()
            .filter_map(|lifecycle| {
                lifecycle
                    .receipt_recovery_request()
                    .map(|request| request.intent().team().clone())
            })
            .collect()
    }

    pub fn team_materialization_recovery_request(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRequest> {
        self.facts.materialization_recovery_request(team_id)
    }

    pub fn team_materialization_removal(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRemoval> {
        self.facts.team_materialization_removal(team_id)
    }

    pub fn team_materialization_cleanup_confirmed(&self, team_id: &TeamId) -> bool {
        self.facts.team_materialization_cleanup_confirmed(team_id)
    }

    pub fn record_team_materialization_cleanup_outcome(
        &mut self,
        team_id: &TeamId,
        outcome: crate::MaterializationOperationOutcome,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let recorded = candidate
            .record_team_materialization_cleanup_outcome(team_id, outcome)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if recorded == crate::MaterializationRecordOutcome::Recorded {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(recorded)
    }

    pub fn create_team_materialization(
        &mut self,
        materialization: crate::TeamMaterialization,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .create_team_materialization(
                    materialization.definition(),
                    materialization.request().clone(),
                )
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub fn record_team_materialization_outcome(
        &mut self,
        team_id: &crate::TeamId,
        outcome: crate::MaterializationOperationOutcome,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .record_materialization_outcome(team_id, outcome)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    /// Persists provider facts only after an explicitly requested native readback.
    pub fn confirm_team_materialization(
        &mut self,
        receipt: crate::MaterializationReceipt,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .confirm_materialization(receipt)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub fn install_runtime_receipt(
        &mut self,
        receipt: crate::RunRuntimeReceipt,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .install_runtime_receipt(receipt)
                .map_err(StoreFault::RuntimeReceipt)
        })
    }

    pub fn claim_agent_activity(
        &mut self,
        activity_id: &ActivityId,
        delivery: crate::DeliveryRequest,
        claimed_at: u64,
    ) -> Result<ActivityClaim, StoreFault> {
        if delivery.delivery_id.as_str() != activity_id.as_str() {
            return Err(StoreFault::InvalidFacts);
        }
        self.transact(|facts| {
            match facts
                .register_delivery(delivery)
                .map_err(StoreFault::DeliveryRequest)?
            {
                crate::RegisterOutcome::Recorded(_) | crate::RegisterOutcome::Replayed(_) => {}
                crate::RegisterOutcome::ConflictingIdempotencyKey
                | crate::RegisterOutcome::ConflictingDeliveryId { .. } => {
                    return Err(StoreFault::InvalidFacts);
                }
            }
            let claim = match facts
                .claim_activity(activity_id, claimed_at)
                .map_err(|_| StoreFault::InvalidFacts)?
            {
                ActivityClaimOutcome::Claimed(claim) => claim,
                ActivityClaimOutcome::AlreadyClaimed(_) | ActivityClaimOutcome::Terminal(_) => {
                    return Err(StoreFault::InvalidFacts);
                }
            };
            match facts
                .dispatch_activity(&claim, claimed_at)
                .map_err(|_| StoreFault::InvalidFacts)?
            {
                ActivityDispatchOutcome::Recorded => {}
                ActivityDispatchOutcome::Replayed => return Err(StoreFault::InvalidFacts),
            }
            let delivery_id = DeliveryId::new(activity_id.as_str().to_owned())
                .map_err(|_| StoreFault::InvalidFacts)?;
            match facts
                .claim_delivery(&delivery_id, claimed_at)
                .map_err(|error| StoreFault::DeliveryReceipt(Box::new(error)))?
            {
                DeliveryStart::Claimed(_) => Ok(claim),
                DeliveryStart::AlreadyClaimed(_)
                | DeliveryStart::AwaitingRetry { .. }
                | DeliveryStart::Terminal(_) => Err(StoreFault::InvalidFacts),
            }
        })
    }

    pub fn settle_agent_activity_dispatch(
        &mut self,
        claim: &ActivityClaim,
        receipt: DeliveryReceipt,
        activity_settlement: Option<ActivitySettlement>,
    ) -> Result<(DeliveryResolution, Option<ActivitySettlementOutcome>), StoreFault> {
        self.transact(|facts| {
            let delivery_id = DeliveryId::new(claim.activity_id().as_str().to_owned())
                .map_err(|_| StoreFault::InvalidFacts)?;
            let delivery_claim = facts
                .deliveries()
                .delivery(&delivery_id)
                .and_then(|delivery| delivery.active_claim().cloned())
                .ok_or(StoreFault::InvalidFacts)?;
            let delivery = facts
                .settle_delivery(&delivery_claim, receipt, 0)
                .map_err(|error| StoreFault::DeliveryReceipt(Box::new(error)))?;
            let activity = activity_settlement
                .map(|settlement| {
                    facts
                        .settle_activity(claim, settlement)
                        .map_err(|_| StoreFault::InvalidFacts)
                })
                .transpose()?;
            Ok((delivery, activity))
        })
    }

    pub fn claim_activity(
        &mut self,
        activity_id: &ActivityId,
        claimed_at: u64,
    ) -> Result<ActivityClaimOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .claim_activity(activity_id, claimed_at)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(&outcome, ActivityClaimOutcome::Claimed(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn dispatch_activity(
        &mut self,
        claim: &ActivityClaim,
        dispatched_at: u64,
    ) -> Result<ActivityDispatchOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .dispatch_activity(claim, dispatched_at)
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(&outcome, ActivityDispatchOutcome::Recorded) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn settle_activity(
        &mut self,
        claim: &ActivityClaim,
        settlement: ActivitySettlement,
    ) -> Result<ActivitySettlementOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .settle_activity(claim, settlement)
                .map_err(StoreFault::ActivityTransition)
        })
    }

    pub fn claim_delivery(
        &mut self,
        delivery_id: &DeliveryId,
        claimed_at: u64,
    ) -> Result<DeliveryStart, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let start = candidate
            .claim_delivery(delivery_id, claimed_at)
            .map_err(|error| StoreFault::DeliveryReceipt(Box::new(error)))?;
        if matches!(&start, DeliveryStart::Claimed(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(start)
    }

    pub fn settle_delivery(
        &mut self,
        claim: &DeliveryClaim,
        receipt: DeliveryReceipt,
        retry_at: u64,
    ) -> Result<DeliveryResolution, StoreFault> {
        self.transact(|facts| {
            facts
                .settle_delivery(claim, receipt, retry_at)
                .map_err(|error| StoreFault::DeliveryReceipt(Box::new(error)))
        })
    }

    pub fn fire_trigger(
        &mut self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<TriggerRegistration, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let registration = candidate
            .fire_trigger(request, fired_at)
            .map_err(StoreFault::TriggerFire)?;
        if matches!(&registration, TriggerRegistration::Recorded(_)) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(registration)
    }

    pub fn native_terminal_target(
        &self,
        delivery_id: &DeliveryId,
    ) -> Option<NativeTerminalReceiptTarget> {
        self.facts.native_terminal_target(delivery_id)
    }

    pub fn observe_native_terminal(
        &mut self,
        target: NativeTerminalReceiptTarget,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
    ) -> Result<TerminalObservationOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let Some(current) = self.facts.native_terminal_target(target.delivery_id()) else {
            return Err(StoreFault::TerminalObservation(
                crate::TerminalObservationError::DeliveryNotAccepted,
            ));
        };
        if current != target {
            return Err(StoreFault::TerminalObservation(
                crate::TerminalObservationError::StaleFence,
            ));
        }
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .observe_native_terminal(target.delivery_id(), native_terminal, observed_at)
            .map_err(StoreFault::TerminalObservation)?;
        if !matches!(outcome, TerminalObservationOutcome::Replayed) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn resolve_native_run_output(
        &mut self,
        target: NativeTerminalReceiptTarget,
        receipt: crate::AuthorizedGraphResolutionReceipt,
        final_assistant_text: String,
        resolved_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let Some(current) = self.facts.native_terminal_target(target.delivery_id()) else {
            return Err(StoreFault::NativeRunOutputResolution(
                crate::NativeRunOutputResolutionError::AuthorizedResolution(
                    crate::AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution,
                ),
            ));
        };
        if current != target {
            return Err(StoreFault::NativeRunOutputResolution(
                crate::NativeRunOutputResolutionError::AuthorizedResolution(
                    crate::AuthorizedGraphResolutionError::StaleFence,
                ),
            ));
        }
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .resolve_native_run_output(
                target.delivery_id(),
                receipt,
                final_assistant_text,
                resolved_at,
            )
            .map_err(StoreFault::NativeRunOutputResolution)?;
        if matches!(outcome, AuthorizedGraphResolutionOutcome::Recorded) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn apply_graph_patch(
        &mut self,
        run_id: &GraphRunId,
        patch: GraphPatch,
        applied_at: u64,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .apply_graph_patch(run_id, &patch, applied_at)
                .map_err(StoreFault::GraphPatch)
        })
    }

    pub fn replace_team_graph(
        &mut self,
        command: crate::RunCommand,
        definition: GraphDefinition,
    ) -> Result<crate::CommandReceipt, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let receipt = candidate
            .replace_team_graph(command, definition)
            .map_err(StoreFault::EventLedger)?;
        if !receipt.is_replay() {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(receipt)
    }

    pub fn team_graph_patch(
        &mut self,
        command: crate::RunCommand,
        patch: GraphPatch,
    ) -> Result<crate::CommandReceipt, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let receipt = candidate
            .team_graph_patch(command, &patch)
            .map_err(StoreFault::EventLedger)?;
        if !receipt.is_replay() {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(receipt)
    }

    pub fn team_node_event(
        &mut self,
        command: crate::RunCommand,
        event: crate::TeamNodeEvent,
    ) -> Result<crate::TeamNodeEventOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        if matches!(
            event.kind(),
            crate::TeamNodeEventKind::Complete | crate::TeamNodeEventKind::Reject
        ) {
            return Ok(crate::TeamNodeEventOutcome::TerminalReceiptRequired);
        }
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .team_node_event(command, event)
            .map_err(StoreFault::EventLedger)?;
        candidate
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.commit_locked(&lock, candidate)?;
        Ok(outcome)
    }

    pub fn apply_agent_node_event_resolution(
        &mut self,
        resolution: AgentNodeEventResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .apply_agent_node_event_resolution(resolution)
            .map_err(StoreFault::AgentNodeEventResolution)?;
        if matches!(outcome, AuthorizedGraphResolutionOutcome::Recorded) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn apply_authorized_graph_resolution(
        &mut self,
        resolution: AuthorizedGraphResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .apply_authorized_graph_resolution(resolution)
                .map_err(StoreFault::AuthorizedGraphResolution)
        })
    }

    pub fn resolve_approval(
        &mut self,
        input: ApprovalResolutionInput,
    ) -> Result<super::facts::ApprovalResolutionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let ApprovalResolutionInput {
            run_id,
            approval_id,
            stage_id,
            role_id,
            decision,
            resolved_at,
            note,
            idempotency_key,
        } = input;
        let outcome = candidate
            .resolve_approval(ApprovalResolutionInput {
                run_id: run_id.clone(),
                approval_id: approval_id.to_owned(),
                stage_id: stage_id.to_owned(),
                role_id: role_id.to_owned(),
                decision,
                resolved_at,
                note,
                idempotency_key: idempotency_key.to_owned(),
            })
            .map_err(|_| StoreFault::InvalidFacts)?;
        if matches!(outcome, super::facts::ApprovalResolutionOutcome::Recorded) {
            candidate
                .validate_transition_from(&self.facts)
                .map_err(|_| StoreFault::InvalidFacts)?;
            self.commit_locked(&lock, candidate)?;
        }
        Ok(outcome)
    }

    pub fn apply_graph_event(
        &mut self,
        run_id: &GraphRunId,
        event: GraphEvent,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.run(run_id).cloned().ok_or(StoreFault::InvalidFacts)?;
            let graph =
                crate::reduce(run.graph().clone(), event).map_err(|_| StoreFault::InvalidFacts)?;
            facts
                .replace_run_graph(run_id, graph)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub fn apply_control_execution_step(
        &mut self,
        run_id: &GraphRunId,
        step: ControlExecutionStep,
    ) -> Result<(), StoreFault> {
        match step {
            ControlExecutionStep::GraphEvent(event) => self.apply_graph_event(run_id, event),
            ControlExecutionStep::ControlResolution(resolution) => {
                self.apply_control_node_resolution(resolution).map(|_| ())
            }
        }
    }

    pub fn apply_control_node_resolution(
        &mut self,
        resolution: ControlNodeResolution,
    ) -> Result<ControlNodeResolutionOutcome, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        if self
            .facts
            .control_node_resolution(resolution.idempotency_key())
            .is_some()
        {
            return self
                .facts
                .apply_control_node_resolution(resolution)
                .map_err(StoreFault::ControlNodeResolution);
        }
        let mut candidate = self.facts.clone();
        let outcome = candidate
            .apply_control_node_resolution(resolution)
            .map_err(StoreFault::ControlNodeResolution)?;
        candidate
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.commit_locked(&lock, candidate)?;
        Ok(outcome)
    }

    fn transact<T>(
        &mut self,
        mutation: impl FnOnce(&mut OrganizationFacts) -> Result<T, StoreFault>,
    ) -> Result<T, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let result = mutation(&mut candidate)?;
        candidate
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.commit_locked(&lock, candidate)?;
        Ok(result)
    }

    fn ensure_writable(&self) -> Result<(), StoreFault> {
        if self.requires_reopen {
            return Err(StoreFault::RecoveryRequired);
        }
        Ok(())
    }

    fn refresh_locked(&mut self) -> Result<(), StoreFault> {
        let recovered =
            recover_log(File::open(&self.path).map_err(|error| StoreFault::Read(error.kind()))?)?;
        if recovered.truncated_tail {
            truncate_to_recovered_prefix(&self.path, recovered.committed_len)?;
        }
        if (recovered.had_interrupted_delivery || recovered.had_interrupted_activity)
            && recovered.facts != self.facts
        {
            return Err(StoreFault::RecoveryRequired);
        }
        self.facts = recovered.facts;
        self.epoch = recovered.epoch;
        Ok(())
    }

    fn commit_locked(
        &mut self,
        lock: &WriterLock,
        facts: OrganizationFacts,
    ) -> Result<(), StoreFault> {
        let next_epoch = self.epoch.checked_add(1).ok_or(StoreFault::EpochOverflow)?;
        let frame = encode_frame(next_epoch, &facts)?;
        let log_len = lock.log_len(&self.path)?;
        let projected_len = log_len
            .checked_add(u64::try_from(frame.len()).map_err(|_| StoreFault::LogFull)?)
            .ok_or(StoreFault::LogFull)?;
        if projected_len > MAX_LOG_BYTES {
            return Err(StoreFault::LogFull);
        }

        let mut log = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(|error| StoreFault::Commit(error.kind()))?;
        if let Err(error) = log.write_all(&frame) {
            return Err(StoreFault::Commit(error.kind()));
        }
        if let Err(error) = log.sync_data() {
            self.requires_reopen = true;
            return Err(StoreFault::CommitOutcomeUnknown(error.kind()));
        }
        self.facts = facts;
        self.epoch = next_epoch;
        Ok(())
    }
}

fn now_seconds() -> Result<u64, StoreFault> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| StoreFault::InvalidFacts)
}

fn ensure_parent_directory(path: &Path) -> Result<(), StoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| StoreFault::Commit(error.kind()))?;
    }
    Ok(())
}

fn recover_or_initialize(path: &Path) -> Result<RecoveredFacts, StoreFault> {
    match File::open(path) {
        Ok(file) => recover_log(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => initialize_log_file(path),
        Err(error) => Err(StoreFault::Read(error.kind())),
    }
}

fn initialize_log_file(path: &Path) -> Result<RecoveredFacts, StoreFault> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            initialize_log(&mut file)?;
            file.sync_all()
                .map_err(|error| StoreFault::CommitOutcomeUnknown(error.kind()))?;
            Ok(RecoveredFacts {
                facts: OrganizationFacts::default(),
                epoch: 0,
                committed_len: HEADER_LEN as u64,
                truncated_tail: false,
                had_interrupted_delivery: false,
                had_interrupted_activity: false,
            })
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = File::open(path).map_err(|error| StoreFault::Read(error.kind()))?;
            recover_log(file)
        }
        Err(error) => Err(StoreFault::Commit(error.kind())),
    }
}

fn commit_recovered_facts(
    path: &Path,
    epoch: u64,
    facts: &OrganizationFacts,
) -> Result<u64, StoreFault> {
    let next_epoch = epoch.checked_add(1).ok_or(StoreFault::EpochOverflow)?;
    let frame = encode_frame(next_epoch, facts)?;
    let log_len = fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    let projected_len = log_len
        .checked_add(u64::try_from(frame.len()).map_err(|_| StoreFault::LogFull)?)
        .ok_or(StoreFault::LogFull)?;
    if projected_len > MAX_LOG_BYTES {
        return Err(StoreFault::LogFull);
    }
    let mut log = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    log.write_all(&frame)
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    log.sync_data()
        .map_err(|error| StoreFault::CommitOutcomeUnknown(error.kind()))?;
    Ok(next_epoch)
}

fn truncate_to_recovered_prefix(path: &Path, committed_len: u64) -> Result<(), StoreFault> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| {
            file.set_len(committed_len)?;
            file.sync_all()
        })
        .map_err(|error| StoreFault::Recovery(error.kind()))
}

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, StoreFault> {
        let started = SystemTime::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => {
                    drop(file);
                    return Ok(Self {
                        path: path.to_owned(),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let elapsed = started.elapsed().unwrap_or_default();
                    if elapsed >= WRITER_LOCK_TIMEOUT {
                        return Err(StoreFault::WriterBusy);
                    }
                    std::thread::sleep(WRITER_LOCK_POLL.min(WRITER_LOCK_TIMEOUT - elapsed));
                }
                Err(error) => return Err(StoreFault::Lock(error.kind())),
            }
        }
    }

    fn log_len(&self, path: &Path) -> Result<u64, StoreFault> {
        fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| StoreFault::Commit(error.kind()))
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
