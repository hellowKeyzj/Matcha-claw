use world_protocol::{
    commit::{CommitFailure, WriteFence},
    failure::FailureStage,
    ids::{Digest, RunId, WorldRef, WriterDomain, WriterEpoch},
    operation::OperationReceipt,
};

use super::{
    CommitRequest, Committed, StoreError, TransactionError, WorldStore, WorldTransaction,
    retention::reference_error, transaction::decode_committed,
};
use crate::{authorization::AuthorityRoot, owner::AcceptedWorkCheckpoint};

/// Only the fixed checkpoint producer can admit the owner's non-business settlement reducer.
pub(super) struct AcceptedWork {
    world: WorldRef,
    storage_id: String,
}
impl AcceptedWork {
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

async fn check_world_intent(
    tx: &WorldTransaction<'_>,
    proof: &AcceptedWorkCheckpoint,
) -> Result<(), StoreError> {
    let intent = proof.mutation().ok_or_else(invalid)?;
    if intent.world != *tx.world() || intent.storage_id != tx.storage_id {
        return Err(invalid());
    }
    let row = tx.query_opt(
        "SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.commit.as_str()],
    ).await?.ok_or_else(invalid)?;
    let digest = Digest::try_new(row.get::<_, String>("input_digest")).map_err(|_| invalid())?;
    let original: Committed<OperationReceipt> =
        decode_committed(&row, &digest, &intent.commit, tx.world())?;
    if original.value.accepted != intent.operation {
        return Err(invalid());
    }
    let row = tx.query_opt(
        "SELECT status,generation,mutation_kind,mutation_commit_id,mutation_operation_id,mutation_final_commit_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
    ).await?.ok_or_else(invalid)?;
    if row.get::<_, String>("status") != intent.kind
        || row.get::<_, i64>("generation") as u64 != intent.operation.incarnation.0
        || row.get::<_, Option<String>>("mutation_kind").as_deref() != Some(intent.kind.as_str())
        || row
            .get::<_, Option<String>>("mutation_commit_id")
            .as_deref()
            != Some(intent.commit.as_str())
        || row
            .get::<_, Option<String>>("mutation_operation_id")
            .as_deref()
            != Some(intent.operation.operation_id.as_str())
        || row
            .get::<_, Option<String>>("mutation_final_commit_id")
            .as_deref()
            != Some(intent.final_commit.as_str())
    {
        return Err(invalid());
    }
    Ok(())
}

impl WorldStore {
    pub(crate) async fn checkpoint_accepted_work(
        &self,
        root: &AuthorityRoot,
        checkpoint: &AcceptedWorkCheckpoint,
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
            let row = snapshot.query_opt(
                "SELECT h.writer_epoch AS storage_epoch,g.writer_epoch AS operation_epoch FROM world_storage_head h JOIN world_writer_gate g USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND g.domain='operation'",
                &[&read_world.tenant_id.as_str(), &read_world.world_id.as_str()],
            ).await?.ok_or_else(invalid)?;
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
        batch.accepted_work = Some(AcceptedWork {
            world,
            storage_id: self.identity_receipt().storage_id().to_owned(),
        });
        let proof = checkpoint.clone();
        let same_root = checkpoint.same_root(root);
        self.transact(batch, move |tx| {
            Box::pin(async move {
                if !same_root || proof.storage_id() != tx.storage_id || !proof.validate() {
                    return Err(invalid().into());
                }
                if proof.mutation().is_some() {
                    check_world_intent(tx, &proof).await?;
                } else {
                    let row = tx.query_opt(
                        "SELECT generation FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
                        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
                    ).await?.ok_or_else(invalid)?;
                    if row.get::<_, i64>("generation") as u64 != proof.closing().operation().incarnation.0 {
                        return Err(invalid().into());
                    }
                    crate::extensions::package::check_accepted_disable(tx, proof.closing())
                        .await
                        .map_err(reference_error)?;
                }
                let affected = crate::owner::checkpoint_accepted_work(tx, &proof).await?;
                if !proof.validate() {
                    return Err(invalid().into());
                }
                Ok(affected)
            })
        })
        .await
    }
}
