use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use world_protocol::state::StateFailure;

use super::{OpenedTarget, StateError, StorageTarget};
use crate::{
    authorization::AuthorityRoot,
    content::Content,
    extensions::{
        lifecycle::{DrainedTransfer, LiveExtensions},
        package::Inventory,
    },
    store::{
        ExportManifest, SourceResumeReceipt, SourceRetirementReceipt, TargetActivationReceipt,
        TransferCut, TransferPhase, TransferValidation, WorldLocator, WorldStore,
    },
};

pub(crate) struct StorageTransferred {
    pub target: OpenedTarget,
    pub validation: TransferValidation,
    pub activation: TargetActivationReceipt,
    pub retirement: SourceRetirementReceipt,
}

/// The owner joins accepted work and Source custody before supplying the live-ledger drain.
/// Physical owners arbitrate GC/publication with the same durable cut. Failures retain the
/// original TransferId and opened resources; an SQL fence alone never proves a world drain.
pub(crate) async fn transfer_storage(
    _authority: &AuthorityRoot,
    source: &WorldStore,
    source_content: &Arc<Content>,
    source_inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    drained: &DrainedTransfer,
    targets: &dyn StorageTarget,
    locator: &dyn WorldLocator,
    cut: TransferCut,
    cancellation: &CancellationToken,
) -> Result<StorageTransferred, StateError> {
    if !live.validate_transfer_drained(drained) || drained.cut() != &cut {
        return Err(StateFailure::Fenced.into());
    }
    check_cancelled(cancellation)?;
    let target = targets.open(&cut.world, &cut.target_storage_id).await?;
    // After activation, only forward recovery may finish retiring the old source.
    if let Some(state) = target.store.read_transfer_optional(&cut).await? {
        if state.phase == TransferPhase::Activated {
            let manifest = state.manifest.ok_or(StateFailure::ShadowValidationFailed)?;
            let validation: TransferValidation =
                serde_json::from_value(state.receipt.ok_or(StateFailure::ShadowValidationFailed)?)?;
            if validation.cut != cut || validation.manifest_digest != manifest.digest {
                return Err(StateFailure::ShadowValidationFailed.into());
            }
            let (activation, retirement) = finish_transfer(
                source,
                source_content,
                &target,
                locator,
                &manifest,
                &validation,
            )
            .await?;
            return Ok(StorageTransferred {
                target,
                validation,
                activation,
                retirement,
            });
        }
        if state.phase == TransferPhase::Aborted {
            return Err(StateFailure::Fenced.into());
        }
    }
    let package_publication = source_inventory.lock_transfer_publication().await;
    let cut = source.cut_transfer(drained, source_content).await?;
    drop(package_publication);
    check_cancelled(cancellation)?;
    let content_cut = cut.clone();
    let content = source_content.clone();
    let blob_plan = source
        .snapshot(cut.world.clone(), move |snapshot| {
            Box::pin(async move {
                content
                    .prepare_transfer(snapshot, &content_cut, 65_536)
                    .await
            })
        })
        .await?;
    let package_cut = cut.clone();
    let inventory = source_inventory.clone();
    let package_plan = source
        .snapshot(cut.world.clone(), move |snapshot| {
            Box::pin(async move { inventory.prepare_transfer(snapshot, &package_cut).await })
        })
        .await?;
    let export = source.export_cut(cut, 256 * 1024 * 1024).await?;
    source.seal_export(&export.manifest).await?;
    let source_proof = source.read_export_receipt(&export.manifest).await?;
    check_cancelled(cancellation)?;
    let validation = target.store.import_prepared(&export).await?;
    source_content
        .copy_transfer(&blob_plan, &target.content, &target.store, cancellation)
        .await?;
    let package_proof = source_inventory
        .copy_transfer(
            &package_plan,
            &target.inventory,
            &target.content,
            cancellation,
        )
        .await?;
    let blob_proof = target.content.validate_transfer(&blob_plan, cancellation)?;
    check_cancelled(cancellation)?;
    let locator_proof = target
        .store
        .cutover_locator(&export.manifest, &source_proof, locator)
        .await?;
    // Once the locator is published, cancellation is not permission to reopen an old writer.
    let activated = target
        .store
        .activate_transfer(
            &validation,
            &target.content,
            &blob_proof,
            &locator_proof,
            &target.inventory,
            &package_proof,
        )
        .await?;
    let retirement = source
        .retire_transfer(&locator_proof, &activated, source_content)
        .await?;
    Ok(StorageTransferred {
        target,
        validation,
        activation: activated,
        retirement,
    })
}

async fn finish_transfer(
    source: &WorldStore,
    source_content: &Content,
    target: &OpenedTarget,
    locator: &dyn WorldLocator,
    manifest: &ExportManifest,
    validation: &TransferValidation,
) -> Result<(TargetActivationReceipt, SourceRetirementReceipt), StateError> {
    let source_proof = source.read_export_receipt(manifest).await?;
    let locator_proof = target
        .store
        .cutover_locator(manifest, &source_proof, locator)
        .await?;
    let activated = target.store.read_activation_receipt(validation).await?;
    let retired = source
        .retire_transfer(&locator_proof, &activated, source_content)
        .await?;
    Ok((activated, retired))
}

/// Explicit rollback first makes this exact target permanently unactivatable, then publishes
/// a source epoch above both previous writers. No error automatically flips an old pointer.
pub(crate) async fn abort_storage_transfer(
    _authority: &AuthorityRoot,
    source: &WorldStore,
    targets: &dyn StorageTarget,
    locator: &dyn WorldLocator,
    cut: &TransferCut,
) -> Result<SourceResumeReceipt, StateError> {
    let target = targets.open(&cut.world, &cut.target_storage_id).await?;
    let aborted = target.store.abort_transfer(cut, &target.content).await?;
    Ok(source.resume_transfer(&aborted, locator).await?)
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), StateError> {
    if cancellation.is_cancelled() {
        return Err(StateError::Cancelled);
    }
    Ok(())
}
