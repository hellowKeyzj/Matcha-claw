use serde::{Deserialize, Serialize};
use world_protocol::{
    api::ApiFailure,
    budget::{Budget, Usage},
    failure::{Failure, FailureStage, Recovery},
    ids::*,
    operation::{OperationAccepted, OperationFailure, OperationPhase},
    time::Timestamp,
};
use crate::{authorization::{Admission, AuthorityRoot, recheck}, extensions::{bindings::read_graph_in_transaction, package::{RetentionOwner, retain_packages, release_packages}}, store::WorldTransaction};
use super::{Error, ledger};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunRecord {
    pub id: RunId,
    pub operation: OperationAccepted,
    pub revision: Revision,
    pub phase: OperationPhase,
    pub activation_lock_id: Option<ActivationLockId>,
    pub release_id: Option<ReleaseId>,
    pub branch_id: Option<BranchId>,
    pub branch_revision: Option<Revision>,
    pub packages: Vec<Digest>,
    pub budget: Budget,
    pub usage: Usage,
}

pub(crate) struct RunSpec {
    pub id: RunId,
    pub activation_lock_id: Option<ActivationLockId>,
    pub release_id: Option<ReleaseId>,
    pub branch_id: Option<BranchId>,
    pub basis: serde_json::Value,
    pub budget: Budget,
}

/// Persist the exact run basis before execution. An existing run is never silently restarted.
pub(crate) async fn start(
    tx: &mut WorldTransaction<'_>, admission: &Admission, expected: &OperationAccepted,
    spec: RunSpec, now: &Timestamp,
) -> Result<RunRecord, Error> {
    recheck(tx, admission, now).await?;
    let mut operation = ledger::read(tx, &expected.operation_id).await?;
    if operation.receipt.accepted != *expected || operation.receipt.progress.run_id.is_some()
        || ledger::terminal(operation.receipt.phase) || expected.world != *tx.world() {
        return Err(conflict());
    }
    if spec.budget.max_wall_time.0 == 0 || spec.budget.max_steps == 0
        || spec.budget.deadline.as_ref().is_some_and(|deadline| deadline <= now) {
        return Err(Error::new("world.invalid_run_budget", FailureStage::Admission,
            "执行预算或截止时间无效。", ApiFailure::Input(world_protocol::failure::InputFailure::InvalidValue {
                field: world_protocol::failure::FieldPath(vec!["budget".into()]),
            }), Recovery::None));
    }
    if let ledger::OperationInput::Maintenance(input) = &operation.input {
        if spec.activation_lock_id.is_some() || spec.release_id.is_some() || spec.branch_id.is_some()
            || crate::definitions::canonical_digest(&input.basis)? != crate::definitions::canonical_digest(&spec.basis)? { return Err(conflict()); }
    }
    let branch_revision = match &spec.branch_id {
        Some(id) => {
            let pinned = match &operation.input {
                ledger::OperationInput::Command(input) => match &input.command {
                    world_protocol::api::WorldCommand::ResolveTask(request) => crate::abstraction::read(tx, &request.abstraction_id, request.abstraction_revision)
                        .await?.ok_or_else(conflict)?.branch,
                    world_protocol::api::WorldCommand::EvaluateRule(_) => {
                        let basis: super::workflows::facts::RuleRunBasis = serde_json::from_value(spec.basis.clone())
                            .map_err(|cause| conflict().caused(cause))?;
                        basis.rule_plan.branch
                    },
                    command => command_branch(command).cloned(),
                },
                ledger::OperationInput::Maintenance(_) => None,
            };
            let branch = if let Some(reference) = pinned {
                if reference.world != *tx.world() || reference.id != *id { return Err(conflict()); }
                crate::releases::read_branch_revision(tx, &reference).await?
            } else {
                crate::releases::read_branch(tx, id).await?
            }.ok_or_else(conflict)?;
            Some(branch.revision)
        }
        None => None,
    };
    let packages = match &spec.activation_lock_id {
        Some(lock) => read_graph_in_transaction(tx, lock).await.map_err(binding_error)?.lock().nodes.iter()
            .map(|node| node.implementation.package_digest.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect(),
        None => Vec::new(),
    };
    let mut run = RunRecord {
        id: spec.id, operation: expected.clone(), revision: Revision(1), phase: OperationPhase::Admitted,
        activation_lock_id: spec.activation_lock_id, release_id: spec.release_id, branch_id: spec.branch_id,
        branch_revision, packages, budget: spec.budget, usage: Usage {
            elapsed: world_protocol::time::DurationMs(0), steps: 0, source_reads: 0, rows: 0, bytes: 0,
            model_calls: 0, input_tokens: 0, output_tokens: 0, cost: None,
        },
    };
    operation.receipt.phase = OperationPhase::Admitted;
    operation.receipt.progress.run_id = Some(run.id.clone());
    ledger::save(tx, &mut operation, now).await?;
    run.operation = operation.receipt.accepted;
    let world = tx.world();
    tx.execute(
        "INSERT INTO world_run(tenant_id,world_id,run_id,operation_id,revision,kind,phase,activation_lock_id,release_id,branch_id,branch_revision,basis,budget,usage,body) VALUES($1,$2,$3,$4,1,$5,'admitted',$6,$7,$8,$9,$10,$11,$12,$13)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.id.as_str(), &expected.operation_id.as_str(),
          &operation.input.operation_name(), &run.activation_lock_id.as_ref().map(ActivationLockId::as_str),
          &run.release_id.as_ref().map(ReleaseId::as_str), &run.branch_id.as_ref().map(BranchId::as_str),
          &run.branch_revision.map(|revision| revision.0 as i64), &spec.basis, &encode(&run.budget)?, &encode(&run.usage)?, &encode(&run)?],
    ).await?;
    retain_packages(tx, RetentionOwner::Run(&run.id), Revision(1), &run.packages).await?;
    Ok(run)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StepRecord {
    pub id: StepId,
    pub run_id: RunId,
    pub revision: Revision,
    pub ordinal: u32,
    pub kind: String,
    pub input_digest: Digest,
    pub writer_epoch: WriterEpoch,
    pub attempt: u32,
    pub phase: OperationPhase,
    pub checkpoint: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub failure: Option<Failure<OperationFailure>>,
}

pub(crate) async fn claim_step(
    tx: &mut WorldTransaction<'_>, admission: &Admission, run: &RunRecord,
    id: StepId, ordinal: u32, kind: &str, input_digest: Digest, now: &Timestamp,
) -> Result<StepRecord, Error> {
    recheck(tx, admission, now).await?;
    if run.operation.world != *tx.world() || ordinal as u64 >= run.budget.max_steps
        || ordinal > i32::MAX as u32 || kind.is_empty() || kind.len() > 256 {
        return Err(conflict());
    }
    let current = read_run(tx, &run.id).await?;
    if current.operation.operation_id != run.operation.operation_id || current.activation_lock_id != run.activation_lock_id
        || current.packages != run.packages || current.branch_id != run.branch_id || current.branch_revision != run.branch_revision || current.release_id != run.release_id {
        return Err(conflict());
    }
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    if operation.receipt.progress.run_id.as_ref() != Some(&run.id) || ledger::terminal(operation.receipt.phase)
        || operation.receipt.cancellation != world_protocol::operation::CancellationState::NotRequested {
        return Err(conflict());
    }
    let step = StepRecord {
        id, run_id: run.id.clone(), revision: Revision(1), ordinal, kind: kind.into(), input_digest,
        writer_epoch: tx.fences().iter().find(|fence| fence.domain.as_str() == "operation")
            .ok_or_else(|| Error::internal(FailureStage::Admission))?.epoch, attempt: 0, phase: OperationPhase::Running,
        checkpoint: serde_json::Value::Null, result: None, failure: None,
    };
    let world = tx.world();
    let changed = tx.execute(
        "INSERT INTO world_step(tenant_id,world_id,run_id,step_id,revision,ordinal,kind,phase,input_digest,writer_epoch,attempt,body) VALUES($1,$2,$3,$4,1,$5,$6,'running',$7,$8,0,$9) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.id.as_str(), &step.id.as_str(),
          &(ordinal as i32), &kind, &step.input_digest.as_str(), &(step.writer_epoch.0 as i64), &encode(&step)?],
    ).await?;
    // A claimed step without a result may already have produced an effect. Recovery inspects it.
    if changed != 1 { return Err(conflict()); }
    retain_packages(tx, RetentionOwner::Step(&step.id), Revision(1), &current.packages).await?;
    Ok(step)
}

pub(crate) async fn read_step(
    tx: &WorldTransaction<'_>, run_id: &RunId, step_id: &StepId,
) -> Result<Option<StepRecord>, Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run_id.as_str(), &step_id.as_str()],
    ).await?;
    let step: Option<StepRecord> = row.map(|row| serde_json::from_value(row.get("body")))
        .transpose().map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    if step.as_ref().is_some_and(|step| &step.id != step_id || &step.run_id != run_id) {
        return Err(Error::internal(FailureStage::Read));
    }
    Ok(step)
}

pub(crate) async fn read_step_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>, run_id: &RunId, step_id: &StepId,
) -> Result<Option<StepRecord>, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run_id.as_str(), &step_id.as_str()],
    ).await?;
    let step: Option<StepRecord> = row.map(|row| serde_json::from_value(row.get("body")))
        .transpose().map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    if step.as_ref().is_some_and(|step| &step.id != step_id || &step.run_id != run_id) {
        return Err(Error::internal(FailureStage::Read));
    }
    Ok(step)
}

pub(crate) async fn checkpoint_step(
    tx: &WorldTransaction<'_>, expected: &StepRecord, mut next: StepRecord,
) -> Result<StepRecord, Error> {
    if expected.id != next.id || expected.run_id != next.run_id || expected.input_digest != next.input_digest
        || expected.writer_epoch != next.writer_epoch || expected.ordinal != next.ordinal
        || expected.kind != next.kind || expected.attempt != next.attempt || ledger::terminal(expected.phase) {
        return Err(conflict());
    }
    next.revision = Revision(expected.revision.0.checked_add(1).filter(|next| *next <= i64::MAX as u64)
        .ok_or_else(|| Error::internal(FailureStage::Commit))?);
    let phase = encode(&next.phase)?;
    let phase = phase.as_str().ok_or_else(|| Error::internal(FailureStage::Commit))?;
    let world = tx.world();
    let changed = tx.execute(
        "UPDATE world_step SET revision=$5,phase=$6,body=$7,result=$8,failure=$9 WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4 AND revision=$10 AND writer_epoch=$11",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &next.run_id.as_str(), &next.id.as_str(),
          &(next.revision.0 as i64), &phase, &encode(&next)?, &next.result,
          &next.failure.as_ref().map(encode).transpose()?, &(expected.revision.0 as i64), &(expected.writer_epoch.0 as i64)],
    ).await?;
    if changed != 1 { return Err(conflict()); }
    Ok(next)
}

pub(crate) async fn read_run(tx: &WorldTransaction<'_>, id: &RunId) -> Result<RunRecord, Error> {
    let world = tx.world();
    let index = tx.query_opt("SELECT operation_id FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(conflict)?;
    let operation_id = OperationId::try_new(index.get::<_, String>("operation_id"))
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    let operation = ledger::read(tx, &operation_id).await?;
    let row = tx.query_opt("SELECT operation_id,branch_id,branch_revision,body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(conflict)?;
    decode_run(world, id, &operation, &row)
}

pub(crate) async fn read_run_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>, id: &RunId,
) -> Result<RunRecord, Error> {
    let world = snapshot.world();
    let index = snapshot.query_opt("SELECT operation_id FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(conflict)?;
    let operation_id = OperationId::try_new(index.get::<_, String>("operation_id"))
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    let operation = ledger::read_record_snapshot(snapshot, &operation_id).await?;
    let row = snapshot.query_opt("SELECT operation_id,branch_id,branch_revision,body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(conflict)?;
    decode_run(world, id, &operation, &row)
}

fn decode_run(
    world: &WorldRef, id: &RunId, operation: &ledger::OperationRecord, row: &tokio_postgres::Row,
) -> Result<RunRecord, Error> {
    let run: RunRecord = serde_json::from_value(row.get("body"))
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    if run.id != *id || run.operation.world != *world || run.operation.operation_id != operation.receipt.accepted.operation_id
        || run.operation.operation_id.as_str() != row.get::<_, String>("operation_id")
        || run.operation.incarnation != operation.receipt.accepted.incarnation
        || run.branch_id.is_some() != run.branch_revision.is_some()
        || run.branch_id.as_ref().map(BranchId::as_str) != row.get::<_, Option<String>>("branch_id").as_deref()
        || run.branch_revision.map(|revision| revision.0 as i64) != row.get::<_, Option<i64>>("branch_revision")
        || operation.receipt.progress.run_id.as_ref() != Some(id) { return Err(Error::internal(FailureStage::Read)); }
    Ok(run)
}

pub(crate) async fn require_run_invocation(
    tx: &WorldTransaction<'_>, admission: &Admission, id: &RunId,
) -> Result<RunRecord, Error> {
    let run = read_run(tx, id).await?;
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    operation.identity.require_resume(admission.verified())?;
    if operation.receipt.progress.run_id.as_ref() != Some(id)
        || run.branch_id != admission.invocation().branch_id {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    recheck(tx, admission, &tx.now().await?).await?;
    Ok(run)
}

/// Extend the original parse run and step custody atomically, never only the retention index.
pub(crate) async fn retain_run_packages(
    tx: &WorldTransaction<'_>, admission: &Admission, expected: &RunRecord,
    step: &StepRecord, packages: &[Digest],
) -> Result<RunRecord, Error> {
    let mut run = require_run_invocation(tx, admission, &expected.id).await?;
    if crate::definitions::canonical_digest(&run)? != crate::definitions::canonical_digest(expected)?
        || ledger::terminal(run.phase) || step.run_id != run.id || ledger::terminal(step.phase) {
        return Err(conflict());
    }
    let current = read_step(tx, &run.id, &step.id).await?.ok_or_else(conflict)?;
    if crate::definitions::canonical_digest(&current)? != crate::definitions::canonical_digest(step)? { return Err(conflict()); }
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    let world_protocol::api::WorldCommand::ImportMaterials(request) = operation.input.command()? else { return Err(conflict()); };
    if current.input_digest != crate::definitions::canonical_digest(request)? { return Err(conflict()); }
    let material = super::workflows::materials::read_material_implementation(&current)?;
    let implementation = &material.implementation;
    let world = tx.world();
    let row = tx.query_opt("SELECT revision,phase,pending_removal,package_digest,install_lock,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.install_id.as_str()]).await?.ok_or_else(conflict)?;
    let record: world_protocol::package::InstalledRecord = serde_json::from_value(row.get("body"))
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    if record.world != *world || record.install_id != implementation.install_id || record.package_digest != implementation.package_digest
        || row.get::<_, String>("phase") != "installed" || row.get::<_, bool>("pending_removal")
        || record.revision.0 != row.get::<_, i64>("revision") as u64
        || row.get::<_, Option<String>>("package_digest").as_deref() != Some(record.package_digest.as_str())
        || encode(&record.lock)? != row.get::<_, serde_json::Value>("install_lock")
        || record.lock.digest != implementation.dependency_lock
        || world_protocol::package::install_lock_digest(&record.lock.packages, &record.lock.contracts, &record.lock.artifacts)
            .map_err(|_| conflict())? != record.lock.digest {
        return Err(conflict());
    }
    let closure: std::collections::BTreeSet<_> = record.lock.packages.iter().map(|package| package.package_digest.clone())
        .chain(std::iter::once(record.package_digest)).collect();
    let supplied: std::collections::BTreeSet<_> = packages.iter().cloned().collect();
    if supplied.len() != packages.len() || supplied != closure { return Err(conflict()); }
    run.packages = run.packages.iter().cloned().chain(closure).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    retain_packages(tx, RetentionOwner::Run(&run.id), Revision(1), &run.packages).await?;
    retain_packages(tx, RetentionOwner::Step(&current.id), Revision(1), &run.packages).await?;
    run.revision = Revision(run.revision.0.checked_add(1).filter(|next| *next <= i64::MAX as u64)
        .ok_or_else(|| Error::internal(FailureStage::Commit))?);
    if tx.execute("UPDATE world_run SET revision=$4,body=$5 WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$6",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.id.as_str(), &(run.revision.0 as i64), &encode(&run)?, &(expected.revision.0 as i64)]).await? != 1 {
        return Err(conflict());
    }
    Ok(run)
}

/// Both inputs are cumulative durable-eligible usage for the same root, not independent deltas.
pub(crate) fn confirmed_usage(durable: &Usage, mut live: Usage) -> Result<Usage, Error> {
    live.elapsed = live.elapsed.max(durable.elapsed);
    live.steps = live.steps.max(durable.steps);
    live.source_reads = live.source_reads.max(durable.source_reads);
    live.rows = live.rows.max(durable.rows);
    live.bytes = live.bytes.max(durable.bytes);
    live.model_calls = live.model_calls.max(durable.model_calls);
    live.input_tokens = live.input_tokens.max(durable.input_tokens);
    live.output_tokens = live.output_tokens.max(durable.output_tokens);
    if let Some(old) = &durable.cost {
        match &live.cost {
            Some(new) if old.currency != new.currency => return Err(conflict()),
            Some(new) if !new.amount.cmp_numeric(&old.amount).is_lt() => {},
            _ => live.cost = Some(old.clone()),
        }
    }
    Ok(live)
}

pub(crate) async fn checkpoint_usage(tx: &WorldTransaction<'_>, expected: &RunRecord, usage: Usage) -> Result<RunRecord, Error> {
    let mut run = read_run(tx, &expected.id).await?;
    if run.revision != expected.revision || run.operation.operation_id != expected.operation.operation_id
        || ledger::terminal(run.phase) || usage.elapsed < run.usage.elapsed || usage.steps < run.usage.steps
        || usage.source_reads < run.usage.source_reads || usage.rows < run.usage.rows || usage.bytes < run.usage.bytes
        || usage.model_calls < run.usage.model_calls || usage.input_tokens < run.usage.input_tokens || usage.output_tokens < run.usage.output_tokens {
        return Err(conflict());
    }
    if run.usage.cost.as_ref().is_some_and(|old| usage.cost.as_ref().is_none_or(|new| old.currency != new.currency || new.amount.cmp_numeric(&old.amount).is_lt())) { return Err(conflict()); }
    run.revision = Revision(run.revision.0.checked_add(1).filter(|next| *next <= i64::MAX as u64).ok_or_else(|| Error::internal(FailureStage::Commit))?);
    run.usage = usage;
    let world = tx.world();
    let changed = tx.execute("UPDATE world_run SET revision=$4,usage=$5,body=$6 WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$7",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.id.as_str(), &(run.revision.0 as i64), &encode(&run.usage)?, &encode(&run)?, &(expected.revision.0 as i64)]).await?;
    if changed != 1 { return Err(conflict()); }
    Ok(run)
}

pub(super) async fn fail_steps(
    tx: &WorldTransaction<'_>, run: &RunRecord, failure: &Failure<OperationFailure>, cancelled: bool,
) -> Result<(), Error> {
    fail_steps_inner(tx, run, failure, cancelled, None).await
}

pub(super) async fn fail_settled_steps(
    tx: &WorldTransaction<'_>, run: &RunRecord, failure: &Failure<OperationFailure>, cancelled: bool,
    proof: &super::settlement::SettledWorkFailure,
) -> Result<(), Error> {
    if !proof.matches(run, &ledger::read(tx, &run.operation.operation_id).await?.receipt.accepted) { return Err(conflict()); }
    fail_steps_inner(tx, run, failure, cancelled, Some(proof)).await
}

async fn fail_steps_inner(
    tx: &WorldTransaction<'_>, run: &RunRecord, failure: &Failure<OperationFailure>, cancelled: bool,
    recovered: Option<&super::settlement::SettledWorkFailure>,
) -> Result<(), Error> {
    let world = tx.world();
    let rows = tx.query("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 ORDER BY ordinal FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.id.as_str()]).await?;
    for row in rows {
        let step: StepRecord = serde_json::from_value(row.get("body"))
            .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
        if step.run_id != run.id { return Err(conflict()); }
        if ledger::terminal(step.phase) { continue; }
        let partial = step.kind == "materials.draft" && super::workflows::materials::retain_partial_step(tx, &step).await?;
        let retained = matches!(step.phase, OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Retained | OperationPhase::Draining);
        let settled = match recovered {
            Some(proof) => proof.permits_step(tx, &step).await?,
            None => !retained,
        };
        if (step.result.is_some() && !partial) || !settled { return Err(conflict()); }
        let mut next = step.clone();
        next.phase = if cancelled { OperationPhase::CancelledBeforeCommit } else { OperationPhase::Failed };
        let mut failure = failure.clone();
        failure.step_id = Some(step.id.clone());
        next.failure = Some(failure);
        checkpoint_step(tx, &step, next).await?;
    }
    Ok(())
}

pub(crate) async fn settle(tx: &WorldTransaction<'_>, receipt: &world_protocol::operation::OperationReceipt) -> Result<(), Error> {
    let Some(id) = &receipt.progress.run_id else { return Ok(()); };
    let mut run = read_run(tx, id).await?;
    if run.operation.operation_id != receipt.accepted.operation_id || ledger::terminal(run.phase) {
        return Err(conflict());
    }
    let world = tx.world();
    let unsettled = tx.query_opt("SELECT 1 FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND phase NOT IN ('completed','failed','cancelled_before_commit','cancelled_after_commit') LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.is_some();
    if ledger::terminal(receipt.phase) && unsettled { return Err(conflict()); }
    let expected = run.revision;
    run.revision = Revision(expected.0.checked_add(1).filter(|next| *next <= i64::MAX as u64).ok_or_else(|| Error::internal(FailureStage::Commit))?);
    run.operation = receipt.accepted.clone();
    run.phase = receipt.phase;
    let phase = encode(&run.phase)?;
    let phase = phase.as_str().ok_or_else(|| Error::internal(FailureStage::Commit))?;
    let changed = tx.execute("UPDATE world_run SET revision=$4,phase=$5,body=$6,terminal_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$8",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &(run.revision.0 as i64), &phase, &encode(&run)?, &ledger::terminal(run.phase), &(expected.0 as i64)]).await?;
    if changed != 1 { return Err(conflict()); }
    Ok(())
}

/// Trusted retention removal, not ordinary completion. Historical runs keep exact
/// artifacts until this transaction can remove their facts (including every FK consumer).
pub(crate) async fn delete_run_history(
    tx: &WorldTransaction<'_>, _root: &AuthorityRoot, id: &RunId, expected: Revision,
) -> Result<(), Error> {
    let run = read_run(tx, id).await?;
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    if run.revision != expected || !ledger::terminal(operation.receipt.phase) { return Err(conflict()); }
    let world = tx.world();
    let rows = tx.query("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 ORDER BY step_id FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    for row in rows {
        let step: StepRecord = serde_json::from_value(row.get("body"))
            .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
        if step.run_id != *id || !ledger::terminal(step.phase) { return Err(conflict()); }
        release_packages(tx, RetentionOwner::Step(&step.id), Revision(1), &run.packages).await?;
    }
    release_packages(tx, RetentionOwner::Run(id), Revision(1), &run.packages).await?;
    tx.execute("DELETE FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    tx.execute("DELETE FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &(expected.0 as i64)]).await?;
    Ok(())
}

pub(crate) async fn has_activation_references(tx: &WorldTransaction<'_>, lock: &ActivationLockId) -> Result<bool, Error> {
    let world = tx.world();
    Ok(tx.query_opt("SELECT 1 FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.as_str()]).await?.is_some())
}

fn command_branch(command: &world_protocol::api::WorldCommand) -> Option<&world_protocol::releases::BranchRef> {
    use world_protocol::api::WorldCommand;
    match command {
        WorldCommand::TestBranch(request) => Some(&request.branch),
        WorldCommand::DiscoverSchema(request) => request.branch.as_ref(),
        WorldCommand::SetBranchMapping(request) => Some(&request.branch),
        WorldCommand::ApproveBranchSourceAuthority(request) => Some(&request.branch),
        _ => None,
    }
}

/// Interpret only the old owner's typed evidence inside the original installation transaction.
pub(crate) async fn restore_history_migration(
    read: &crate::store::WorldMigrationRead<'_, '_>,
) -> Result<crate::store::RestoreHistoryMigration, Error> {
    use world_protocol::{commit::CommitReceipt, learning::{Candidate, ChangeSet}, releases::BranchRef};
    use crate::store::{CandidateChangeMigration, ChangeBranchMigration, RestoreHistoryMigration, RunBranchMigration};
    let world = read.world();
    let tenant = world.tenant_id.as_str();
    let world_id = world.world_id.as_str();
    let parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[&tenant, &world_id];
    let mut proof = RestoreHistoryMigration { runs: Vec::new(), changes: Vec::new(), candidates: Vec::new() };
    for row in read.query("SELECT r.run_id,r.operation_id,r.revision,r.branch_id,r.basis,r.body,o.body AS operation_body FROM world_run r JOIN world_operation o USING(tenant_id,world_id,operation_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.branch_id IS NOT NULL ORDER BY r.run_id", parameters).await? {
        let run: RunRecord = migration_decode(row.get("body"), "run")?;
        let operation: ledger::OperationRecord = migration_decode(row.get("operation_body"), "run.operation")?;
        if run.id.as_str() != row.get::<_, String>("run_id") || run.revision.0 != row.get::<_, i64>("revision") as u64
            || run.operation.world != *world || run.operation.operation_id.as_str() != row.get::<_, String>("operation_id")
            || operation.receipt.accepted.world != *world || operation.receipt.accepted.operation_id != run.operation.operation_id
            || operation.receipt.accepted.incarnation != run.operation.incarnation || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
            || operation.input.world() != world || run.branch_id.as_ref().map(BranchId::as_str) != Some(row.get::<_, String>("branch_id").as_str()) {
            return Err(migration_failure("run.identity"));
        }
        let ledger::OperationInput::Command(input) = &operation.input else { return Err(migration_failure("run.command")); };
        let basis: world_protocol::api::WorldCommand = migration_decode(row.get("basis"), "run.basis")?;
        if basis != input.command { return Err(migration_failure("run.basis")); }
        let branch = match &basis {
            world_protocol::api::WorldCommand::ResolveTask(request) => {
                let row = read.query_opt("SELECT body FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND abstraction_id=$3 AND revision=$4",
                    &[&tenant, &world_id, &request.abstraction_id.as_str(), &(request.abstraction_revision.0 as i64)]).await?
                    .ok_or_else(|| migration_failure("run.abstraction"))?;
                let contract = crate::abstraction::decode_revision(row.get("body"))
                    .map_err(|cause| migration_failure("run.abstraction").caused(cause))?;
                if contract.world != *world || contract.id != request.abstraction_id || contract.revision != request.abstraction_revision {
                    return Err(migration_failure("run.abstraction"));
                }
                contract.branch
            }
            command => command_branch(command).cloned(),
        }.ok_or_else(|| migration_failure(&format!("run.{}.branchRevision.evidence", run.id)))?;
        if branch.world != *world || run.branch_id.as_ref() != Some(&branch.id)
            || run.branch_revision.is_some_and(|revision| revision != branch.revision) {
            return Err(migration_failure("run.branchRevision"));
        }
        proof.runs.push(RunBranchMigration { id: run.id, branch });
    }
    let receipts = read.query("SELECT commit_id,receipt FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND committed_at IS NOT NULL ORDER BY commit_id", parameters).await?
        .into_iter().map(|row| {
            let receipt: CommitReceipt = migration_decode(row.get("receipt"), "commit.receipt")?;
            if receipt.world != *world || receipt.commit_id.as_str() != row.get::<_, String>("commit_id") { return Err(migration_failure("commit.identity")); }
            Ok(receipt)
        }).collect::<Result<Vec<_>, Error>>()?;
    for row in read.query("SELECT change_set_id,revision,branch_id,content_digest,body FROM world_change_set WHERE tenant_id=$1 AND world_id=$2 ORDER BY change_set_id,revision", parameters).await? {
        let change: ChangeSet = migration_decode(row.get("body"), "changeSet")?;
        if change.world != *world || change.id.as_str() != row.get::<_, String>("change_set_id")
            || change.revision.0 != row.get::<_, i64>("revision") as u64
            || crate::definitions::canonical_digest(&change)?.as_str() != row.get::<_, String>("content_digest") {
            return Err(migration_failure("changeSet.identity"));
        }
        let id = BranchId::try_new(row.get::<_, String>("branch_id")).map_err(|_| migration_failure("changeSet.branch"))?;
        let mut branch = None;
        for receipt in &receipts {
            if !receipt.revisions.iter().any(|revision| revision.resource == (ResourceRef::ChangeSet { id: change.id.clone() }) && revision.revision == change.revision) { continue; }
            let mut revisions = receipt.revisions.iter().filter(|revision| revision.resource == (ResourceRef::Branch { id: id.clone() }));
            let revision = revisions.next().ok_or_else(|| migration_failure("changeSet.birth.branch"))?.revision;
            if revisions.next().is_some() || branch.is_some() { return Err(migration_failure("changeSet.birth.ambiguous")); }
            let reference = BranchRef { world: world.clone(), id: id.clone(), revision };
            let row = read.query_opt("SELECT body FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND revision=$4",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &(revision.0 as i64)]).await?
                .ok_or_else(|| migration_failure("changeSet.birth.target"))?;
            let target: world_protocol::releases::WorldBranch = migration_decode(row.get("body"), "changeSet.birth.target")?;
            if target.world != *world || target.id != id || target.revision != revision || target.change_set_id != change.id
                || target.basis.release_id != change.base_release || target.basis.overlay != change.operations || target.status != change.status {
                return Err(migration_failure("changeSet.birth.target"));
            }
            branch = Some(reference);
        }
        let branch = branch.ok_or_else(|| migration_failure(&format!("changeSet.{}.{}.birth.evidence", change.id, change.revision.0)))?;
        proof.changes.push(ChangeBranchMigration { id: change.id, revision: change.revision, branch });
    }
    for row in read.query("SELECT candidate_id,revision,content_digest,body FROM world_candidate WHERE tenant_id=$1 AND world_id=$2 ORDER BY candidate_id", parameters).await? {
        let candidate: Candidate = migration_decode(row.get("body"), "candidate")?;
        if candidate.world != *world || candidate.change_set.world != *world || candidate.id.as_str() != row.get::<_, String>("candidate_id")
            || candidate.change_set.revision.0 != row.get::<_, i64>("revision") as u64
            || crate::definitions::canonical_digest(&candidate)?.as_str() != row.get::<_, String>("content_digest") {
            return Err(migration_failure("candidate.identity"));
        }
        proof.candidates.push(CandidateChangeMigration { id: candidate.id, change_set_id: candidate.change_set.id, revision: candidate.change_set.revision });
    }
    Ok(proof)
}

fn migration_decode<T: serde::de::DeserializeOwned>(value: serde_json::Value, field: &str) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|cause| migration_failure(field).caused(cause))
}
fn migration_failure(field: &str) -> Error {
    Error::new("world.restore_history_evidence_missing", FailureStage::Prepare,
        "历史记录缺少可验证的精确分支证据，不能安装恢复结构。",
        ApiFailure::Input(world_protocol::failure::InputFailure::InvalidValue {
            field: world_protocol::failure::FieldPath(vec![field.into()]),
        }), Recovery::ManualReview)
}

fn binding_error(error: crate::extensions::bindings::BindingError) -> Error {
    use crate::extensions::bindings::BindingError;
    match error {
        BindingError::Store(error) => error.into(),
        BindingError::Authorization(error) => error.into(),
        BindingError::Operation(error) => error,
        BindingError::PackageOperation(error) => error.into(),
        BindingError::Binding(failure) => Error::new("world.binding.failed", FailureStage::Admission,
            "执行绑定不可用。", ApiFailure::Operation(world_protocol::operation::OperationFailure::Binding(failure)), Recovery::Refresh),
        other => Error::internal(FailureStage::Admission).caused(other),
    }
}

fn conflict() -> Error {
    Error::new("world.run_basis_conflict", FailureStage::Recover,
        "执行身份、检查点或归属已变化，不能重复执行。", ApiFailure::RevisionConflict, Recovery::Refresh)
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))
}
