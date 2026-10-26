use platform::state_dir::CanonicalStateDir;
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::Digest,
    materials::{BlobRef, MaterialFailure},
};

use super::{Content, Error};
use crate::store::{TransferCut, WorldSnapshot, WorldStore};

/// Finite, exact catalog from a fenced source with durable transfer pins.
pub(crate) struct BlobTransferPlan {
    cut: TransferCut,
    blobs: Vec<BlobRef>,
}

/// Only constructed by exact verification of every target blob. It cannot be restored from JSON.
pub(crate) struct BlobTransferValidation {
    cut: TransferCut,
    root: CanonicalStateDir,
    catalog_digest: Digest,
}
impl BlobTransferValidation {
    pub(crate) fn matches(&self, cut: &TransferCut, target: &Content) -> bool {
        &self.cut == cut && target.world() == &cut.world && &self.root == target.blobs.identity()
    }

    /// Storage activation compares its own ordered target catalog; a cut alone is insufficient.
    pub(crate) fn matches_catalog(&self, blobs: &[BlobRef]) -> bool {
        catalog_digest(blobs) == self.catalog_digest
    }

    pub(crate) fn catalog_digest(&self) -> &Digest {
        &self.catalog_digest
    }
}

impl Content {
    /// Copy publication and storage activation share this physical gate, never a SQL copy transaction.
    pub(crate) fn lock_transfer_publication(&self) -> Result<std::fs::File, Error> {
        self.blobs.lock().map_err(Into::into)
    }

    /// SQL-only preparation. Copying and full byte verification happen after this snapshot ends.
    pub(crate) async fn prepare_transfer(
        &self,
        snapshot: &WorldSnapshot<'_>,
        cut: &TransferCut,
        maximum_blobs: usize,
    ) -> Result<BlobTransferPlan, Error> {
        self.check_world(snapshot.world())?;
        self.check_world(&cut.world)?;
        if maximum_blobs == 0 || maximum_blobs > 65_536 {
            return Err(Error::material(MaterialFailure::SizeLimit));
        }
        let world = snapshot.world();
        let head = snapshot.query_opt(
            "SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?.ok_or_else(|| Error::material(MaterialFailure::InputInvalid))?;
        if head.get::<_, String>("storage_id") != cut.source_storage_id
            || head.get::<_, i64>("writer_epoch") as u64 != cut.source_epoch.0
            || head.get::<_, String>("mode") != "fenced"
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let rows = snapshot.query(
            "SELECT b.digest,b.byte_size,b.state,EXISTS(SELECT 1 FROM world_blob_pin p WHERE p.tenant_id=b.tenant_id AND p.world_id=b.world_id AND p.digest=b.digest AND p.kind='transfer' AND p.owner_id=$3 AND p.released_at IS NULL) AS pinned FROM world_blob b WHERE b.tenant_id=$1 AND b.world_id=$2 AND b.state<>'deleted' ORDER BY b.digest LIMIT $4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &cut.transfer_id.as_str(), &((maximum_blobs + 1) as i64)],
        ).await?;
        if rows.len() > maximum_blobs {
            return Err(Error::material(MaterialFailure::SizeLimit));
        }
        let blobs = rows
            .into_iter()
            .map(|row| {
                if row.get::<_, String>("state") != "live" || !row.get::<_, bool>("pinned") {
                    return Err(Error::material(MaterialFailure::RetainedReferences));
                }
                let digest = Digest::try_new(row.get::<_, String>("digest"))
                    .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))?;
                let byte_size = u64::try_from(row.get::<_, i64>("byte_size"))
                    .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))?;
                Ok(BlobRef { digest, byte_size })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(BlobTransferPlan {
            cut: cut.clone(),
            blobs,
        })
    }

    /// Cancel/failure leaves durable target orphans, never an activation proof or a partial success.
    pub(crate) async fn copy_transfer(
        &self,
        plan: &BlobTransferPlan,
        target: &Content,
        target_store: &WorldStore,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        self.check_world(&plan.cut.world)?;
        target.check_world(&plan.cut.world)?;
        if self.blobs.identity() == target.blobs.identity() {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let _physical = self.blobs.lock()?;
        for blob in &plan.blobs {
            check_cancelled(cancellation)?;
            let bytes = self
                .blobs
                .read_locked(&super::digest_bytes(&blob.digest), blob.byte_size)?;
            let prepared =
                target.prepare_blob(&mut bytes.as_slice(), Some(&blob.digest), cancellation)?;
            if prepared.reference() != blob {
                return Err(Error::material(MaterialFailure::DigestMismatch));
            }
            let _target_publication = target.lock_transfer_publication()?;
            let cut = plan.cut.clone();
            let exact = blob.clone();
            target_store
                .snapshot(plan.cut.world.clone(), move |snapshot| {
                    Box::pin(async move { validate_target(snapshot, &cut, &exact).await })
                })
                .await?;
            check_cancelled(cancellation)?;
            target.blobs.publish_locked(&prepared.staged)?;
        }
        Ok(())
    }

    /// Target catalog is rechecked by S03 activation; no SQL transaction spans this full byte scan.
    pub(crate) fn validate_transfer(
        &self,
        plan: &BlobTransferPlan,
        cancellation: &CancellationToken,
    ) -> Result<BlobTransferValidation, Error> {
        self.check_world(&plan.cut.world)?;
        let _physical = self.blobs.lock()?;
        for blob in &plan.blobs {
            check_cancelled(cancellation)?;
            self.blobs
                .read_locked(&super::digest_bytes(&blob.digest), blob.byte_size)?;
        }
        Ok(BlobTransferValidation {
            cut: plan.cut.clone(),
            root: self.blobs.identity().clone(),
            catalog_digest: catalog_digest(&plan.blobs),
        })
    }
}

async fn validate_target(
    snapshot: &WorldSnapshot<'_>,
    cut: &TransferCut,
    blob: &BlobRef,
) -> Result<(), Error> {
    let world = snapshot.world();
    let ready = snapshot.query_opt(
        "SELECT 1 FROM world_storage_head h JOIN world_blob b ON b.tenant_id=h.tenant_id AND b.world_id=h.world_id WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.mode='prepared' AND h.storage_id=$3 AND h.writer_epoch=$4 AND h.transfer_id=$5 AND b.digest=$6 AND b.byte_size=$7 AND b.state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &cut.target_storage_id, &(cut.target_epoch.0 as i64), &cut.transfer_id.as_str(), &blob.digest.as_str(), &(blob.byte_size as i64)],
    ).await?;
    if ready.is_none() {
        return Err(Error::material(MaterialFailure::Deleted));
    }
    Ok(())
}

fn catalog_digest(blobs: &[BlobRef]) -> Digest {
    let mut hasher = Sha256::new();
    for blob in blobs {
        hasher.update(blob.digest.as_str().as_bytes());
        hasher.update(blob.byte_size.to_be_bytes());
    }
    Digest::try_new(format!(
        "sha256:{}",
        super::blob::digest_name(&hasher.finalize().into())
    ))
    .expect("SHA-256 is a protocol digest")
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::material(MaterialFailure::Cancelled))
    } else {
        Ok(())
    }
}
