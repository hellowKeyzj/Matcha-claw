use super::{StoreError, WorldSnapshot, WorldStore, schema};
use crate::content::{BlobTransferValidation, Content};
use crate::extensions::package::{Inventory, PackageTransferValidation};
use serde::{Deserialize, Serialize};
use world_protocol::materials::BlobRef;
use world_protocol::{
    commit::{CommitFailure, InstallationFailure},
    failure::FailureStage,
    ids::{Digest, TransferId, WorldRef, WriterEpoch},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferCut {
    pub world: WorldRef,
    pub transfer_id: TransferId,
    pub source_storage_id: String,
    pub target_storage_id: String,
    pub source_epoch: WriterEpoch,
    pub target_epoch: WriterEpoch,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportManifest {
    pub cut: TransferCut,
    pub schema_digest: Digest,
    pub tables: Vec<TableManifest>,
    pub digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TableManifest {
    pub table: String,
    pub rows: u64,
    pub digest: Digest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TableExport {
    pub table: String,
    pub rows: Vec<serde_json::Value>,
}
/// Transfer envelope only. Each row is decoded into its concrete PostgreSQL table type.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoreExport {
    pub manifest: ExportManifest,
    pub tables: Vec<TableExport>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferValidation {
    pub cut: TransferCut,
    pub manifest_digest: Digest,
    pub validated_rows: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransferPhase {
    Draining,
    Cut,
    Exported,
    Importing,
    Validated,
    Activated,
    Retired,
    Aborted,
}

pub(crate) struct TransferState {
    pub cut: TransferCut,
    pub phase: TransferPhase,
    pub manifest_digest: Option<Digest>,
    pub manifest: Option<ExportManifest>,
    pub receipt: Option<serde_json::Value>,
    pub storage_id: String,
    pub writer_epoch: WriterEpoch,
    pub mode: String,
}

/// Only the target's authoritative activated state produces this non-deserializable evidence.
#[derive(Clone)]
pub(crate) struct TargetActivationReceipt {
    pub(super) cut: TransferCut,
    pub(super) manifest_digest: Digest,
}
impl TargetActivationReceipt {
    pub(crate) fn cut(&self) -> &TransferCut {
        &self.cut
    }

    pub(crate) fn manifest_digest(&self) -> &Digest {
        &self.manifest_digest
    }

    pub(crate) async fn recheck_read(
        &self,
        snapshot: &WorldSnapshot<'_>,
    ) -> Result<(), StoreError> {
        let state = read_transfer_snapshot(snapshot, &self.cut)
            .await?
            .ok_or_else(invalid)?;
        if state.phase != TransferPhase::Activated
            || state.mode != "active"
            || state.storage_id != self.cut.target_storage_id
            || state.writer_epoch != self.cut.target_epoch
            || state.manifest_digest.as_ref() != Some(&self.manifest_digest)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// Durable source export evidence; only a committed seal or its authoritative reread creates it.
pub(crate) struct SourceExportReceipt {
    pub(super) cut: TransferCut,
    pub(super) manifest_digest: Digest,
}

fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Migrate)
}
fn digest(value: &impl Serialize) -> Result<Digest, StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Migrate, error)
    })?;
    Digest::try_new(schema::checksum(&bytes)).map_err(|_| invalid())
}
fn data_tables() -> Vec<&'static str> {
    schema::tables()
        .into_iter()
        .filter(|name| !matches!(*name, "world_storage_head" | "world_storage_transfer"))
        .collect()
}
pub(super) async fn read_transfer_snapshot(
    snapshot: &WorldSnapshot<'_>,
    cut: &TransferCut,
) -> Result<Option<TransferState>, StoreError> {
    if snapshot.world() != &cut.world {
        return Err(invalid());
    }
    let Some(row) = snapshot.query_opt("SELECT t.source_storage_id,t.target_storage_id,t.source_epoch,t.target_epoch,t.phase,t.manifest_digest,t.manifest,t.receipt,h.storage_id,h.writer_epoch,h.mode,h.transfer_id AS head_transfer_id FROM world_storage_transfer t LEFT JOIN world_storage_head h USING(tenant_id,world_id) WHERE t.tenant_id=$1 AND t.world_id=$2 AND t.transfer_id=$3", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await? else { return Ok(None); };
    require_same_cut(&row, cut)?;
    if row.get::<_, Option<String>>("head_transfer_id").as_deref() != Some(cut.transfer_id.as_str())
    {
        return Err(invalid());
    }
    let phase = match row.get::<_, String>("phase").as_str() {
        "draining" => TransferPhase::Draining,
        "cut" => TransferPhase::Cut,
        "exported" => TransferPhase::Exported,
        "importing" => TransferPhase::Importing,
        "validated" => TransferPhase::Validated,
        "activated" => TransferPhase::Activated,
        "retired" => TransferPhase::Retired,
        "aborted" => TransferPhase::Aborted,
        _ => return Err(invalid()),
    };
    let manifest_digest = row
        .get::<_, Option<String>>("manifest_digest")
        .map(Digest::try_new)
        .transpose()
        .map_err(|_| invalid())?;
    let manifest: Option<ExportManifest> = row
        .get::<_, Option<serde_json::Value>>("manifest")
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid())?;
    if let Some(manifest) = &manifest {
        validate_manifest(manifest)?;
        if manifest.cut != *cut || manifest_digest.as_ref() != Some(&manifest.digest) {
            return Err(invalid());
        }
    }
    Ok(Some(TransferState {
        cut: cut.clone(),
        phase,
        manifest_digest,
        manifest,
        receipt: row.get("receipt"),
        storage_id: row.get("storage_id"),
        writer_epoch: WriterEpoch(
            u64::try_from(row.get::<_, i64>("writer_epoch")).map_err(|_| invalid())?,
        ),
        mode: row.get("mode"),
    }))
}

pub(super) fn validate_cut(cut: &TransferCut) -> Result<(), StoreError> {
    if cut.source_storage_id.is_empty()
        || cut.target_storage_id.is_empty()
        || cut.source_storage_id == cut.target_storage_id
        || cut.source_epoch.0 == 0
        || cut.target_epoch.0 <= cut.source_epoch.0
        || cut.target_epoch.0 > i64::MAX as u64
    {
        return Err(invalid());
    }
    Ok(())
}
impl WorldStore {
    /// Always reads the writable primary. Absence is not evidence that a lost transfer rolled back.
    pub(crate) async fn read_transfer(
        &self,
        cut: &TransferCut,
    ) -> Result<TransferState, StoreError> {
        self.read_transfer_optional(cut).await?.ok_or_else(|| {
            StoreError::new(
                CommitFailure::TransferIndeterminate {
                    transfer_id: cut.transfer_id.clone(),
                },
                FailureStage::Recover,
            )
        })
    }

    /// Primary snapshot absence only; it does not prove that a concurrent lost COMMIT rolled back.
    pub(crate) async fn read_transfer_optional(
        &self,
        cut: &TransferCut,
    ) -> Result<Option<TransferState>, StoreError> {
        validate_cut(cut)?;
        if self.inner.identity.storage_id() != cut.source_storage_id
            && self.inner.identity.storage_id() != cut.target_storage_id
        {
            return Err(invalid());
        }
        let cut = cut.clone();
        self.snapshot(cut.world.clone(), move |snapshot| {
            Box::pin(async move { read_transfer_snapshot(snapshot, &cut).await })
        })
        .await
    }

    pub(crate) async fn read_export_receipt(
        &self,
        manifest: &ExportManifest,
    ) -> Result<SourceExportReceipt, StoreError> {
        validate_manifest(manifest)?;
        let state = self.read_transfer(&manifest.cut).await?;
        if !matches!(
            state.phase,
            TransferPhase::Exported | TransferPhase::Retired
        ) || state.storage_id != manifest.cut.source_storage_id
            || state.writer_epoch != manifest.cut.source_epoch
            || !matches!(state.mode.as_str(), "fenced" | "retired")
            || state.manifest.as_ref() != Some(manifest)
            || state.receipt.as_ref()
                != Some(&serde_json::to_value(manifest).map_err(|_| invalid())?)
        {
            return Err(invalid());
        }
        Ok(SourceExportReceipt {
            cut: manifest.cut.clone(),
            manifest_digest: manifest.digest.clone(),
        })
    }

    pub(crate) async fn read_activation_receipt(
        &self,
        validation: &TransferValidation,
    ) -> Result<TargetActivationReceipt, StoreError> {
        self.require_storage(&validation.cut.target_storage_id)?;
        let proof = TargetActivationReceipt {
            cut: validation.cut.clone(),
            manifest_digest: validation.manifest_digest.clone(),
        };
        self.snapshot(proof.cut.world.clone(), move |snapshot| {
            Box::pin(async move {
                proof.recheck_read(snapshot).await?;
                Ok(proof)
            })
        })
        .await
    }

    /// Stops writers before copying. The FOR UPDATE waits for every admitted FOR SHARE writer.
    /// This is a per-world storage cut, not the ordinary business conflict mechanism.
    pub(crate) async fn cut_transfer(
        &self,
        drained: &crate::extensions::lifecycle::DrainedTransfer,
        source: &Content,
    ) -> Result<TransferCut, StoreError> {
        let cut = drained.cut().clone();
        if !drained.validate() {
            return Err(invalid());
        }
        validate_cut(&cut)?;
        self.require_storage(&cut.source_storage_id)?;
        if source.world() != &cut.world {
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
        let head = tx.query_opt("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error,FailureStage::Migrate))?.ok_or_else(invalid)?;
        // Ordinary content registration already owns storage FOR SHARE before publication.
        // Drain those writers before taking the physical gate; the reverse order would deadlock.
        let _publication = source.lock_transfer_publication().map_err(|error| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Migrate, error)
        })?;
        let replay = head.get::<_, String>("mode") == "fenced"
            && head.get::<_, Option<String>>("transfer_id").as_deref()
                == Some(cut.transfer_id.as_str());
        if !drained.validate()
            || head.get::<_, String>("storage_id") != cut.source_storage_id
            || head.get::<_, i64>("writer_epoch") != cut.source_epoch.0 as i64
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
            || (!replay && head.get::<_, String>("mode") != "active")
        {
            return Err(invalid());
        }
        let transfer = tx.query_opt("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch,phase FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 FOR UPDATE", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?.ok_or_else(invalid)?;
        require_same_cut(&transfer, &cut)?;
        let phase: String = transfer.get("phase");
        if (!replay && phase != "draining")
            || (replay && !matches!(phase.as_str(), "cut" | "exported"))
        {
            return Err(invalid());
        }
        tx.execute("UPDATE world_storage_transfer SET phase='cut',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND phase='draining'", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        let blocked: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND state='deleting') OR EXISTS(SELECT 1 FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND state<>'deleted') AS blocked", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?.get("blocked");
        if blocked {
            return Err(invalid());
        }
        tx.execute("INSERT INTO world_blob_pin(tenant_id,world_id,digest,pin_id,kind,owner_id,generation) SELECT tenant_id,world_id,digest,$3,'transfer',$3,generation FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND state<>'deleted' ON CONFLICT DO NOTHING", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        tx.execute("UPDATE world_storage_head SET mode='fenced',transfer_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str(),&cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error,FailureStage::Migrate))?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        Ok(cut)
    }

    /// Finite transfer envelope. Exceeding the caller's bound fails; it never exports a partial world.
    pub(crate) async fn export_cut(
        &self,
        cut: TransferCut,
        max_bytes: usize,
    ) -> Result<StoreExport, StoreError> {
        validate_cut(&cut)?;
        self.require_storage(&cut.source_storage_id)?;
        if max_bytes == 0 || max_bytes > 268_435_456 {
            return Err(invalid());
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &cut.world).await?;
        let head=tx.query_opt("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error,FailureStage::Migrate))?.ok_or_else(invalid)?;
        if head.get::<_, String>("mode") != "fenced"
            || head.get::<_, String>("storage_id") != cut.source_storage_id
            || head.get::<_, i64>("writer_epoch") != cut.source_epoch.0 as i64
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
        {
            return Err(invalid());
        }
        let mut tables = Vec::new();
        let mut manifests = Vec::new();
        let mut size = 0usize;
        for table in data_tables() {
            let sql = format!(
                "SELECT to_jsonb(t) AS row FROM public.{table} t WHERE tenant_id=$1 AND world_id=$2 ORDER BY to_jsonb(t)::text LIMIT 512 OFFSET $3"
            );
            let mut rows = Vec::new();
            let mut offset = 0i64;
            loop {
                let page = tx
                    .query(
                        &sql,
                        &[
                            &cut.world.tenant_id.as_str(),
                            &cut.world.world_id.as_str(),
                            &offset,
                        ],
                    )
                    .await
                    .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
                let count = page.len();
                for row in page {
                    let value: serde_json::Value = row.get("row");
                    size = size
                        .checked_add(serde_json::to_vec(&value).map_err(|_| invalid())?.len())
                        .ok_or_else(invalid)?;
                    if size > max_bytes {
                        return Err(invalid());
                    }
                    rows.push(value);
                }
                if count < 512 {
                    break;
                }
                offset += count as i64;
            }
            manifests.push(TableManifest {
                table: table.to_owned(),
                rows: rows.len() as u64,
                digest: digest(&rows)?,
            });
            tables.push(TableExport {
                table: table.to_owned(),
                rows,
            });
        }
        let rows = |name: &str| {
            tables
                .iter()
                .find(|table| table.table == name)
                .map_or(&[][..], |table| table.rows.as_slice())
        };
        crate::extensions::package::catalog_from_rows(
            rows("world_package"),
            rows("world_package_install"),
            rows("world_package_gc"),
            &cut.world,
        )
        .map_err(super::retention::reference_error)?;
        tx.rollback()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        client.dirty = false;
        let schema_digest = Digest::try_new(schema::fingerprint()).map_err(|_| invalid())?;
        let manifest_digest = digest(&(&cut, &schema_digest, &manifests))?;
        Ok(StoreExport {
            manifest: ExportManifest {
                cut,
                schema_digest,
                tables: manifests,
                digest: manifest_digest,
            },
            tables,
        })
    }

    /// Source receipt is durable before target activation; re-read this exact transfer after loss.
    pub(crate) async fn seal_export(&self, manifest: &ExportManifest) -> Result<(), StoreError> {
        validate_manifest(manifest)?;
        self.require_storage(&manifest.cut.source_storage_id)?;
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &manifest.cut.world).await?;
        let cut = &manifest.cut;
        let changed=tx.execute("UPDATE world_storage_transfer t SET phase='exported',manifest_digest=$4,manifest=$5,receipt=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND phase IN ('cut','exported') AND (manifest_digest IS NULL OR manifest_digest=$4) AND EXISTS(SELECT 1 FROM world_storage_head h WHERE h.tenant_id=t.tenant_id AND h.world_id=t.world_id AND h.mode='fenced' AND h.transfer_id=t.transfer_id)",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str(),&cut.transfer_id.as_str(),&manifest.digest.as_str(),&serde_json::to_value(manifest).map_err(|_|invalid())?]).await.map_err(|error|StoreError::database(error,FailureStage::Migrate))?;
        if changed != 1 {
            return Err(invalid());
        }
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        Ok(())
    }

    /// Target stays prepared. All rows pass concrete types, CHECKs, unique constraints and exact FKs.
    pub(crate) async fn import_prepared(
        &self,
        export: &StoreExport,
    ) -> Result<TransferValidation, StoreError> {
        validate_manifest(&export.manifest)?;
        self.require_storage(&export.manifest.cut.target_storage_id)?;
        let cut = &export.manifest.cut;
        let names = data_tables();
        if export.tables.len() != names.len() {
            return Err(invalid());
        }
        for ((table, manifest), name) in export
            .tables
            .iter()
            .zip(&export.manifest.tables)
            .zip(&names)
        {
            if table.table != *name
                || manifest.table != *name
                || table.rows.len() as u64 != manifest.rows
                || digest(&table.rows)? != manifest.digest
            {
                return Err(invalid());
            }
            if table.rows.iter().any(|row| {
                row.get("tenant_id").and_then(|v| v.as_str()) != Some(cut.world.tenant_id.as_str())
                    || row.get("world_id").and_then(|v| v.as_str())
                        != Some(cut.world.world_id.as_str())
            }) {
                return Err(invalid());
            }
        }
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let tx = client
            .transaction()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        self.configure(&tx, &cut.world).await?;
        tx.execute("INSERT INTO world_storage_head(tenant_id,world_id,storage_id,writer_epoch,mode,transfer_id) VALUES($1,$2,$3,$4,'prepared',$5) ON CONFLICT DO NOTHING",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str(),&cut.target_storage_id,&(cut.target_epoch.0 as i64),&cut.transfer_id.as_str()]).await.map_err(|error|StoreError::database(error,FailureStage::Migrate))?;
        let head=tx.query_one("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str()]).await.map_err(|error|StoreError::database(error,FailureStage::Migrate))?;
        if head.get::<_, String>("mode") != "prepared"
            || head.get::<_, String>("storage_id") != cut.target_storage_id
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
        {
            return Err(invalid());
        }
        if head.get::<_, i64>("writer_epoch") != cut.target_epoch.0 as i64 {
            return Err(invalid());
        }
        if let Some(record) = tx.query_opt("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch,phase,manifest_digest,receipt FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Recover))? {
            require_same_cut(&record, cut)?;
            if record.get::<_, String>("phase") == "validated" && record.get::<_, Option<String>>("manifest_digest").as_deref() == Some(export.manifest.digest.as_str()) {
                let receipt = record.get::<_, Option<serde_json::Value>>("receipt").ok_or_else(invalid)?;
                let validation = serde_json::from_value(receipt).map_err(|_| invalid())?;
                tx.rollback().await.map_err(|error| StoreError::database(error, FailureStage::Recover))?;
                client.dirty = false;
                return Ok(validation);
            }
            return Err(invalid());
        }
        tx.execute("INSERT INTO world_storage_transfer(tenant_id,world_id,transfer_id,source_storage_id,target_storage_id,source_epoch,target_epoch,phase,manifest_digest,manifest,import_xid) VALUES($1,$2,$3,$4,$5,$6,$7,'importing',$8,$9,pg_current_xact_id())", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str(), &cut.source_storage_id, &cut.target_storage_id, &(cut.source_epoch.0 as i64), &(cut.target_epoch.0 as i64), &export.manifest.digest.as_str(), &serde_json::to_value(&export.manifest).map_err(|_| invalid())?]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        let mut total = 0u64;
        for table in &export.tables {
            let occupied: bool = tx
                .query_one(
                    &format!(
                        "SELECT EXISTS(SELECT 1 FROM public.{} WHERE tenant_id=$1 AND world_id=$2)",
                        table.table
                    ),
                    &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()],
                )
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Migrate))?
                .get(0);
            if occupied {
                return Err(invalid());
            }
            let sql = format!(
                "INSERT INTO public.{} OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::public.{},r)).* FROM jsonb_array_elements($1) r",
                table.table, table.table
            );
            for chunk in table.rows.chunks(256) {
                tx.execute(
                    &sql,
                    &[&serde_json::to_value(chunk).map_err(|_| invalid())?],
                )
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
            }
            total += table.rows.len() as u64;
        }
        let validation = TransferValidation {
            cut: cut.clone(),
            manifest_digest: export.manifest.digest.clone(),
            validated_rows: total,
        };
        tx.execute("UPDATE world_storage_transfer SET phase='validated',receipt=$4,import_xid=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND import_xid=pg_current_xact_id()", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str(), &serde_json::to_value(&validation).map_err(|_| invalid())?]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        tx.batch_execute("SET CONSTRAINTS ALL IMMEDIATE")
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Validate))?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        Ok(validation)
    }

    /// Call only after Host durably CASes its private locator to this exact validated target.
    pub(crate) async fn activate_transfer(
        &self,
        validation: &TransferValidation,
        target: &Content,
        blobs: &BlobTransferValidation,
        locator: &super::LocatorCutoverReceipt,
        inventory: &Inventory,
        packages: &PackageTransferValidation,
    ) -> Result<TargetActivationReceipt, StoreError> {
        let cut = &validation.cut;
        validate_cut(cut)?;
        self.require_storage(&cut.target_storage_id)?;
        if !locator.matches(cut, &validation.manifest_digest)
            || !blobs.matches(cut, target)
            || !packages.matches(cut, inventory)
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
        let head = tx
            .query_opt(
                "SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
                &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()],
            )
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Activate))?
            .ok_or_else(invalid)?;
        if head.get::<_, String>("storage_id") != cut.target_storage_id
            || head.get::<_, i64>("writer_epoch") != cut.target_epoch.0 as i64
            || head.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
        {
            return Err(invalid());
        }
        if head.get::<_, String>("mode") == "active" {
            tx.rollback()
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Activate))?;
            client.dirty = false;
            drop(client);
            return self.read_activation_receipt(validation).await;
        }
        if head.get::<_, String>("mode") != "prepared" {
            return Err(invalid());
        }
        let _publication = target.lock_transfer_publication().map_err(|error| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Activate, error)
        })?;
        let rows = tx.query("SELECT digest,byte_size FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND state<>'deleted' ORDER BY digest", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Activate))?;
        let catalog = rows
            .into_iter()
            .map(|row| {
                Ok(BlobRef {
                    digest: Digest::try_new(row.get::<_, String>("digest"))
                        .map_err(|_| invalid())?,
                    byte_size: u64::try_from(row.get::<_, i64>("byte_size"))
                        .map_err(|_| invalid())?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        if !blobs.matches_catalog(&catalog) {
            return Err(invalid());
        }
        let catalog = super::package_catalog::read(&tx, &cut.world).await?;
        if !packages.matches_catalog(&catalog) {
            return Err(invalid());
        }
        let changed=tx.execute("UPDATE world_storage_head h SET mode='active',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND storage_id=$3 AND writer_epoch=$4 AND transfer_id=$5 AND mode IN ('prepared','active') AND EXISTS(SELECT 1 FROM world_storage_transfer t WHERE t.tenant_id=h.tenant_id AND t.world_id=h.world_id AND t.transfer_id=h.transfer_id AND t.phase IN ('validated','activated') AND t.manifest_digest=$6)",
            &[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str(),&cut.target_storage_id,&(cut.target_epoch.0 as i64),&cut.transfer_id.as_str(),&validation.manifest_digest.as_str()]).await.map_err(|error|StoreError::database(error,FailureStage::Migrate))?;
        if changed != 1 {
            return Err(invalid());
        }
        tx.execute("UPDATE world_storage_transfer SET phase='activated',updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",&[&cut.world.tenant_id.as_str(),&cut.world.world_id.as_str(),&cut.transfer_id.as_str()]).await.map_err(|error|StoreError::database(error,FailureStage::Migrate))?;
        tx.execute("UPDATE world_blob_pin SET released_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND kind='transfer' AND owner_id=$3 AND released_at IS NULL", &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Activate))?;
        commit_transfer(tx, &cut.transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        drop(client);
        drop(_publication);
        self.read_activation_receipt(validation).await
    }
}
pub(super) async fn commit_transfer(
    tx: tokio_postgres::Transaction<'_>,
    id: &TransferId,
    timeout: std::time::Duration,
) -> Result<(), StoreError> {
    match tokio::time::timeout(timeout, tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if StoreError::proves_commit_aborted(&error) => {
            Err(StoreError::database(error, FailureStage::Migrate))
        }
        Ok(Err(error)) => Err(StoreError::caused_by(
            CommitFailure::TransferIndeterminate {
                transfer_id: id.clone(),
            },
            FailureStage::Migrate,
            error,
        )),
        Err(error) => Err(StoreError::caused_by(
            CommitFailure::TransferIndeterminate {
                transfer_id: id.clone(),
            },
            FailureStage::Migrate,
            error,
        )),
    }
}

pub(super) fn require_same_cut(
    row: &tokio_postgres::Row,
    cut: &TransferCut,
) -> Result<(), StoreError> {
    if row.get::<_, String>("source_storage_id") != cut.source_storage_id
        || row.get::<_, String>("target_storage_id") != cut.target_storage_id
        || row.get::<_, i64>("source_epoch") != cut.source_epoch.0 as i64
        || row.get::<_, i64>("target_epoch") != cut.target_epoch.0 as i64
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_manifest(manifest: &ExportManifest) -> Result<(), StoreError> {
    validate_cut(&manifest.cut)?;
    if manifest.schema_digest.as_str() != schema::fingerprint() {
        return Err(schema::installation(InstallationFailure::SchemaMismatch));
    }
    if manifest
        .tables
        .iter()
        .map(|table| table.table.as_str())
        .collect::<Vec<_>>()
        != data_tables()
        || digest(&(&manifest.cut, &manifest.schema_digest, &manifest.tables))? != manifest.digest
    {
        return Err(invalid());
    }
    Ok(())
}
