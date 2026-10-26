mod candidates;
mod checkpoint;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    failure::FailureStage,
    ids::{ContentId, OperationId, RunId},
    materials::MaterialFailure,
    process::HostFailure,
};

pub(super) use candidates::require_unretained_snapshot;
use candidates::{Candidate, current_candidate, require_unretained};
pub(crate) use candidates::{CleanupBatch, cleanup_batch_finished, cleanup_candidates};
pub(crate) use checkpoint::CleanupCheckpoint;
use checkpoint::{Entry, Recovery};

use crate::{
    authorization,
    content::{
        self, CleanupResult, Content, DeletionClaim, DeletionPlan, DeletionReason, Error, stable_id,
    },
    definitions::canonical_digest,
    owner::{self, ExecutionContext},
    store::{CommitRequest, Committed, TransactionError, WorldTransaction},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CleanupOutcome {
    Removed,
    Failed { reason: MaterialFailure },
}

impl CleanupOutcome {
    fn of(cleanup: &CleanupResult) -> Self {
        match &cleanup.result {
            Ok(()) => Self::Removed,
            Err(error) => Self::Failed {
                reason: error
                    .reason()
                    .cloned()
                    .unwrap_or(MaterialFailure::CleanupFailed),
            },
        }
    }

    fn result(self) -> Result<(), owner::Error> {
        match self {
            Self::Removed => Ok(()),
            Self::Failed { reason } => Err(Error::material(reason).into()),
        }
    }
}

/// One finite maintenance run only; physical results survive observer loss and commit ambiguity.
pub(super) struct CleanupCustody {
    operation: OperationId,
    run: RunId,
    batch: CleanupBatch,
    recovery: Vec<Entry>,
    next: usize,
    attempt: Option<Attempt>,
}

struct Attempt {
    plan: DeletionPlan,
    token: ContentId,
    begin: CommitRequest,
    claim: CommitRequest,
    start: CommitRequest,
    finish: CommitRequest,
    began: bool,
    claimed: Option<Committed<DeletionClaim>>,
    started: bool,
    physical: Option<Arc<CleanupResult>>,
    unknown: bool,
}

impl Attempt {
    async fn new(ctx: &ExecutionContext, candidate: &Candidate) -> Result<Self, owner::Error> {
        check(ctx)?;
        ctx.budget
            .charge(BudgetDimension::Steps, 1)
            .map_err(budget_error)?;
        let plan = candidate.plan.clone().unwrap_or(DeletionPlan {
            id: candidate.deletion_id.clone(),
            blob: candidate.blob.clone(),
            actor: authorization::actor_id(&ctx.admission.invocation().actor).clone(),
            reason: DeletionReason::Unreferenced,
            cleanup_targets: Vec::new(),
        });
        let token = match &candidate.token {
            Some(token) => token.clone(),
            None => stable_id(&(
                "world.content.cleanup.claim.v1",
                &ctx.operation,
                &ctx.run.id,
                &plan.id,
            ))?,
        };
        let key = format!("content.cleanup.{}", plan.id.as_str());
        let digest = canonical_digest(&(&plan, &token))?;
        Ok(Self {
            begin: ctx
                .commit_request(
                    &format!("{key}.begin"),
                    canonical_digest(&plan)?,
                    &["content"],
                )
                .await?,
            claim: ctx
                .commit_request(&format!("{key}.claim"), digest.clone(), &["content"])
                .await?,
            start: ctx
                .commit_request(&format!("{key}.physical"), digest.clone(), &["content"])
                .await?,
            finish: ctx
                .commit_request(&format!("{key}.finish"), digest, &["content"])
                .await?,
            plan,
            token,
            began: false,
            claimed: None,
            started: false,
            physical: None,
            unknown: false,
        })
    }

    fn entry(&self, outcome: Option<CleanupOutcome>) -> Entry {
        Entry {
            deletion_id: self.plan.id.clone(),
            token: self.token.clone(),
            finish: self.finish.clone(),
            started: self.started,
            outcome,
        }
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

pub(crate) async fn cleanup_impact(
    tx: &WorldTransaction<'_>,
) -> Result<ActualImpact, owner::Error> {
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes: vec![AccessMode::Manage, AccessMode::Delete],
            scope: owner::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

impl Content {
    pub(crate) async fn has_cleanup_pending(&self) -> bool {
        self.cleanup.lock().await.is_some()
    }

    pub(crate) async fn cleanup_batch(
        self: &Arc<Self>,
        ctx: &ExecutionContext,
        batch: CleanupBatch,
    ) -> Result<(), owner::Error> {
        batch.validate()?;
        self.check_world(batch.world())?;
        if ctx.operation.world != *batch.world() || ctx.run.operation != ctx.operation {
            return Err(Error::material(MaterialFailure::InputInvalid).into());
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
        let pending = guard.as_mut().expect("cleanup custody installed");
        let result = self.execute_cleanup(ctx, pending).await;
        let held = pending.attempt.as_ref().is_some_and(|attempt| {
            attempt.unknown || attempt.started || attempt.physical.is_some()
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
        while pending.next < pending.batch.candidates.len() {
            let mut candidate = pending.batch.candidates[pending.next].clone();
            if pending.attempt.is_none() {
                candidate = ctx
                    .store
                    .snapshot(ctx.operation.world.clone(), move |snapshot| {
                        Box::pin(async move { current_candidate(snapshot, &candidate).await })
                    })
                    .await?;
                if let Some(entry) = pending
                    .recovery
                    .iter()
                    .find(|entry| entry.deletion_id == candidate.deletion_id)
                {
                    if candidate
                        .recovery
                        .as_ref()
                        .is_none_or(|recovery| !recovery.started)
                    {
                        candidate.token = Some(entry.token.clone());
                        candidate.recovery = Some(Recovery {
                            finish: entry.finish.clone(),
                            started: entry.started,
                            outcome: entry.outcome.clone(),
                        });
                        let deletion = candidate.deletion_id.clone();
                        let status = ctx
                            .store
                            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                                Box::pin(async move {
                                    content::read_deletion(snapshot, &deletion).await
                                })
                            })
                            .await?;
                        if status.plan.blob != candidate.blob
                            || status.claim_token.as_ref() != candidate.token.as_ref()
                        {
                            return Err(Error::material(MaterialFailure::CorruptContent).into());
                        }
                        candidate.plan = Some(status.plan);
                    }
                }
                if let Some(recovery) = &candidate.recovery {
                    if recovery.started {
                        if let Some(committed) = ctx
                            .store
                            .read_commit_optional::<CleanupOutcome>(
                                &ctx.operation.world,
                                &recovery.finish.commit_id,
                                &recovery.finish.input_digest,
                            )
                            .await?
                        {
                            pending.next += 1;
                            committed.value.result()?;
                            continue;
                        }
                        // Absence cannot establish rollback or whether a prior physical unlink ran.
                        return Err(retained());
                    }
                } else if candidate.token.is_some() {
                    // A pre-existing claim without its physical checkpoint is not permission to unlink again.
                    return Err(retained());
                }
                pending.attempt = Some(Attempt::new(ctx, &candidate).await?);
            }
            let attempt = pending.attempt.as_mut().expect("cleanup attempt installed");
            let result = self.cleanup_one(ctx, &pending.batch, attempt).await;
            match result {
                Ok(()) => {
                    pending.attempt = None;
                    pending.next += 1;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    async fn cleanup_one(
        &self,
        ctx: &ExecutionContext,
        batch: &CleanupBatch,
        attempt: &mut Attempt,
    ) -> Result<(), owner::Error> {
        if !attempt.began {
            if !attempt.unknown {
                check(ctx)?;
            }
            let plan = attempt.plan.clone();
            let result = ctx
                .transact_outcome(attempt.begin.clone(), move |tx, admission, _, _| {
                    Box::pin(async move {
                        admission.require_impact(&cleanup_impact(tx).await?)?;
                        require_unretained(tx, &plan.blob).await?;
                        content::begin_deletion(tx, &plan).await?;
                        Ok(())
                    })
                })
                .await;
            attempt.outcome(result)?;
            attempt.began = true;
        }
        if attempt.claimed.is_none() {
            if !attempt.unknown {
                check(ctx)?;
            }
            let plan = attempt.plan.clone();
            let token = attempt.token.clone();
            let batch = batch.clone();
            let entry = attempt.entry(None);
            let result = ctx
                .transact_outcome(attempt.claim.clone(), move |tx, admission, _, run| {
                    Box::pin(async move {
                        admission.require_impact(&cleanup_impact(tx).await?)?;
                        require_unretained(tx, &plan.blob).await?;
                        let claim = content::claim_deletion(tx, &plan.id, token).await?;
                        checkpoint::record(tx, &run.id, &batch, entry).await?;
                        Ok(claim)
                    })
                })
                .await;
            attempt.claimed = Some(attempt.outcome(result)?);
        }
        if !attempt.started {
            if !attempt.unknown {
                check(ctx)?;
            }
            let plan = attempt.plan.clone();
            let batch = batch.clone();
            let mut entry = attempt.entry(None);
            entry.started = true;
            let result = ctx
                .transact_outcome(attempt.start.clone(), move |tx, admission, _, run| {
                    Box::pin(async move {
                        admission.require_impact(&cleanup_impact(tx).await?)?;
                        require_unretained(tx, &plan.blob).await?;
                        checkpoint::record(tx, &run.id, &batch, entry).await?;
                        Ok(())
                    })
                })
                .await;
            attempt.outcome(result)?;
            attempt.started = true;
        }
        if attempt.physical.is_none() {
            check(ctx)?;
            let admission = ctx.admission.clone();
            ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
                let now = snapshot.now().await?;
                authorization::recheck_read(snapshot, &admission, &now).await?;
                let world = snapshot.world();
                if snapshot.query_opt("SELECT 1 FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 AND status='ready'",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.is_none() {
                    return Err(retained());
                }
                Ok::<_, owner::Error>(())
            })).await?;
            // Owned maintenance task awaits this through physical completion: no select/abort/drop.
            let cleanup = self
                .remove_claimed(
                    &ctx.store,
                    attempt.claimed.as_ref().expect("committed claim"),
                )
                .await?;
            attempt.physical = Some(Arc::new(cleanup));
        }
        let cleanup = attempt
            .physical
            .as_ref()
            .expect("physical result retained")
            .clone();
        let original_error = cleanup.result.as_ref().err().cloned();
        let outcome = CleanupOutcome::of(&cleanup);
        let entry = attempt.entry(Some(outcome.clone()));
        let batch = batch.clone();
        // Settlement is not skipped when cancellation/deadline arrives after the physical effect.
        let result = ctx
            .transact_outcome(attempt.finish.clone(), move |tx, admission, _, run| {
                Box::pin(async move {
                    admission.require_impact(&cleanup_impact(tx).await?)?;
                    content::finish_deletion(tx, &cleanup).await?;
                    checkpoint::record(tx, &run.id, &batch, entry).await?;
                    Ok(outcome)
                })
            })
            .await;
        attempt.outcome(result)?;
        attempt.started = false;
        attempt.physical = None;
        match original_error {
            Some(error) => Err(error.into()),
            None => Ok(()),
        }
    }
}

fn check(ctx: &ExecutionContext) -> Result<(), owner::Error> {
    let work_deadline = ctx
        .deadline
        .checked_sub(ctx.resources.preparation.execution_policy().cleanup_timeout)
        .ok_or_else(retained)?;
    if ctx.cancellation.is_cancelled()
        || ctx.pipeline.is_cancelled()
        || tokio::time::Instant::now() >= work_deadline
    {
        return Err(owner::Error::from_host_failure(
            HostFailure::Cancelled,
            FailureStage::Admission,
        ));
    }
    ctx.budget.check().map_err(budget_error)
}

fn budget_error(error: crate::extensions::invocation::BudgetFailure) -> owner::Error {
    owner::Error::from_host_failure(
        HostFailure::BudgetExceeded {
            dimension: error.dimension,
        },
        FailureStage::Admission,
    )
}

fn retained() -> owner::Error {
    owner::Error::from_host_failure(
        HostFailure::Operation(world_protocol::operation::OperationFailure::Lifecycle(
            world_protocol::lifecycle::LifecycleFailure::Retained {
                stage: world_protocol::lifecycle::LifecycleStage::Cleanup,
                remaining_resources: Vec::new(),
            },
        )),
        FailureStage::Recover,
    )
}
