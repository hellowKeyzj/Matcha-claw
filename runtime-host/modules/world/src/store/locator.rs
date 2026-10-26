use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use world_protocol::{
    commit::CommitFailure,
    failure::FailureStage,
    ids::{Digest, Generation, TransferId, WorldRef, WriterEpoch},
};

use super::transfer::SourceExportReceipt;
use super::{ExportManifest, StoreError, TransferCut, WorldStore};

/// Private composition port. It contains identities, never credentials or a connection string.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocatorRecord {
    pub world: WorldRef,
    pub storage_id: String,
    pub writer_epoch: WriterEpoch,
    pub generation: Generation,
    pub transfer_id: Option<TransferId>,
    pub manifest_digest: Option<Digest>,
}
pub type LocatorFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send + 'a>>;

/// Successful CAS, including replacement == expected, synchronizes the file and directory.
/// An interrupted CAS must be resolved by read and confirmed CAS, never another transfer identity.
pub trait WorldLocator: Send + Sync {
    fn read<'a>(&'a self, world: &'a WorldRef) -> LocatorFuture<'a, Option<LocatorRecord>>;
    fn compare_and_set<'a>(
        &'a self,
        expected: Option<&'a LocatorRecord>,
        replacement: &'a LocatorRecord,
    ) -> LocatorFuture<'a, LocatorRecord>;
}

/// Only verified durable locator CAS creates this non-deserializable evidence.
pub(crate) struct LocatorCutoverReceipt {
    pub(super) cut: TransferCut,
    pub(super) manifest_digest: Digest,
    pub(super) record: LocatorRecord,
}
impl LocatorCutoverReceipt {
    pub(super) fn matches(&self, cut: &TransferCut, digest: &Digest) -> bool {
        &self.cut == cut
            && &self.manifest_digest == digest
            && self.record.world == cut.world
            && self.record.storage_id == cut.target_storage_id
            && self.record.writer_epoch == cut.target_epoch
            && self.record.transfer_id.as_ref() == Some(&cut.transfer_id)
            && self.record.manifest_digest.as_ref() == Some(digest)
    }
}
fn invalid() -> StoreError {
    StoreError::locator_conflict()
}
impl WorldStore {
    /// Establishes private locator authority from locked, ready storage facts, not bootstrap config.
    pub(crate) async fn initialize_locator(
        &self,
        _root: &crate::authorization::AuthorityRoot,
        world: &WorldRef,
        locator: &dyn WorldLocator,
    ) -> Result<LocatorRecord, StoreError> {
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        self.configure(&tx, world).await?;
        let row = tx.query_opt("SELECT h.storage_id,h.writer_epoch,h.transfer_id FROM world_storage_head h JOIN world_runtime_head r USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.mode='active' AND r.status='ready' FOR SHARE OF h,r", &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Recover))?.ok_or_else(invalid)?;
        let storage_id: String = row.get("storage_id");
        self.require_storage(&storage_id)?;
        let writer_epoch =
            WriterEpoch(u64::try_from(row.get::<_, i64>("writer_epoch")).map_err(|_| invalid())?);
        let transfer_id: Option<String> = row.get("transfer_id");
        let current = locator.read(world).await?;
        let replacement = match &current {
            Some(record)
                if record.world == *world
                    && record.storage_id == storage_id
                    && record.writer_epoch == writer_epoch
                    && record.generation.0 > 0
                    && record.transfer_id.as_ref().map(TransferId::as_str)
                        == transfer_id.as_deref() =>
            {
                record.clone()
            }
            Some(_) => return Err(invalid()),
            None if transfer_id.is_none() => LocatorRecord {
                world: world.clone(),
                storage_id,
                writer_epoch,
                generation: Generation(1),
                transfer_id: None,
                manifest_digest: None,
            },
            None => return Err(invalid()),
        };
        // A visible previous write may have returned commit_unknown before directory sync.
        let persisted = locator
            .compare_and_set(current.as_ref(), &replacement)
            .await?;
        if persisted != replacement {
            return Err(invalid());
        }
        tx.rollback()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        client.dirty = false;
        Ok(persisted)
    }

    /// Target validation and committed source export evidence precede durable locator CAS.
    pub(crate) async fn cutover_locator(
        &self,
        manifest: &ExportManifest,
        source: &SourceExportReceipt,
        locator: &dyn WorldLocator,
    ) -> Result<LocatorCutoverReceipt, StoreError> {
        self.require_storage(&manifest.cut.target_storage_id)?;
        if source.cut != manifest.cut || source.manifest_digest != manifest.digest {
            return Err(invalid());
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &manifest.cut.world).await?;
        let cut = &manifest.cut;
        // This lock covers only the bounded local durable locator CAS, not byte scans or networks.
        let row = tx.query_opt("SELECT h.storage_id,h.writer_epoch,h.mode,h.transfer_id,t.phase,t.manifest_digest FROM world_storage_head h JOIN world_storage_transfer t ON t.tenant_id=h.tenant_id AND t.world_id=h.world_id AND t.transfer_id=h.transfer_id WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.transfer_id=$3 FOR SHARE OF h,t", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?.ok_or_else(invalid)?;
        if !matches!(
            row.get::<_, String>("phase").as_str(),
            "validated" | "activated"
        ) || row.get::<_, Option<String>>("manifest_digest").as_deref()
            != Some(manifest.digest.as_str())
            || row.get::<_, String>("storage_id") != cut.target_storage_id
            || row.get::<_, i64>("writer_epoch") != cut.target_epoch.0 as i64
            || !matches!(row.get::<_, String>("mode").as_str(), "prepared" | "active")
        {
            return Err(invalid());
        }
        let current = locator
            .read(&manifest.cut.world)
            .await?
            .ok_or_else(invalid)?;
        let cut = &manifest.cut;
        if current.world != cut.world || current.generation.0 == 0 {
            return Err(invalid());
        }
        let replacement = if current.storage_id == cut.target_storage_id
            && current.writer_epoch == cut.target_epoch
            && current.transfer_id.as_ref() == Some(&cut.transfer_id)
            && current.manifest_digest.as_ref() == Some(&manifest.digest)
        {
            current.clone()
        } else {
            if current.storage_id != cut.source_storage_id
                || current.writer_epoch != cut.source_epoch
            {
                return Err(invalid());
            }
            let generation = current.generation.0.checked_add(1).ok_or_else(invalid)?;
            LocatorRecord {
                world: cut.world.clone(),
                storage_id: cut.target_storage_id.clone(),
                writer_epoch: cut.target_epoch,
                generation: Generation(generation),
                transfer_id: Some(cut.transfer_id.clone()),
                manifest_digest: Some(manifest.digest.clone()),
            }
        };
        let record = locator
            .compare_and_set(Some(&current), &replacement)
            .await?;
        if record != replacement {
            return Err(invalid());
        }
        tx.rollback()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        client.dirty = false;
        Ok(LocatorCutoverReceipt {
            cut: cut.clone(),
            manifest_digest: manifest.digest.clone(),
            record,
        })
    }
}
