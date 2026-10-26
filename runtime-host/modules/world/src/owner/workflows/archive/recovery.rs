use std::sync::Arc;

use world_protocol::{
    api::{ApiFailure, WorldCommand},
    failure::{FailureStage, Recovery},
    ids::{OperationId, RunId, WorldRef},
    lifecycle::{LifecycleFailure, LifecycleStage},
    materials::BlobRef,
    operation::{OperationFailure, OperationPhase, OperationReceipt, OperationResult},
};

use super::custody::{self, ArchiveWorkflows, MutationPlan};
use crate::{
    authorization::AuthorityRoot,
    content::StagedCommit,
    definitions::canonical_digest,
    owner::{
        Error, execution_commit_id, read_record_snapshot, resources::Resources, terminal_phase,
    },
    store::{Committed, WorldStore},
};

/// Original receipts authorize cleanup/publication only; no new business admission is made here.
pub(super) async fn run(
    owner: &ArchiveWorkflows,
    store: &WorldStore,
    resources: &Arc<Resources>,
    authority: &AuthorityRoot,
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
) -> Result<(), Error> {
    let id = operation.clone();
    let record = store
        .snapshot(world.clone(), move |snapshot| {
            Box::pin(async move { read_record_snapshot(snapshot, &id).await })
        })
        .await?;
    if !terminal_phase(record.receipt.phase) || record.receipt.progress.run_id.as_ref() != Some(run)
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    let input = canonical_digest(record.input.command()?)?;
    if matches!(record.input.command()?, WorldCommand::Backup(_)) {
        let checkpoint_id = execution_commit_id(world, operation, run, "archive.backup.prepare")?;
        if let Some(checkpoint) = store
            .read_commit_optional::<StagedCommit>(world, &checkpoint_id, &input)
            .await?
        {
            let original = checkpoint.value.request();
            if original.world != *world
                || original.commit_id
                    != execution_commit_id(world, operation, run, "archive.backup")?
                || original.input_digest != input
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            if let Some(OperationResult::Backup { manifest }) = &record.receipt.result {
                let committed: Committed<BlobRef> = store
                    .read_commit(world, &original.commit_id, &original.input_digest)
                    .await?;
                if &committed.value != manifest {
                    return Err(Error::internal(FailureStage::Recover));
                }
            }
            resources
                .content
                .discard_committed_stages(store, authority, &checkpoint)
                .await?;
            owner.remove_backup(operation);
        } else if matches!(record.receipt.result, Some(OperationResult::Backup { .. })) {
            return Err(Error::internal(FailureStage::Recover));
        } else if let Some(held) = owner.backup(operation) {
            if held.request.world != *world
                || held.request.commit_id
                    != execution_commit_id(world, operation, run, "archive.backup")?
                || held.request.input_digest != input
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            match super::backup::arbitrate(store, &held.request).await {
                Err(crate::store::TransactionError::NotCommitted { cleanup: None, .. }) => {
                    resources.content.discard_prepared(&held.prepared)?;
                    owner.remove_backup(operation);
                }
                Err(error) => return Err(error.into()),
                Ok(_) => return Err(Error::internal(FailureStage::Recover)),
            }
        }
        return Ok(());
    }
    let plan_id = execution_commit_id(world, operation, run, "archive.mutation.prepare")?;
    let plan = store
        .read_commit_optional::<MutationPlan>(world, &plan_id, &input)
        .await?
        .ok_or_else(|| Error::internal(FailureStage::Recover))?
        .value;
    custody::validate_identity(world, operation, run, record.input.command()?, &plan)?;
    let completed: Committed<OperationReceipt> = store
        .read_commit(
            world,
            &plan.final_commit.commit_id,
            &plan.final_commit.input_digest,
        )
        .await?;
    if completed.value.accepted.world != *world
        || completed.value.accepted.operation_id != *operation
        || completed.value.progress.run_id.as_ref() != Some(run)
        || !matches!(
            completed.value.phase,
            OperationPhase::Completed | OperationPhase::CancelledAfterCommit
        )
        || completed.value.result != record.receipt.result
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    match (&plan.command, &completed.value.result) {
        (WorldCommand::DeleteWorld(_), Some(OperationResult::Delete { deleted: true, .. })) => {
            owner.remove(operation);
            Ok(())
        }
        (WorldCommand::Restore(_), Some(OperationResult::Restore { .. })) => {
            // The closed-world lane releases only the exact committed run's existing recovery pin.
            store
                .release_archive_read(
                    authority,
                    plan.pin
                        .as_ref()
                        .ok_or_else(|| Error::internal(FailureStage::Recover))?,
                    &plan.final_commit,
                    plan.release
                        .as_ref()
                        .ok_or_else(|| Error::internal(FailureStage::Recover))?,
                    operation,
                    run,
                )
                .await?;
            let held = owner.held(operation);
            let mut pending = match &held {
                Some(held) => Some(held.lock().await),
                None => None,
            };
            if let Some(pending) = pending.as_mut() {
                custody::validate_identity(world, operation, run, &plan.command, &pending.plan)?;
                if pending.input != input {
                    return Err(Error::internal(FailureStage::Recover));
                }
                if pending.published {
                    owner.remove(operation);
                    return Ok(());
                }
            }
            let intent: Committed<OperationReceipt> = store
                .read_commit(world, &plan.intent.commit_id, &plan.intent.input_digest)
                .await?;
            let proof = store.committed_world_mutation(authority, &intent).await?;
            let restored = store
                .committed_world_restore(authority, &proof, &completed)
                .await?;
            if !resources.live.world_restore_applied(&proof, &restored)? {
                let held = pending.as_ref().ok_or_else(runtime_pending)?;
                let drained = held.drained.as_ref().ok_or_else(runtime_pending)?;
                let prepared = held.prepared.as_ref().ok_or_else(runtime_pending)?;
                resources
                    .bindings
                    .publish_restored(&restored, drained, prepared)?;
            }
            if let Some(pending) = pending.as_mut() {
                pending.published = true;
            }
            drop(pending);
            owner.remove(operation);
            Ok(())
        }
        _ => Err(Error::internal(FailureStage::Recover)),
    }
}

fn runtime_pending() -> Error {
    Error::new(
        "world.restore_runtime_pending",
        FailureStage::Recover,
        "世界恢复已提交，运行资源仍待恢复。",
        ApiFailure::Operation(OperationFailure::Lifecycle(LifecycleFailure::Retained {
            stage: LifecycleStage::Recover,
            remaining_resources: Vec::new(),
        })),
        Recovery::ManualReview,
    )
}
