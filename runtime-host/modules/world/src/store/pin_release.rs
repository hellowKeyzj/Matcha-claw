use serde::de::DeserializeOwned;
use world_protocol::{
    commit::{CommitFailure, WriteFence},
    failure::FailureStage,
    ids::{CommitId, ContentId, Digest, OperationId, RunId, WorldRef, WriterDomain, WriterEpoch},
    operation::{OperationPhase, OperationReceipt, OperationResult},
    releases::ReleaseHead,
};

use super::{
    CommitRequest, Committed, PreparedBatch, StoreError, TransactionError, WorldStore,
    WorldTransaction, retention::reference_error, transaction::decode_committed,
};
use crate::{authorization::AuthorityRoot, content::BlobPin};

/// Only the finite producers below can enter this lane; original receipts are checked before release.
pub(super) struct RecoveryPinRelease {
    world: WorldRef,
    storage_id: String,
}
impl RecoveryPinRelease {
    pub(super) fn matches(&self, world: &WorldRef, storage_id: &str) -> bool {
        &self.world == world && self.storage_id == storage_id
    }
}

fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Recover)
}
fn hash(value: &impl serde::Serialize) -> Result<Digest, StoreError> {
    crate::definitions::canonical_digest(value)
        .map_err(|failure| reference_error(crate::definitions::DefinitionError::from(failure)))
}
fn uncertain(commit: &CommitId, error: StoreError) -> TransactionError<StoreError> {
    TransactionError::Indeterminate(StoreError::caused_by(
        CommitFailure::CommitIndeterminate {
            commit_id: commit.clone(),
        },
        FailureStage::Recover,
        error,
    ))
}

async fn original<T: DeserializeOwned>(
    tx: &WorldTransaction<'_>,
    commit: &CommitId,
    digest: &Digest,
) -> Result<Committed<T>, StoreError> {
    let row = tx.query_opt(
        "SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &commit.as_str()],
    ).await?.ok_or_else(|| StoreError::new(CommitFailure::CommitIndeterminate { commit_id: commit.clone() }, FailureStage::Recover))?;
    decode_committed(&row, digest, commit, tx.world())
}

async fn terminal_run(
    tx: &WorldTransaction<'_>,
    run: &RunId,
) -> Result<OperationReceipt, StoreError> {
    let record = crate::owner::read_run(tx, run)
        .await
        .map_err(reference_error)?;
    let operation = crate::owner::read_operation(tx, &record.operation.operation_id)
        .await
        .map_err(reference_error)?;
    if !crate::owner::terminal_phase(record.phase)
        || !crate::owner::terminal_phase(operation.phase)
        || operation.accepted.operation_id != record.operation.operation_id
        || operation.progress.run_id.as_ref() != Some(run)
    {
        return Err(invalid());
    }
    Ok(operation)
}
fn execution_id(
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
    key: &str,
) -> Result<CommitId, StoreError> {
    crate::owner::execution_commit_id(world, operation, run, key).map_err(reference_error)
}

impl WorldStore {
    async fn pin_release_batch(
        &self,
        world: &WorldRef,
        commit_id: CommitId,
        input_digest: Digest,
    ) -> Result<PreparedBatch, StoreError> {
        let read_world = world.clone();
        let (storage_epoch, content_epoch) = self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt("SELECT h.writer_epoch AS storage_epoch,g.writer_epoch AS content_epoch FROM world_storage_head h JOIN world_writer_gate g USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND g.domain='content'",
                &[&read_world.tenant_id.as_str(), &read_world.world_id.as_str()]).await?.ok_or_else(invalid)?;
            Ok::<_, StoreError>((WriterEpoch(row.get::<_, i64>("storage_epoch") as u64), WriterEpoch(row.get::<_, i64>("content_epoch") as u64)))
        })).await?;
        let mut batch = CommitRequest {
            world: world.clone(),
            commit_id,
            input_digest,
            storage_epoch,
            fences: vec![WriteFence {
                world: world.clone(),
                domain: WriterDomain::try_new("content").map_err(|_| invalid())?,
                epoch: content_epoch,
            }],
            watch_basis: Vec::new(),
        }
        .prepare()?;
        batch.recovery_pin_release = Some(RecoveryPinRelease {
            world: world.clone(),
            storage_id: self.identity_receipt().storage_id().to_owned(),
        });
        Ok(batch)
    }

    /// No current grant or caller closure: release only the terminal run's original acquisition pin.
    pub(crate) async fn release_material_acquisition(
        &self,
        _root: &AuthorityRoot,
        world: &WorldRef,
        original_commit: &CommitId,
        original_digest: &Digest,
        run: &RunId,
        index: usize,
    ) -> Result<Committed<()>, TransactionError<StoreError>> {
        let input = hash(&(
            "material-acquisition-release/1",
            world,
            original_commit,
            original_digest,
            run,
            index,
        ))
        .map_err(|error| uncertain(original_commit, error))?;
        let cleanup = CommitId::try_new(format!("pin-release-{}", &input.as_str()[7..]))
            .map_err(|_| uncertain(original_commit, invalid()))?;
        let batch = self
            .pin_release_batch(world, cleanup.clone(), input)
            .await
            .map_err(|error| uncertain(&cleanup, error))?;
        let original_commit = original_commit.clone();
        let original_digest = original_digest.clone();
        let run = run.clone();
        self.transact(batch, move |tx| {
            Box::pin(async move {
                let operation = terminal_run(tx, &run).await?;
                let key = format!("acquire-{index}");
                if original_commit
                    != execution_id(
                        tx.world(),
                        &operation.accepted.operation_id,
                        &run,
                        &format!("materials.{key}"),
                    )?
                {
                    return Err(invalid());
                }
                let acquired: Committed<crate::owner::Acquired> =
                    original(tx, &original_commit, &original_digest).await?;
                let pin_id =
                    ContentId::try_new(hash(&(&run, &key, "input"))?.as_str()[7..].to_owned())
                        .map_err(|_| invalid())?;
                if let Some(pin) = acquired.value.pin() {
                    if !pin.matches_recovery_run(
                        tx.world(),
                        &run,
                        &acquired.value.source().blob,
                        &pin_id,
                    ) {
                        return Err(invalid());
                    }
                    crate::content::release_pin(tx, pin)
                        .await
                        .map_err(reference_error)?;
                }
                Ok(())
            })
        })
        .await
    }

    /// Only the terminal material run's original batch read may surrender its exact read pins.
    pub(crate) async fn release_material_parse_reads(
        &self,
        _root: &AuthorityRoot,
        world: &WorldRef,
        original_commit: &CommitId,
        original_digest: &Digest,
        run: &RunId,
    ) -> Result<Committed<()>, TransactionError<StoreError>> {
        let input = hash(&(
            "material-parse-reads-release/1",
            world,
            original_commit,
            original_digest,
            run,
        ))
        .map_err(|error| uncertain(original_commit, error))?;
        let cleanup = CommitId::try_new(format!("pin-release-{}", &input.as_str()[7..]))
            .map_err(|_| uncertain(original_commit, invalid()))?;
        let batch = self
            .pin_release_batch(world, cleanup.clone(), input)
            .await
            .map_err(|error| uncertain(&cleanup, error))?;
        let original_commit = original_commit.clone();
        let original_digest = original_digest.clone();
        let run = run.clone();
        self.transact(batch, move |tx| {
            Box::pin(async move {
                let operation = terminal_run(tx, &run).await?;
                if original_commit
                    != execution_id(
                        tx.world(),
                        &operation.accepted.operation_id,
                        &run,
                        "materials.parse-read",
                    )?
                {
                    return Err(invalid());
                }
                let record =
                    crate::owner::read_operation_record(tx, &operation.accepted.operation_id)
                        .await
                        .map_err(reference_error)?;
                let request_digest = match record.input.command().map_err(reference_error)? {
                    world_protocol::api::WorldCommand::ImportMaterials(request) => hash(request)?,
                    world_protocol::api::WorldCommand::ProposeMaterialDraft(request) => {
                        hash(request)?
                    }
                    _ => return Err(invalid()),
                };
                if record.input.world() != tx.world() || request_digest != original_digest {
                    return Err(invalid());
                }
                let reads: Committed<Vec<crate::content::ParseRead>> =
                    original(tx, &original_commit, &original_digest).await?;
                for read in reads.value {
                    let artifact = read.artifact_id();
                    let pin_id = ContentId::try_new(
                        hash(&(&run, "parse-read", artifact))?.as_str()[7..].to_owned(),
                    )
                    .map_err(|_| invalid())?;
                    if !read.matches_recovery_read(tx.world(), artifact, &pin_id) {
                        return Err(invalid());
                    }
                    crate::content::release_pin(tx, read.pin())
                        .await
                        .map_err(reference_error)?;
                }
                Ok(())
            })
        })
        .await
    }

    /// A terminal original model call can only surrender the pins acquired by its prepare receipt.
    pub(crate) async fn release_generation_pins(
        &self,
        prepare_request: &CommitRequest,
        prepared: &Committed<crate::generation::PreparedCall>,
    ) -> Result<Committed<()>, TransactionError<StoreError>> {
        let input = hash(&(
            "generation-pin-release/1",
            &prepare_request.world,
            &prepare_request.commit_id,
            &prepare_request.input_digest,
        ))
        .map_err(|error| uncertain(&prepare_request.commit_id, error))?;
        let cleanup = CommitId::try_new(format!("pin-release-{}", &input.as_str()[7..]))
            .map_err(|_| uncertain(&prepare_request.commit_id, invalid()))?;
        let batch = self
            .pin_release_batch(&prepare_request.world, cleanup.clone(), input)
            .await
            .map_err(|error| uncertain(&cleanup, error))?;
        let request = prepare_request.clone();
        let expected_receipt = prepared.receipt.clone();
        let expected_value = serde_json::to_value(&prepared.value).map_err(|cause| {
            uncertain(
                &cleanup,
                StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Recover, cause),
            )
        })?;
        self.transact(batch, move |tx| {
            Box::pin(async move {
                let prepared: Committed<crate::generation::PreparedCall> =
                    original(tx, &request.commit_id, &request.input_digest).await?;
                if prepared.receipt != expected_receipt
                    || serde_json::to_value(&prepared.value).map_err(|cause| {
                        StoreError::caused_by(
                            CommitFailure::InvalidBatch,
                            FailureStage::Recover,
                            cause,
                        )
                    })? != expected_value
                    || request.commit_id.as_str()
                        != format!("model-{}-prepare", prepared.value.id().as_str())
                    || !prepared
                        .value
                        .recovery_terminal(tx)
                        .await
                        .map_err(reference_error)?
                {
                    return Err(invalid());
                }
                for pin in prepared
                    .value
                    .recovery_pins(tx.world(), prepared.value.run())
                    .map_err(reference_error)?
                {
                    crate::content::release_pin(tx, pin)
                        .await
                        .map_err(reference_error)?;
                }
                Ok(())
            })
        })
        .await
    }

    /// Preserve the original archive cleanup identity, including a previous unknown COMMIT.
    pub(crate) async fn release_archive_read(
        &self,
        _root: &AuthorityRoot,
        pin_request: &CommitRequest,
        final_request: &CommitRequest,
        cleanup_request: &CommitRequest,
        operation: &OperationId,
        run: &RunId,
    ) -> Result<Committed<()>, TransactionError<StoreError>> {
        let batch = self
            .pin_release_batch(
                &cleanup_request.world,
                cleanup_request.commit_id.clone(),
                cleanup_request.input_digest.clone(),
            )
            .await
            .map_err(|error| uncertain(&cleanup_request.commit_id, error))?;
        let pin_request = pin_request.clone();
        let final_request = final_request.clone();
        let cleanup_request = cleanup_request.clone();
        let operation = operation.clone();
        let run = run.clone();
        self.transact(batch, move |tx| Box::pin(async move {
            let current = terminal_run(tx, &run).await?;
            if current.accepted.operation_id != operation { return Err(invalid()); }
            for (request, key) in [(&pin_request, "archive.mutation.pin"), (&final_request, "archive.mutation.final"), (&cleanup_request, "archive.mutation.release")] {
                if request.world != *tx.world() || request.commit_id != execution_id(tx.world(), &operation, &run, key)? { return Err(invalid()); }
            }
            if pin_request.input_digest != cleanup_request.input_digest
                || final_request.input_digest != cleanup_request.input_digest
            { return Err(invalid()); }
            let completed: Committed<OperationReceipt> = original(tx, &final_request.commit_id, &final_request.input_digest).await?;
            if completed.value.accepted.operation_id != operation
                || completed.value.accepted.world != *tx.world()
                || completed.value.progress.run_id.as_ref() != Some(&run)
                || !matches!(completed.value.phase, OperationPhase::Completed | OperationPhase::CancelledAfterCommit)
                || completed.value.result != current.result
                || !matches!(completed.value.result, Some(OperationResult::Restore { .. }))
            { return Err(invalid()); }
            let pinned: Committed<BlobPin> = original(tx, &pin_request.commit_id, &pin_request.input_digest).await?;
            let pin_id = ContentId::try_new(pin_request.commit_id.as_str()).map_err(|_| invalid())?;
            if pinned.value.reference().byte_size > i64::MAX as u64
                || !pinned.value.matches_recovery_run(tx.world(), &run, pinned.value.reference(), &pin_id)
                || tx.query_opt("SELECT 1 FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND manifest_blob_digest=$3 AND manifest_blob_size=$4",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &pinned.value.reference().digest.as_str(), &(pinned.value.reference().byte_size as i64)]).await?.is_none()
            { return Err(invalid()); }
            crate::content::release_pin(tx, &pinned.value).await.map_err(reference_error)
        })).await
    }

    /// A committed original rollback authorizes releasing its exact original pins, not republishing.
    pub(crate) async fn release_rollback_pins(
        &self,
        _root: &AuthorityRoot,
        pin_request: &CommitRequest,
        final_request: &CommitRequest,
        cleanup_request: &CommitRequest,
        operation: &OperationId,
        run: &RunId,
    ) -> Result<Committed<()>, TransactionError<StoreError>> {
        let batch = self
            .pin_release_batch(
                &cleanup_request.world,
                cleanup_request.commit_id.clone(),
                cleanup_request.input_digest.clone(),
            )
            .await
            .map_err(|error| uncertain(&cleanup_request.commit_id, error))?;
        let pin_request = pin_request.clone();
        let final_request = final_request.clone();
        let cleanup_request = cleanup_request.clone();
        let operation = operation.clone();
        let run = run.clone();
        self.transact(batch, move |tx| {
            Box::pin(async move {
                for (request, key) in [
                    (&pin_request, "release.rollback.pin"),
                    (&final_request, "release.rollback"),
                    (&cleanup_request, "release.rollback.cleanup"),
                ] {
                    if request.world != *tx.world()
                        || request.commit_id != execution_id(tx.world(), &operation, &run, key)?
                    {
                        return Err(invalid());
                    }
                }
                if cleanup_request.input_digest != hash(&(&pin_request.commit_id, "cleanup"))? {
                    return Err(invalid());
                }
                let pins: Committed<crate::releases::RollbackPins> =
                    original(tx, &pin_request.commit_id, &pin_request.input_digest).await?;
                let completed: Committed<ReleaseHead> =
                    original(tx, &final_request.commit_id, &final_request.input_digest).await?;
                pins.value
                    .validate_committed(&completed.value)
                    .map_err(reference_error)?;
                for pin in pins.value.recovery_pins() {
                    crate::content::release_pin(tx, pin)
                        .await
                        .map_err(reference_error)?;
                }
                Ok(())
            })
        })
        .await
    }
}
