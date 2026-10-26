use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{Digest, OriginFamilyId, ParseArtifactId, RunId, WorldRef},
    materials::{
        BlobRef, CoverageEntry, DocumentAsset, DocumentBlock, DocumentTable, MaterialFailure,
        ParseArtifact, SourceLineage, SourceMapEntry, SourceVersion, SourceVersionRef,
    },
};

use super::{
    Content, ContentOwner, ContentReference, Error, PreparedBlob, decode, encode, retention,
};
use crate::store::WorldTransaction;

/// Parser output before the content owner assigns the durable manifest reference.
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParseInput {
    pub world: WorldRef,
    pub id: ParseArtifactId,
    pub source_version: SourceVersionRef,
    pub parse_run: RunId,
    pub parser_fingerprint: Digest,
    pub options_digest: Digest,
    pub dependency_fingerprints: Vec<Digest>,
    pub blocks: Vec<DocumentBlock>,
    pub tables: Vec<DocumentTable>,
    pub assets: Vec<DocumentAsset>,
    pub source_map: Vec<SourceMapEntry>,
    pub coverage: Vec<CoverageEntry>,
    pub metadata: std::collections::BTreeMap<String, String>,
}

pub(crate) struct PreparedParse {
    artifact: ParseArtifact,
    manifest: PreparedBlob,
}

impl PreparedParse {
    pub(crate) fn artifact(&self) -> &ParseArtifact {
        &self.artifact
    }
}

/// Digest-checked bytes loaded outside SQL; not current authorization or live custody.
pub(crate) struct LoadedParse {
    artifact: ParseArtifact,
}

impl LoadedParse {
    pub(crate) fn artifact(&self) -> &ParseArtifact {
        &self.artifact
    }

    pub(crate) fn into_artifact(self) -> ParseArtifact {
        self.artifact
    }
}

/// No block text, table values, quotes or source-map excerpts remain in PostgreSQL.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ParseMetadata {
    pub(super) world: WorldRef,
    pub(super) id: ParseArtifactId,
    pub(super) source_version: SourceVersionRef,
    parse_run: RunId,
    parser_fingerprint: Digest,
    options_digest: Digest,
    dependency_fingerprints: Vec<Digest>,
    pub(super) manifest: BlobRef,
}

impl ParseMetadata {
    fn from_artifact(artifact: &ParseArtifact) -> Self {
        Self {
            world: artifact.world.clone(),
            id: artifact.id.clone(),
            source_version: artifact.source_version.clone(),
            parse_run: artifact.parse_run.clone(),
            parser_fingerprint: artifact.parser_fingerprint.clone(),
            options_digest: artifact.options_digest.clone(),
            dependency_fingerprints: artifact.dependency_fingerprints.clone(),
            manifest: artifact.manifest.clone(),
        }
    }

    fn hydrate(self, input: ParseInput) -> Result<ParseArtifact, Error> {
        if self.world != input.world
            || self.id != input.id
            || self.source_version != input.source_version
            || self.parse_run != input.parse_run
            || self.parser_fingerprint != input.parser_fingerprint
            || self.options_digest != input.options_digest
            || self.dependency_fingerprints != input.dependency_fingerprints
        {
            return Err(Error::material(MaterialFailure::DigestMismatch));
        }
        Ok(ParseArtifact {
            world: self.world,
            id: self.id,
            source_version: self.source_version,
            parse_run: self.parse_run,
            parser_fingerprint: self.parser_fingerprint,
            options_digest: self.options_digest,
            dependency_fingerprints: self.dependency_fingerprints,
            manifest: self.manifest,
            blocks: input.blocks,
            tables: input.tables,
            assets: input.assets,
            source_map: input.source_map,
            coverage: input.coverage,
            metadata: input.metadata,
        })
    }
}

/// A confirmed read pin carries metadata, never document text, in a durable receipt.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParseRead {
    metadata: ParseMetadata,
    pin: super::BlobPin,
}

impl ParseRead {
    pub(crate) fn pin(&self) -> &super::BlobPin {
        &self.pin
    }

    pub(crate) fn artifact_id(&self) -> &ParseArtifactId {
        &self.metadata.id
    }

    pub(crate) fn matches_recovery_read(
        &self,
        world: &WorldRef,
        artifact: &ParseArtifactId,
        pin_id: &world_protocol::ids::ContentId,
    ) -> bool {
        &self.metadata.world == world
            && &self.metadata.id == artifact
            && &self.metadata.source_version.world == world
            && &self.pin.world == world
            && &self.pin.id == pin_id
            && self.pin.blob == self.metadata.manifest
            && self.pin.owner
                == (ContentOwner::ParseArtifact {
                    id: artifact.clone(),
                })
            && self.pin.kind == super::PinKind::Read
            && self.pin.generation.0 > 0
            && i64::try_from(self.pin.generation.0).is_ok()
    }
}

impl Content {
    pub(crate) async fn prepare_parse_read(
        &self,
        transaction: &WorldTransaction<'_>,
        id: &ParseArtifactId,
        pin_id: world_protocol::ids::ContentId,
    ) -> Result<ParseRead, Error> {
        self.check_world(transaction.world())?;
        let metadata = parse_metadata(transaction, id).await?;
        read_source_version_in_transaction(transaction, &metadata.source_version).await?;
        let pin = retention::pin(
            transaction,
            &ContentReference::new(
                ContentOwner::ParseArtifact { id: id.clone() },
                metadata.manifest.clone(),
            )?,
            pin_id,
            super::PinKind::Read,
        )
        .await?;
        Ok(ParseRead { metadata, pin })
    }

    pub(crate) async fn read_parse_pinned(
        &self,
        store: &crate::store::WorldStore,
        committed: &crate::store::Committed<ParseRead>,
    ) -> Result<LoadedParse, Error> {
        let pin = crate::store::Committed {
            value: committed.value.pin.clone(),
            receipt: committed.receipt.clone(),
            replayed: committed.replayed,
        };
        let payload = self.read_pinned(store, &pin).await?;
        let input: ParseInput = serde_json::from_slice(&payload)
            .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))?;
        Ok(LoadedParse {
            artifact: committed.value.metadata.clone().hydrate(input)?,
        })
    }

    pub(crate) fn prepare_parse(
        &self,
        input: ParseInput,
        cancellation: &CancellationToken,
    ) -> Result<PreparedParse, Error> {
        self.check_world(&input.world)?;
        self.check_world(&input.source_version.world)?;
        if input.coverage.is_empty() {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let payload = serde_json::to_vec(&input)
            .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?;
        let manifest = self.prepare_blob(&mut payload.as_slice(), None, cancellation)?;
        let artifact = ParseArtifact {
            world: input.world,
            id: input.id,
            source_version: input.source_version,
            parse_run: input.parse_run,
            parser_fingerprint: input.parser_fingerprint,
            options_digest: input.options_digest,
            dependency_fingerprints: input.dependency_fingerprints,
            manifest: manifest.reference.clone(),
            blocks: input.blocks,
            tables: input.tables,
            assets: input.assets,
            source_map: input.source_map,
            coverage: input.coverage,
            metadata: input.metadata,
        };
        Ok(PreparedParse { artifact, manifest })
    }

    pub(crate) fn discard_prepared_parse(&self, prepared: &PreparedParse) -> Result<(), Error> {
        self.discard_prepared(&prepared.manifest)
    }

    pub(crate) fn refresh_prepared_parse(&self, prepared: &mut PreparedParse) -> Result<(), Error> {
        self.refresh_prepared(&mut prepared.manifest)
    }

    pub(crate) async fn register_source_version(
        &self,
        transaction: &WorldTransaction<'_>,
        prepared: &PreparedBlob,
        version: &SourceVersion,
    ) -> Result<(), Error> {
        self.check_world(transaction.world())?;
        self.check_world(&version.reference.world)?;
        if prepared.world != self.world
            || prepared.reference != version.blob
            || version.media_type.is_empty()
            || version.media_type.len() > 256
            || version.access.revision.0 == 0
            || version.retention.revision.0 == 0
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        if let Some(previous) = &version.supersedes {
            if previous.source_id != version.reference.source_id || previous == &version.reference {
                return Err(Error::material(MaterialFailure::InputInvalid));
            }
            let previous = source_metadata(transaction, previous).await?;
            if previous.origin_family != version.origin_family {
                return Err(Error::material(MaterialFailure::InputInvalid));
            }
        }
        for lineage in &version.lineage {
            match lineage {
                SourceLineage::SourceVersion { reference } => {
                    let ancestor = source_metadata(transaction, reference).await?;
                    if ancestor.origin_family != version.origin_family
                        || reference == &version.reference
                    {
                        return Err(Error::material(MaterialFailure::InputInvalid));
                    }
                }
                SourceLineage::Generated { inputs, .. } => {
                    for input in inputs {
                        source_metadata(transaction, input).await?;
                    }
                }
                SourceLineage::WikiSource {
                    project_id,
                    source_id,
                    version,
                } => {
                    if [project_id, source_id, version]
                        .iter()
                        .any(|part| part.is_empty() || part.len() > 1024)
                    {
                        return Err(Error::material(MaterialFailure::InputInvalid));
                    }
                }
                SourceLineage::WikiPage {
                    project_id,
                    page_id,
                    version,
                    source_versions,
                } => {
                    if [project_id, page_id, version]
                        .iter()
                        .any(|part| part.is_empty() || part.len() > 1024)
                        || source_versions.len() > 4096
                    {
                        return Err(Error::material(MaterialFailure::InputInvalid));
                    }
                }
            }
        }
        retention::register_blob(self, transaction, prepared).await?;
        let body = encode(version)?;
        let access_revision = i64::try_from(version.access.revision.0)
            .map_err(|_| Error::material(MaterialFailure::InputInvalid))?;
        let retention_revision = i64::try_from(version.retention.revision.0)
            .map_err(|_| Error::material(MaterialFailure::InputInvalid))?;
        transaction.execute(
            "INSERT INTO world_source_version(tenant_id,world_id,source_id,version_id,blob_digest,media_type,captured_at,origin_family,supersedes_source_id,supersedes_version_id,access_policy_id,access_policy_revision,retention_policy_id,retention_policy_revision,body) VALUES($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING",
            &[&self.world.tenant_id.as_str(), &self.world.world_id.as_str(), &version.reference.source_id.as_str(),
              &version.reference.version_id.as_str(), &version.blob.digest.as_str(), &version.media_type, &version.captured_at.as_str(),
              &version.origin_family.as_str(), &version.supersedes.as_ref().map(|reference| reference.source_id.as_str()),
              &version.supersedes.as_ref().map(|reference| reference.version_id.as_str()), &version.access.policy_id.as_str(),
              &access_revision, &version.retention.policy_id.as_str(), &retention_revision, &body],
        ).await?;
        let stored = source_metadata(transaction, &version.reference).await?;
        if stored != *version {
            return Err(Error::material(MaterialFailure::DigestMismatch));
        }
        retention::retain(
            transaction,
            &ContentReference::new(
                ContentOwner::SourceVersion {
                    reference: version.reference.clone(),
                },
                version.blob.clone(),
            )?,
        )
        .await
    }

    /// Each source/parser/options/dependency axis is immutable; upgrading a parser adds an artifact, not a source version.
    pub(crate) async fn register_parse_artifact(
        &self,
        transaction: &WorldTransaction<'_>,
        prepared: &PreparedParse,
        assets: &[PreparedBlob],
    ) -> Result<(), Error> {
        self.check_world(transaction.world())?;
        let artifact = &prepared.artifact;
        self.check_world(&artifact.world)?;
        read_source_version_in_transaction(transaction, &artifact.source_version).await?;
        retention::register_blob(self, transaction, &prepared.manifest).await?;
        for asset in &artifact.assets {
            if let Some(bytes) = assets
                .iter()
                .find(|prepared| prepared.reference == asset.blob && prepared.world == self.world)
            {
                retention::register_blob(self, transaction, bytes).await?;
            } else {
                retention::lock_live_blob(transaction, &asset.blob).await?;
            }
        }
        let metadata = ParseMetadata::from_artifact(artifact);
        let body = encode(&metadata)?;
        transaction.execute(
            "INSERT INTO world_parse_artifact(tenant_id,world_id,artifact_id,source_id,source_version_id,parse_run_id,parser_fingerprint,options_digest,manifest_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
            &[&self.world.tenant_id.as_str(), &self.world.world_id.as_str(), &artifact.id.as_str(),
              &artifact.source_version.source_id.as_str(), &artifact.source_version.version_id.as_str(), &artifact.parse_run.as_str(),
              &artifact.parser_fingerprint.as_str(), &artifact.options_digest.as_str(), &artifact.manifest.digest.as_str(), &body],
        ).await?;
        let stored = parse_metadata(transaction, &artifact.id).await?;
        if encode(&stored)? != body {
            return Err(Error::material(MaterialFailure::DigestMismatch));
        }
        let owner = ContentOwner::ParseArtifact {
            id: artifact.id.clone(),
        };
        retention::retain(
            transaction,
            &ContentReference::new(owner.clone(), artifact.manifest.clone())?,
        )
        .await?;
        // A retained parse artifact keeps its exact source bytes and media dependencies, not a mutable latest.
        let source =
            read_source_version_in_transaction(transaction, &artifact.source_version).await?;
        retention::retain(
            transaction,
            &ContentReference::new(owner.clone(), source.blob)?,
        )
        .await?;
        for asset in &artifact.assets {
            retention::retain(
                transaction,
                &ContentReference::new(owner.clone(), asset.blob.clone())?,
            )
            .await?;
        }
        Ok(())
    }
}

pub(crate) async fn read_source_version_in_transaction(
    transaction: &WorldTransaction<'_>,
    reference: &SourceVersionRef,
) -> Result<SourceVersion, Error> {
    let version = source_metadata(transaction, reference).await?;
    retention::lock_live_blob(transaction, &version.blob).await?;
    let owned = ContentReference::new(
        ContentOwner::SourceVersion {
            reference: reference.clone(),
        },
        version.blob.clone(),
    )?;
    let world = transaction.world();
    if transaction.query_opt(
        "SELECT 1 FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND released_at IS NULL FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &owned.id().as_str()],
    ).await?.is_none() {
        return Err(Error::material(MaterialFailure::VersionContentUnavailable { reference: reference.clone() }));
    }
    Ok(version)
}

/// Transaction custody only; authorize first. No physical read or new read pin is performed.
pub(crate) async fn require_parse_artifact_in_transaction(
    transaction: &WorldTransaction<'_>,
    id: &ParseArtifactId,
    source: &SourceVersionRef,
) -> Result<(), Error> {
    if transaction.world() != &source.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let metadata = parse_metadata(transaction, id).await?;
    if metadata.source_version != *source {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    let version = read_source_version_in_transaction(transaction, source).await?;
    let world = transaction.world();
    let owner = ContentOwner::ParseArtifact { id: id.clone() };
    for blob in [&metadata.manifest, &version.blob] {
        retention::lock_live_blob(transaction, blob).await?;
        let reference = ContentReference::new(owner.clone(), blob.clone())?;
        let row = transaction.query_opt(
            "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND released_at IS NULL FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id().as_str()],
        ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
        if row.get::<_, serde_json::Value>("body") != encode(&reference)? {
            return Err(Error::material(MaterialFailure::CorruptContent));
        }
    }
    Ok(())
}

/// Recheck a loaded immutable manifest against current SQL custody; no physical I/O or authority.
pub(crate) async fn require_loaded_parse_in_transaction(
    transaction: &WorldTransaction<'_>,
    loaded: &LoadedParse,
) -> Result<(), Error> {
    let artifact = loaded.artifact();
    if transaction.world() != &artifact.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    require_parse_artifact_in_transaction(transaction, &artifact.id, &artifact.source_version)
        .await?;
    if parse_metadata(transaction, &artifact.id).await? != ParseMetadata::from_artifact(artifact) {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    Ok(())
}

/// Metadata only; each public disclosure still requires the current source policy.
pub(crate) async fn list_source_versions(
    transaction: &WorldTransaction<'_>,
    page: &world_protocol::query::PageRequest,
) -> Result<world_protocol::query::Page<SourceVersion>, Error> {
    if page.limit == 0 || page.limit > world_protocol::api::MAX_PAGE_ITEMS {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let cursor: Option<(WorldRef, String, String)> = page
        .cursor
        .as_deref()
        .map(|cursor| {
            if cursor.len() > 4096 {
                return Err(Error::material(MaterialFailure::InputInvalid));
            }
            serde_json::from_str(cursor)
                .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))
        })
        .transpose()?;
    if cursor.as_ref().is_some_and(|cursor| &cursor.0 != world) {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let (source, version) = cursor
        .as_ref()
        .map(|cursor| (cursor.1.as_str(), cursor.2.as_str()))
        .unwrap_or(("", ""));
    let rows = transaction.query(
        "SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND (source_id,version_id)>($3,$4) ORDER BY source_id,version_id LIMIT $5",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source, &version, &(i64::from(page.limit) + 1)],
    ).await?;
    let more = rows.len() > page.limit as usize;
    let mut items = Vec::new();
    let mut last = None;
    for row in rows.into_iter().take(page.limit as usize) {
        let source: SourceVersion = decode(row.get("body"))?;
        if &source.reference.world != world {
            return Err(Error::material(MaterialFailure::CorruptContent));
        }
        last = Some((
            world.clone(),
            source.reference.source_id.to_string(),
            source.reference.version_id.to_string(),
        ));
        let reference = ContentReference::new(
            ContentOwner::SourceVersion {
                reference: source.reference.clone(),
            },
            source.blob.clone(),
        )?;
        if transaction.query_opt(
            "SELECT 1 FROM world_content_reference r JOIN world_blob b ON b.tenant_id=r.tenant_id AND b.world_id=r.world_id AND b.digest=r.blob_digest WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.reference_id=$3 AND r.released_at IS NULL AND b.state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id().as_str()],
        ).await?.is_some() {
            items.push(source);
        }
    }
    let next_cursor = if more {
        Some(
            serde_json::to_string(
                &last.ok_or_else(|| Error::material(MaterialFailure::CorruptContent))?,
            )
            .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?,
        )
    } else {
        None
    };
    Ok(world_protocol::query::Page { items, next_cursor })
}

/// Internal metadata only, without a live-custody check or physical content read.
pub(crate) async fn read_source_version_metadata_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    reference: &SourceVersionRef,
) -> Result<SourceVersion, Error> {
    if snapshot.world() != &reference.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND version_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.source_id.as_str(), &reference.version_id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::SourceVersionMissing { reference: reference.clone() }))?;
    let source: SourceVersion = decode(row.get("body"))?;
    if source.reference != *reference {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    Ok(source)
}

/// Read metadata and retained source custody without opening any physical content.
pub(crate) async fn read_source_version_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    reference: &SourceVersionRef,
) -> Result<SourceVersion, Error> {
    let source = read_source_version_metadata_snapshot(snapshot, reference).await?;
    let world = snapshot.world();
    let retained = ContentReference::new(
        ContentOwner::SourceVersion {
            reference: reference.clone(),
        },
        source.blob.clone(),
    )?;
    if snapshot.query_opt(
        "SELECT b.byte_size FROM world_content_reference r JOIN world_blob b ON b.tenant_id=r.tenant_id AND b.world_id=r.world_id AND b.digest=r.blob_digest WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.reference_id=$3 AND r.released_at IS NULL AND b.state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &retained.id().as_str()],
    ).await?.is_none_or(|row| u64::try_from(row.get::<_, i64>("byte_size")).ok() != Some(source.blob.byte_size)) {
        return Err(Error::material(MaterialFailure::VersionContentUnavailable { reference: reference.clone() }));
    }
    Ok(source)
}

/// Snapshot custody only; this neither hydrates the manifest nor proves physical bytes.
pub(crate) async fn require_parse_artifact_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    id: &ParseArtifactId,
    source: &SourceVersionRef,
) -> Result<(), Error> {
    if snapshot.world() != &source.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT body FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let metadata: ParseMetadata = decode(row.get("body"))?;
    if metadata.world != *world || metadata.id != *id || metadata.source_version != *source {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    let version = read_source_version_snapshot(snapshot, source).await?;
    let owner = ContentOwner::ParseArtifact { id: id.clone() };
    for blob in [&metadata.manifest, &version.blob] {
        let reference = ContentReference::new(owner.clone(), blob.clone())?;
        if snapshot.query_opt(
            "SELECT b.byte_size FROM world_content_reference r JOIN world_blob b ON b.tenant_id=r.tenant_id AND b.world_id=r.world_id AND b.digest=r.blob_digest WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.reference_id=$3 AND r.released_at IS NULL AND b.state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id().as_str()],
        ).await?.is_none_or(|row| u64::try_from(row.get::<_, i64>("byte_size")).ok() != Some(blob.byte_size)) {
            return Err(Error::material(MaterialFailure::ContentNotFound));
        }
    }
    Ok(())
}

/// Historical metadata stays immutable; only required locators demand current live custody.
pub(crate) async fn validate_archive_restore(
    transaction: &WorldTransaction<'_>,
    source_rows: &[serde_json::Value],
    parse_rows: &[serde_json::Value],
    required: &[world_protocol::facts::EvidenceLocator],
) -> Result<(), Error> {
    use serde_json::Value;
    use std::collections::BTreeMap;

    transaction.require_exclusive_storage()?;
    if source_rows.len() > 65_536 || parse_rows.len() > 65_536 || required.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let invalid = || Error::material(MaterialFailure::CorruptContent);
    let world = transaction.world();
    let same_world = |row: &Value| {
        row.get("tenant_id").and_then(Value::as_str) == Some(world.tenant_id.as_str())
            && row.get("world_id").and_then(Value::as_str) == Some(world.world_id.as_str())
    };
    let mut sources = BTreeMap::new();
    for row in source_rows {
        let source: SourceVersion = decode(row.get("body").cloned().ok_or_else(invalid)?)?;
        let key = (
            source.reference.source_id.clone(),
            source.reference.version_id.clone(),
        );
        if !same_world(row)
            || source.reference.world != *world
            || row.get("source_id").and_then(Value::as_str)
                != Some(source.reference.source_id.as_str())
            || row.get("version_id").and_then(Value::as_str)
                != Some(source.reference.version_id.as_str())
            || row.get("blob_digest").and_then(Value::as_str) != Some(source.blob.digest.as_str())
            || sources.contains_key(&key)
        {
            return Err(invalid());
        }
        if let Some(current) = transaction.query_opt(
            "SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND version_id=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source.reference.source_id.as_str(), &source.reference.version_id.as_str()],
        ).await? {
            if current.get::<_, Value>("body") != encode(&source)? {
                return Err(Error::material(MaterialFailure::DigestMismatch));
            }
        }
        sources.insert(key, source);
    }
    let mut parses = BTreeMap::new();
    for row in parse_rows {
        let metadata: ParseMetadata = decode(row.get("body").cloned().ok_or_else(invalid)?)?;
        if !same_world(row)
            || metadata.world != *world
            || metadata.source_version.world != *world
            || row.get("artifact_id").and_then(Value::as_str) != Some(metadata.id.as_str())
            || row.get("source_id").and_then(Value::as_str)
                != Some(metadata.source_version.source_id.as_str())
            || row.get("source_version_id").and_then(Value::as_str)
                != Some(metadata.source_version.version_id.as_str())
            || row.get("manifest_digest").and_then(Value::as_str)
                != Some(metadata.manifest.digest.as_str())
            || row.get("parse_run_id").and_then(Value::as_str) != Some(metadata.parse_run.as_str())
            || row.get("parser_fingerprint").and_then(Value::as_str)
                != Some(metadata.parser_fingerprint.as_str())
            || row.get("options_digest").and_then(Value::as_str)
                != Some(metadata.options_digest.as_str())
            || parses.contains_key(&metadata.id)
        {
            return Err(invalid());
        }
        if let Some(current) = transaction.query_opt(
            "SELECT body FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &metadata.id.as_str()],
        ).await? {
            if current.get::<_, Value>("body") != encode(&metadata)? {
                return Err(Error::material(MaterialFailure::DigestMismatch));
            }
        }
        parses.insert(metadata.id.clone(), metadata);
    }
    let mut checked_sources = BTreeSet::new();
    let mut checked_parses = BTreeSet::new();
    for locator in required {
        let reference = &locator.source_version;
        if &reference.world != world {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let key = (reference.source_id.clone(), reference.version_id.clone());
        if !sources.contains_key(&key) {
            sources.insert(key.clone(), source_metadata(transaction, reference).await?);
        }
        let source = sources.get(&key).expect("required source was resolved");
        if checked_sources.insert(key) {
            retention::lock_live_blob(transaction, &source.blob).await?;
            let owned = ContentReference::new(
                ContentOwner::SourceVersion {
                    reference: reference.clone(),
                },
                source.blob.clone(),
            )?;
            let body = encode(&owned)?;
            if transaction.query_opt(
                "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND released_at IS NULL FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &owned.id().as_str()],
            ).await?.is_none_or(|row| row.get::<_, Value>("body") != body) {
                return Err(Error::material(MaterialFailure::VersionContentUnavailable { reference: reference.clone() }));
            }
        }
        let Some(id) = &locator.parse_artifact_id else {
            continue;
        };
        if !parses.contains_key(id) {
            parses.insert(id.clone(), parse_metadata(transaction, id).await?);
        }
        let metadata = parses.get(id).expect("required parse was resolved");
        if metadata.source_version != *reference {
            return Err(invalid());
        }
        if checked_parses.insert(id.clone()) {
            let owner = ContentOwner::ParseArtifact { id: id.clone() };
            let references = retention::owner_references(transaction, &owner).await?;
            for blob in [&metadata.manifest, &source.blob] {
                let reference = ContentReference::new(owner.clone(), blob.clone())?;
                if !references.contains(&reference) {
                    return Err(Error::material(MaterialFailure::ContentNotFound));
                }
            }
            for reference in &references {
                if reference.owner != owner {
                    return Err(invalid());
                }
                retention::lock_live_blob(transaction, &reference.blob).await?;
            }
        }
    }
    Ok(())
}

pub(crate) async fn parse_source_version(
    transaction: &WorldTransaction<'_>,
    id: &ParseArtifactId,
) -> Result<SourceVersion, Error> {
    Ok(parse_origin(transaction, id).await?.0)
}

pub(crate) async fn parse_origin(
    transaction: &WorldTransaction<'_>,
    id: &ParseArtifactId,
) -> Result<(SourceVersion, RunId), Error> {
    let metadata = parse_metadata(transaction, id).await?;
    let source = read_source_version_in_transaction(transaction, &metadata.source_version).await?;
    Ok((source, metadata.parse_run))
}

/// Internal metadata only: authorize the current material policy before checking live custody.
pub(crate) async fn source_metadata(
    transaction: &WorldTransaction<'_>,
    reference: &SourceVersionRef,
) -> Result<SourceVersion, Error> {
    if transaction.world() != &reference.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND version_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.source_id.as_str(), &reference.version_id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::SourceVersionMissing { reference: reference.clone() }))?;
    let version: SourceVersion = decode(row.get("body"))?;
    if version.reference != *reference {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    Ok(version)
}

#[derive(Debug)]
pub(crate) enum SourceOriginError {
    Content(Error),
    ConflictingFamilies { families: Vec<OriginFamilyId> },
}

impl From<Error> for SourceOriginError {
    fn from(error: Error) -> Self {
        Self::Content(error)
    }
}

impl std::fmt::Display for SourceOriginError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Content(error) => std::fmt::Display::fmt(error, formatter),
            Self::ConflictingFamilies { .. } => {
                formatter.write_str("world content source origin family conflict")
            }
        }
    }
}

impl std::error::Error for SourceOriginError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Content(error) => Some(error),
            Self::ConflictingFamilies { .. } => None,
        }
    }
}

/// Metadata only. The caller supplies digest-checked bytes or a checked sealed upload,
/// and producer-verified lineage; this does not authorize access or assert independence.
pub(crate) async fn source_origin_family(
    transaction: &WorldTransaction<'_>,
    blob: &BlobRef,
    lineage: &[SourceLineage],
) -> Result<OriginFamilyId, SourceOriginError> {
    let size_limit = || Error::material(MaterialFailure::SizeLimit);
    if lineage.len() > 65_536 {
        return Err(size_limit().into());
    }
    let world = transaction.world();
    let mut references = BTreeSet::new();
    let mut input_count = 0;
    for entry in lineage {
        let inputs = match entry {
            SourceLineage::SourceVersion { reference } => std::slice::from_ref(reference),
            SourceLineage::Generated { inputs, .. } => inputs.as_slice(),
            SourceLineage::WikiSource { .. } | SourceLineage::WikiPage { .. } => continue,
        };
        if inputs.len() > 65_536 - input_count {
            return Err(size_limit().into());
        }
        input_count += inputs.len();
        for reference in inputs {
            if &reference.world != world {
                return Err(Error::material(MaterialFailure::InputInvalid).into());
            }
            references.insert((reference.source_id.clone(), reference.version_id.clone()));
        }
    }
    let rows = transaction.query(
        "SELECT source_id,version_id,origin_family,body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 ORDER BY source_id,version_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str()],
    ).await.map_err(Error::from)?;
    if rows.len() > 65_536 {
        return Err(size_limit().into());
    }
    let mut families = BTreeSet::new();
    for row in rows {
        let version: SourceVersion = decode(row.get("body"))?;
        if &version.reference.world != world || version.blob != *blob
            || version.reference.source_id.as_str() != row.get::<_, String>("source_id")
            || version.reference.version_id.as_str() != row.get::<_, String>("version_id")
            || version.origin_family.as_str() != row.get::<_, String>("origin_family")
        {
            return Err(Error::material(MaterialFailure::CorruptContent).into());
        }
        families.insert(version.origin_family);
    }
    for (source_id, version_id) in references {
        let reference = SourceVersionRef { world: world.clone(), source_id, version_id };
        let version = source_metadata(transaction, &reference).await?;
        families.insert(version.origin_family);
    }
    match families.len() {
        0 => Ok(OriginFamilyId::try_new(
            super::stable_id(&("world.source.origin-family.v1", world, &blob.digest))?.as_str(),
        ).expect("bounded digest identifier")),
        1 => Ok(families.into_iter().next().expect("one origin family")),
        _ => Err(SourceOriginError::ConflictingFamilies {
            families: families.into_iter().collect(),
        }),
    }
}

async fn parse_metadata(
    transaction: &WorldTransaction<'_>,
    id: &ParseArtifactId,
) -> Result<ParseMetadata, Error> {
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT body FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let metadata: ParseMetadata = decode(row.get("body"))?;
    if metadata.world != *world || metadata.id != *id {
        return Err(Error::material(MaterialFailure::CorruptContent));
    }
    Ok(metadata)
}
