use std::sync::Arc;

use world_protocol::{
    api::{CommandResult, WorldCommand},
    failure::FailureStage,
    ids::ContentId,
    materials::MaterialFailure,
    operation::{OperationPhase, OperationReceipt, OperationResult},
};

use super::custody::{self, ArchiveWorkflows, MutationPlan, Pending};
use crate::{
    authorization,
    content::{self, BlobPin},
    definitions::canonical_digest,
    extensions::lifecycle::LifecycleError,
    owner::{
        Error, ExecutionContext, OperationUpdate, complete_operation, complete_world_deletion,
        update_operation,
    },
    store::{ArchiveSnapshot, Committed, CommittedWorldMutation, StoreFuture},
};

pub(super) fn run<'a>(
    owner: &'a ArchiveWorkflows,
    ctx: &'a ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'a, CommandResult, Error> {
    Box::pin(async move {
        custody::current(ctx).await?;
        let input = canonical_digest(&command)?;
        let plan = custody::plan(ctx, &command, &input).await?;
        let held = owner.pending(ctx, &input, plan)?;
        let mut pending = held.lock().await;
        if pending.input != input {
            return Err(Error::internal(FailureStage::Recover));
        }
        custody::validate_plan(ctx, &command, &pending.plan)?;
        if pending.snapshot.is_none() && matches!(&command, WorldCommand::Restore(_)) {
            pending.snapshot = Some(read_archive(ctx, &pending.plan).await?);
        }
        let snapshot = pending.snapshot.clone();
        let intent = intent(ctx, &pending.plan, snapshot.clone()).await?;
        let proof = ctx
            .store
            .committed_world_mutation(&ctx.authority, &intent)
            .await?;
        if pending.drained.is_none() {
            if pending.closing.is_none() {
                pending.closing = Some(ctx.resources.live.close_world(&proof)?);
            }
            ctx.checkpoint_world_mutation(
                &proof,
                pending.closing.as_ref().expect("closed world custody"),
            )
            .await?;
            let closing = pending.closing.take().expect("closed world custody");
            match closing.drain_until(ctx.deadline).await {
                Ok(drained) => pending.drained = Some(Arc::new(drained)),
                Err((closing, remaining)) => {
                    pending.closing = Some(closing);
                    return Err(LifecycleError::Cleanup {
                        cause: Box::new(LifecycleError::Retiring),
                        remaining_resources: remaining
                            .iter()
                            .flat_map(crate::extensions::lifecycle::retained_resources)
                            .collect(),
                    }
                    .into());
                }
            }
        }
        if pending.completed.is_none() {
            pending.completed = ctx
                .store
                .read_commit_optional::<OperationReceipt>(
                    &pending.plan.final_commit.world,
                    &pending.plan.final_commit.commit_id,
                    &pending.plan.final_commit.input_digest,
                )
                .await?;
        }
        match snapshot {
            Some(snapshot) => restore(ctx, &proof, &snapshot, &mut pending).await?,
            None => delete(ctx, &proof, &mut pending).await?,
        }
        custody::current(ctx).await?;
        owner.remove(&ctx.operation.operation_id);
        Ok(CommandResult::Accepted(ctx.operation.clone()))
    })
}

async fn read_archive(
    ctx: &ExecutionContext,
    plan: &MutationPlan,
) -> Result<Arc<ArchiveSnapshot>, Error> {
    let WorldCommand::Restore(request) = &plan.command else {
        return Err(Error::internal(FailureStage::Recover));
    };
    let original = plan
        .pin
        .as_ref()
        .ok_or_else(|| Error::internal(FailureStage::Recover))?;
    let pinned = if let Some(committed) = ctx
        .store
        .read_commit_optional::<BlobPin>(
            &original.world,
            &original.commit_id,
            &original.input_digest,
        )
        .await?
    {
        committed
    } else {
        let blob = request.manifest.clone();
        let archive = plan
            .archive
            .clone()
            .ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let command = plan.command.clone();
        let content = ctx.resources.content.clone();
        let run = ctx.run.id.clone();
        let id = ContentId::try_new(original.commit_id.as_str())
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        ctx.transact_outcome(original.clone(), move |tx, admission, _, _| {
            Box::pin(async move {
                admission.require_access(&super::impact(tx, &command).await?)?;
                content
                    .pin_archive_read(tx, &archive, &blob, &run, id)
                    .await
                    .map_err(Error::from)
            })
        })
        .await?
    };
    let bytes = ctx
        .resources
        .content
        .read_pinned(&ctx.store, &pinned)
        .await?;
    let snapshot: ArchiveSnapshot = serde_json::from_slice(&bytes).map_err(|cause| {
        Error::from(content::Error::material(MaterialFailure::CorruptContent)).caused(cause)
    })?;
    if snapshot.world() != &ctx.operation.world
        || snapshot.storage_id() != ctx.store.identity_receipt().storage_id()
        || plan.archive.as_ref() != Some(snapshot.digest())
    {
        return Err(content::Error::material(MaterialFailure::InputInvalid).into());
    }
    custody::current(ctx).await?;
    Ok(Arc::new(snapshot))
}

async fn intent(
    ctx: &ExecutionContext,
    plan: &MutationPlan,
    snapshot: Option<Arc<ArchiveSnapshot>>,
) -> Result<Committed<OperationReceipt>, Error> {
    if let Some(committed) = ctx
        .store
        .read_commit_optional::<OperationReceipt>(
            &plan.intent.world,
            &plan.intent.commit_id,
            &plan.intent.input_digest,
        )
        .await?
    {
        return Ok(committed);
    }
    let final_commit = plan.final_commit.commit_id.clone();
    let command = plan.command.clone();
    ctx.transact_exclusive_storage_outcome(
        plan.intent.clone(),
        move |tx, admission, operation, _| {
            Box::pin(async move {
                admission.require_access(&super::impact(tx, &command).await?)?;
                match &command {
                    WorldCommand::Restore(request) => {
                        tx.begin_world_restore(
                            request.expected_incarnation,
                            &operation.receipt.accepted,
                            snapshot
                                .as_ref()
                                .ok_or_else(|| Error::internal(FailureStage::Prepare))?,
                            &final_commit,
                        )
                        .await?
                    }
                    WorldCommand::DeleteWorld(request) => {
                        tx.begin_world_deletion(
                            request.expected_incarnation,
                            request.expected_revision,
                            &operation.receipt.accepted,
                            &final_commit,
                        )
                        .await?
                    }
                    _ => return Err(Error::internal(FailureStage::Decode)),
                }
                let mut progress = operation.receipt.progress.clone();
                progress.stage = FailureStage::Drain;
                update_operation(
                    tx,
                    &operation.receipt.accepted,
                    OperationUpdate {
                        phase: OperationPhase::Draining,
                        progress,
                        failure: None,
                        effects: Vec::new(),
                    },
                    &tx.now().await?,
                )
                .await
            })
        },
    )
    .await
    .map_err(Error::from)
}

async fn restore(
    ctx: &ExecutionContext,
    proof: &CommittedWorldMutation,
    snapshot: &Arc<ArchiveSnapshot>,
    pending: &mut Pending,
) -> Result<(), Error> {
    let request = pending.plan.final_commit.clone();
    let drained = pending.drained.as_ref().expect("drained world custody");
    if pending.prepared.is_none() {
        pending.prepared = Some(Arc::new(
            ctx.resources
                .bindings
                .prepare_restore(
                    snapshot,
                    &request,
                    &proof
                        .restore()
                        .ok_or_else(|| Error::internal(FailureStage::Recover))?,
                    drained,
                    &ctx.resources.inventory,
                    &ctx.resources.preparation,
                    &ctx.cancellation,
                    ctx.deadline,
                )
                .await?,
        ));
    }
    if pending.completed.is_none() {
        let checked_snapshot = snapshot.clone();
        let content = ctx.resources.content.clone();
        let cancel = ctx.cancellation.clone();
        let blobs = tokio::task::spawn_blocking(move || {
            content.validate_archive(&checked_snapshot, &cancel)
        })
        .await
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))??;
        let packages = ctx
            .resources
            .inventory
            .validate_archive(snapshot, &ctx.cancellation)
            .await?;
        let _inventory = ctx.resources.inventory.lock_transfer_publication().await;
        // The prepared candidate and drain proof remain owned by Pending throughout COMMIT.
        let candidate = pending
            .prepared
            .as_ref()
            .expect("prepared restore custody")
            .clone();
        let live_drained = pending
            .drained
            .as_ref()
            .expect("drained world custody")
            .clone();
        let snapshot_copy = snapshot.clone();
        let content = ctx.resources.content.clone();
        let inventory = ctx.resources.inventory.clone();
        let live = ctx.resources.live.clone();
        let intent = proof.clone();
        let command = pending.plan.command.clone();
        let outcome = ctx
            .transact_world_mutation_outcome(request, proof, move |tx, admission, operation, _| {
                Box::pin(async move {
                    admission.require_access(&super::impact(tx, &command).await?)?;
                    let checked = candidate
                        .recheck(tx, &admission, snapshot_copy.activation_lock())
                        .await?;
                    let release_id = tx
                        .restore_archive(
                            &snapshot_copy,
                            operation.receipt.accepted.incarnation,
                            &content,
                            &blobs,
                            &inventory,
                            &packages,
                            &intent,
                            &live,
                            &live_drained,
                            &checked,
                        )
                        .await?;
                    let now = tx.now().await?;
                    authorization::check_admitted_output(
                        tx,
                        &admission,
                        admission.impact(),
                        1,
                        &now,
                    )
                    .await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Restore { release_id },
                        &now,
                    )
                    .await
                })
            })
            .await;
        pending.completed = Some(outcome.map_err(Error::from)?);
    }
    let committed = pending
        .completed
        .as_ref()
        .expect("confirmed restore receipt");
    let restored = ctx
        .store
        .committed_world_restore(&ctx.authority, proof, committed)
        .await?;
    if !pending.published {
        ctx.resources.bindings.publish_restored(
            &restored,
            pending.drained.as_ref().expect("drained world custody"),
            pending.prepared.as_ref().expect("prepared restore custody"),
        )?;
        pending.published = true;
    }
    release_manifest_pin(ctx, &pending.plan).await
}

async fn delete(
    ctx: &ExecutionContext,
    proof: &CommittedWorldMutation,
    pending: &mut Pending,
) -> Result<(), Error> {
    if pending.completed.is_some() {
        return Ok(());
    }
    let custody = pending
        .drained
        .as_ref()
        .expect("drained world custody")
        .clone();
    let content = ctx.resources.content.clone();
    let live = ctx.resources.live.clone();
    let intent = proof.clone();
    let command = pending.plan.command.clone();
    let outcome = ctx
        .transact_world_mutation_outcome(
            pending.plan.final_commit.clone(),
            proof,
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    admission.require_access(&super::impact(tx, &command).await?)?;
                    tx.finish_world_deletion(&intent, &live, &custody, &content)
                        .await?;
                    let now = tx.now().await?;
                    complete_world_deletion(tx, &operation.receipt.accepted, &content, &now).await
                })
            },
        )
        .await;
    pending.completed = Some(outcome.map_err(Error::from)?);
    Ok(())
}

async fn release_manifest_pin(ctx: &ExecutionContext, plan: &MutationPlan) -> Result<(), Error> {
    ctx.store
        .release_archive_read(
            &ctx.authority,
            plan.pin
                .as_ref()
                .ok_or_else(|| Error::internal(FailureStage::Recover))?,
            &plan.final_commit,
            plan.release
                .as_ref()
                .ok_or_else(|| Error::internal(FailureStage::Recover))?,
            &ctx.operation.operation_id,
            &ctx.run.id,
        )
        .await?;
    Ok(())
}
