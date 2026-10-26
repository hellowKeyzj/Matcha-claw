use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use world_protocol::{
    api::{CommandResult, WorldCommand},
    commit::CommitFailure,
    failure::FailureStage,
    ids::{CommitId, Digest, OperationId, RunId, WorldRef, WriterDomain},
    operation::OperationResult,
    releases::ReleaseHead,
};

use crate::{
    authorization,
    compiler::CompilationCache,
    content::StagedCommit,
    definitions::canonical_digest,
    extensions::bindings::Publication,
    owner::{Error, ExecutionContext},
    releases::{self, PreparedRollback, RollbackPins},
    store::{CommitRequest, Committed, StoreError, TransactionError, WorldStore},
};

/// Owns the original capabilities until Store proves the original identity's outcome.
#[derive(Default)]
pub(crate) struct ReleaseWorkflows {
    pub(super) cache: Mutex<CompilationCache>,
    execution: Mutex<BTreeMap<OperationId, Weak<tokio::sync::Mutex<()>>>>,
    pending: Mutex<BTreeMap<CommitId, Arc<Pending>>>,
}

pub(super) struct Pending {
    pub(super) request: CommitRequest,
    pub(super) operation: OperationId,
    pub(super) input: Digest,
    pub(super) publication: Mutex<Option<Publication>>,
    pub(super) custody: Custody,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RollbackPlan {
    pub(super) pin: CommitRequest,
    pub(super) publish: CommitRequest,
    pub(super) cleanup: CommitRequest,
}

pub(super) enum Custody {
    Compilation(Arc<super::compilation::Compilation>),
    Publish(Arc<Committed<StagedCommit>>),
    StageCleanup(Arc<Committed<StagedCommit>>, Completion),
    RecoveredRollback(RollbackPlan),
    Pin(RollbackPlan),
    Rollback(Arc<PreparedRollback>, RollbackPlan),
    Cleanup(Arc<Committed<RollbackPins>>, Completion),
}

#[derive(Clone)]
pub(super) enum Completion {
    Committed(Arc<Committed<ReleaseHead>>),
    Failed(Error),
    WaitingDependency(Error, Digest),
}

impl ReleaseWorkflows {
    pub(crate) fn has_any_pending(&self) -> bool {
        !self
            .pending
            .lock()
            .expect("release pending poisoned")
            .is_empty()
    }

    pub(crate) fn has_pending(&self, operation: &OperationId) -> bool {
        self.for_operation(operation).is_some()
    }

    /// Finishes only a durably completed release's cleanup; this cannot execute or disclose business.
    pub(crate) async fn cleanup_committed(
        &self,
        store: &WorldStore,
        content: &crate::content::Content,
        root: &authorization::AuthorityRoot,
        world: &WorldRef,
        operation: &OperationId,
    ) -> Result<(), Error> {
        if content.world() != world {
            return Err(Error::internal(FailureStage::Recover));
        }
        let execution = self.execution(operation);
        let _execution = execution.lock().await;
        let id = operation.clone();
        let record = store
            .snapshot(world.clone(), move |snapshot| {
                Box::pin(async move { crate::owner::read_record_snapshot(snapshot, &id).await })
            })
            .await?;
        if !crate::owner::terminal_phase(record.receipt.phase) {
            return Ok(());
        }
        let Some(OperationResult::Release { head }) = &record.receipt.result else {
            return Ok(());
        };
        let run = record
            .receipt
            .progress
            .run_id
            .as_ref()
            .ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let identity = |key| crate::owner::execution_commit_id(world, operation, run, key);
        let request_head = match record.input.command()? {
            WorldCommand::Publish(request) => &request.head,
            WorldCommand::Rollback(request) => &request.head,
            _ => return Err(Error::internal(FailureStage::Recover)),
        };
        if head.world != *world
            || request_head.world != *world
            || request_head.channel != head.channel
            || request_head.next != head.release_id
        {
            return Err(Error::internal(FailureStage::Recover));
        }
        let pending = self.for_operation(operation);
        match record.input.command()? {
            WorldCommand::Publish(_) => {
                let checkpoint: Committed<StagedCommit> = store
                    .read_commit_for_recovery(root, world, &identity("release.publish.prepare")?)
                    .await?;
                let original = checkpoint.value.request();
                if original.world != *world || original.commit_id != identity("release.publish")? {
                    return Err(Error::internal(FailureStage::Recover));
                }
                original.clone().prepare()?;
                let committed: Committed<ReleaseHead> = store
                    .read_commit(world, &original.commit_id, &original.input_digest)
                    .await?;
                require_completed_head(&committed, head)?;
                if let Some(pending) = &pending {
                    if pending.input != canonical_digest(record.input.command()?)? {
                        return Err(Error::internal(FailureStage::Recover));
                    }
                    resolve_gate(pending, &Ok(committed))?;
                }
                content
                    .discard_committed_stages(store, root, &checkpoint)
                    .await?;
            }
            WorldCommand::Rollback(_) => {
                let checkpoint: Committed<RollbackPlan> = store
                    .read_commit_for_recovery(root, world, &identity("release.rollback.prepare")?)
                    .await?;
                let plan = checkpoint.value;
                validate_plan_identity(world, operation, run, &plan)?;
                let committed: Committed<ReleaseHead> = store
                    .read_commit(world, &plan.publish.commit_id, &plan.publish.input_digest)
                    .await?;
                require_completed_head(&committed, head)?;
                if let Some(pending) = &pending {
                    if pending.input != canonical_digest(record.input.command()?)? {
                        return Err(Error::internal(FailureStage::Recover));
                    }
                    resolve_gate(pending, &Ok(committed))?;
                }
                store
                    .release_rollback_pins(
                        root,
                        &plan.pin,
                        &plan.publish,
                        &plan.cleanup,
                        operation,
                        run,
                    )
                    .await
                    .map_err(Error::from)?;
            }
            _ => return Err(Error::internal(FailureStage::Recover)),
        }
        if let Some(pending) = pending {
            self.remove(&pending);
        }
        Ok(())
    }

    pub(super) fn execution(&self, operation: &OperationId) -> Arc<tokio::sync::Mutex<()>> {
        let mut execution = self.execution.lock().expect("release execution poisoned");
        execution.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = execution.get(operation).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        execution.insert(operation.clone(), Arc::downgrade(&lock));
        lock
    }

    pub(super) fn find(&self, operation: &OperationId, input: &Digest) -> Option<Arc<Pending>> {
        self.pending
            .lock()
            .expect("release custody poisoned")
            .values()
            .find(|pending| &pending.operation == operation && &pending.input == input)
            .cloned()
    }

    fn for_operation(&self, operation: &OperationId) -> Option<Arc<Pending>> {
        self.pending
            .lock()
            .expect("release custody poisoned")
            .values()
            .find(|pending| &pending.operation == operation)
            .cloned()
    }

    pub(super) fn retain(&self, pending: Pending) -> Arc<Pending> {
        let pending = Arc::new(pending);
        self.pending
            .lock()
            .expect("release custody poisoned")
            .insert(pending.request.commit_id.clone(), pending.clone());
        pending
    }

    pub(super) fn remove(&self, pending: &Pending) {
        self.pending
            .lock()
            .expect("release custody poisoned")
            .remove(&pending.request.commit_id);
    }
}

pub(super) async fn recover(ctx: ExecutionContext) -> Result<CommandResult, Error> {
    let execution = ctx
        .resources
        .releases
        .execution(&ctx.operation.operation_id);
    let _execution = execution.lock().await;
    if let Some(pending) = ctx
        .resources
        .releases
        .for_operation(&ctx.operation.operation_id)
    {
        return resume(&ctx, pending).await;
    }
    let operation = ctx.operation.operation_id.clone();
    let admission = ctx.admission.clone();
    let run = ctx.run.id.clone();
    let record = ctx
        .store
        .snapshot(ctx.operation.world.clone(), move |snapshot| {
            Box::pin(async move {
                let now = snapshot.now().await?;
                authorization::recheck_read(snapshot, &admission, &now).await?;
                let record = crate::owner::read_record_snapshot(snapshot, &operation).await?;
                if record.receipt.progress.run_id.as_ref() != Some(&run) {
                    return Err(Error::internal(FailureStage::Recover));
                }
                Ok::<_, Error>(record)
            })
        })
        .await?;
    match record.input.command()? {
        WorldCommand::Rollback(_) => {
            let plan: Committed<RollbackPlan> = ctx
                .store
                .read_commit_for_recovery(
                    &ctx.authority,
                    &ctx.operation.world,
                    &ctx.commit_id("release.rollback.prepare")?,
                )
                .await?;
            validate_plan(&ctx, &plan.value)?;
            let publication = reserve(&ctx, &plan.value.publish)?;
            let pending = ctx.resources.releases.retain(Pending {
                request: plan.value.publish.clone(),
                operation: ctx.operation.operation_id.clone(),
                input: canonical_digest(record.input.command()?)?,
                publication: Mutex::new(Some(publication)),
                custody: Custody::RecoveredRollback(plan.value),
            });
            resume(&ctx, pending).await
        }
        WorldCommand::Publish(publish) => {
            let checkpoint: Option<Committed<StagedCommit>> = ctx
                .store
                .read_commit_for_recovery_optional(
                    &ctx.authority,
                    &ctx.operation.world,
                    &ctx.commit_id("release.publish.prepare")?,
                )
                .await?;
            let Some(checkpoint) = checkpoint else {
                let input = canonical_digest(record.input.command()?)?;
                super::compilation::recover(&ctx, publish, input.clone()).await?;
                return super::publish(&ctx, publish.clone(), input).await;
            };
            let request = checkpoint.value.request();
            if request.world != ctx.operation.world
                || request.commit_id != ctx.commit_id("release.publish")?
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            request.clone().prepare()?;
            let publication = reserve(&ctx, request)?;
            let pending = ctx.resources.releases.retain(Pending {
                request: request.clone(),
                operation: ctx.operation.operation_id.clone(),
                input: canonical_digest(record.input.command()?)?,
                publication: Mutex::new(Some(publication)),
                custody: Custody::Publish(Arc::new(checkpoint)),
            });
            resume(&ctx, pending).await
        }
        _ => Err(Error::internal(FailureStage::Recover)),
    }
}

async fn recover_rollback(
    ctx: &ExecutionContext,
    pending: Arc<Pending>,
    plan: &RollbackPlan,
) -> Result<CommandResult, Error> {
    let outcome = recover_original::<ReleaseHead>(ctx, &plan.publish).await;
    if let Err(resolution) = resolve_gate(&pending, &outcome) {
        return Err(with_resolution(outcome, resolution));
    }
    let completion = match outcome {
        Ok(committed) => Completion::Committed(Arc::new(committed)),
        Err(error @ TransactionError::NotCommitted { .. }) => Completion::Failed(error.into()),
        Err(error) => return Err(error.into()),
    };
    match recover_original::<RollbackPins>(ctx, &plan.pin).await {
        Ok(pins) => cleanup_pins(ctx, &pending, Arc::new(pins), completion).await,
        Err(TransactionError::NotCommitted { .. })
            if matches!(&completion, Completion::Failed(_)) =>
        {
            ctx.resources.releases.remove(&pending);
            finish_completion(ctx, &completion).await
        }
        Err(error) => Err(completion_failure(&completion, error.into())),
    }
}

pub(super) fn validate_plan(ctx: &ExecutionContext, plan: &RollbackPlan) -> Result<(), Error> {
    validate_plan_identity(
        &ctx.operation.world,
        &ctx.operation.operation_id,
        &ctx.run.id,
        plan,
    )
}

fn validate_plan_identity(
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
    plan: &RollbackPlan,
) -> Result<(), Error> {
    for (request, key) in [
        (&plan.pin, "release.rollback.pin"),
        (&plan.publish, "release.rollback"),
        (&plan.cleanup, "release.rollback.cleanup"),
    ] {
        if request.world != *world
            || request.commit_id != crate::owner::execution_commit_id(world, operation, run, key)?
        {
            return Err(Error::internal(FailureStage::Recover));
        }
        request.clone().prepare()?;
    }
    Ok(())
}

fn require_completed_head(
    committed: &Committed<ReleaseHead>,
    head: &ReleaseHead,
) -> Result<(), Error> {
    if committed.receipt.world != head.world || committed.value != *head {
        return Err(Error::internal(FailureStage::Recover));
    }
    Ok(())
}

pub(super) async fn checkpoint(
    ctx: &ExecutionContext,
    staged: StagedCommit,
) -> Result<Committed<StagedCommit>, Error> {
    let digest = canonical_digest(&staged)?;
    let committed = ctx
        .transact("release.publish.prepare", digest, &[], move |_, _, _, _| {
            Box::pin(async move { Ok(staged) })
        })
        .await?;
    let request = committed.value.request();
    if request.world != ctx.operation.world
        || request.commit_id != ctx.commit_id("release.publish")?
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    request.clone().prepare()?;
    Ok(committed)
}

/// A failed resolution keeps the exact capability in custody; only success removes it.
fn resolve_gate(
    pending: &Pending,
    outcome: &Result<Committed<ReleaseHead>, TransactionError<Error>>,
) -> Result<(), Error> {
    let mut held = pending
        .publication
        .lock()
        .expect("release gate custody poisoned");
    let Some(publication) = held.as_ref() else {
        return Ok(());
    };
    match outcome {
        Ok(committed) => publication.committed(&committed.receipt, |_| Ok(()))?,
        Err(proof @ TransactionError::NotCommitted { .. }) => publication
            .not_committed(proof, |_| ())
            .map_err(crate::extensions::bindings::BindingError::from)?,
        Err(TransactionError::Indeterminate(_)) => {
            publication
                .mark_indeterminate()
                .map_err(crate::extensions::bindings::BindingError::from)?;
            return Ok(());
        }
    }
    held.take();
    Ok(())
}

fn with_resolution(
    outcome: Result<Committed<ReleaseHead>, TransactionError<Error>>,
    resolution: Error,
) -> Error {
    match outcome {
        Ok(_) => resolution,
        Err(error) => Error::from(error).with_related(resolution),
    }
}

pub(super) async fn finish_final(
    ctx: &ExecutionContext,
    pending: Arc<Pending>,
    outcome: Result<Committed<ReleaseHead>, TransactionError<Error>>,
) -> Result<CommandResult, Error> {
    if let Err(resolution) = resolve_gate(&pending, &outcome) {
        return Err(with_resolution(outcome, resolution));
    }
    let completion = match outcome {
        Ok(committed) => Completion::Committed(Arc::new(committed)),
        Err(proof @ TransactionError::NotCommitted { .. }) => {
            let failure = Error::from(proof);
            if matches!(&pending.custody, Custody::Publish(_))
                && matches!(
                    &failure.safe_failure().details,
                    world_protocol::api::ApiFailure::Operation(
                        world_protocol::operation::OperationFailure::Release(
                            world_protocol::releases::ReleaseFailure::BackfillNotReady { .. }
                        )
                    )
                )
            {
                Completion::WaitingDependency(failure, pending.input.clone())
            } else {
                Completion::Failed(failure)
            }
        }
        Err(error) => return Err(error.into()),
    };
    match &pending.custody {
        Custody::Publish(checkpoint) => {
            let next = ctx.resources.releases.retain(Pending {
                request: pending.request.clone(),
                operation: pending.operation.clone(),
                input: pending.input.clone(),
                publication: Mutex::new(None),
                custody: Custody::StageCleanup(checkpoint.clone(), completion.clone()),
            });
            cleanup_stages(ctx, &next, checkpoint, &completion).await
        }
        Custody::Rollback(prepared, _) => {
            cleanup_pins(
                ctx,
                &pending,
                Arc::new(copy_committed(prepared.pins())),
                completion,
            )
            .await
        }
        _ => Err(Error::internal(FailureStage::Recover)),
    }
}

async fn cleanup_stages(
    ctx: &ExecutionContext,
    pending: &Pending,
    checkpoint: &Committed<StagedCommit>,
    completion: &Completion,
) -> Result<CommandResult, Error> {
    if let Err(cleanup) = ctx
        .resources
        .content
        .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
        .await
    {
        return Err(completion_failure(completion, cleanup.into()));
    }
    ctx.resources.releases.remove(pending);
    finish_completion(ctx, completion).await
}

pub(super) async fn cleanup_pins(
    ctx: &ExecutionContext,
    previous: &Pending,
    pins: Arc<Committed<RollbackPins>>,
    completion: Completion,
) -> Result<CommandResult, Error> {
    let plan = match &previous.custody {
        Custody::Pin(plan) | Custody::Rollback(_, plan) | Custody::RecoveredRollback(plan) => plan,
        _ => return Err(Error::internal(FailureStage::Recover)),
    };
    let request = plan.cleanup.clone();
    let pending = ctx.resources.releases.retain(Pending {
        request: request.clone(),
        operation: previous.operation.clone(),
        input: previous.input.clone(),
        publication: Mutex::new(None),
        custody: Custody::Cleanup(pins.clone(), completion.clone()),
    });
    ctx.resources.releases.remove(previous);
    submit_cleanup(ctx, pending, pins, completion).await
}

async fn submit_cleanup(
    ctx: &ExecutionContext,
    pending: Arc<Pending>,
    pins: Arc<Committed<RollbackPins>>,
    completion: Completion,
) -> Result<CommandResult, Error> {
    let outcome = ctx
        .transact_outcome(pending.request.clone(), move |tx, _, _, _| {
            Box::pin(async move {
                releases::release_rollback_pins(tx, &pins).await?;
                Ok(())
            })
        })
        .await;
    match outcome {
        Ok(_) => {
            ctx.resources.releases.remove(&pending);
            finish_completion(ctx, &completion).await
        }
        Err(error) => Err(completion_failure(&completion, error.into())),
    }
}

fn completion_failure(completion: &Completion, cleanup: Error) -> Error {
    match completion {
        Completion::Committed(_) => cleanup,
        Completion::Failed(failure) | Completion::WaitingDependency(failure, _) => {
            failure.clone().with_related(cleanup)
        }
    }
}

async fn finish_completion(
    ctx: &ExecutionContext,
    completion: &Completion,
) -> Result<CommandResult, Error> {
    match completion {
        Completion::Committed(committed) => {
            ctx.recheck_replay(committed).await?;
            Ok(CommandResult::Commit(committed.receipt.clone()))
        }
        Completion::Failed(failure) => Err(failure.clone()),
        Completion::WaitingDependency(_, input) => super::wait_for_backfill(ctx, input).await,
    }
}

pub(super) async fn resume(
    ctx: &ExecutionContext,
    pending: Arc<Pending>,
) -> Result<CommandResult, Error> {
    match &pending.custody {
        Custody::Compilation(_) => {
            let id = ctx.operation.operation_id.clone();
            let record = ctx
                .store
                .snapshot(ctx.operation.world.clone(), move |snapshot| {
                    Box::pin(async move { crate::owner::read_record_snapshot(snapshot, &id).await })
                })
                .await?;
            let WorldCommand::Publish(request) = record.input.command()? else {
                return Err(Error::internal(FailureStage::Recover));
            };
            if canonical_digest(&WorldCommand::Publish(request.clone()))? != pending.input {
                return Err(Error::internal(FailureStage::Recover));
            }
            super::publish(ctx, request.clone(), pending.input.clone()).await
        }
        Custody::Publish(_) | Custody::Rollback(_, _) => {
            let outcome = recover_original::<ReleaseHead>(ctx, &pending.request).await;
            finish_final(ctx, pending, outcome).await
        }
        Custody::StageCleanup(checkpoint, completion) => {
            cleanup_stages(ctx, &pending, checkpoint, completion).await
        }
        Custody::RecoveredRollback(plan) => recover_rollback(ctx, pending.clone(), plan).await,
        Custody::Pin(_) => match recover_original::<RollbackPins>(ctx, &pending.request).await {
            Ok(pinned) => super::continue_rollback(ctx, pending, pinned).await,
            Err(error @ TransactionError::NotCommitted { .. }) => {
                ctx.resources.releases.remove(&pending);
                Err(error.into())
            }
            Err(error) => Err(error.into()),
        },
        Custody::Cleanup(pins, completion) => {
            match recover_original::<()>(ctx, &pending.request).await {
                Ok(_) => {
                    ctx.resources.releases.remove(&pending);
                    finish_completion(ctx, completion).await
                }
                Err(TransactionError::NotCommitted { .. }) => {
                    // Only this cleanup is proven absent. Refresh admission fences, never its identity or input.
                    let request = ctx
                        .commit_request(
                            "release.rollback.cleanup",
                            pending.request.input_digest.clone(),
                            &["releases", "content"],
                        )
                        .await?;
                    if request.world != pending.request.world
                        || request.commit_id != pending.request.commit_id
                    {
                        return Err(Error::internal(FailureStage::Recover));
                    }
                    let next = ctx.resources.releases.retain(Pending {
                        request,
                        operation: pending.operation.clone(),
                        input: pending.input.clone(),
                        publication: Mutex::new(None),
                        custody: Custody::Cleanup(pins.clone(), completion.clone()),
                    });
                    submit_cleanup(ctx, next, pins.clone(), completion.clone()).await
                }
                Err(error) => Err(completion_failure(completion, error.into())),
            }
        }
    }
}

/// The unique receipt reservation arbitrates the original identity; absence alone never proves abort.
pub(super) async fn recover_original<T: Serialize + DeserializeOwned + Send>(
    ctx: &ExecutionContext,
    request: &CommitRequest,
) -> Result<Committed<T>, TransactionError<Error>> {
    match ctx
        .store
        .read_commit_optional(&request.world, &request.commit_id, &request.input_digest)
        .await
    {
        Ok(Some(committed)) => return Ok(committed),
        Ok(None) => {}
        Err(error) => {
            return Err(TransactionError::Indeterminate(StoreError::caused_by(
                CommitFailure::CommitIndeterminate {
                    commit_id: request.commit_id.clone(),
                },
                FailureStage::Recover,
                error,
            )));
        }
    }
    let batch = request.clone().prepare().map_err(|error| {
        TransactionError::Indeterminate(StoreError::caused_by(
            CommitFailure::CommitIndeterminate {
                commit_id: request.commit_id.clone(),
            },
            FailureStage::Recover,
            error,
        ))
    })?;
    ctx.store
        .transact(batch, |_| {
            Box::pin(async {
                Err(Error::from(StoreError::new(
                    CommitFailure::RolledBack,
                    FailureStage::Recover,
                )))
            })
        })
        .await
}

pub(super) fn reserve(
    ctx: &ExecutionContext,
    request: &CommitRequest,
) -> Result<Publication, Error> {
    Ok(ctx
        .resources
        .live
        .gate()
        .begin(
            request.world.clone(),
            request.commit_id.clone(),
            &[],
            &[WriterDomain::try_new("releases").map_err(|_| super::invalid("domain"))?],
        )
        .map_err(crate::extensions::bindings::BindingError::from)?)
}

fn copy_committed<T: Clone>(value: &Committed<T>) -> Committed<T> {
    Committed {
        value: value.value.clone(),
        receipt: value.receipt.clone(),
        replayed: value.replayed,
    }
}
