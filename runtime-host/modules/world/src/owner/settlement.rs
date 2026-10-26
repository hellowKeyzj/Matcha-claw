use std::sync::Arc;

use world_protocol::{
    failure::{Failure, FailureStage, Recovery}, ids::*,
    operation::{OperationAccepted, OperationFailure, OperationPhase, OperationReceipt},
};
use crate::{authorization::{Admission, AuthorityRoot, RestartIdentity}, extensions::package::{RetentionOwner, require_retained_packages}, store::{WorldStore, WorldTransaction}};
use super::{Error, ExecutionContext, RunRecord, execution_commit_id, ledger, resources::Resources, run};

#[derive(Clone)]
enum FailedWorkSource {
    Returned { invocation: InvocationId, budget: crate::extensions::invocation::CallBudget },
    NotStarted { operation: OperationAccepted },
    RecoveredGeneration { operation: OperationAccepted, generation: crate::generation::SettledRunGeneration },
    FencedSource { operation: OperationAccepted, segment: crate::sources::sync::FencedSourceSegment },
}

enum SettledWork {
    Generation,
    Investigation(Arc<crate::authorization::InvestigationBinding>),
    Source(crate::sources::sync::FencedSourceSegment),
}

/// Minted only after the original execution and every other blocker are settled.
pub(super) struct SettledWorkFailure {
    run: RunRecord,
    operation: OperationAccepted,
    source: SettledWork,
}

impl SettledWorkFailure {
    pub(super) fn matches(&self, run: &RunRecord, operation: &OperationAccepted) -> bool {
        self.operation == *operation && self.run.id == run.id && self.run.revision == run.revision
            && self.run.operation == run.operation && self.operation.world == run.operation.world
    }

    pub(super) async fn permits_step(&self, tx: &WorldTransaction<'_>, step: &super::StepRecord) -> Result<bool, Error> {
        if step.run_id != self.run.id || step.phase == OperationPhase::EffectIndeterminate
            || (step.phase == OperationPhase::CommitIndeterminate && step.failure.is_none()) { return Ok(false); }
        if let SettledWork::Investigation(binding) = &self.source {
            return if matches!(step.phase, OperationPhase::Retained | OperationPhase::Draining | OperationPhase::CommitIndeterminate) {
                crate::learning::investigation::require_settled_execution(step, binding)
            } else { Ok(true) };
        }
        if let SettledWork::Source(segment) = &self.source {
            if step.kind != "sources.service" || step.ordinal != 0 { return Ok(false); }
            segment.recheck(tx, &self.run).await?;
            return Ok(true);
        }
        if !generation_failure_resolved(tx, &self.run.id, step.failure.as_ref()).await? { return Ok(false); }
        if !matches!(step.phase, OperationPhase::CommitIndeterminate | OperationPhase::Retained | OperationPhase::Draining) { return Ok(true); }
        let generation = tx.query_opt(
            "SELECT 1 FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4 AND status IN ('completed','failed') LIMIT 1",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &self.run.id.as_str(), &step.id.as_str()],
        ).await?.is_some();
        Ok(generation)
    }
}

/// Failed-work custody only. It cannot admit business execution or construct new effects.
#[derive(Clone)]
pub(crate) struct FailedWorkSettlement {
    run: RunRecord,
    identity: RestartIdentity,
    failure: Failure<OperationFailure>,
    unresolved: Option<OperationPhase>,
    commit: CommitId,
    input: Digest,
    cancelled: bool,
    source: FailedWorkSource,
    authority: Arc<AuthorityRoot>,
    resources: Arc<Resources>,
    store: WorldStore,
    storage_id: String,
}

impl FailedWorkSettlement {
    fn new(ctx: &ExecutionContext, error: &Error) -> Result<Self, Error> {
        let mut failure = error.operation_failure().ok_or_else(|| error.clone())?;
        failure.operation_id = Some(ctx.operation.operation_id.clone());
        failure.run_id = Some(ctx.run.id.clone());
        let unresolved = error.unresolved_phase();
        let input = crate::definitions::canonical_digest(&(&failure, unresolved))?;
        let cancelled = ctx.cancellation.is_cancelled() || ctx.pipeline.is_cancelled()
            || matches!(&failure.details, OperationFailure::Cancelled | OperationFailure::Evaluation(world_protocol::evaluation::EvaluationFailure::Cancelled));
        let commit = execution_commit_id(&ctx.operation.world, &ctx.operation.operation_id, &ctx.run.id, &format!("failure.{}", failure.diagnostic_id))?;
        Ok(Self { run: ctx.run.clone(), identity: ctx.admission.restart_identity(), failure, unresolved, commit, input,
            cancelled,
            source: FailedWorkSource::Returned { invocation: ctx.admission.invocation().id.clone(), budget: ctx.budget.clone() }, authority: ctx.authority.clone(),
            resources: ctx.resources.clone(), store: ctx.store.clone(), storage_id: ctx.store.identity_receipt().storage_id().to_owned() })
    }

    /// Only this Resume attempt did not start. No evidence about an earlier execution is implied.
    pub(super) async fn resume_rejected(
        store: &WorldStore, resources: &Arc<Resources>, authority: &Arc<AuthorityRoot>,
        admission: &Admission, operation: &OperationAccepted, run: &RunRecord, error: &Error,
    ) -> Result<OperationReceipt, Error> {
        Self::resume_rejected_inner(store, resources, authority, admission, operation, run, error, None).await
    }

    pub(super) async fn resume_rejected_source(
        store: &WorldStore, resources: &Arc<Resources>, authority: &Arc<AuthorityRoot>,
        admission: &Admission, operation: &OperationAccepted, run: &RunRecord, error: &Error,
        segment: crate::sources::sync::FencedSourceSegment,
    ) -> Result<OperationReceipt, Error> {
        Self::resume_rejected_inner(store, resources, authority, admission, operation, run, error, Some(segment)).await
    }

    async fn resume_rejected_inner(
        store: &WorldStore, resources: &Arc<Resources>, authority: &Arc<AuthorityRoot>,
        admission: &Admission, operation: &OperationAccepted, run: &RunRecord, error: &Error,
        segment: Option<crate::sources::sync::FencedSourceSegment>,
    ) -> Result<OperationReceipt, Error> {
        let mut failure = error.operation_failure().ok_or_else(|| error.clone())?;
        failure.operation_id = Some(operation.operation_id.clone());
        failure.run_id = Some(run.id.clone());
        let unresolved = error.unresolved_phase();
        // No budget is renewed: only the original observed calls, receipts and usage may settle.
        let saved_run = run.id.clone();
        let has_generation = store.snapshot(operation.world.clone(), move |snapshot| Box::pin(async move {
            Ok::<_, Error>(snapshot.query_opt(
                "SELECT 1 FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 LIMIT 1",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str()],
            ).await?.is_some())
        })).await?;
        let (source, settlement) = if let Some(segment) = segment {
            (FailedWorkSource::FencedSource { operation: operation.clone(), segment }, None)
        } else if has_generation && !resources.tasks.contains_run(&operation.world, &run.id) {
            match crate::generation::settle_observed_run(
                store, &resources.model_calls, authority, &operation.world, &run.id, resources.content.clone(),
            ).await {
                Ok(generation) => (FailedWorkSource::RecoveredGeneration { operation: operation.clone(), generation }, None),
                Err(error) => (FailedWorkSource::NotStarted { operation: operation.clone() }, Some(error)),
            }
        } else { (FailedWorkSource::NotStarted { operation: operation.clone() }, None) };
        let input = crate::definitions::canonical_digest(&("world.resume.rejected.v1", operation, &failure, unresolved,
            matches!(&source, FailedWorkSource::RecoveredGeneration { .. }), matches!(&source, FailedWorkSource::FencedSource { .. })))?;
        let commit = execution_commit_id(&operation.world, &operation.operation_id, &run.id, &format!("resume.rejected.{}", failure.diagnostic_id))?;
        let proof = Self {
            run: run.clone(), identity: admission.restart_identity(), failure, unresolved, commit, input,
            cancelled: false, source, authority: authority.clone(), resources: resources.clone(), store: store.clone(),
            storage_id: store.identity_receipt().storage_id().to_owned(),
        };
        let receipt = store.settle_failed_work(authority, &proof).await;
        match (receipt, settlement) {
            (Ok(_), Some(error)) => Err(error),
            (Err(error), Some(settlement)) => Err(Error::from(error).with_related(settlement)),
            (receipt, None) => Ok(receipt?.value),
        }
    }

    pub(crate) fn world(&self) -> &WorldRef { &self.run.operation.world }
    pub(crate) fn commit_id(&self) -> &CommitId { &self.commit }
    pub(crate) fn input_digest(&self) -> &Digest { &self.input }
    pub(crate) fn run(&self) -> &RunRecord { &self.run }
    pub(crate) fn identity(&self) -> &RestartIdentity { &self.identity }
    pub(crate) fn storage_id(&self) -> &str { &self.storage_id }
    pub(crate) fn same_root(&self, root: &AuthorityRoot) -> bool { std::ptr::eq(self.authority.as_ref(), root) }
}

impl ExecutionContext {
    /// Call only after the owned workflow has returned; current business grants are not renewed.
    pub(crate) async fn fail(&self, error: &Error) -> Result<OperationReceipt, Error> {
        let proof = FailedWorkSettlement::new(self, error)?;
        Ok(self.store.settle_failed_work(&self.authority, &proof).await?.value)
    }
}

/// The store's private finite lane invokes this fixed reducer, never a caller closure.
pub(crate) async fn settle_failed_work(tx: &mut WorldTransaction<'_>, proof: &FailedWorkSettlement) -> Result<OperationReceipt, Error> {
    if tx.world() != proof.world() { return Err(invalid()); }
    let expected = &proof.run;
    let mut operation = ledger::read(tx, &expected.operation.operation_id).await?;
    let run = run::read_run(tx, &expected.id).await?;
    if operation.identity != proof.identity || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
        || operation.receipt.accepted.incarnation != expected.operation.incarnation
        || run.operation.operation_id != expected.operation.operation_id || run.operation.incarnation != expected.operation.incarnation
        || run.branch_id != expected.branch_id || run.branch_revision != expected.branch_revision || run.release_id != expected.release_id
        || run.activation_lock_id != expected.activation_lock_id || run.budget != expected.budget
        || expected.packages.iter().any(|package| !run.packages.contains(package))
        || (run.packages != expected.packages && !matches!(&operation.input, ledger::OperationInput::Command(input)
            if matches!(&input.command, world_protocol::api::WorldCommand::ImportMaterials(_)))) {
        return Err(invalid());
    }
    require_retained_packages(tx, RetentionOwner::Run(&run.id), Revision(1), &run.packages).await?;
    if ledger::terminal(operation.receipt.phase) { return Ok(operation.receipt); }
    let (invocation, budget) = match &proof.source {
        FailedWorkSource::Returned { invocation, budget } => (invocation, budget),
        FailedWorkSource::RecoveredGeneration { operation: expected_operation, generation } => {
            if operation.receipt.accepted != *expected_operation { return Err(invalid()); }
            generation.validate(tx, &proof.resources.model_calls, &proof.authority).await?;
            let resources = &proof.resources;
            let effects = tx.query_opt(
                "SELECT 1 FROM world_effect_intent i WHERE i.tenant_id=$1 AND i.world_id=$2 AND (i.run_id=$3 OR i.operation_id=$4) AND (i.status<>'rejected' OR NOT EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id) OR EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id AND r.disposition NOT IN ('not_sent','rejected','not_applied'))) LIMIT 1",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str(), &expected_operation.operation_id.as_str()],
            ).await?.is_some();
            let pending = proof.store.pending_commits().iter().any(|pending| pending.world == *proof.world() && pending.commit_id != proof.commit)
                || resources.tasks.contains_run(tx.world(), &run.id)
                || resources.releases.has_pending(&expected_operation.operation_id)
                || resources.archive.has_pending(&expected_operation.operation_id)
                || resources.actions.has_any_pending()
                || resources.model_calls.has_pending_run(&run.id)
                // Both current generation callers require an exact activation lock; absence is not a guest-return proof.
                || run.activation_lock_id.as_ref().is_none_or(|lock| resources.live.lock_invocations_unsettled(tx.world(), lock));
            let unresolved = pending || effects || proof.unresolved.is_some()
                || crate::generation::has_unsettled(tx, &run.id).await?
                || crate::evaluation::has_unsettled_execution(tx, &run.id).await?
                || operation.receipt.phase == OperationPhase::EffectIndeterminate
                || operation.receipt.commit.is_some()
                || operation.receipt.effects.iter().any(|effect| !matches!(effect.disposition,
                    world_protocol::actions::EffectDisposition::NotSent | world_protocol::actions::EffectDisposition::Rejected | world_protocol::actions::EffectDisposition::NotApplied))
                || !generation_failure_resolved(tx, &run.id, operation.receipt.failure.as_ref()).await?
                || (operation.receipt.phase == OperationPhase::CommitIndeterminate
                    && !operation.receipt.failure.as_ref().is_some_and(|failure|
                        matches!(&failure.details, OperationFailure::Commit(world_protocol::commit::CommitFailure::CommitIndeterminate { .. }))
                            || matches!(generation_failure(&failure.details).map(|failure| &failure.kind),
                                Some(world_protocol::generation::GenerationFailureKind::Commit { failure: world_protocol::commit::CommitFailure::CommitIndeterminate { .. } }))
                            || matches!(&failure.recovery, Recovery::ReadCommit { .. })));
            let cancelled = proof.cancelled || operation.receipt.cancellation != world_protocol::operation::CancellationState::NotRequested;
            if !unresolved {
                let settled = SettledWorkFailure { run: run.clone(), operation: operation.receipt.accepted.clone(), source: SettledWork::Generation };
                run::fail_settled_steps(tx, &run, &proof.failure, cancelled, &settled).await?;
                return ledger::fail_settled_work(tx, &operation.receipt.accepted, proof.failure.clone(), cancelled, &settled, &tx.now().await?).await;
            }
            operation.receipt.phase = match operation.receipt.phase {
                phase @ (OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Draining) => phase,
                _ => OperationPhase::Retained,
            };
            // Do not replace an unrelated unresolved cause with this Resume's budget rejection.
            if operation.receipt.failure.is_none() { operation.receipt.failure = Some(proof.failure.clone()); }
            ledger::save(tx, &mut operation, &tx.now().await?).await?;
            run::settle(tx, &operation.receipt).await?;
            return Ok(operation.receipt);
        },
        FailedWorkSource::FencedSource { operation: expected_operation, segment } => {
            if operation.receipt.accepted != *expected_operation
                || !matches!(operation.input.command()?, world_protocol::api::WorldCommand::StartSync(_))
                || !matches!(proof.failure.details, OperationFailure::BudgetExceeded { .. }) { return Err(invalid()); }
            segment.recheck(tx, &run).await?;
            let resources = &proof.resources;
            let pending = proof.store.pending_commits().iter().any(|pending| pending.world == *proof.world() && pending.commit_id != proof.commit)
                || resources.tasks.contains_run(tx.world(), &run.id)
                || resources.releases.has_pending(&expected_operation.operation_id)
                || resources.archive.has_pending(&expected_operation.operation_id)
                || resources.actions.has_any_pending()
                || resources.model_calls.has_pending_run(&run.id)
                || run.activation_lock_id.as_ref().is_none_or(|lock| resources.live.lock_invocations_unsettled(tx.world(), lock));
            let other_steps = tx.query_opt(
                "SELECT 1 FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND phase NOT IN ('completed','failed','cancelled_before_commit','cancelled_after_commit') AND (kind<>'sources.service' OR ordinal<>0 OR phase IN ('commit_indeterminate','effect_indeterminate') OR result IS NOT NULL) LIMIT 1",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str()],
            ).await?.is_some();
            let effects = tx.query_opt(
                "SELECT 1 FROM world_effect_intent i WHERE i.tenant_id=$1 AND i.world_id=$2 AND (i.run_id=$3 OR i.operation_id=$4) AND (i.status<>'rejected' OR NOT EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id) OR EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id AND r.disposition NOT IN ('not_sent','rejected','not_applied'))) LIMIT 1",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str(), &expected_operation.operation_id.as_str()],
            ).await?.is_some();
            let unresolved = pending || other_steps || effects || proof.unresolved.is_some()
                || crate::generation::has_unsettled(tx, &run.id).await?
                || crate::evaluation::has_unsettled_execution(tx, &run.id).await?
                || matches!(operation.receipt.phase, OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate)
                || operation.receipt.commit.is_some()
                || operation.receipt.failure.as_ref().is_some_and(|failure| ledger::unresolved_phase(&failure.details).is_some()
                    || matches!(failure.recovery, Recovery::ReadCommit { .. } | Recovery::ReadTransfer { .. } | Recovery::InspectEffect { .. }))
                || operation.receipt.effects.iter().any(|effect| !matches!(effect.disposition,
                    world_protocol::actions::EffectDisposition::NotSent | world_protocol::actions::EffectDisposition::Rejected | world_protocol::actions::EffectDisposition::NotApplied));
            if !unresolved {
                let settled = SettledWorkFailure { run: run.clone(), operation: operation.receipt.accepted.clone(), source: SettledWork::Source(segment.clone()) };
                run::fail_settled_steps(tx, &run, &proof.failure, false, &settled).await?;
                return ledger::fail_settled_work(tx, &operation.receipt.accepted, proof.failure.clone(), false, &settled, &tx.now().await?).await;
            }
            operation.receipt.phase = match operation.receipt.phase {
                phase @ (OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Draining) => phase,
                _ => OperationPhase::Retained,
            };
            if operation.receipt.failure.is_none() { operation.receipt.failure = Some(proof.failure.clone()); }
            ledger::save(tx, &mut operation, &tx.now().await?).await?;
            run::settle(tx, &operation.receipt).await?;
            return Ok(operation.receipt);
        },
        FailedWorkSource::NotStarted { operation: expected_operation } => {
            if operation.receipt.accepted != *expected_operation || run.revision != expected.revision {
                return Err(Error::new("world.operation_revision_conflict", FailureStage::Recover,
                    "操作状态已变化，请读取当前状态。", world_protocol::api::ApiFailure::RevisionConflict, Recovery::Refresh));
            }
            // The old execution has not returned to this owner. Keep its effects, steps and usage unresolved.
            let mut failure = proof.failure.clone();
            failure.recovery = operation.receipt.failure.as_ref().map(|old| old.recovery.clone())
                .filter(|recovery| !matches!(recovery, Recovery::None | Recovery::Refresh))
                .unwrap_or(Recovery::ManualReview);
            operation.receipt.phase = match operation.receipt.phase {
                phase @ (OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Draining) => phase,
                _ => OperationPhase::Retained,
            };
            operation.receipt.failure = Some(failure);
            ledger::save(tx, &mut operation, &tx.now().await?).await?;
            run::settle(tx, &operation.receipt).await?;
            return Ok(operation.receipt);
        },
    };
    let generation = crate::generation::has_unsettled(tx, &run.id).await?;
    let evaluation = crate::evaluation::has_unsettled_execution(tx, &run.id).await?;
    let resources = &proof.resources;
    let investigation = if matches!(operation.input.command()?, world_protocol::api::WorldCommand::ResolveTask(_))
        && matches!(proof.failure.details, OperationFailure::BudgetExceeded { .. } | OperationFailure::Cancelled)
        && matches!(operation.receipt.phase, OperationPhase::Retained | OperationPhase::Draining)
        && operation.receipt.failure.as_ref().is_none_or(|failure| matches!(failure.details, OperationFailure::BudgetExceeded { .. } | OperationFailure::Cancelled))
        && operation.receipt.commit.is_none()
    {
        match resources.tasks.settled_investigation(tx.world(), &run.id) {
            Some(binding) if binding.world() == tx.world() && binding.run_id() == &run.id
                && binding.identity().operation.operation_id == operation.receipt.accepted.operation_id
                && binding.identity().operation.incarnation == operation.receipt.accepted.incarnation =>
            {
                match run::read_step(tx, &run.id, &binding.identity().step_id).await? {
                    Some(step) if crate::learning::investigation::require_settled_execution(&step, &binding)? => Some(binding),
                    _ => None,
                }
            },
            Some(_) => None,
            None => None,
        }
    } else { None };
    let pending = proof.store.pending_commits().iter().any(|pending| pending.world == *proof.world() && pending.commit_id != proof.commit)
        || resources.releases.has_pending(&expected.operation.operation_id)
        || resources.archive.has_pending(&expected.operation.operation_id)
        || resources.model_calls.has_pending_run(&run.id)
        || resources.live.invocation_unsettled(tx.world(), invocation)
        || budget.has_pending_reservations()
        || (investigation.is_some() && (resources.actions.has_any_pending()
            || run.activation_lock_id.as_ref().is_none_or(|lock| resources.live.lock_invocations_unsettled(tx.world(), lock))));
    let investigation_effects = investigation.is_some() && tx.query_opt(
        "SELECT 1 FROM world_effect_intent i WHERE i.tenant_id=$1 AND i.world_id=$2 AND (i.run_id=$3 OR i.operation_id=$4) AND (i.status<>'rejected' OR NOT EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id) OR EXISTS (SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id AND r.disposition NOT IN ('not_sent','rejected','not_applied'))) LIMIT 1",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str(), &operation.receipt.accepted.operation_id.as_str()],
    ).await?.is_some();
    let unresolved = pending || generation || evaluation || proof.unresolved.is_some() || investigation_effects
        || (matches!(operation.receipt.phase, OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Draining | OperationPhase::Retained)
            && investigation.is_none())
        || operation.receipt.effects.iter().any(|effect| !matches!(effect.disposition,
            world_protocol::actions::EffectDisposition::NotSent | world_protocol::actions::EffectDisposition::Rejected | world_protocol::actions::EffectDisposition::NotApplied));
    let run = run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, budget.checkpoint_usage())?).await?;
    if unresolved {
        operation.receipt.phase = match operation.receipt.phase {
            phase @ (OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate) => phase,
            _ => proof.unresolved.unwrap_or(OperationPhase::Retained),
        };
        operation.receipt.failure = Some(proof.failure.clone());
        ledger::save(tx, &mut operation, &tx.now().await?).await?;
        run::settle(tx, &operation.receipt).await?;
        Ok(operation.receipt)
    } else if let Some(binding) = investigation {
        let settled = SettledWorkFailure { run: run.clone(), operation: operation.receipt.accepted.clone(), source: SettledWork::Investigation(binding) };
        run::fail_settled_steps(tx, &run, &proof.failure, proof.cancelled, &settled).await?;
        ledger::fail_settled_work(tx, &operation.receipt.accepted, proof.failure.clone(), proof.cancelled, &settled, &tx.now().await?).await
    } else {
        run::fail_steps(tx, &run, &proof.failure, proof.cancelled).await?;
        ledger::fail(tx, &operation.receipt.accepted, proof.failure.clone(), proof.cancelled, &tx.now().await?).await
    }
}

fn generation_failure(failure: &OperationFailure) -> Option<&world_protocol::generation::GenerationFailure> {
    match failure {
        OperationFailure::Generation(failure) | OperationFailure::Learning(world_protocol::learning::LearningFailure::Model { failure }) => Some(failure),
        _ => None,
    }
}

async fn generation_failure_resolved(
    tx: &WorldTransaction<'_>, run: &RunId, failure: Option<&Failure<OperationFailure>>,
) -> Result<bool, Error> {
    let Some(failure) = failure else { return Ok(true); };
    let commit = match &failure.details {
        OperationFailure::Commit(world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id }) => Some(commit_id),
        details => match generation_failure(details).map(|failure| &failure.kind) {
            Some(world_protocol::generation::GenerationFailureKind::Commit { failure: world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id } }) => Some(commit_id),
            Some(world_protocol::generation::GenerationFailureKind::CallIndeterminate { model_call_id }) => {
                return Ok(tx.query_opt(
                    "SELECT 1 FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND model_call_id=$4 AND status IN ('completed','failed')",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.as_str(), &model_call_id.as_str()],
                ).await?.is_some());
            },
            _ => None,
        },
    };
    let commit = commit.or_else(|| match &failure.recovery { Recovery::ReadCommit { commit_id } => Some(commit_id), _ => None });
    if let Some(commit) = commit {
        return Ok(tx.query_opt(
            "SELECT 1 FROM world_model_call m JOIN world_commit_receipt c USING(tenant_id,world_id) WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.run_id=$3 AND m.status IN ('completed','failed') AND c.commit_id=$4 AND c.input_digest=m.input_digest AND c.committed_at IS NOT NULL AND (c.commit_id IN ('model-'||m.model_call_id||'-plan','model-'||m.model_call_id||'-prepare','model-'||m.model_call_id||'-dispatch','model-'||m.model_call_id||'-observed','model-'||m.model_call_id||'-finish','model-'||m.model_call_id||'-prepare-failed') OR left(c.commit_id,length('model-'||m.model_call_id||'-stage-'))='model-'||m.model_call_id||'-stage-') LIMIT 1",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.as_str(), &commit.as_str()],
        ).await?.is_some());
    }
    Ok(ledger::unresolved_phase(&failure.details).is_none()
        && !matches!(failure.recovery, Recovery::ReadTransfer { .. } | Recovery::InspectEffect { .. }))
}

fn invalid() -> Error { world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into() }
