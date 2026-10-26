use std::sync::Arc;

use world_protocol::{
    api::{BackupRequest, CommandResult, WorldCommand},
    failure::FailureStage,
    materials::BlobRef,
    operation::OperationResult,
};

use super::custody::{self, ArchiveWorkflows};
use crate::{
    authorization,
    content::{self, ContentOwner, StagedCommit},
    definitions::canonical_digest,
    owner::{Error, ExecutionContext},
    store::{Committed, StoreError, StoreFuture, TransactionError},
};

pub(super) fn run<'a>(
    owner: &'a ArchiveWorkflows,
    ctx: &'a ExecutionContext,
    request: BackupRequest,
) -> StoreFuture<'a, CommandResult, Error> {
    Box::pin(async move {
        let command = WorldCommand::Backup(request.clone());
        let input = canonical_digest(&command)?;
        let checkpoint_id = ctx.commit_id("archive.backup.prepare")?;
        if let Some(checkpoint) = ctx
            .store
            .read_commit_optional::<StagedCommit>(&ctx.operation.world, &checkpoint_id, &input)
            .await?
        {
            let original = checkpoint.value.request();
            if original.world != ctx.operation.world
                || original.commit_id != ctx.commit_id("archive.backup")?
                || original.input_digest != input
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            // A restart cannot reconstruct publication from a cleanup witness. Arbitrate only the original ID.
            let outcome = arbitrate(&ctx.store, original).await;
            return finish(owner, ctx, &checkpoint, outcome).await;
        }
        if let Some(held) = owner.backup(&ctx.operation.operation_id) {
            if held.request.world != ctx.operation.world
                || held.request.commit_id != ctx.commit_id("archive.backup")?
                || held.request.input_digest != input
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            let outcome = arbitrate(&ctx.store, &held.request).await;
            return match outcome {
                Err(error @ TransactionError::NotCommitted { cleanup: None, .. }) => {
                    let failure = Error::from(error);
                    match ctx.resources.content.discard_prepared(&held.prepared) {
                        Ok(()) => {
                            owner.remove_backup(&ctx.operation.operation_id);
                            Err(failure)
                        }
                        Err(cleanup) => Err(failure.with_related(cleanup.into())),
                    }
                }
                Err(error) => Err(error.into()),
                Ok(_) => Err(Error::internal(FailureStage::Recover)),
            };
        }
        custody::current(ctx).await?;
        let commit = ctx
            .commit_request(
                "archive.backup",
                input.clone(),
                &["authorization", "content", "packages", "releases"],
            )
            .await?;
        let snapshot = Arc::new(
            ctx.store
                .archive_snapshot(
                    ctx.operation.world.clone(),
                    request.expected_release,
                    request.include_materials,
                    268_435_456,
                )
                .await?,
        );
        let bytes = serde_json::to_vec(snapshot.as_ref())
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let inventory = ctx.resources.inventory.clone();
        let packages = inventory
            .validate_archive(&snapshot, &ctx.cancellation)
            .await?;
        let content = ctx.resources.content.clone();
        let cancel = ctx.cancellation.clone();
        let checked = snapshot.clone();
        let (prepared, blobs) = tokio::task::spawn_blocking(move || {
            let blobs = content.validate_archive(&checked, &cancel)?;
            let prepared = content.prepare_blob(&mut bytes.as_slice(), None, &cancel)?;
            Ok::<_, Error>((Arc::new(prepared), blobs))
        })
        .await
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))??;
        owner.hold_backup(
            ctx.operation.operation_id.clone(),
            commit.clone(),
            prepared.clone(),
        );
        let staged = ctx
            .resources
            .content
            .stage_commit(commit.clone(), &[prepared.as_ref()])?;
        // The checkpoint owns restart cleanup before the publication request can be submitted.
        let checkpoint = custody::staged_checkpoint(ctx, input, staged).await?;
        let content = ctx.resources.content.clone();
        let published = prepared.clone();
        let cancel = ctx.cancellation.clone();
        let _inventory = ctx.resources.inventory.lock_transfer_publication().await;
        let outcome = ctx
            .transact_exclusive_storage_outcome(commit, move |tx, admission, operation, _| {
                Box::pin(async move {
                    admission.require_access(&super::impact(tx, &command).await?)?;
                    if cancel.is_cancelled() {
                        return Err(content::Error::material(
                            world_protocol::materials::MaterialFailure::Cancelled,
                        )
                        .into());
                    }
                    if !blobs.matches(&snapshot, &content)
                        || !blobs.matches_catalog(snapshot.blob_catalog())
                        || !packages.matches(&snapshot, &inventory)
                        || !packages.matches_catalog(snapshot.package_catalog())
                    {
                        return Err(content::Error::material(
                            world_protocol::materials::MaterialFailure::InputInvalid,
                        )
                        .into());
                    }
                    content
                        .retain_prepared(
                            tx,
                            &published,
                            ContentOwner::Backup {
                                digest: snapshot.digest().clone(),
                            },
                        )
                        .await?;
                    tx.retain_archive(&snapshot, &content, published.reference())
                        .await?;
                    let now = tx.now().await?;
                    authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now)
                        .await?;
                    crate::owner::complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Backup {
                            manifest: published.reference().clone(),
                        },
                        &now,
                    )
                    .await?;
                    Ok(published.reference().clone())
                })
            })
            .await;
        finish(owner, ctx, &checkpoint, outcome).await
    })
}

pub(super) async fn arbitrate(
    store: &crate::store::WorldStore,
    original: &crate::store::CommitRequest,
) -> Result<Committed<BlobRef>, TransactionError<Error>> {
    let batch = original.clone().prepare().map_err(|cause| {
        TransactionError::Indeterminate(StoreError::caused_by(
            world_protocol::commit::CommitFailure::CommitIndeterminate {
                commit_id: original.commit_id.clone(),
            },
            FailureStage::Recover,
            cause,
        ))
    })?;
    store
        .transact(batch, |_| {
            Box::pin(async {
                Err(StoreError::new(
                    world_protocol::commit::CommitFailure::RolledBack,
                    FailureStage::Recover,
                ))
            })
        })
        .await
        .map_err(|error| match error {
            TransactionError::NotCommitted { error, cleanup } => TransactionError::NotCommitted {
                error: Error::from(error),
                cleanup,
            },
            TransactionError::Indeterminate(error) => TransactionError::Indeterminate(error),
        })
}

async fn finish(
    owner: &ArchiveWorkflows,
    ctx: &ExecutionContext,
    checkpoint: &Committed<StagedCommit>,
    outcome: Result<Committed<BlobRef>, TransactionError<Error>>,
) -> Result<CommandResult, Error> {
    match outcome {
        Ok(_) => {
            ctx.resources
                .content
                .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
                .await?;
            owner.remove_backup(&ctx.operation.operation_id);
            custody::current(ctx).await?;
            Ok(CommandResult::Accepted(ctx.operation.clone()))
        }
        Err(error @ TransactionError::NotCommitted { .. }) => {
            let failure = Error::from(error);
            match ctx
                .resources
                .content
                .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
                .await
            {
                Ok(_) => {
                    owner.remove_backup(&ctx.operation.operation_id);
                    Err(failure)
                }
                Err(cleanup) => Err(failure.with_related(cleanup.into())),
            }
        }
        Err(error) => Err(error.into()),
    }
}
