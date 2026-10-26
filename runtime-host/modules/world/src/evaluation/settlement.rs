use std::{collections::BTreeSet, sync::Arc};

use super::{Error, EvaluationRun, records, run};
use crate::{
    authorization::{Admission, AuthorityRoot, RestartIdentity},
    owner,
    store::{CommitRequest, TransactionError, WorldStore, WorldTransaction},
};
use foundation::pipeline::PipelineContext;
use world_protocol::{
    budget::Usage,
    commit::WriteFence,
    evaluation::{CandidateVerdict, EvaluationExecution, EvaluationFailure},
    failure::Failure,
    ids::{CommitId, Digest, StepId, WorldRef, WriterEpoch},
    operation::{OperationFailure, OperationPhase},
};

/// Minted only from this operation's durable evaluation and the actual awaited workflow.
#[derive(Clone)]
pub(super) struct Custody {
    state: EvaluationRun,
    identity: RestartIdentity,
    awaited: BTreeSet<StepId>,
}

impl Custody {
    pub(super) fn prepared(
        state: &EvaluationRun,
        admission: &Admission,
        pipeline: &PipelineContext,
    ) -> Result<Self, Error> {
        if state.run.id.as_str() != pipeline.run_id()
            || state.request.world != admission.invocation().world
            || state.request.branch_id != state.branch.id
            || state.run.branch_id.as_ref() != Some(&state.request.branch_id)
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(Self {
            state: state.clone(),
            identity: admission.restart_identity(),
            awaited: BTreeSet::new(),
        })
    }

    pub(super) fn await_step(&mut self, step: &owner::StepRecord) -> Result<(), Error> {
        if step.run_id != self.state.run.id
            || step.kind != "world.evaluation.case"
            || step.phase != OperationPhase::Running
            || step.result.is_some()
            || step.failure.is_some()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        self.awaited.insert(step.id.clone());
        Ok(())
    }

    pub(super) async fn fail(
        &self,
        store: &WorldStore,
        root: &Arc<AuthorityRoot>,
        commits: &CommitRequest,
        error: &owner::Error,
        usage: Usage,
        execution: Option<&dyn super::BranchExecution>,
    ) -> Result<(), Error> {
        if store
            .pending_commits()
            .iter()
            .any(|pending| pending.world == self.state.request.world)
            || execution.is_some_and(super::BranchExecution::unsettled)
            || error.unresolved_phase().is_some()
        {
            return Ok(());
        }
        let proof = EvaluationSettlement::new(self, store, root, commits, error, usage)?;
        match store.settle_evaluation_report(root, &proof).await {
            Ok(_) => Ok(()),
            Err(TransactionError::NotCommitted { error, cleanup }) => Err(match cleanup {
                Some(cleanup) => Error::Rollback {
                    error: Box::new(error),
                    cleanup,
                },
                None => error,
            }),
            Err(TransactionError::Indeterminate(error)) => {
                match store
                    .read_commit::<()>(proof.world(), proof.commit_id(), proof.input_digest())
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(read) => {
                        let cause = owner::Error::from(error).with_related(read.into());
                        Err(Error::Owner(
                            cause.clone().caused(UnresolvedReport { proof, cause }),
                        ))
                    }
                }
            }
        }
    }
}

/// Private awaited-work proof. It carries no current grant or business execution capability.
#[derive(Clone)]
pub(crate) struct EvaluationSettlement {
    custody: Custody,
    failure: Failure<OperationFailure>,
    cause: owner::Error,
    usage: Usage,
    root: Arc<AuthorityRoot>,
    store: WorldStore,
    storage_id: String,
    commit: CommitId,
    input: Digest,
    storage_epoch: WriterEpoch,
    fence: WriteFence,
}

impl EvaluationSettlement {
    fn new(
        custody: &Custody,
        store: &WorldStore,
        root: &Arc<AuthorityRoot>,
        commits: &CommitRequest,
        cause: &owner::Error,
        usage: Usage,
    ) -> Result<Self, Error> {
        let failure = cause
            .operation_failure()
            .ok_or_else(|| Error::Owner(cause.clone()))?;
        let fence = commits
            .fences
            .iter()
            .find(|fence| fence.domain.as_str() == "evaluation")
            .filter(|fence| fence.world == custody.state.request.world)
            .ok_or(EvaluationFailure::BasisChanged)?
            .clone();
        if commits.world != custody.state.request.world {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let stage = format!("failure.{}", failure.diagnostic_id);
        let identity = records::digest(&(&commits.world, &commits.commit_id, &stage))?;
        let commit = CommitId::try_new(format!("eval-{}", &identity.as_str()[7..]))
            .expect("bounded digest identifier");
        let input = records::digest(&(
            &stage,
            &custody.state,
            &custody.identity,
            &custody.awaited,
            &failure,
            &usage,
            store.identity_receipt().storage_id(),
            commits.storage_epoch,
            &fence,
        ))?;
        Ok(Self {
            custody: custody.clone(),
            failure,
            cause: cause.clone(),
            usage,
            root: root.clone(),
            store: store.clone(),
            storage_id: store.identity_receipt().storage_id().to_owned(),
            commit,
            input,
            storage_epoch: commits.storage_epoch,
            fence,
        })
    }

    pub(crate) fn world(&self) -> &WorldRef {
        &self.custody.state.request.world
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub(crate) fn input_digest(&self) -> &Digest {
        &self.input
    }
    pub(crate) fn storage_id(&self) -> &str {
        &self.storage_id
    }
    pub(crate) fn storage_epoch(&self) -> WriterEpoch {
        self.storage_epoch
    }
    pub(crate) fn fence(&self) -> &WriteFence {
        &self.fence
    }
    pub(crate) fn same_root(&self, root: &AuthorityRoot) -> bool {
        std::ptr::eq(self.root.as_ref(), root)
    }
}

/// Keeps an ambiguous report commit's original proof and typed cause alive for recovery.
struct UnresolvedReport {
    proof: EvaluationSettlement,
    cause: owner::Error,
}
impl std::fmt::Debug for UnresolvedReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnresolvedReport")
            .field("commit", &self.proof.commit)
            .field("cause", &self.cause)
            .finish()
    }
}
impl std::fmt::Display for UnresolvedReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for UnresolvedReport {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

/// Store invokes only this reducer; it may update the original report, never root or step state.
pub(crate) async fn settle_report(
    tx: &mut WorldTransaction<'_>,
    proof: &EvaluationSettlement,
) -> Result<(), Error> {
    let expected = &proof.custody.state;
    if tx.world() != proof.world() {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let mut state = run::load(tx, &expected.request.id)
        .await?
        .ok_or(EvaluationFailure::BasisChanged)?;
    let operation = owner::read_operation_record(tx, &expected.run.operation.operation_id).await?;
    let current = owner::read_run(tx, &expected.run.id).await?;
    check_run(tx, &state, &current, &operation)?;
    if operation.identity != proof.custody.identity
        || state.request != expected.request
        || state.submitted_branch != expected.submitted_branch
        || state.branch != expected.branch
        || state.compile_digest != expected.compile_digest
        || state.model_digest != expected.model_digest
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    run::read_report(tx, &state.request.id).await?;
    if !matches!(state.report.execution, EvaluationExecution::Running) {
        return Ok(());
    }
    let receipt = &operation.receipt;
    if proof.cause.unresolved_phase().is_some()
        || proof
            .store
            .pending_commits()
            .iter()
            .any(|pending| pending.world == *proof.world() && pending.commit_id != proof.commit)
        || owner::terminal_phase(receipt.phase)
        || matches!(
            receipt.phase,
            OperationPhase::CommitIndeterminate
                | OperationPhase::EffectIndeterminate
                | OperationPhase::Retained
                | OperationPhase::Draining
                | OperationPhase::Verifying
                | OperationPhase::Committing
        )
        || receipt.effects.iter().any(|effect| {
            !matches!(
                effect.disposition,
                world_protocol::actions::EffectDisposition::NotSent
                    | world_protocol::actions::EffectDisposition::Rejected
                    | world_protocol::actions::EffectDisposition::NotApplied
            )
        })
        || crate::generation::has_unsettled(tx, &current.id).await?
        || unsettled_steps(tx, &current, &proof.custody.awaited).await?
    {
        return Ok(());
    }
    let mut failure = proof.failure.clone();
    failure.operation_id = Some(current.operation.operation_id.clone());
    failure.run_id = Some(current.id.clone());
    state.report.execution = match &failure.details {
        OperationFailure::Cancelled
        | OperationFailure::Evaluation(EvaluationFailure::Cancelled) => {
            EvaluationExecution::Cancelled
        }
        _ => EvaluationExecution::Failed { failure },
    };
    state.report.verdict = CandidateVerdict::Inconclusive;
    state.report.usage = owner::confirmed_usage(
        &state.report.usage,
        owner::confirmed_usage(&current.usage, proof.usage.clone())?,
    )?;
    let now = tx.now().await?;
    let elapsed = now
        .unix_millis()
        .checked_sub(state.started_at.unix_millis())
        .and_then(|elapsed| u64::try_from(elapsed).ok())
        .ok_or(EvaluationFailure::InternalFault)?;
    state.report.usage.elapsed.0 = state.report.usage.elapsed.0.max(elapsed);
    state.report.completed_at = Some(now);
    run::save(tx, &mut state).await
}

fn check_run(
    tx: &WorldTransaction<'_>,
    state: &EvaluationRun,
    current: &owner::RunRecord,
    operation: &owner::OperationRecord,
) -> Result<(), Error> {
    if state.request.world != *tx.world()
        || current.operation.world != state.run.operation.world
        || current.operation.operation_id != state.run.operation.operation_id
        || current.operation.incarnation != state.run.operation.incarnation
        || current.id != state.run.id
        || operation.receipt.accepted.world != current.operation.world
        || operation.receipt.accepted.operation_id != current.operation.operation_id
        || operation.receipt.accepted.incarnation != current.operation.incarnation
        || operation.receipt.progress.run_id.as_ref() != Some(&current.id)
        || current.branch_id != state.run.branch_id
        || current.release_id != state.run.release_id
        || current.activation_lock_id != state.run.activation_lock_id
        || current.packages != state.run.packages
        || current.budget != state.run.budget
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let world_protocol::api::WorldCommand::TestBranch(input) = operation.input.command()? else {
        return Err(EvaluationFailure::BasisChanged.into());
    };
    let digest = records::digest(&(
        "world.evaluation.operation.v1",
        tx.world(),
        &current.operation.operation_id,
    ))?;
    if state.request.id.as_str() != format!("evaluation-{}", &digest.as_str()[7..])
        || input.branch != state.submitted_branch
        || input.suite.world != state.request.world
        || input.suite.id != state.request.suite.id
        || input.suite.revision != state.request.suite.revision
        || input.budget != state.request.budget
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    Ok(())
}

async fn unsettled_steps(
    tx: &WorldTransaction<'_>,
    run: &owner::RunRecord,
    awaited: &BTreeSet<StepId>,
) -> Result<bool, Error> {
    let mut after = String::new();
    loop {
        let rows = tx.query("SELECT step_id,body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id>$4 ORDER BY step_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("step_id");
            let step: owner::StepRecord = records::decode(row.get("body"))?;
            if step.id.as_str() != after || step.run_id != run.id {
                return Err(EvaluationFailure::BasisChanged.into());
            }
            if step
                .failure
                .as_ref()
                .is_some_and(|failure| owner::unresolved_failure_phase(&failure.details).is_some())
            {
                return Ok(true);
            }
            if step.kind == "world.evaluation.case"
                && awaited.contains(&step.id)
                && step.phase == OperationPhase::Running
                && step.result.is_none()
                && step.failure.is_none()
            {
                continue;
            }
            if !matches!(
                step.phase,
                OperationPhase::Completed | OperationPhase::Failed
            ) || step.kind == "world.evaluation.oracle_custody" && step.result.is_none()
            {
                return Ok(true);
            }
        }
        if done {
            return Ok(false);
        }
    }
}
