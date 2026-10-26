use world_protocol::{
    commit::{CommitFailure, WriteFence},
    failure::FailureStage,
    ids::{RunId, TransferId, WorldRef, WriterDomain, WriterEpoch},
};

use super::{
    CommitRequest, Committed, StoreError, TransactionError, TransferCut, TransferPhase, WorldStore,
    transfer::{commit_transfer, validate_cut},
};
use crate::{authorization::AuthorityRoot, owner::TransferWorkCheckpoint};

/// Primary-backed original transfer identity; closing this transfer does not prove it drained.
#[derive(Clone)]
pub(crate) struct TransferDraining {
    cut: TransferCut,
}
impl TransferDraining {
    pub(crate) fn cut(&self) -> &TransferCut {
        &self.cut
    }
}

pub(super) struct TransferCheckpoint {
    world: WorldRef,
    storage_id: String,
}
impl TransferCheckpoint {
    pub(super) fn matches(&self, world: &WorldRef, storage_id: &str) -> bool {
        &self.world == world && self.storage_id == storage_id
    }
}

pub(super) fn allows(statement: &str) -> bool {
    matches!(
        statement,
        "INSERT INTO world_commit_receipt(tenant_id,world_id,commit_id,input_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING"
            | "UPDATE world_commit_receipt SET receipt=$4,result=$5,committed_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3"
            | "UPDATE world_operation SET revision=$4,phase=$5,body=$6,failure=$7,updated_at=$8::text::timestamptz,terminal_at=CASE WHEN $9 THEN $8::text::timestamptz ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 AND revision=$10"
            | "UPDATE world_run SET revision=$4,usage=$5,body=$6 WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$7"
            | "UPDATE world_run SET revision=$4,phase=$5,body=$6,terminal_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND revision=$8"
            | "INSERT INTO world_outbox(tenant_id,world_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,causation_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"
    )
}
fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Admission)
}

impl WorldStore {
    /// A locator for the original DTO, not evidence of rollback or lifecycle drain.
    pub(crate) async fn read_transfer_by_id(
        &self,
        world: &WorldRef,
        transfer_id: &TransferId,
    ) -> Result<Option<TransferCut>, StoreError> {
        let world = world.clone();
        let transfer_id = transfer_id.clone();
        self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let Some(row) = snapshot.query_opt("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &transfer_id.as_str()]).await? else { return Ok(None); };
            let cut = TransferCut { world, transfer_id, source_storage_id: row.get("source_storage_id"), target_storage_id: row.get("target_storage_id"),
                source_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("source_epoch")).map_err(|_| invalid())?),
                target_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("target_epoch")).map_err(|_| invalid())?) };
            validate_cut(&cut)?;
            Ok(Some(cut))
        })).await
    }

    /// Current durable identity only; callers still need the original transfer's lifecycle proof.
    pub(crate) async fn read_current_transfer(
        &self,
        world: &WorldRef,
    ) -> Result<Option<TransferCut>, StoreError> {
        let world = world.clone();
        let storage_id = self.identity_receipt().storage_id().to_owned();
        self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let Some(head) = snapshot.query_opt("SELECT storage_id,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2",
                &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await? else { return Ok(None); };
            if head.get::<_, String>("storage_id") != storage_id { return Err(invalid()); }
            let Some(transfer_id) = head.get::<_, Option<String>>("transfer_id") else { return Ok(None); };
            let transfer_id = TransferId::try_new(transfer_id).map_err(|_| invalid())?;
            let row = snapshot.query_opt("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &transfer_id.as_str()]).await?.ok_or_else(invalid)?;
            let cut = TransferCut { world, transfer_id, source_storage_id: row.get("source_storage_id"), target_storage_id: row.get("target_storage_id"),
                source_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("source_epoch")).map_err(|_| invalid())?),
                target_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("target_epoch")).map_err(|_| invalid())?) };
            validate_cut(&cut)?;
            if storage_id != cut.source_storage_id && storage_id != cut.target_storage_id { return Err(invalid()); }
            Ok(Some(cut))
        })).await
    }

    /// Reserves the original cut before lifecycle drain, without pretending SQL writers are cut.
    pub(crate) async fn prepare_transfer(
        &self,
        _root: &AuthorityRoot,
        world: &WorldRef,
        target_storage_id: &str,
        transfer_id: &TransferId,
    ) -> Result<TransferCut, StoreError> {
        if target_storage_id.is_empty()
            || target_storage_id.len() > 256
            || target_storage_id.chars().any(char::is_control)
            || target_storage_id == self.identity_receipt().storage_id()
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
        self.configure(&tx, world).await?;
        let head = tx.query_opt("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?.ok_or_else(invalid)?;
        let storage_id: String = head.get("storage_id");
        self.require_storage(&storage_id)?;
        if let Some(row) = tx.query_opt("SELECT source_storage_id,target_storage_id,source_epoch,target_epoch FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Recover))? {
            let cut = TransferCut {
                world: world.clone(), transfer_id: transfer_id.clone(),
                source_storage_id: row.get("source_storage_id"), target_storage_id: row.get("target_storage_id"),
                source_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("source_epoch")).map_err(|_| invalid())?),
                target_epoch: WriterEpoch(u64::try_from(row.get::<_, i64>("target_epoch")).map_err(|_| invalid())?),
            };
            validate_cut(&cut)?;
            if cut.source_storage_id != storage_id || cut.target_storage_id != target_storage_id {
                return Err(invalid());
            }
            tx.rollback().await.map_err(|error| StoreError::database(error, FailureStage::Recover))?;
            client.dirty = false;
            return Ok(cut);
        }
        if head.get::<_, String>("mode") != "active" {
            return Err(invalid());
        }
        if let Some(previous) = head.get::<_, Option<String>>("transfer_id") {
            let row = tx.query_opt("SELECT phase FROM world_storage_transfer WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &previous]).await.map_err(|error| StoreError::database(error, FailureStage::Read))?.ok_or_else(invalid)?;
            if !matches!(
                row.get::<_, String>("phase").as_str(),
                "activated" | "aborted"
            ) {
                return Err(invalid());
            }
        }
        let ready = tx.query_opt("SELECT status FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Read))?.ok_or_else(invalid)?;
        if ready.get::<_, String>("status") != "ready" {
            return Err(invalid());
        }
        let source_epoch =
            u64::try_from(head.get::<_, i64>("writer_epoch")).map_err(|_| invalid())?;
        let target_epoch = source_epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= i64::MAX as u64)
            .ok_or_else(invalid)?;
        let cut = TransferCut {
            world: world.clone(),
            transfer_id: transfer_id.clone(),
            source_storage_id: storage_id,
            target_storage_id: target_storage_id.to_owned(),
            source_epoch: WriterEpoch(source_epoch),
            target_epoch: WriterEpoch(target_epoch),
        };
        validate_cut(&cut)?;
        tx.execute("INSERT INTO world_storage_transfer(tenant_id,world_id,transfer_id,source_storage_id,target_storage_id,source_epoch,target_epoch,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'draining')",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &transfer_id.as_str(), &cut.source_storage_id, &cut.target_storage_id, &(source_epoch as i64), &(target_epoch as i64)]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        tx.execute("UPDATE world_storage_head SET transfer_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &transfer_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Migrate))?;
        commit_transfer(tx, transfer_id, self.inner.limits.statement_timeout).await?;
        client.dirty = false;
        Ok(cut)
    }

    pub(crate) async fn begin_transfer_draining(
        &self,
        cut: &TransferCut,
    ) -> Result<TransferDraining, StoreError> {
        self.require_storage(&cut.source_storage_id)?;
        let state = self.read_transfer(cut).await?;
        let valid = match state.phase {
            TransferPhase::Draining => {
                state.mode == "active" && state.writer_epoch == cut.source_epoch
            }
            TransferPhase::Cut | TransferPhase::Exported => {
                state.mode == "fenced" && state.writer_epoch == cut.source_epoch
            }
            TransferPhase::Retired => {
                state.mode == "retired" && state.writer_epoch == cut.source_epoch
            }
            TransferPhase::Aborted => {
                state.mode == "active"
                    && cut.target_epoch.0.checked_add(1) == Some(state.writer_epoch.0)
            }
            _ => false,
        };
        if !valid || state.storage_id != cut.source_storage_id {
            return Err(invalid());
        }
        Ok(TransferDraining { cut: cut.clone() })
    }

    pub(crate) async fn checkpoint_transfer_work(
        &self,
        root: &AuthorityRoot,
        checkpoint: &TransferWorkCheckpoint,
    ) -> Result<Committed<Vec<RunId>>, TransactionError<crate::owner::Error>> {
        let uncertain = |error| {
            TransactionError::Indeterminate(StoreError::caused_by(
                CommitFailure::CommitIndeterminate {
                    commit_id: checkpoint.commit_id().clone(),
                },
                FailureStage::Recover,
                error,
            ))
        };
        let world = checkpoint.world().clone();
        let read_world = world.clone();
        let (storage_epoch, epoch) = self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt("SELECT h.writer_epoch AS storage_epoch,g.writer_epoch AS operation_epoch FROM world_storage_head h JOIN world_writer_gate g USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND g.domain='operation'",
                &[&read_world.tenant_id.as_str(), &read_world.world_id.as_str()]).await?.ok_or_else(invalid)?;
            Ok::<_, StoreError>((WriterEpoch(row.get::<_, i64>("storage_epoch") as u64), WriterEpoch(row.get::<_, i64>("operation_epoch") as u64)))
        })).await.map_err(&uncertain)?;
        let mut batch = CommitRequest {
            world: world.clone(),
            commit_id: checkpoint.commit_id().clone(),
            input_digest: checkpoint.input_digest().clone(),
            storage_epoch,
            fences: vec![WriteFence {
                world: world.clone(),
                domain: WriterDomain::try_new("operation").map_err(|_| uncertain(invalid()))?,
                epoch,
            }],
            watch_basis: Vec::new(),
        }
        .prepare()
        .map_err(&uncertain)?;
        batch.transfer_checkpoint = Some(TransferCheckpoint {
            world,
            storage_id: self.identity_receipt().storage_id().to_owned(),
        });
        let proof = checkpoint.clone();
        let same_root = checkpoint.same_root(root);
        self.transact(batch, move |tx| Box::pin(async move {
            if !same_root || proof.storage_id() != tx.storage_id || !proof.validate() { return Err(invalid().into()); }
            let cut = proof.cut();
            let row = tx.query_opt("SELECT t.source_storage_id,t.target_storage_id,t.source_epoch,t.target_epoch FROM world_storage_transfer t JOIN world_storage_head h USING(tenant_id,world_id) WHERE t.tenant_id=$1 AND t.world_id=$2 AND t.transfer_id=$3 AND h.transfer_id=t.transfer_id AND t.phase='draining' AND h.mode='active' AND h.storage_id=t.source_storage_id AND h.writer_epoch=t.source_epoch FOR SHARE OF t",
                &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str(), &cut.transfer_id.as_str()]).await?.ok_or_else(invalid)?;
            super::transfer::require_same_cut(&row, cut)?;
            let affected = crate::owner::checkpoint_transfer_work(tx, &proof).await?;
            if !proof.validate() { return Err(invalid().into()); }
            Ok(affected)
        })).await
    }
}
