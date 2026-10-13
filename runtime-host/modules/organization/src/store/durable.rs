use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;

use super::{
    NativeTerminalReceiptTarget, OrganizationFacts, StoreFault,
    content::ContentStore,
    facts::{
        ApprovalResolutionInput, PendingWorkflowPlanAdmission, WorkflowPlanAdmissionOutcome,
        WorkflowPlanSubmitOutcome,
    },
    records,
    schema::RecordChange,
    sqlite::Database,
};
use crate::{
    ActivityClaim, ActivityClaimOutcome, ActivityDispatchOutcome, ActivityId,
    ActivityRegistrationOutcome, ActivityRequest, ActivitySettlement, ActivitySettlementOutcome,
    AgentNodeEventResolution, AuthorizedGraphResolution, AuthorizedGraphResolutionOutcome,
    ControlExecutionStep, ControlNodeResolution, ControlNodeResolutionOutcome, DeliveryClaim,
    DeliveryId, DeliveryReceipt, DeliveryResolution, DeliveryStart, EvidenceRecord,
    GraphDefinition, GraphEvent, GraphPatch, GraphRunFacts, GraphRunId, IdempotencyKey,
    NativeTerminalStatus, RecordOutcome, TeamId, TerminalObservationOutcome, TriggerFireRequest,
    TriggerRegistration,
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

pub struct OrganizationStore {
    path: PathBuf,
    database: Database,
    contents: ContentStore,
    facts: OrganizationFacts,
    epoch: u64,
    requires_reopen: bool,
}

impl OrganizationStore {
    pub(crate) fn open(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        let mut store = Self::open_live(path)?;
        let observed_at = now_millis()?;
        store.transact(|facts| {
            facts.recover_interrupted_materializations();
            facts.recover_interrupted_deliveries(observed_at);
            facts.recover_interrupted_activities(observed_at);
            facts.recover_interrupted_graph_run_cancellations(observed_at);
            Ok(())
        })?;
        Ok(store)
    }

    pub(crate) fn open_live(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let fresh = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                true
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(StoreFault::Commit(error.kind())),
        };
        let mut database = Database::open(&path)?;
        if fresh {
            let mut transaction = database.begin()?;
            transaction.mark_initialized()?;
            transaction.commit()?;
        } else if !database.initialized()? {
            return Err(StoreFault::MigrationRequired);
        }
        let contents =
            ContentStore::new(path.parent().unwrap_or_else(|| Path::new(".")).to_owned());
        let (epoch, records) = database.read_all()?;
        let facts = records::decode_all(&records, &contents)?;
        Ok(Self {
            path,
            database,
            contents,
            facts,
            epoch,
            requires_reopen: false,
        })
    }

    pub(crate) fn facts(&self) -> &OrganizationFacts {
        &self.facts
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn reopen(&mut self) -> Result<(), StoreFault> {
        let reopened = Self::open(self.path.clone())?;
        *self = reopened;
        Ok(())
    }

    pub(crate) fn refresh(&mut self) -> Result<(), StoreFault> {
        if self.requires_reopen {
            *self = Self::open_live(self.path.clone())?;
            return Ok(());
        }
        let (epoch, changes) = self.database.read_since(self.epoch)?;
        if let Err(error) = self.facts.apply_record_changes(changes, &self.contents) {
            self.requires_reopen = true;
            return Err(error);
        }
        self.epoch = epoch;
        Ok(())
    }

    pub(crate) fn task_board(&self) -> &crate::run::TaskBoardFacts {
        self.facts.task_board()
    }

    pub(crate) fn task_board_mutate<T>(
        &mut self,
        mutation: impl FnOnce(&mut crate::run::TaskBoardFacts) -> Result<T, crate::run::TaskBoardError>,
    ) -> Result<T, StoreFault> {
        self.transact(|facts| {
            let result = mutation(facts.task_board_mut()).map_err(|_| StoreFault::InvalidFacts)?;

            Ok(result)
        })
    }

    pub(crate) fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&crate::TeamDecision> {
        self.facts.decision(run_id, idempotency_key)
    }

    pub(crate) fn decisions(&self) -> impl Iterator<Item = &crate::TeamDecision> {
        self.facts.decisions()
    }

    pub(crate) fn record_decision(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, StoreFault> {
        self.transact(|facts| {
            if facts
                .decision_ledger()
                .event(command.decision_id())
                .is_some_and(|event| event.run_id() != command.run_id())
            {
                return Err(StoreFault::InvalidFacts);
            }
            let receipt = facts
                .record_decision(command)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(receipt)
        })
    }

    /// Explicit whole-state replacement; normal owner mutations use record transactions.
    pub(crate) fn replace_facts(&mut self, facts: OrganizationFacts) -> Result<(), StoreFault> {
        self.ensure_writable()?;
        let mut transaction = self.database.begin()?;
        let (epoch, changes) = transaction.read_since(self.epoch)?;
        if let Err(error) = self.facts.apply_record_changes(changes, &self.contents) {
            self.requires_reopen = true;
            return Err(error);
        }
        self.epoch = epoch;
        facts
            .validate_transition_from(&self.facts)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let records = records::encode_all(&facts, &self.contents)?;
        let keys = records
            .iter()
            .map(|record| &record.key)
            .collect::<std::collections::BTreeSet<_>>();
        for previous in transaction.read_all()? {
            if !keys.contains(&previous.key) {
                transaction.delete(&previous.key)?;
            }
        }
        for record in &records {
            transaction.put(record)?;
        }
        match transaction.commit() {
            Ok(epoch) => {
                self.facts = facts;
                self.epoch = epoch;
                Ok(())
            }
            Err(error) => {
                self.requires_reopen = matches!(error, StoreFault::CommitOutcomeUnknown(_));
                Err(error)
            }
        }
    }

    pub(crate) fn replace_workflow_template(
        &mut self,
        template: crate::WorkflowTemplateFacts,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .replace_workflow_template(template)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub(crate) fn purge_graph_run(
        &mut self,
        request: crate::TeamRunPurgeRequest,
    ) -> Result<crate::GraphRunPurgeOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .purge_graph_run(
                    request,
                    now_millis().map_err(|_| StoreFault::Read(io::ErrorKind::Other))?,
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn replace_workflow_plan_template(
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

    pub(crate) fn create_graph_run(
        &mut self,
        run: GraphRunFacts,
        creation_idempotency_key: &str,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .create_graph_run(run, creation_idempotency_key)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn admit_workflow_plan_run(
        &mut self,
        admission: PendingWorkflowPlanAdmission,
    ) -> Result<WorkflowPlanAdmissionOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .admit_workflow_plan_run(admission)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn submit_workflow_plan(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        source_identity: String,
        team_revision: crate::TeamRevision,
        plan: crate::run::WorkflowPlan,
    ) -> Result<WorkflowPlanSubmitOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .submit_workflow_plan(
                    team,
                    run_id,
                    creation_idempotency_key,
                    source_identity,
                    team_revision,
                    plan,
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn create_workflow_plan_run(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        plan: crate::run::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
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
            Ok(outcome)
        })
    }

    pub(crate) fn start_run(
        &mut self,
        team_id: &TeamId,
        run_id: &GraphRunId,
        epoch: Option<&str>,
        version: &str,
    ) -> Result<bool, StoreFault> {
        self.transact(|facts| {
            let run = facts
                .run(run_id)
                .ok_or(StoreFault::Design(super::DesignError::UnknownRun))?;
            if run.team() != team_id {
                return Err(StoreFault::Design(super::DesignError::TeamMismatch));
            }
            // Started is the existing one-way, no-write replay boundary.
            if matches!(run.start_gate(), crate::RunStartGate::Started) {
                return Ok(false);
            }
            if !matches!(
                run.lifecycle().state(),
                crate::GraphRunLifecycleState::Active
            ) {
                return Err(StoreFault::Design(super::DesignError::RunInactive));
            }
            match run.start_gate() {
                crate::RunStartGate::Intake if epoch.is_none() => {}
                crate::RunStartGate::Designing { design_epoch, .. }
                    if epoch == Some(design_epoch.as_str()) => {}
                _ => return Err(StoreFault::Design(super::DesignError::StaleEpoch)),
            }
            if super::codec::graph_version(run.graph().definition())? != version {
                return Err(StoreFault::Design(super::DesignError::StaleGraphVersion));
            }
            crate::application::design::validate_graph(facts, run)?;

            facts
                .design_run_mut(run_id)
                .expect("validated run")
                .start_gate = crate::RunStartGate::Started;

            Ok(true)
        })
    }

    pub(crate) fn exit_design(
        &mut self,
        team_id: &TeamId,
        run_id: &GraphRunId,
        epoch: &str,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts
                .design_run_mut(run_id)
                .filter(|run| run.team() == team_id)
                .ok_or(StoreFault::InvalidFacts)?;
            run.start_gate
                .exit_design(epoch)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(())
        })
    }

    pub(crate) fn begin_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        requested_at: u64,
    ) -> Result<BeginCancellationOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .begin_graph_run_cancellation(run_id, idempotency_key, requested_at)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn settle_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, StoreFault> {
        self.transact(|facts| {
            let settled = facts
                .settle_graph_run_cancellation(run_id, idempotency_key, outcome, observed_at)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(settled)
        })
    }

    pub(crate) fn tombstone_graph_run(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> Result<TombstoneOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .tombstone_graph_run(run_id, idempotency_key, tombstoned_at)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn resume_graph_runs(&self, team_id: &crate::TeamId) -> Vec<ResumeOutcome> {
        self.facts.resume_graph_runs(team_id)
    }

    pub(crate) fn register_delivery(
        &mut self,
        request: crate::DeliveryRequest,
    ) -> Result<crate::RegisterOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .register_delivery(request)
                .map_err(StoreFault::DeliveryRequest)?;
            Ok(outcome)
        })
    }

    pub(crate) fn register_activity_and_start_attempt(
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
                facts
                    .apply_graph_event(
                        &run_id,
                        GraphEvent::AttemptStarted {
                            node_id,
                            fence,
                            started_at,
                        },
                    )
                    .map_err(|_| StoreFault::InvalidFacts)?;
            }
            Ok(outcome)
        })
    }

    pub(crate) fn register_activity(
        &mut self,
        request: ActivityRequest,
    ) -> Result<ActivityRegistrationOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .register_activity(request)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn resolve_human_decision(
        &mut self,
        command: HumanDecisionCommand,
    ) -> Result<HumanDecisionOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .resolve_human_decision(command)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn record_artifact(
        &mut self,
        record: ArtifactRecord,
    ) -> Result<ArtifactRecordOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .record_artifact(record)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn record_evidence(&mut self, record: EvidenceRecord) -> Result<RecordOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .record_evidence(record)
                .map_err(StoreFault::Evidence)?;
            Ok(outcome)
        })
    }

    /// Tombstone is the Organization lifecycle boundary: facts remain durable and
    /// provider cleanup is not implied by this local transition.
    pub(crate) fn tombstone_team(
        &mut self,
        team_id: &TeamId,
        cleanup_idempotency_key: IdempotencyKey,
    ) -> Result<super::facts::TeamTombstoneOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .tombstone_team(team_id, cleanup_idempotency_key)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    /// Returns only materializations which may be settled by native readback.
    /// These requests must never be replayed as mutations after process recovery.
    pub(crate) fn materialization_receipt_recovery_teams(&self) -> Vec<TeamId> {
        self.facts
            .materialization_lifecycles()
            .filter_map(|lifecycle| {
                lifecycle
                    .receipt_recovery_request()
                    .map(|request| request.intent().team().clone())
            })
            .collect()
    }

    pub(crate) fn team_materialization_recovery_request(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRequest> {
        self.facts.materialization_recovery_request(team_id)
    }

    pub(crate) fn team_materialization_removal(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRemoval> {
        self.facts.team_materialization_removal(team_id)
    }

    pub(crate) fn team_unconfirmed_materialization_cleanup_request(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRequest> {
        self.facts
            .team_unconfirmed_materialization_cleanup_request(team_id)
    }

    pub(crate) fn team_materialization_cleanup_confirmed(&self, team_id: &TeamId) -> bool {
        self.facts.team_materialization_cleanup_confirmed(team_id)
    }

    pub(crate) fn record_team_materialization_cleanup_outcome(
        &mut self,
        team_id: &TeamId,
        outcome: crate::MaterializationOperationOutcome,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.transact(|facts| {
            let recorded = facts
                .record_team_materialization_cleanup_outcome(team_id, outcome)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(recorded)
        })
    }

    pub(crate) fn create_team_materialization(
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

    pub(crate) fn record_team_materialization_outcome(
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
    pub(crate) fn confirm_team_materialization(
        &mut self,
        receipt: crate::MaterializationReceipt,
    ) -> Result<crate::MaterializationRecordOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .confirm_materialization(receipt)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub(crate) fn install_runtime_receipt(
        &mut self,
        receipt: crate::RunRuntimeReceipt,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .install_runtime_receipt(receipt)
                .map_err(StoreFault::RuntimeReceipt)
        })
    }

    pub(crate) fn claim_agent_activity(
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

    pub(crate) fn settle_agent_activity_dispatch(
        &mut self,
        claim: &ActivityClaim,
        receipt: DeliveryReceipt,
        activity_settlement: Option<ActivitySettlement>,
    ) -> Result<(DeliveryResolution, Option<ActivitySettlementOutcome>), StoreFault> {
        self.transact(|facts| {
            let delivery_id = DeliveryId::new(claim.activity_id().as_str().to_owned())
                .map_err(|_| StoreFault::InvalidFacts)?;
            let delivery = facts
                .deliveries()
                .delivery(&delivery_id)
                .ok_or(StoreFault::InvalidFacts)?;
            let activity = facts
                .activities()
                .activity(claim.activity_id())
                .ok_or(StoreFault::InvalidFacts)?;
            if let DeliveryReceipt::Accepted {
                receipt,
                native_correlation,
                ..
            } = &receipt
            {
                let accepted = match delivery.phase() {
                    crate::DeliveryPhase::Delivered {
                        receipt: existing,
                        native_correlation: existing_correlation,
                        ..
                    } => existing == receipt && existing_correlation == native_correlation,
                    crate::DeliveryPhase::TerminalObserved { observation } => {
                        observation.delivered_receipt() == receipt
                            && Some(observation.correlation()) == native_correlation.as_ref()
                    }
                    _ => false,
                };
                let snapshot = activity.snapshot();
                let matching_claim = activity.active_claim().map_or_else(
                    || {
                        snapshot.completed_attempts() == claim.attempt()
                            && snapshot.next_claim_generation() == claim.generation() + 1
                    },
                    |active| active == claim,
                );
                if accepted && matching_claim && activity_settlement.is_none() {
                    return Ok((DeliveryResolution::Delivered, None));
                }
            }
            if activity.active_claim() != Some(claim) {
                return Err(StoreFault::InvalidFacts);
            }
            let delivery_claim = delivery
                .active_claim()
                .cloned()
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
            let run_id = facts
                .activities()
                .activity(claim.activity_id())
                .ok_or(StoreFault::InvalidFacts)?
                .facts()
                .run_id
                .clone();
            facts.cancel_superseded_pending_activities(&run_id);

            Ok((delivery, activity))
        })
    }

    pub(crate) fn claim_activity(
        &mut self,
        activity_id: &ActivityId,
        claimed_at: u64,
    ) -> Result<ActivityClaimOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .claim_activity(activity_id, claimed_at)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn dispatch_activity(
        &mut self,
        claim: &ActivityClaim,
        dispatched_at: u64,
    ) -> Result<ActivityDispatchOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .dispatch_activity(claim, dispatched_at)
                .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(outcome)
        })
    }

    pub(crate) fn settle_activity(
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

    pub(crate) fn claim_delivery(
        &mut self,
        delivery_id: &DeliveryId,
        claimed_at: u64,
    ) -> Result<DeliveryStart, StoreFault> {
        self.transact(|facts| {
            let start = facts
                .claim_delivery(delivery_id, claimed_at)
                .map_err(|error| StoreFault::DeliveryReceipt(Box::new(error)))?;
            Ok(start)
        })
    }

    pub(crate) fn settle_delivery(
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

    pub(crate) fn fire_trigger(
        &mut self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<TriggerRegistration, StoreFault> {
        self.transact(|facts| {
            let registration = facts
                .fire_trigger(request, fired_at)
                .map_err(StoreFault::TriggerFire)?;
            Ok(registration)
        })
    }

    pub(crate) fn accept_native_terminal_context(
        &mut self,
        delivery_id: &DeliveryId,
        endpoint_session_id: crate::EndpointSessionId,
        native_run_id: String,
    ) -> Result<(), StoreFault> {
        runtime_trace("runtime.team_run.terminal.store.accept_context", || {
            json!({
                "deliveryHash": identifier_hash(delivery_id.as_str()),
                "nativeRunHash": identifier_hash(&native_run_id), "outcome": "begin",
            })
        });
        let mut phase = "ensure_writable";
        let mut recorded = false;
        let result = self.transact(|facts| {
            phase = "accept_context";
            recorded = facts
                .accept_native_terminal_context(delivery_id, endpoint_session_id, native_run_id)
                .map_err(|error| {
                    runtime_trace("runtime.team_run.terminal.store.accept_context", || json!({
                        "deliveryHash": identifier_hash(delivery_id.as_str()), "outcome": "error",
                        "reason": crate::trace::terminal_facts_reason(&error),
                    }));
                    StoreFault::InvalidFacts
                })?;
            phase = "commit";
            Ok(())
        });
        runtime_trace("runtime.team_run.terminal.store.accept_context", || {
            json!({
                "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": phase,
                "outcome": match &result {
                    Ok(()) if recorded => "recorded",
                    Ok(()) => "replayed",
                    Err(StoreFault::CommitOutcomeUnknown(_)) => "commit_outcome_unknown",
                    Err(_) => "error",
                },
                "error": result.as_ref().err().map(crate::trace::terminal_error),
            })
        });
        result
    }

    pub(crate) fn native_terminal_target(
        &self,
        delivery_id: &DeliveryId,
    ) -> Option<NativeTerminalReceiptTarget> {
        self.facts.native_terminal_target(delivery_id)
    }

    pub(crate) fn observe_native_terminal(
        &mut self,
        target: NativeTerminalReceiptTarget,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
    ) -> Result<TerminalObservationOutcome, StoreFault> {
        self.transact(|facts| {
            let Some(current) = facts.native_terminal_target(target.delivery_id()) else {
                return Err(StoreFault::TerminalObservation(
                    crate::TerminalObservationError::DeliveryNotAccepted,
                ));
            };
            if current != target {
                return Err(StoreFault::TerminalObservation(
                    crate::TerminalObservationError::StaleFence,
                ));
            }

            let outcome = facts
                .observe_native_terminal(target.delivery_id(), native_terminal, observed_at)
                .map_err(StoreFault::TerminalObservation)?;
            Ok(outcome)
        })
    }

    pub(crate) fn settle_native_terminal(
        &mut self,
        target: NativeTerminalReceiptTarget,
        status: NativeTerminalStatus,
        output: Result<
            Option<crate::TeamNodeOutput>,
            crate::application::team_message::TeamMessageFailure,
        >,
        settled_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        runtime_trace("runtime.team_run.terminal.store.settle", || {
            json!({
                "deliveryHash": identifier_hash(target.delivery_id().as_str()),
                "runHash": identifier_hash(target.graph_run_id().as_str()),
                "nativeRunHash": identifier_hash(target.correlation().native_run_receipt().as_str()),
                "outcome": "begin",
            })
        });
        let mut phase = "ensure_writable";
        let result = self.transact(|facts| {
            phase = "target_fence";
            if facts.native_terminal_target(target.delivery_id()).as_ref() != Some(&target) {
                return Err(StoreFault::TerminalObservation(
                    crate::TerminalObservationError::StaleFence,
                ));
            }

            phase = "settle_facts";
            let outcome = facts.settle_native_terminal(&target, status, output, settled_at)?;
            phase = "commit";
            Ok(outcome)
        });
        runtime_trace("runtime.team_run.terminal.store.settle", || {
            json!({
                "deliveryHash": identifier_hash(target.delivery_id().as_str()),
                "runHash": identifier_hash(target.graph_run_id().as_str()),
                "nativeRunHash": identifier_hash(target.correlation().native_run_receipt().as_str()),
                "phase": phase,
                "outcome": match &result {
                    Ok(AuthorizedGraphResolutionOutcome::Recorded) => "recorded",
                    Ok(AuthorizedGraphResolutionOutcome::Replayed) => "replayed",
                    Err(StoreFault::CommitOutcomeUnknown(_)) => "commit_outcome_unknown",
                    Err(_) => "error",
                },
                "error": result.as_ref().err().map(crate::trace::terminal_error),
            })
        });
        result
    }

    pub(crate) fn resolve_native_run_output(
        &mut self,
        target: NativeTerminalReceiptTarget,
        receipt: crate::AuthorizedGraphResolutionReceipt,
        final_assistant_text: String,
        resolved_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.transact(|facts| {
            let Some(current) = facts.native_terminal_target(target.delivery_id()) else {
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

            let outcome = facts
                .resolve_native_run_output(
                    target.delivery_id(),
                    receipt,
                    final_assistant_text,
                    resolved_at,
                )
                .map_err(StoreFault::NativeRunOutputResolution)?;
            Ok(outcome)
        })
    }

    pub(crate) fn apply_graph_patch(
        &mut self,
        run_id: &GraphRunId,
        patch: GraphPatch,
        applied_at: u64,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| facts.apply_graph_patch(run_id, &patch, applied_at))
    }

    pub(crate) fn replace_team_graph(
        &mut self,
        command: crate::RunCommand,
        definition: GraphDefinition,
    ) -> Result<crate::CommandReceipt, StoreFault> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        runtime_trace("runtime.team_run.graph_write.request", || {
            json!({
                "operation": "replace", "runHash": identifier_hash(run_id.as_str()),
                "requestVersionHash": super::codec::graph_version(&definition).ok().map(|value| identifier_hash(&value)),
                "edgeCount": definition.edges().len(), "edgesTruncated": definition.edges().len() > 32,
                "edges": definition.edges().iter().take(32).map(crate::trace::edge).collect::<Vec<_>>(),
            })
        });
        let result: Result<crate::CommandReceipt, StoreFault> = self.transact(|facts| {
            let receipt = facts.replace_team_graph(command, definition)?;
            Ok(receipt)
        });
        crate::trace::graph_write_result(
            self.facts(),
            &run_id,
            "replace",
            result.as_ref().map(|receipt| receipt.is_replay()),
        );
        result
    }

    pub(crate) fn apply_graph_patch_draft(
        &mut self,
        draft: crate::TeamGraphPatchDraft,
    ) -> Result<crate::CommandReceipt, StoreFault> {
        let run_id = draft.run_id.clone();
        let result: Result<crate::CommandReceipt, StoreFault> = self.transact(|facts| {
            let run = facts.run(&run_id)
                .ok_or(StoreFault::GraphPatch(crate::GraphPatchError::UnknownRun))?;
            let command = draft.command(run.graph().definition())?;
            if let Some(receipt) = facts.events().replay(&command).map_err(StoreFault::EventLedger)? {
                return Ok(receipt);
            }
            let patch = draft.resolve(run.graph().definition(), run.runtime().map_or(&[], |runtime| runtime.bindings()))?;
            runtime_trace("runtime.team_run.graph_write.request", || json!({
                "operation": "patch", "runHash": identifier_hash(run_id.as_str()),
                "expectedGraphIdHash": identifier_hash(patch.expected_graph_id()),
                "expectedWorkflowPlanIdHash": identifier_hash(patch.expected_workflow_plan_id()),
                "patch": crate::trace::patch_edges(patch.operations()),
            }));

            let receipt = facts.team_graph_patch(command, &patch)?;

            Ok(receipt)
        });
        crate::trace::graph_write_result(
            self.facts(),
            &run_id,
            "patch",
            result.as_ref().map(|receipt| receipt.is_replay()),
        );
        result
    }

    pub(crate) fn team_graph_patch(
        &mut self,
        command: crate::RunCommand,
        patch: GraphPatch,
    ) -> Result<crate::CommandReceipt, StoreFault> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        runtime_trace("runtime.team_run.graph_write.request", || {
            json!({
                "operation": "patch", "runHash": identifier_hash(run_id.as_str()),
                "expectedGraphIdHash": identifier_hash(patch.expected_graph_id()),
                "expectedWorkflowPlanIdHash": identifier_hash(patch.expected_workflow_plan_id()),
                "patch": crate::trace::patch_edges(patch.operations()),
            })
        });
        let result: Result<crate::CommandReceipt, StoreFault> = self.transact(|facts| {
            let receipt = facts.team_graph_patch(command, &patch)?;
            Ok(receipt)
        });
        crate::trace::graph_write_result(
            self.facts(),
            &run_id,
            "patch",
            result.as_ref().map(|receipt| receipt.is_replay()),
        );
        result
    }

    pub(crate) fn team_node_event(
        &mut self,
        command: crate::RunCommand,
        event: crate::TeamNodeEvent,
    ) -> Result<crate::TeamNodeEventOutcome, StoreFault> {
        self.transact(|facts| {
            if matches!(
                event.kind(),
                crate::TeamNodeEventKind::Complete | crate::TeamNodeEventKind::Reject
            ) {
                return Ok(crate::TeamNodeEventOutcome::TerminalReceiptRequired);
            }

            let outcome = facts
                .team_node_event(command, event)
                .map_err(StoreFault::EventLedger)?;

            Ok(outcome)
        })
    }

    pub(crate) fn apply_agent_node_event_resolution(
        &mut self,
        resolution: AgentNodeEventResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.transact(|facts| {
            let outcome = facts
                .apply_agent_node_event_resolution(resolution)
                .map_err(StoreFault::AgentNodeEventResolution)?;
            Ok(outcome)
        })
    }

    pub(crate) fn apply_authorized_graph_resolution(
        &mut self,
        resolution: AuthorizedGraphResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, StoreFault> {
        self.transact(|facts| {
            facts
                .apply_authorized_graph_resolution(resolution)
                .map_err(StoreFault::AuthorizedGraphResolution)
        })
    }

    pub(crate) fn resolve_approval(
        &mut self,
        input: ApprovalResolutionInput,
    ) -> Result<super::facts::ApprovalResolutionOutcome, StoreFault> {
        self.transact(|facts| {
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
            let outcome = facts
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
            Ok(outcome)
        })
    }

    pub(crate) fn apply_graph_event(
        &mut self,
        run_id: &GraphRunId,
        event: GraphEvent,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            facts
                .apply_graph_event(run_id, event)
                .map_err(|_| StoreFault::InvalidFacts)
        })
    }

    pub(crate) fn apply_control_execution_step(
        &mut self,
        run_id: &GraphRunId,
        step: ControlExecutionStep,
    ) -> Result<(), StoreFault> {
        match step {
            ControlExecutionStep::GraphEvent(event) => self.transact(|facts| {
                let run = facts
                    .require_started_run(run_id)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let GraphEvent::NodeCompleted {
                    node_id,
                    fence,
                    output_port,
                    ..
                } = &event
                else {
                    return Err(StoreFault::InvalidFacts);
                };
                if output_port != "completed"
                    || run.graph().definition().node(node_id).is_none_or(|node| {
                        !matches!(node.kind(), crate::NodeKind::Start | crate::NodeKind::End)
                    })
                    || run.graph().current_attempt(node_id).is_none_or(|attempt| {
                        attempt.fence() != fence || attempt.status() != crate::AttemptStatus::Ready
                    })
                {
                    return Err(StoreFault::InvalidFacts);
                }
                facts.apply_graph_event(run_id, event)
            }),
            ControlExecutionStep::ControlResolution(resolution) => {
                if resolution.graph_run_id() != run_id {
                    return Err(StoreFault::InvalidFacts);
                }
                self.apply_control_node_resolution(resolution).map(|_| ())
            }
            ControlExecutionStep::HumanDecisionApproval {
                node_id,
                fence,
                requested_at,
            } => self.transact(|facts| {
                facts
                    .request_human_decision(run_id, node_id, fence, requested_at)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                Ok(())
            }),
        }
    }

    pub(crate) fn apply_control_node_resolution(
        &mut self,
        resolution: ControlNodeResolution,
    ) -> Result<ControlNodeResolutionOutcome, StoreFault> {
        self.transact(|facts| {
            if facts
                .control_node_resolution(resolution.idempotency_key())
                .is_some()
            {
                return facts
                    .apply_control_node_resolution(resolution)
                    .map_err(StoreFault::ControlNodeResolution);
            }

            let outcome = facts
                .apply_control_node_resolution(resolution)
                .map_err(StoreFault::ControlNodeResolution)?;

            Ok(outcome)
        })
    }

    pub(super) fn read_locked<T>(
        &mut self,
        read: impl FnOnce(&OrganizationFacts) -> Result<T, StoreFault>,
    ) -> Result<T, StoreFault> {
        self.ensure_writable()?;
        let transaction = self.database.begin()?;
        let (epoch, changes) = transaction.read_since(self.epoch)?;
        if let Err(error) = self.facts.apply_record_changes(changes, &self.contents) {
            self.requires_reopen = true;
            return Err(error);
        }
        self.epoch = epoch;
        read(&self.facts)
    }

    pub(super) fn transact<T>(
        &mut self,
        mutation: impl FnOnce(&mut OrganizationFacts) -> Result<T, StoreFault>,
    ) -> Result<T, StoreFault> {
        self.ensure_writable()?;
        let mut transaction = self.database.begin()?;
        let (epoch, changes) = transaction.read_since(self.epoch)?;
        if let Err(error) = self.facts.apply_record_changes(changes, &self.contents) {
            self.requires_reopen = true;
            return Err(error);
        }
        self.epoch = epoch;
        self.facts.begin_transaction();
        let prepared: Result<T, StoreFault> = (|| {
            let result = mutation(&mut self.facts)?;
            for change in self.facts.changed_records(&self.contents)? {
                match change {
                    RecordChange::Put(record) => transaction.put(&record)?,
                    RecordChange::Delete(key) => transaction.delete(&key)?,
                }
            }
            Ok(result)
        })();
        let result = match prepared {
            Ok(result) => result,
            Err(error) => {
                self.facts.rollback_transaction();
                return Err(error);
            }
        };
        match transaction.commit() {
            Ok(epoch) => {
                self.facts.commit_transaction();
                self.epoch = epoch;
                Ok(result)
            }
            Err(error) => {
                self.facts.rollback_transaction();
                self.requires_reopen = matches!(error, StoreFault::CommitOutcomeUnknown(_));
                Err(error)
            }
        }
    }

    fn ensure_writable(&self) -> Result<(), StoreFault> {
        if self.requires_reopen {
            return Err(StoreFault::RecoveryRequired);
        }
        Ok(())
    }
}

fn now_millis() -> Result<u64, StoreFault> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreFault::InvalidFacts)
        .and_then(|duration| {
            u64::try_from(duration.as_millis()).map_err(|_| StoreFault::InvalidFacts)
        })
}

fn ensure_parent_directory(path: &Path) -> Result<(), StoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| StoreFault::Commit(error.kind()))?;
    }
    Ok(())
}
