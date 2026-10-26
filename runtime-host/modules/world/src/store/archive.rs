use serde::{Deserialize, Serialize};
use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    ids::{ActivationLockId, Digest, Generation, ReleaseId, Revision, WorldRef},
    materials::BlobRef,
};

use super::{
    StoreError, WorldStore, WorldTransaction, schema,
    transfer::{TableExport, TableManifest},
};
use crate::{
    content::{BlobArchiveValidation, Content},
    extensions::package::{Inventory, PackageArchiveValidation},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchiveManifest {
    world: WorldRef,
    storage_id: String,
    schema_digest: Digest,
    incarnation: Generation,
    revision: Revision,
    release_id: ReleaseId,
    channel: String,
    activation_lock: ActivationLockId,
    include_materials: bool,
    included: Vec<TableManifest>,
    retained: Vec<String>,
    blobs: Vec<BlobRef>,
    packages: Vec<(Digest, Digest)>,
}

/// A finite same-storage archive, never a transfer cut or authority grant.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveSnapshot {
    pub(super) manifest: ArchiveManifest,
    pub(super) tables: Vec<TableExport>,
    digest: Digest,
    #[serde(skip)]
    observed: bool,
}

impl ArchiveSnapshot {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.manifest.world
    }
    pub(crate) fn storage_id(&self) -> &str {
        &self.manifest.storage_id
    }
    pub(crate) fn digest(&self) -> &Digest {
        &self.digest
    }
    pub(crate) fn blob_catalog(&self) -> &[BlobRef] {
        &self.manifest.blobs
    }
    pub(crate) fn package_catalog(&self) -> &[(Digest, Digest)] {
        &self.manifest.packages
    }
    pub(crate) fn include_materials(&self) -> bool {
        self.manifest.include_materials
    }
    pub(crate) fn release_id(&self) -> &ReleaseId {
        &self.manifest.release_id
    }
    pub(crate) fn activation_lock(&self) -> &ActivationLockId {
        &self.manifest.activation_lock
    }
    /// Current binding heads and unfinished runs are added from the retained live ledgers.
    pub(crate) fn required_activation_locks(&self) -> std::collections::BTreeSet<ActivationLockId> {
        std::collections::BTreeSet::from([self.manifest.activation_lock.clone()])
    }
    pub(super) fn rows(&self, table: &str) -> &[serde_json::Value] {
        self.tables
            .iter()
            .find(|entry| entry.table == table)
            .map_or(&[], |entry| entry.rows.as_slice())
    }
}

pub(super) fn conflict(constraint: ConstraintCode) -> StoreError {
    StoreError::new(
        CommitFailure::ConstraintConflict { constraint },
        FailureStage::Validate,
    )
}
fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate)
}
fn material_table(name: &str) -> bool {
    matches!(name, "world_source_version" | "world_parse_artifact")
}

/// Only exact historical carriers may survive a restore without an active archive head.
pub(super) fn history_table(name: &str) -> bool {
    material_table(name)
        || matches!(name,
            "world_scope_revision" | "world_definition_identity" | "world_definition_revision"
            | "world_definition_dependency" | "world_definition_lineage" | "world_kind_registration"
            | "world_identity_revision" | "world_source_alias_revision"
            | "world_identity_resolution" | "world_identity_resolution_member"
            | "world_evidence_revision" | "world_evidence_derived_from"
            | "world_assertion_identity" | "world_assertion_revision" | "world_assertion_role"
            | "world_assertion_evidence" | "world_assertion_subject"
            | "world_definition_evidence_revision" | "world_definition_evidence"
            | "world_support_revision" | "world_support_premise" | "world_explanation_revision"
            | "world_source_schema_revision" | "world_schema_mapping_revision"
            | "world_source_binding_revision" | "world_source_record_state"
            | "world_artifact_manifest" | "world_compile_dependency" | "world_release"
            | "world_release_definition" | "world_release_head_history"
            | "world_branch" | "world_branch_revision" | "world_change_set"
            | "world_branch_derivation_revision"
            | "world_candidate" | "world_candidate_revision"
            | "world_definition_annotation_revision" | "world_definition_link_revision"
            | "world_source_branch_capture" | "world_branch_identity_reservation"
            | "world_branch_identity_promotion")
}
fn hash(value: &impl Serialize) -> Result<Digest, StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, cause)
    })?;
    Digest::try_new(schema::checksum(&bytes)).map_err(|_| invalid())
}

pub(super) async fn catalog(
    tx: &tokio_postgres::Transaction<'_>,
) -> Result<Vec<String>, StoreError> {
    let names: Vec<String> = tx
        .query_one("SELECT world_archive_included()", &[])
        .await
        .map_err(|error| StoreError::database(error, FailureStage::Read))?
        .get(0);
    let known = schema::tables();
    if names.is_empty() || names.iter().any(|name| !known.contains(&name.as_str())) {
        return Err(invalid());
    }
    Ok(names)
}

impl WorldStore {
    /// Exact manifest-blob lookup precedes reading any untrusted serialized archive rows.
    pub(crate) async fn sealed_archive(
        &self,
        world: WorldRef,
        blob: &BlobRef,
    ) -> Result<Digest, StoreError> {
        if blob.byte_size > i64::MAX as u64 {
            return Err(invalid());
        }
        let blob = blob.clone();
        self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt("SELECT archive_digest FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND manifest_blob_digest=$3 AND manifest_blob_size=$4",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str(), &(blob.byte_size as i64)]).await?.ok_or_else(|| conflict(ConstraintCode::ForeignReference))?;
            Digest::try_new(row.get::<_, String>(0)).map_err(|_| invalid())
        })).await
    }

    pub(crate) async fn archive_snapshot(
        &self,
        world: WorldRef,
        expected_release: ReleaseId,
        include_materials: bool,
        max_bytes: usize,
    ) -> Result<ArchiveSnapshot, StoreError> {
        if max_bytes == 0 || max_bytes > 268_435_456 {
            return Err(invalid());
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let snapshot = {
            let tx = client
                .build_transaction()
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .read_only(true)
                .start()
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Read))?;
            self.configure(&tx, &world).await?;
            let head = tx.query_opt(
                "SELECT r.generation,r.revision,r.status,r.active_release_channel,h.storage_id,h.mode,l.release_id,v.activation_lock_id FROM world_runtime_head r JOIN world_storage_head h USING(tenant_id,world_id) JOIN world_release_head l ON l.tenant_id=r.tenant_id AND l.world_id=r.world_id AND l.channel=r.active_release_channel JOIN world_release v USING(tenant_id,world_id,release_id) WHERE r.tenant_id=$1 AND r.world_id=$2",
                &[&world.tenant_id.as_str(), &world.world_id.as_str()],
            ).await.map_err(|error| StoreError::database(error, FailureStage::Read))?.ok_or_else(invalid)?;
            if head.get::<_, String>("status") != "ready"
                || head.get::<_, String>("mode") != "active"
                || head.get::<_, String>("release_id") != expected_release.as_str()
                || head.get::<_, String>("storage_id") != self.identity_receipt().storage_id()
            {
                return Err(conflict(ConstraintCode::HeadGeneration));
            }
            let read = super::WorldSnapshot {
                transaction: tx,
                world: world.clone(),
            };
            let roots = if include_materials {
                super::RetentionRoots::default()
            } else {
                crate::owner::archive_retention_roots(&read)
                    .await
                    .map_err(super::retention::reference_error)?
            };
            let materials = crate::content::archive_materials(&read, &roots, include_materials)
                .await
                .map_err(super::retention::reference_error)?;
            let sources: std::collections::BTreeSet<_> = materials
                .source_versions
                .iter()
                .map(|reference| (reference.source_id.as_str(), reference.version_id.as_str()))
                .collect();
            let parses: std::collections::BTreeSet<_> = materials
                .parse_artifacts
                .iter()
                .map(|id| id.as_str())
                .collect();
            let tx = &read.transaction;
            let names = catalog(tx).await?;
            let mut size = 0usize;
            let mut tables = Vec::new();
            let mut included = Vec::new();
            for name in &names {
                let mut rows = Vec::new();
                let sql = format!(
                    "SELECT to_jsonb(t) FROM public.{name} t WHERE tenant_id=$1 AND world_id=$2 ORDER BY to_jsonb(t)::text COLLATE \"C\" LIMIT 512 OFFSET $3"
                );
                let mut offset = 0i64;
                loop {
                    let page = tx
                        .query(
                            &sql,
                            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &offset],
                        )
                        .await
                        .map_err(|error| StoreError::database(error, FailureStage::Read))?;
                    let count = page.len();
                    for row in page {
                        let row: serde_json::Value = row.get(0);
                        if !include_materials
                            && match name.as_str() {
                                "world_source_version" => !row
                                    .get("source_id")
                                    .and_then(serde_json::Value::as_str)
                                    .zip(row.get("version_id").and_then(serde_json::Value::as_str))
                                    .is_some_and(|key| sources.contains(&key)),
                                "world_parse_artifact" => !row
                                    .get("artifact_id")
                                    .and_then(serde_json::Value::as_str)
                                    .is_some_and(|id| parses.contains(id)),
                                _ => false,
                            }
                        {
                            continue;
                        }
                        size = size
                            .checked_add(serde_json::to_vec(&row).map_err(|_| invalid())?.len())
                            .ok_or_else(invalid)?;
                        if size > max_bytes {
                            return Err(invalid());
                        }
                        rows.push(row);
                    }
                    if count < 512 {
                        break;
                    }
                    offset += count as i64;
                }
                included.push(TableManifest {
                    table: name.clone(),
                    rows: rows.len() as u64,
                    digest: hash(&rows)?,
                });
                tables.push(TableExport {
                    table: name.clone(),
                    rows,
                });
            }
            let blobs = materials.blobs;
            let packages = super::package_catalog::read(tx, &world).await?;
            let manifest = ArchiveManifest {
                world,
                storage_id: self.identity_receipt().storage_id().to_owned(),
                schema_digest: Digest::try_new(schema::fingerprint()).map_err(|_| invalid())?,
                incarnation: Generation(head.get::<_, i64>("generation") as u64),
                revision: Revision(head.get::<_, i64>("revision") as u64),
                release_id: expected_release,
                channel: head.get("active_release_channel"),
                activation_lock: ActivationLockId::try_new(head.get::<_, String>("activation_lock_id"))
                    .map_err(|_| invalid())?,
                include_materials,
                included,
                retained: schema::tables()
                    .into_iter()
                    .filter(|name| !names.iter().any(|included| included == name))
                    .map(str::to_owned)
                    .collect(),
                blobs,
                packages,
            };
            let digest = hash(&manifest)?;
            read.transaction
                .rollback()
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Read))?;
            ArchiveSnapshot {
                manifest,
                tables,
                digest,
                observed: true,
            }
        };
        client.dirty = false;
        Ok(snapshot)
    }
}

impl WorldTransaction<'_> {
    pub(crate) async fn retain_archive(
        &self,
        snapshot: &ArchiveSnapshot,
        content: &Content,
        manifest_blob: &BlobRef,
    ) -> Result<(), StoreError> {
        validate(snapshot, self).await?;
        if !snapshot.observed || manifest_blob.byte_size > i64::MAX as u64 {
            return Err(invalid());
        }
        content
            .retain_archive(self, snapshot)
            .await
            .map_err(|cause| match cause {
                crate::content::Error::Store(error) => error,
                cause => StoreError::caused_by(
                    CommitFailure::ConstraintConflict {
                        constraint: ConstraintCode::ForeignReference,
                    },
                    FailureStage::Execute,
                    cause,
                ),
            })?;
        let world = self.world();
        for (package, _) in snapshot.package_catalog() {
            self.execute("INSERT INTO world_package_retention(tenant_id,world_id,package_digest,owner_kind,owner_id,owner_revision) VALUES($1,$2,$3,'backup',$4,1) ON CONFLICT DO NOTHING",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &snapshot.digest().as_str()]).await?;
        }
        let manifest = serde_json::to_value(&snapshot.manifest).map_err(|_| invalid())?;
        self.execute("INSERT INTO world_archive_manifest(tenant_id,world_id,archive_digest,backup_commit_id,manifest,manifest_blob_digest,manifest_blob_size) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &snapshot.digest().as_str(), &self.commit_id().as_str(), &manifest, &manifest_blob.digest.as_str(), &(manifest_blob.byte_size as i64)]).await?;
        let seal = self.query_opt("SELECT manifest,manifest_blob_digest,manifest_blob_size FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND archive_digest=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &snapshot.digest().as_str()]).await?.ok_or_else(invalid)?;
        if seal.get::<_, serde_json::Value>(0) != manifest
            || seal.get::<_, String>(1) != manifest_blob.digest.as_str()
            || seal.get::<_, i64>(2) != manifest_blob.byte_size as i64
        {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
        Ok(())
    }

    /// The caller holds Inventory's mutation guard before entering this exclusive transaction.
    pub(crate) async fn restore_archive(
        &mut self,
        snapshot: &ArchiveSnapshot,
        expected: Generation,
        content: &Content,
        blobs: &BlobArchiveValidation,
        inventory: &Inventory,
        packages: &PackageArchiveValidation,
        intent: &super::CommittedWorldMutation,
        live: &crate::extensions::lifecycle::LiveExtensions,
        drained: &crate::extensions::lifecycle::DrainedWorld,
        checked: &crate::extensions::bindings::CheckedRestore,
    ) -> Result<ReleaseId, StoreError> {
        self.require_exclusive_storage()?;
        self.require_world_mutation(intent, "restoring")?;
        if !live.validate_world_drained(drained)
            || drained.world() != self.world()
            || drained.commit_id() != intent.commit_id()
            || expected != intent.operation().incarnation
            || intent
                .restore()
                .is_none_or(|restore| restore.archive_digest() != snapshot.digest())
            || !checked.matches(self, snapshot.activation_lock())
        {
            return Err(invalid());
        }
        validate(snapshot, self).await?;
        validate_restore(snapshot, self).await?;
        let manifest = serde_json::to_value(&snapshot.manifest).map_err(|_| invalid())?;
        let seal = self.query_opt("SELECT manifest FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND archive_digest=$3",
            &[&self.world().tenant_id.as_str(), &self.world().world_id.as_str(), &snapshot.digest().as_str()]).await?;
        if !seal.is_some_and(|row| row.get::<_, serde_json::Value>(0) == manifest) {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
        if !blobs.matches(snapshot, content)
            || !blobs.matches_catalog(snapshot.blob_catalog())
            || !packages.matches(snapshot, inventory)
            || !packages.matches_catalog(snapshot.package_catalog())
        {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
        let world = self.world().clone();
        let head = self.query_opt("SELECT generation,revision,status,active_release_channel FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.ok_or_else(invalid)?;
        if head.get::<_, i64>("generation") as u64 != expected.0
            || head.get::<_, String>("status") != "restoring"
            || head.get::<_, i64>("generation") == i64::MAX
            || head.get::<_, i64>("revision") > i64::MAX - 2
        {
            return Err(conflict(ConstraintCode::HeadGeneration));
        }
        let _physical = content.lock_transfer_publication().map_err(|cause| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Execute, cause)
        })?;
        for blob in snapshot.blob_catalog() {
            if self.query_opt("SELECT 1 FROM world_blob b WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND byte_size=$4 AND state='live' AND NOT EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest)",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str(), &(blob.byte_size as i64)]).await?.is_none() { return Err(conflict(ConstraintCode::ForeignReference)); }
        }
        let current_packages = super::package_catalog::read(&self.transaction, &world).await?;
        if snapshot
            .package_catalog()
            .iter()
            .any(|pair| current_packages.binary_search(pair).is_err())
        {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
        self.execute("UPDATE world_runtime_head SET status='restoring',mutation_xid=pg_current_xact_id(),revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?;
        super::archive_history::retain(snapshot, self).await?;
        super::archive_history::delete_replaced(snapshot, self).await?;
        for table in &snapshot.tables {
            let sql = format!(
                "INSERT INTO public.{} SELECT (jsonb_populate_record(NULL::public.{},r)).* FROM jsonb_array_elements($1) r{}",
                table.table,
                table.table,
                if history_table(&table.table) {
                    " ON CONFLICT DO NOTHING"
                } else {
                    ""
                }
            );
            for rows in table.rows.chunks(512) {
                self.transaction
                    .execute(&sql, &[&serde_json::Value::Array(rows.to_vec())])
                    .await
                    .map_err(|error| StoreError::database(error, FailureStage::Execute))?;
            }
        }
        self.execute("UPDATE world_runtime_head SET status='ready',generation=generation+1,revision=revision+1,active_release_channel=$3,mutation_xid=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &snapshot.manifest.channel]).await?;
        Ok(snapshot.release_id().clone())
    }
}

/// The same preflight runs before durable draining and again before final replacement.
pub(super) async fn validate_restore(
    snapshot: &ArchiveSnapshot,
    tx: &WorldTransaction<'_>,
) -> Result<(), StoreError> {
    validate_retained_references(snapshot, tx).await?;
    let archive = snapshot.tables.iter().map(|table| (table.table.as_str(), table.rows.as_slice()))
        .collect::<Vec<_>>();
    let mut retained = Vec::new();
    for table in ["world_branch_derivation_revision", "world_branch_derivation_head"] {
        let rows = tx.transaction.query(
            &format!("SELECT to_jsonb(t) FROM public.{table} t JOIN pg_temp.world_delete_keep k ON k.table_name='{table}' AND k.row_id=t.ctid WHERE t.tenant_id=$1 AND t.world_id=$2"),
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
        ).await.map_err(|error| StoreError::database(error, FailureStage::Read))?;
        retained.push((table, rows.into_iter().map(|row| row.get(0)).collect::<Vec<serde_json::Value>>()));
    }
    let retained = retained.iter().map(|(table, rows)| (*table, rows.as_slice())).collect::<Vec<_>>();
    crate::facts::assertions::validate_branch_restore(tx.world(), &archive, &retained)
        .map_err(super::retention::reference_error)?;
    super::archive_history::release_marks(tx).await?;
    let required = crate::facts::assertions::validate_archive_restore(
        tx,
        snapshot.rows("world_evidence_revision"),
        snapshot.rows("world_evidence_head"),
        snapshot.rows("world_assertion_revision"),
        snapshot.rows("world_assertion_head"),
    )
    .await
    .map_err(super::retention::reference_error)?;
    crate::content::validate_archive_restore(
        tx,
        snapshot.rows("world_source_version"),
        snapshot.rows("world_parse_artifact"),
        &required,
    )
    .await
    .map_err(super::retention::reference_error)
}

/// Historical runs must not pull newer mutable branch/head rows into an exact restore.
async fn validate_retained_references(
    snapshot: &ArchiveSnapshot,
    tx: &WorldTransaction<'_>,
) -> Result<(), StoreError> {
    tx.require_exclusive_storage()?;
    let keep = super::archive_history::retain(snapshot, tx).await?;
    let included: Vec<_> = snapshot
        .tables
        .iter()
        .map(|table| table.table.as_str())
        .filter(|name| !material_table(name))
        .collect();
    let keys = tx.transaction.query(
        "SELECT s.relname AS source,t.relname AS target,string_agg(format('s.%I=a.%I',sa.attname,ta.attname),' AND ' ORDER BY k.ordinality) AS join_sql,string_agg(format('s.%I IS NOT NULL',sa.attname),' AND ' ORDER BY k.ordinality) AS present_sql FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS k(source_key,target_key,ordinality) JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=k.source_key JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=k.target_key WHERE c.contype='f' AND sn.nspname='public' AND tn.nspname='public' AND s.relname=ANY($1) AND t.relname=ANY($2) AND NOT (s.relname='world_runtime_head' AND t.relname='world_release_head') GROUP BY c.oid,s.relname,t.relname ORDER BY s.relname,t.relname,c.oid",
        &[&schema::tables(), &included],
    ).await.map_err(|error| StoreError::database(error, FailureStage::Read))?;
    for key in keys {
        let source: String = key.get("source");
        let target: String = key.get("target");
        let join: String = key.get("join_sql");
        let present: String = key.get("present_sql");
        let source_mark = if keep.names.contains(&source) {
            format!(" AND EXISTS(SELECT 1 FROM pg_temp.world_delete_keep k WHERE k.table_name='{source}' AND k.row_id=s.ctid)")
        } else {
            String::new()
        };
        let retained_target = if history_table(&target) {
            format!(" AND NOT EXISTS(SELECT 1 FROM public.{target} a JOIN pg_temp.world_delete_keep k ON k.table_name='{target}' AND k.row_id=a.ctid WHERE {join})")
        } else {
            String::new()
        };
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM public.{source} s WHERE s.tenant_id=$1 AND s.world_id=$2{source_mark} AND {present} AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.{target},$3) a WHERE {join}){retained_target})"
        );
        let missing: bool = tx.transaction.query_one(&sql,
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &serde_json::to_value(snapshot.rows(&target)).map_err(|_| invalid())?],
        ).await.map_err(|error| StoreError::database(error, FailureStage::Validate))?.get(0);
        if missing {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
    }
    Ok(())
}

pub(super) async fn validate(
    snapshot: &ArchiveSnapshot,
    tx: &WorldTransaction<'_>,
) -> Result<(), StoreError> {
    if snapshot.manifest.schema_digest.as_str() != schema::fingerprint() {
        return Err(StoreError::new(
            CommitFailure::Installation {
                reason: world_protocol::commit::InstallationFailure::SchemaMismatch,
            },
            FailureStage::Prepare,
        ));
    }
    if snapshot.world() != tx.world()
        || snapshot.storage_id() != tx.storage_id
        || hash(&snapshot.manifest)? != snapshot.digest
        || snapshot.manifest.incarnation.0 == 0
        || snapshot.tables.len() != snapshot.manifest.included.len()
    {
        return Err(invalid());
    }
    let names = catalog(&tx.transaction).await?;
    if names.len() != snapshot.tables.len() {
        return Err(invalid());
    }
    let retained: Vec<_> = schema::tables()
        .into_iter()
        .filter(|name| !names.iter().any(|included| included == name))
        .collect();
    if retained
        .iter()
        .copied()
        .ne(snapshot.manifest.retained.iter().map(String::as_str))
    {
        return Err(invalid());
    }
    let mut size = 0usize;
    for ((name, table), manifest) in names
        .iter()
        .zip(&snapshot.tables)
        .zip(&snapshot.manifest.included)
    {
        if name != &table.table
            || name != &manifest.table
            || table.rows.len() as u64 != manifest.rows
            || hash(&table.rows)? != manifest.digest
        {
            return Err(invalid());
        }
        for row in &table.rows {
            if row.get("tenant_id").and_then(serde_json::Value::as_str)
                != Some(tx.world().tenant_id.as_str())
                || row.get("world_id").and_then(serde_json::Value::as_str)
                    != Some(tx.world().world_id.as_str())
            {
                return Err(invalid());
            }
            size = size
                .checked_add(serde_json::to_vec(row).map_err(|_| invalid())?.len())
                .ok_or_else(invalid)?;
            if size > 268_435_456 {
                return Err(invalid());
            }
        }
    }
    if snapshot.blob_catalog().len() > 65_536
        || snapshot.package_catalog().len() > 4096
        || snapshot
            .blob_catalog()
            .windows(2)
            .any(|pair| pair[0].digest.as_str() >= pair[1].digest.as_str())
        || snapshot
            .package_catalog()
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid());
    }
    Ok(())
}
