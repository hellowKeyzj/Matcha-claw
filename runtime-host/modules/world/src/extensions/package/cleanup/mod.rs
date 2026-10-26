mod candidates;
mod checkpoint;

use serde::{Deserialize, Serialize};
use world_protocol::{
    budget::BudgetDimension,
    failure::FailureStage,
    ids::{OperationId, RunId},
    package::PackageFailure,
};

use super::{Inventory, PackageError};
use crate::{
    authorization,
    owner::{self, ExecutionContext},
    store::{Committed, TransactionError},
};
use candidates::{Candidate, require_unretained};
pub(crate) use candidates::{
    PackageCleanupBatch, cleanup_batch_finished, cleanup_candidates, cleanup_impact,
};
use checkpoint::Entry;
pub(crate) use checkpoint::PackageCleanupCheckpoint;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Outcome {
    Removed,
    Failed { reason: PackageFailure },
}

pub(crate) enum PackageCleanupObservation {
    Pending,
    Completed,
    Incomplete,
    Failed(PackageFailure),
}

pub(crate) async fn observe_cleanup(
    snapshot: &crate::store::WorldSnapshot<'_>,
    batch: &PackageCleanupBatch,
    checkpoint: &PackageCleanupCheckpoint,
) -> Result<PackageCleanupObservation, owner::Error> {
    checkpoint.validate(batch)?;
    if batch.world() != snapshot.world() {
        return Err(invalid());
    }
    let mut failure = None;
    let mut removed = 0;
    for entry in &checkpoint.entries {
        let row = snapshot.query_opt("SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3 AND committed_at IS NOT NULL",
            &[&batch.world().tenant_id.as_str(), &batch.world().world_id.as_str(), &entry.finish.commit_id.as_str()]).await?;
        let Some(row) = row else {
            return Ok(PackageCleanupObservation::Pending);
        };
        let receipt: world_protocol::commit::CommitReceipt =
            serde_json::from_value(row.get("receipt")).map_err(|cause| invalid().caused(cause))?;
        let outcome: Outcome =
            serde_json::from_value(row.get("result")).map_err(|cause| invalid().caused(cause))?;
        if row.get::<_, String>("input_digest") != entry.finish.input_digest.as_str()
            || receipt.world != *batch.world()
            || receipt.commit_id != entry.finish.commit_id
            || !entry.finish.fences.contains(&receipt.fence)
            || entry
                .outcome
                .as_ref()
                .is_some_and(|recorded| recorded != &outcome)
        {
            return Err(invalid());
        }
        match outcome {
            Outcome::Removed => removed += 1,
            Outcome::Failed { reason } => {
                failure.get_or_insert(reason);
            }
        }
    }
    Ok(match failure {
        Some(reason) => PackageCleanupObservation::Failed(reason),
        None if !batch.is_empty() && removed == batch.candidates.len() => {
            PackageCleanupObservation::Completed
        }
        None => PackageCleanupObservation::Incomplete,
    })
}

pub(super) struct CleanupCustody {
    operation: OperationId,
    run: RunId,
    batch: PackageCleanupBatch,
    recovery: Vec<Entry>,
    next: usize,
    attempt: Option<Attempt>,
}

struct Attempt {
    entry: Entry,
    claimed: bool,
    physical: Option<Outcome>,
    unknown: bool,
    recovered: bool,
}

impl Attempt {
    async fn new(
        ctx: &ExecutionContext,
        batch: &PackageCleanupBatch,
        candidate: &Candidate,
        token: Option<String>,
    ) -> Result<Self, owner::Error> {
        check(ctx)?;
        ctx.budget
            .charge(BudgetDimension::Steps, 1)
            .map_err(|failure| {
                owner::Error::from_host_failure(
                    world_protocol::process::HostFailure::BudgetExceeded {
                        dimension: failure.dimension,
                    },
                    FailureStage::Admission,
                )
            })?;
        let token = token.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let input = crate::definitions::canonical_digest(&(batch.world(), candidate, &token))?;
        let key = format!("package.cleanup.{}", candidate.package);
        Ok(Self {
            entry: Entry {
                package: candidate.package.clone(),
                token,
                generation: candidate.generation,
                operation: ctx.operation.operation_id.clone(),
                run: ctx.run.id.clone(),
                claim: ctx
                    .commit_request(&format!("{key}.claim"), input.clone(), &["packages"])
                    .await?,
                pending: ctx
                    .commit_request(&format!("{key}.pending"), input.clone(), &["packages"])
                    .await?,
                finish: ctx
                    .commit_request(&format!("{key}.finish"), input, &["packages"])
                    .await?,
                started: false,
                outcome: None,
            },
            claimed: false,
            physical: None,
            unknown: false,
            recovered: false,
        })
    }

    fn outcome<T>(
        &mut self,
        result: Result<T, TransactionError<owner::Error>>,
    ) -> Result<T, owner::Error> {
        self.unknown = matches!(&result, Err(TransactionError::Indeterminate(_)))
            || matches!(&result, Err(TransactionError::NotCommitted { error, .. }) if error.unresolved_phase().is_some());
        result.map_err(Into::into)
    }
}

impl Inventory {
    pub(crate) async fn has_cleanup_pending(&self) -> bool {
        self.cleanup.lock().await.is_some()
    }

    pub(crate) async fn finish_cleanup(
        &self,
        ctx: &ExecutionContext,
        batch: &PackageCleanupBatch,
    ) -> Result<(), owner::Error> {
        batch.validate()?;
        self.require_world(batch.world())?;
        if ctx.operation.world != *batch.world() || ctx.run.operation != ctx.operation {
            return Err(invalid());
        }
        let mut guard = self.cleanup.lock().await;
        let Some(pending) = guard.as_mut() else {
            return Ok(());
        };
        if pending.operation != ctx.operation.operation_id
            || pending.run != ctx.run.id
            || pending.batch.input_digest()? != batch.input_digest()?
        {
            return Err(retained());
        }
        let Some(attempt) = pending.attempt.as_mut() else {
            return Ok(());
        };
        if attempt.physical.is_none() {
            return Ok(());
        }
        let _mutation = self.mutation.lock().await;
        self.finish_one(ctx, batch, attempt).await?;
        // Only the held outcome is settled; remaining candidates never start here.
        *guard = None;
        Ok(())
    }

    pub(crate) async fn cleanup_batch(
        &self,
        ctx: &ExecutionContext,
        batch: PackageCleanupBatch,
    ) -> Result<(), owner::Error> {
        batch.validate()?;
        self.require_world(batch.world())?;
        if ctx.operation.world != *batch.world() || ctx.run.operation != ctx.operation {
            return Err(invalid());
        }
        let mut guard = self.cleanup.lock().await;
        if let Some(pending) = guard.as_ref() {
            if pending.operation != ctx.operation.operation_id
                || pending.run != ctx.run.id
                || pending.batch.input_digest()? != batch.input_digest()?
            {
                return Err(retained());
            }
        } else {
            *guard = Some(CleanupCustody {
                operation: ctx.operation.operation_id.clone(),
                run: ctx.run.id.clone(),
                recovery: checkpoint::recover(ctx, &batch).await?,
                batch,
                next: 0,
                attempt: None,
            });
        }
        let pending = guard.as_mut().expect("package cleanup custody installed");
        let result = self.execute_cleanup(ctx, pending).await;
        let held = pending.attempt.as_ref().is_some_and(|attempt| {
            attempt.unknown || attempt.entry.started || attempt.physical.is_some()
        });
        if result.is_ok()
            || (!held
                && result
                    .as_ref()
                    .err()
                    .is_none_or(|error| error.unresolved_phase().is_none()))
        {
            *guard = None;
        }
        result
    }

    async fn execute_cleanup(
        &self,
        ctx: &ExecutionContext,
        pending: &mut CleanupCustody,
    ) -> Result<(), owner::Error> {
        let _mutation = self.mutation.lock().await;
        while pending.next < pending.batch.candidates.len() {
            let candidate = pending.batch.candidates[pending.next].clone();
            if pending.attempt.is_none() {
                let entry = pending
                    .recovery
                    .iter()
                    .find(|entry| entry.package == candidate.package)
                    .cloned();
                let entry = match entry {
                    Some(entry) => Some(entry),
                    None => {
                        let batch = pending.batch.clone();
                        let package = candidate.package.clone();
                        ctx.store
                            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                                Box::pin(async move {
                                    checkpoint::previous(snapshot, &batch, &package).await
                                })
                            })
                            .await?
                    }
                };
                let mut retry_token = None;
                if let Some(entry) = entry {
                    if candidate
                        .token
                        .as_ref()
                        .is_some_and(|token| token != &entry.token)
                    {
                        return Err(retained());
                    }
                    let finished = ctx
                        .store
                        .read_commit_optional::<Outcome>(
                            &ctx.operation.world,
                            &entry.finish.commit_id,
                            &entry.finish.input_digest,
                        )
                        .await?;
                    if let Some(finished) = finished {
                        match finished.value {
                            Outcome::Removed => {
                                pending.next += 1;
                                continue;
                            }
                            Outcome::Failed { reason } => {
                                if entry.operation == ctx.operation.operation_id
                                    && entry.run == ctx.run.id
                                {
                                    return Err(PackageError::new(reason).into());
                                }
                                retry_token = Some(entry.token);
                            }
                        }
                    } else {
                        let recovered = entry.operation != ctx.operation.operation_id
                            || entry.run != ctx.run.id
                            || entry.started;
                        pending.attempt = Some(Attempt {
                            entry,
                            claimed: true,
                            physical: None,
                            unknown: recovered,
                            recovered,
                        });
                    }
                } else {
                    let package = candidate.package.clone();
                    let state = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
                        let world = snapshot.world();
                        let row = snapshot.query_opt("SELECT state FROM world_package_gc WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
                            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str()]).await?.ok_or_else(invalid)?;
                        Ok::<_, owner::Error>(row.get::<_, String>("state"))
                    })).await?;
                    if state != "live" {
                        return Err(retained());
                    }
                }
                if pending.attempt.is_none() {
                    pending.attempt =
                        Some(Attempt::new(ctx, &pending.batch, &candidate, retry_token).await?);
                }
            }
            let attempt = pending
                .attempt
                .as_mut()
                .expect("package cleanup attempt installed");
            let outcome = self
                .cleanup_one(ctx, &pending.batch, &candidate, attempt)
                .await?;
            pending.attempt = None;
            pending.next += 1;
            if let Outcome::Failed { reason } = outcome {
                return Err(PackageError::new(reason).into());
            }
        }
        Ok(())
    }

    async fn cleanup_one(
        &self,
        ctx: &ExecutionContext,
        batch: &PackageCleanupBatch,
        candidate: &Candidate,
        attempt: &mut Attempt,
    ) -> Result<Outcome, owner::Error> {
        if attempt.recovered {
            let admission = ctx.admission.clone();
            ctx.store
                .snapshot(ctx.operation.world.clone(), move |snapshot| {
                    Box::pin(async move {
                        let now = snapshot.now().await?;
                        authorization::recheck_read(snapshot, &admission, &now).await?;
                        Ok::<_, owner::Error>(())
                    })
                })
                .await?;
            return match ctx
                .store
                .read_commit_optional::<Outcome>(
                    &ctx.operation.world,
                    &attempt.entry.finish.commit_id,
                    &attempt.entry.finish.input_digest,
                )
                .await?
            {
                Some(committed) => Ok(committed.value),
                // Absence cannot establish rollback or whether the old unlink ran.
                None => Err(retained()),
            };
        }
        if !attempt.claimed {
            if !attempt.unknown {
                check(ctx)?;
                if self.files.is_live(&candidate.package) {
                    return Err(PackageError::new(PackageFailure::RetainedReferences).into());
                }
            }
            let candidate = candidate.clone();
            let batch = batch.clone();
            let entry = attempt.entry.clone();
            let result = ctx.transact_outcome(entry.claim.clone(), move |tx, admission, _, run| Box::pin(async move {
                admission.require_access(&cleanup_impact(tx, &batch).await?)?;
                let world = tx.world();
                let row = tx.query_opt("SELECT g.state,g.generation,g.claim_token,p.transport_digest FROM world_package_gc g JOIN world_package p USING(tenant_id,world_id,package_digest) WHERE g.tenant_id=$1 AND g.world_id=$2 AND g.package_digest=$3 FOR UPDATE OF g",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str()]).await?.ok_or_else(invalid)?;
                if row.get::<_, String>("transport_digest") != candidate.transport.as_str() { return Err(invalid()); }
                require_unretained(tx, &candidate).await?;
                let generation: i64 = row.get("generation");
                let state: String = row.get("state");
                if state == "live" && generation.checked_add(1) == Some(entry.generation) {
                    tx.execute("UPDATE world_package_gc SET state='claimed',generation=$4,claim_token=$5,failure_code=NULL,failure_stage=NULL WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
                        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str(), &entry.generation, &entry.token]).await?;
                } else if !matches!(state.as_str(), "claimed" | "pending_removal") || generation != entry.generation
                    || row.get::<_, Option<String>>("claim_token").as_deref() != Some(entry.token.as_str()) { return Err(retained()); }
                tx.execute("UPDATE world_package_install SET pending_removal=true WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND phase='uninstalled'",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str()]).await?;
                checkpoint::record(tx, &run.id, &batch, entry).await?;
                Ok(())
            })).await;
            attempt.outcome(result)?;
            attempt.claimed = true;
        }
        if !attempt.entry.started {
            if !attempt.unknown {
                check(ctx)?;
            }
            let candidate = candidate.clone();
            let batch = batch.clone();
            let mut entry = attempt.entry.clone();
            entry.started = true;
            let result = ctx.transact_outcome(entry.pending.clone(), move |tx, admission, _, run| Box::pin(async move {
                admission.require_access(&cleanup_impact(tx, &batch).await?)?;
                let world = tx.world();
                let changed = tx.execute("UPDATE world_package_gc SET state='pending_removal',failure_code=NULL,failure_stage='cleanup' WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND claim_token=$4 AND generation=$5 AND state IN('claimed','pending_removal')",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str(), &entry.token, &entry.generation]).await?;
                if changed != 1 { return Err(retained()); }
                require_unretained(tx, &candidate).await?;
                checkpoint::record(tx, &run.id, &batch, entry).await?;
                Ok(())
            })).await;
            attempt.outcome(result)?;
            attempt.entry.started = true;
        }
        if attempt.physical.is_none() && self.files.is_live(&candidate.package) {
            return Err(PackageError::new(PackageFailure::RetainedReferences).into());
        }
        if attempt.physical.is_none() {
            check(ctx)?;
            let admission = ctx.admission.clone();
            ctx.store
                .snapshot(ctx.operation.world.clone(), move |snapshot| {
                    Box::pin(async move {
                        let now = snapshot.now().await?;
                        authorization::recheck_read(snapshot, &admission, &now).await?;
                        Ok::<_, owner::Error>(())
                    })
                })
                .await?;
            // The owning task awaits the whole unlink; observer loss cannot drop its result.
            attempt.physical = Some(
                match self.files.remove(&candidate.package, &ctx.cancellation) {
                    Ok(()) => Outcome::Removed,
                    Err(error) => Outcome::Failed {
                        reason: error.reason,
                    },
                },
            );
        }
        self.finish_one(ctx, batch, attempt).await
    }

    async fn finish_one(
        &self,
        ctx: &ExecutionContext,
        batch: &PackageCleanupBatch,
        attempt: &mut Attempt,
    ) -> Result<Outcome, owner::Error> {
        if !attempt.entry.started
            || attempt.entry.operation != ctx.operation.operation_id
            || attempt.entry.run != ctx.run.id
        {
            return Err(invalid());
        }
        let outcome = attempt.physical.as_ref().ok_or_else(retained)?.clone();
        let batch = batch.clone();
        let mut entry = attempt.entry.clone();
        entry.outcome = Some(outcome.clone());
        let settled = outcome;
        let authority = ctx
            .resources
            .authorities
            .maintenance
            .get()
            .cloned()
            .ok_or_else(retained)?;
        if authority.world() != batch.world() || !authority.same_root(&ctx.authority) {
            return Err(invalid());
        }
        let timeout = ctx.resources.preparation.execution_policy().cleanup_timeout;
        let operation = ctx.operation.clone();
        let request = entry.finish.clone().prepare()?;
        // Fresh admission can settle this held result, never renew the old physical work.
        let result = ctx.store.transact(request, move |tx| Box::pin(async move {
            tx.require_world_mutation_operation(&operation.operation_id)?;
            let now = tx.now().await?;
            let admission = authority.admit(tx, &cleanup_impact(tx, &batch).await?, &cleanup_deadline(&now, timeout)?, &now).await?;
            let run = owner::require_run_invocation(tx, &admission, &entry.run).await?;
            let current = owner::read_operation_record(tx, &operation.operation_id).await?;
            if run.operation.operation_id != operation.operation_id
                || current.receipt.accepted.incarnation != operation.incarnation
                || owner::terminal_phase(current.receipt.phase)
                || owner::terminal_phase(run.phase)
            {
                return Err(invalid());
            }
            let world = tx.world();
            let (state, code): (&str, Option<&str>) = match &settled {
                Outcome::Removed => ("removed", None),
                Outcome::Failed { .. } => ("pending_removal", Some("world.package.cleanup_failed")),
            };
            let changed = tx.execute("UPDATE world_package_gc SET state=$6,failure_code=$7,failure_stage=CASE WHEN $6='removed' THEN NULL ELSE 'cleanup' END WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND claim_token=$4 AND generation=$5 AND state='pending_removal'",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &entry.package.as_str(), &entry.token, &entry.generation, &state, &code]).await?;
            if changed != 1 { return Err(retained()); }
            if matches!(&settled, Outcome::Removed) {
                tx.execute("UPDATE world_package_install SET pending_removal=false WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND phase='uninstalled'",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &entry.package.as_str()]).await?;
            }
            checkpoint::record(tx, &run.id, &batch, entry).await?;
            authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now).await?;
            Ok(settled)
        })).await;
        let settled: Committed<Outcome> = attempt.outcome(result)?;
        attempt.entry.started = false;
        attempt.physical = None;
        Ok(settled.value)
    }
}

fn cleanup_deadline(
    now: &world_protocol::time::Timestamp,
    timeout: std::time::Duration,
) -> Result<world_protocol::time::Timestamp, owner::Error> {
    let deadline = chrono::DateTime::parse_from_rfc3339(now.as_str())
        .map_err(|cause| invalid().caused(cause))?
        .checked_add_signed(
            chrono::Duration::from_std(timeout).map_err(|cause| invalid().caused(cause))?,
        )
        .ok_or_else(retained)?;
    world_protocol::time::Timestamp::try_new(deadline.to_rfc3339())
        .map_err(|cause| invalid().caused(cause))
}

fn check(ctx: &ExecutionContext) -> Result<(), owner::Error> {
    let deadline = ctx
        .deadline
        .checked_sub(ctx.resources.preparation.execution_policy().cleanup_timeout)
        .ok_or_else(retained)?;
    if ctx.cancellation.is_cancelled()
        || ctx.pipeline.is_cancelled()
        || tokio::time::Instant::now() >= deadline
    {
        return Err(PackageError::new(PackageFailure::Cancelled).into());
    }
    ctx.budget.check().map_err(|failure| {
        owner::Error::from_host_failure(
            world_protocol::process::HostFailure::BudgetExceeded {
                dimension: failure.dimension,
            },
            FailureStage::Admission,
        )
    })
}

fn invalid() -> owner::Error {
    PackageError::new(PackageFailure::InstallConflict).into()
}
fn retained() -> owner::Error {
    PackageError::new(PackageFailure::CleanupFailed).into()
}
