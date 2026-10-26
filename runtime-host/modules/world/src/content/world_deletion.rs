use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    ids::{Digest, TransferId},
    materials::MaterialFailure,
};

use super::{Content, ContentOwner, ContentReference, Error, RetentionHold, decode, stable_id};
use crate::store::WorldTransaction;

pub(crate) struct ContentRetentionCounts {
    pub blobs: u64,
    pub references: u64,
    pub holds: u64,
    pub pins: u64,
}

/// The exclusive world mutation gate freezes admissions before this owner closure is read.
pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<Vec<ContentOwner>, Error> {
    tx.require_exclusive_storage()?;
    let world = tx.world();
    let mut owners = BTreeMap::new();
    let references = tx.query(
        "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL ORDER BY reference_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if references.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    for row in references {
        let reference: ContentReference = decode(row.get("body"))?;
        reference.owner.check_world(world)?;
        owners.insert(stable_id(&reference.owner)?.to_string(), reference.owner);
    }
    let holds = tx.query(
        "SELECT body FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL ORDER BY hold_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if holds.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    for row in holds {
        let hold: RetentionHold = decode(row.get("body"))?;
        hold.owner.check_world(world)?;
        owners.insert(stable_id(&hold.owner)?.to_string(), hold.owner);
    }
    if owners.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    // Upload pins have no ordinary content reference. Their identity comes from this
    // owner's durable upload catalog, never by reversing an owner hash.
    let uploads = tx.query(
        "SELECT transfer_id FROM world_content_upload WHERE tenant_id=$1 AND world_id=$2 ORDER BY transfer_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if uploads.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let mut pin_owners: BTreeSet<_> = owners.keys().cloned().collect();
    for row in uploads {
        let transfer_id = TransferId::try_new(row.get::<_, String>("transfer_id"))
            .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))?;
        pin_owners.insert(stable_id(&ContentOwner::Upload { transfer_id })?.to_string());
    }
    let archives = tx.query(
        "SELECT archive_digest FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 ORDER BY archive_digest LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if archives.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    for row in archives {
        let digest = Digest::try_new(row.get::<_, String>("archive_digest"))
            .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))?;
        pin_owners.insert(stable_id(&ContentOwner::Backup { digest })?.to_string());
    }
    let pins = tx.query(
        "SELECT DISTINCT owner_id FROM world_blob_pin WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL ORDER BY owner_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if pins.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    if pins
        .iter()
        .any(|row| !pin_owners.contains(&row.get::<_, String>("owner_id")))
    {
        // A surviving pin without a typed owner cannot authorize deleting that owner.
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    Ok(owners
        .into_values()
        .filter(|owner| {
            !matches!(
                owner,
                ContentOwner::Backup { .. } | ContentOwner::Upload { .. }
            )
        })
        .collect())
}

impl Content {
    pub(crate) async fn world_deletion_roots(
        &self,
        tx: &WorldTransaction<'_>,
    ) -> Result<Vec<ContentOwner>, Error> {
        self.check_world(tx.world())?;
        world_deletion_roots(tx).await
    }

    /// Counts are disjoint table records, not an additive count of unique business resources.
    pub(crate) async fn world_retention_counts(
        &self,
        tx: &WorldTransaction<'_>,
    ) -> Result<ContentRetentionCounts, Error> {
        self.check_world(tx.world())?;
        tx.require_exclusive_storage()?;
        let world = tx.world();
        let row = tx.query_opt(
            "SELECT (SELECT count(*) FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND state<>'deleted') AS blobs,(SELECT count(*) FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL) AS refs,(SELECT count(*) FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL) AS holds,(SELECT count(*) FROM world_blob_pin WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL) AS pins",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?.expect("aggregate returns one row");
        Ok(ContentRetentionCounts {
            blobs: row.get::<_, i64>("blobs") as u64,
            references: row.get::<_, i64>("refs") as u64,
            holds: row.get::<_, i64>("holds") as u64,
            pins: row.get::<_, i64>("pins") as u64,
        })
    }
}
