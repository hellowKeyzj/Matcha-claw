use crate::content::Content;
use world_protocol::{commit::CommitFailure, failure::FailureStage, ids::WriterEpoch};

use super::transfer::{commit_transfer, require_same_cut, validate_cut};
use super::{
    LocatorCutoverReceipt, LocatorRecord, StoreError, TransferCut, TransferPhase, WorldLocator,
    WorldStore,
};

/// A target permanently rejected activation. Neither Serde nor callers can manufacture this proof.
pub(crate) struct TargetAbortReceipt {
    cut: TransferCut,
    manifest_digest: Option<world_protocol::ids::Digest>,
}
impl TargetAbortReceipt {
    pub(crate) fn cut(&self) -> &TransferCut {
        &self.cut
    }
}

/// A committed source reopening and its durable locator, not a caller-provided epoch.
#[derive(Clone)]
pub(crate) struct SourceResumeReceipt {
    cut: TransferCut,
    epoch: WriterEpoch,
}
impl SourceResumeReceipt {
    pub(crate) fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub(crate) fn writer_epoch(&self) -> WriterEpoch {
        self.epoch
    }

    pub(crate) async fn recheck_read(
        &self,
        snapshot: &super::WorldSnapshot<'_>,
    ) -> Result<(), StoreError> {
        let state = super::transfer::read_transfer_snapshot(snapshot, &self.cut)
            .await?
            .ok_or_else(invalid)?;
        if state.phase != TransferPhase::Aborted
            || state.mode != "active"
            || state.storage_id != self.cut.source_storage_id
            || state.writer_epoch != self.epoch
        {
            return Err(invalid());
        }
        Ok(())
    }
}
/// The original source is durably retired; target activation alone does not prove this.
pub(crate) struct SourceRetirementReceipt {
    cut: TransferCut,
    manifest_digest: world_protocol::ids::Digest,
}
impl SourceRetirementReceipt {
    pub(crate) fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub(crate) fn manifest_digest(&self) -> &world_protocol::ids::Digest {
        &self.manifest_digest
    }
}
fn invalid() -> StoreError {
    StoreError::locator_conflict()
}

impl WorldStore {
    /// A prepared or absent target can be permanently aborted, never an already active target.
    pub(crate) async fn abort_transfer(
        &self,
        cut: &TransferCut,
        target: &Content,
    ) -> Result<TargetAbortReceipt, StoreError> {
        validate_cut(cut)?;
        self.require_storage(&cut.target_storage_id)?;
        if target.world() != &cut.world {
            return Err(invalid());
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &cut.world).await?;
        tx.execute("INSERT INTO world_storage_head(tenant_id,world_id,storage_id,writer_epoch,mode,transfer_id) VALUES($1,$2,$3,$4,'retired',$5) ON CONFLICT DO NOTHING", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.target_storage_id, &(cut.target_epoch.0 as i64), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        let head = tx.query_one("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        if head.get::<_, String>("storage_id") != cut.target_storage_id
            || head.get::<_, i64>("writer_epoch") != cut.target_epoch.0 as i64
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
            || !matches!(
                head.get::<_, String>("mode").as_str(),
                "prepared" | "retired"
            )
        {
            return Err(invalid());
        }
        let _publication = target.lock_transfer_publication().map_err(|error| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Migrate, error)
        })?;
        tx.execute("INSERT INTO world_storage_transfer(tenant_id,world_id,transfer_id,source_storage_id,target_storage_id,source_epoch,target_epoch,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'aborted') ON CONFLICT DO NOTHING", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str(), &cut.source_storage_id, &cut.target_storage_id, &(cut.source_epoch.0 as i64), &(cut.target_epoch.0 as i64)]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        let transfer = tx.query_one("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch,phase FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        require_same_cut(&transfer, cut)?;
        if !matches!(
            transfer.get::<_, String>("phase").as_str(),
            "validated" | "aborted"
        ) {
            return Err(invalid());
        }
        tx.execute("UPDATE world_storage_head SET mode='retired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        tx.execute("UPDATE world_storage_transfer SET phase='aborted',import_xid=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        drop(client);
        drop(_publication);
        self.read_abort_receipt(cut).await
    }

    pub(crate) async fn read_abort_receipt(
        &self,
        cut: &TransferCut,
    ) -> Result<TargetAbortReceipt, StoreError> {
        let state = self.read_transfer(cut).await?;
        if state.phase != TransferPhase::Aborted
            || state.mode != "retired"
            || state.storage_id != cut.target_storage_id
            || state.writer_epoch != cut.target_epoch
        {
            return Err(invalid());
        }
        Ok(TargetAbortReceipt {
            cut: cut.clone(),
            manifest_digest: state.manifest_digest,
        })
    }

    /// Locator recovery precedes source reopening, with a fresh epoch above both old writers.
    pub(crate) async fn resume_transfer(
        &self,
        aborted: &TargetAbortReceipt,
        locator: &dyn WorldLocator,
    ) -> Result<SourceResumeReceipt, StoreError> {
        let cut = &aborted.cut;
        validate_cut(cut)?;
        self.require_storage(&cut.source_storage_id)?;
        let epoch = cut
            .target_epoch
            .0
            .checked_add(1)
            .filter(|epoch| *epoch <= i64::MAX as u64)
            .ok_or_else(invalid)?;
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &cut.world).await?;
        let head = tx.query_one("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        let replay = head.get::<_, String>("mode") == "active"
            && head.get::<_, i64>("writer_epoch") == epoch as i64;
        if head.get::<_, String>("storage_id") != cut.source_storage_id
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
            || (!replay
                && (!matches!(head.get::<_, String>("mode").as_str(), "active" | "fenced")
                    || head.get::<_, i64>("writer_epoch") != cut.source_epoch.0 as i64))
        {
            return Err(invalid());
        }
        let transfer = tx.query_one("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch,phase FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        require_same_cut(&transfer, cut)?;
        let phase: String = transfer.get("phase");
        let valid = if replay {
            phase == "aborted"
        } else if head.get::<_, String>("mode") == "active" {
            phase == "draining"
        } else {
            matches!(phase.as_str(), "cut" | "exported" | "aborted")
        };
        if !valid {
            return Err(invalid());
        }
        let current = locator.read(&cut.world).await?.ok_or_else(invalid)?;
        if current.world != cut.world || current.generation.0 == 0 {
            return Err(invalid());
        }
        let already = current.storage_id == cut.source_storage_id
            && current.writer_epoch == WriterEpoch(epoch)
            && current.transfer_id.as_ref() == Some(&cut.transfer_id)
            && current.manifest_digest == aborted.manifest_digest;
        let replacement = if already {
            current.clone()
        } else {
            let source = current.storage_id == cut.source_storage_id
                && current.writer_epoch == cut.source_epoch;
            let target = current.storage_id == cut.target_storage_id
                && current.writer_epoch == cut.target_epoch
                && current.transfer_id.as_ref() == Some(&cut.transfer_id)
                && current.manifest_digest == aborted.manifest_digest;
            if !source && !target {
                return Err(invalid());
            }
            LocatorRecord {
                world: cut.world.clone(),
                storage_id: cut.source_storage_id.clone(),
                writer_epoch: WriterEpoch(epoch),
                generation: world_protocol::ids::Generation(
                    current.generation.0.checked_add(1).ok_or_else(invalid)?,
                ),
                transfer_id: Some(cut.transfer_id.clone()),
                manifest_digest: aborted.manifest_digest.clone(),
            }
        };
        if locator
            .compare_and_set(Some(&current), &replacement)
            .await?
            != replacement
        {
            return Err(invalid());
        }
        tx.execute("UPDATE world_storage_head SET mode='active',writer_epoch=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &(epoch as i64)]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        tx.execute("UPDATE world_storage_transfer SET phase='aborted',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        release_pins(&tx, cut).await?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        drop(client);
        if locator.read(&cut.world).await?.as_ref() != Some(&replacement) {
            return Err(invalid());
        }
        let proof = SourceResumeReceipt {
            cut: cut.clone(),
            epoch: WriterEpoch(epoch),
        };
        self.snapshot(cut.world.clone(), move |snapshot| {
            Box::pin(async move {
                proof.recheck_read(snapshot).await?;
                Ok(proof)
            })
        })
        .await
    }

    pub(crate) async fn retire_transfer(
        &self,
        proof: &LocatorCutoverReceipt,
        activated: &super::transfer::TargetActivationReceipt,
        source: &Content,
    ) -> Result<SourceRetirementReceipt, StoreError> {
        let cut = &proof.cut;
        self.require_storage(&cut.source_storage_id)?;
        if source.world() != &cut.world
            || !proof.matches(cut, &proof.manifest_digest)
            || activated.cut != *cut
            || activated.manifest_digest != proof.manifest_digest
        {
            return Err(invalid());
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &cut.world).await?;
        let head = tx.query_one("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        if head.get::<_, String>("storage_id") != cut.source_storage_id
            || head.get::<_, i64>("writer_epoch") != cut.source_epoch.0 as i64
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
            || !matches!(head.get::<_, String>("mode").as_str(), "fenced" | "retired")
        {
            return Err(invalid());
        }
        let _publication = source.lock_transfer_publication().map_err(|error| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Migrate, error)
        })?;
        let changed = tx.execute("UPDATE world_storage_transfer SET phase='retired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND phase IN ('exported','retired') AND manifest_digest=$4", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str(), &proof.manifest_digest.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        if changed != 1 {
            return Err(invalid());
        }
        tx.execute("UPDATE world_storage_head SET mode='retired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        release_pins(&tx, cut).await?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        drop(client);
        drop(_publication);
        let state = self.read_transfer(cut).await?;
        if state.phase != TransferPhase::Retired
            || state.mode != "retired"
            || state.storage_id != cut.source_storage_id
            || state.writer_epoch != cut.source_epoch
            || state.manifest_digest.as_ref() != Some(&proof.manifest_digest)
        {
            return Err(invalid());
        }
        Ok(SourceRetirementReceipt {
            cut: cut.clone(),
            manifest_digest: proof.manifest_digest.clone(),
        })
    }
}
async fn release_pins(
    tx: &tokio_postgres::Transaction<'_>,
    cut: &TransferCut,
) -> Result<(), StoreError> {
    tx.execute("UPDATE world_blob_pin SET released_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND kind='transfer' AND owner_id=$3 AND released_at IS NULL", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
    Ok(())
}
