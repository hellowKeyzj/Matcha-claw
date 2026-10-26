use std::collections::{BTreeMap, BTreeSet};

use platform::state_dir::CanonicalStateDir;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{Digest, ParseArtifactId, SourceId, SourceVersionId, WorldRef},
    materials::{BlobRef, MaterialFailure, SourceLineage, SourceVersionRef},
};

use super::{
    Content, ContentOwner, ContentReference, Error, RetentionHold, decode,
    read_source_version_metadata_snapshot, records::ParseMetadata,
};
use crate::store::{ArchiveSnapshot, RetentionRoots, WorldSnapshot};

pub(crate) struct ArchiveMaterials {
    pub source_versions: Vec<SourceVersionRef>,
    pub parse_artifacts: Vec<ParseArtifactId>,
    pub blobs: Vec<BlobRef>,
}

/// Selects existing immutable identities and live bytes in the caller's repeatable-read snapshot.
pub(crate) async fn archive_materials(
    snapshot: &WorldSnapshot<'_>,
    roots: &RetentionRoots,
    include_materials: bool,
) -> Result<ArchiveMaterials, Error> {
    let invalid = || Error::material(MaterialFailure::CorruptContent);
    let world = snapshot.world();
    if roots.source_versions.len() > 65_536 || roots.parse_artifacts.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let mut sources = BTreeMap::new();
    let mut parses: BTreeSet<_> = roots.parse_artifacts.iter().cloned().collect();
    for reference in &roots.source_versions {
        if &reference.world != world {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        sources.insert(
            (reference.source_id.clone(), reference.version_id.clone()),
            reference.clone(),
        );
    }
    let catalog = snapshot.query(
        "SELECT digest,byte_size FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=world_blob.tenant_id AND d.world_id=world_blob.world_id AND d.blob_digest=world_blob.digest) ORDER BY digest LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if catalog.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let mut live = BTreeMap::new();
    for row in catalog {
        let digest = Digest::try_new(row.get::<_, String>("digest")).map_err(|_| invalid())?;
        let byte_size = u64::try_from(row.get::<_, i64>("byte_size")).map_err(|_| invalid())?;
        live.insert(digest.clone(), BlobRef { digest, byte_size });
    }
    if include_materials {
        let rows = snapshot.query(
            "SELECT source_id,version_id FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 ORDER BY source_id,version_id LIMIT 65537",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?;
        if rows.len() > 65_536 {
            return Err(Error::material(MaterialFailure::SizeLimit));
        }
        for row in rows {
            let source_id =
                SourceId::try_new(row.get::<_, String>("source_id")).map_err(|_| invalid())?;
            let version_id = SourceVersionId::try_new(row.get::<_, String>("version_id"))
                .map_err(|_| invalid())?;
            sources.insert(
                (source_id.clone(), version_id.clone()),
                SourceVersionRef {
                    world: world.clone(),
                    source_id,
                    version_id,
                },
            );
        }
        let rows = snapshot.query(
            "SELECT artifact_id FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 ORDER BY artifact_id LIMIT 65537",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?;
        if rows.len() > 65_536 {
            return Err(Error::material(MaterialFailure::SizeLimit));
        }
        for row in rows {
            parses.insert(
                ParseArtifactId::try_new(row.get::<_, String>("artifact_id"))
                    .map_err(|_| invalid())?,
            );
        }
    }
    if sources.len() > 65_536 || parses.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    for id in &parses {
        let row = snapshot.query_opt(
            "SELECT body,source_id,source_version_id,manifest_digest FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
        ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
        let metadata: ParseMetadata = decode(row.get("body"))?;
        if metadata.world != *world
            || metadata.id != *id
            || metadata.source_version.world != *world
            || row.get::<_, String>("source_id") != metadata.source_version.source_id.as_str()
            || row.get::<_, String>("source_version_id")
                != metadata.source_version.version_id.as_str()
            || row.get::<_, String>("manifest_digest") != metadata.manifest.digest.as_str()
        {
            return Err(invalid());
        }
        sources.insert(
            (
                metadata.source_version.source_id.clone(),
                metadata.source_version.version_id.clone(),
            ),
            metadata.source_version,
        );
        if sources.len() > 65_536 {
            return Err(Error::material(MaterialFailure::SizeLimit));
        }
    }
    let mut pending: Vec<_> = sources.values().cloned().collect();
    while let Some(reference) = pending.pop() {
        let source = read_source_version_metadata_snapshot(snapshot, &reference).await?;
        let mut ancestors: Vec<_> = source.supersedes.into_iter().collect();
        for lineage in source.lineage {
            match lineage {
                SourceLineage::SourceVersion { reference } => ancestors.push(reference),
                SourceLineage::Generated { inputs, .. } => ancestors.extend(inputs),
                SourceLineage::WikiSource { .. } | SourceLineage::WikiPage { .. } => {}
            }
        }
        for ancestor in ancestors {
            if &ancestor.world != world {
                return Err(invalid());
            }
            if let std::collections::btree_map::Entry::Vacant(entry) =
                sources.entry((ancestor.source_id.clone(), ancestor.version_id.clone()))
            {
                entry.insert(ancestor.clone());
                pending.push(ancestor);
                if sources.len() > 65_536 {
                    return Err(Error::material(MaterialFailure::SizeLimit));
                }
            }
        }
    }
    if include_materials {
        return Ok(ArchiveMaterials {
            source_versions: sources.into_values().collect(),
            parse_artifacts: parses.into_iter().collect(),
            blobs: live.into_values().collect(),
        });
    }
    let mut required = BTreeMap::new();
    let references = snapshot.query(
        "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL ORDER BY reference_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    let holds = snapshot.query(
        "SELECT body FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND released_at IS NULL ORDER BY hold_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    if references.len() > 65_536 || holds.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let selected = |owner: &ContentOwner| -> Result<bool, Error> {
        owner.check_world(world)?;
        Ok(match owner {
            ContentOwner::SourceVersion { reference } => {
                sources.contains_key(&(reference.source_id.clone(), reference.version_id.clone()))
            }
            ContentOwner::ParseArtifact { id } => parses.contains(id),
            ContentOwner::Upload { .. } | ContentOwner::Backup { .. } => false,
            _ => true,
        })
    };
    for row in references {
        let reference: ContentReference = decode(row.get("body"))?;
        if reference != ContentReference::new(reference.owner.clone(), reference.blob.clone())? {
            return Err(invalid());
        }
        if selected(&reference.owner)? {
            match live.get(&reference.blob.digest) {
                Some(blob) if blob == &reference.blob => {
                    required.insert(blob.digest.clone(), blob.clone());
                }
                Some(_) => return Err(invalid()),
                None => {}
            }
        }
    }
    for row in holds {
        let hold: RetentionHold = decode(row.get("body"))?;
        if selected(&hold.owner)? {
            if let Some(blob) = live.get(&hold.blob.digest) {
                if blob != &hold.blob {
                    return Err(invalid());
                }
                required.insert(blob.digest.clone(), blob.clone());
            }
        }
    }
    Ok(ArchiveMaterials {
        source_versions: sources.into_values().collect(),
        parse_artifacts: parses.into_iter().collect(),
        blobs: required.into_values().collect(),
    })
}

/// Only a full physical verification can mint this same-storage archive proof.
pub(crate) struct BlobArchiveValidation {
    world: WorldRef,
    storage_id: String,
    snapshot: Digest,
    root: CanonicalStateDir,
    catalog: Vec<BlobRef>,
}

impl BlobArchiveValidation {
    pub(crate) fn matches(&self, snapshot: &ArchiveSnapshot, content: &Content) -> bool {
        &self.world == snapshot.world()
            && content.world() == &self.world
            && self.storage_id == snapshot.storage_id()
            && &self.snapshot == snapshot.digest()
            && &self.root == content.blobs.identity()
    }

    pub(crate) fn matches_catalog(&self, catalog: &[BlobRef]) -> bool {
        self.catalog == catalog
    }
}

impl Content {
    /// Archive custody uses the same Content pin admission, never a second reference ledger.
    pub(crate) async fn retain_archive(
        &self,
        tx: &crate::store::WorldTransaction<'_>,
        snapshot: &ArchiveSnapshot,
    ) -> Result<(), Error> {
        self.check_world(tx.world())?;
        self.check_world(snapshot.world())?;
        let owner = super::ContentOwner::Backup {
            digest: snapshot.digest().clone(),
        };
        for blob in snapshot.blob_catalog() {
            let generation = super::retention::lock_live_blob(tx, blob).await?;
            let id = super::stable_id(&("archive", snapshot.digest(), blob))?;
            super::retention::pin_registered(
                tx,
                blob,
                owner.clone(),
                id,
                super::PinKind::Backup,
                generation,
            )
            .await?;
        }
        Ok(())
    }

    /// A legal Backup reference is checked before issuing the run's independent recovery custody.
    pub(crate) async fn pin_archive_read(
        &self,
        tx: &crate::store::WorldTransaction<'_>,
        archive: &Digest,
        blob: &BlobRef,
        run: &world_protocol::ids::RunId,
        id: world_protocol::ids::ContentId,
    ) -> Result<super::BlobPin, Error> {
        self.check_world(tx.world())?;
        let backup = super::ContentReference::new(
            super::ContentOwner::Backup {
                digest: archive.clone(),
            },
            blob.clone(),
        )?;
        let world = tx.world();
        if tx.query_opt(
            "SELECT 1 FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND released_at IS NULL FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &backup.id().as_str()],
        ).await?.is_none() {
            return Err(Error::material(MaterialFailure::ContentNotFound));
        }
        let generation = super::retention::lock_live_blob(tx, blob).await?;
        let reference = super::ContentReference::new(
            super::ContentOwner::Run { id: run.clone() },
            blob.clone(),
        )?;
        super::retention::retain(tx, &reference).await?;
        super::retention::pin_registered(
            tx,
            blob,
            reference.owner,
            id,
            super::PinKind::Recovery,
            generation,
        )
        .await
    }

    /// No SQL transaction spans this full hash scan; the final exclusive transaction checks custody.
    pub(crate) fn validate_archive(
        &self,
        snapshot: &ArchiveSnapshot,
        cancellation: &CancellationToken,
    ) -> Result<BlobArchiveValidation, Error> {
        self.check_world(snapshot.world())?;
        let catalog = snapshot.blob_catalog();
        if catalog.len() > 65_536
            || catalog
                .windows(2)
                .any(|pair| pair[0].digest.as_str() >= pair[1].digest.as_str())
            || catalog.iter().any(|blob| blob.byte_size > i64::MAX as u64)
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let _physical = self.blobs.lock()?;
        if cancellation.is_cancelled() {
            return Err(Error::material(MaterialFailure::Cancelled));
        }
        for blob in catalog {
            if cancellation.is_cancelled() {
                return Err(Error::material(MaterialFailure::Cancelled));
            }
            self.blobs
                .read_locked(&super::digest_bytes(&blob.digest), blob.byte_size)?;
        }
        if cancellation.is_cancelled() {
            return Err(Error::material(MaterialFailure::Cancelled));
        }
        Ok(BlobArchiveValidation {
            world: self.world.clone(),
            storage_id: snapshot.storage_id().to_owned(),
            snapshot: snapshot.digest().clone(),
            root: self.blobs.identity().clone(),
            catalog: catalog.to_vec(),
        })
    }
}
