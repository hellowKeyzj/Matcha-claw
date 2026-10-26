use world_protocol::{
    commit::{CommitFailure, WriteFence},
    failure::FailureStage,
    ids::{WorldRef, WriterDomain, WriterEpoch},
    operation::OperationReceipt,
};

use super::{CommitRequest, Committed, StoreError, TransactionError, WorldStore};
use crate::{authorization::AuthorityRoot, owner::FailedWorkSettlement};

/// Returned work may settle its original ledger, never acquire new business authority.
pub(super) struct FailedWork {
    world: WorldRef,
    storage_id: String,
}
impl FailedWork {
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
            | "UPDATE world_step SET revision=$5,phase=$6,body=$7,result=$8,failure=$9 WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4 AND revision=$10 AND writer_epoch=$11"
            | "INSERT INTO world_outbox(tenant_id,world_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,causation_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"
    )
}

fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Admission)
}

impl WorldStore {
    pub(crate) async fn settle_failed_work(
        &self,
        root: &AuthorityRoot,
        settlement: &FailedWorkSettlement,
    ) -> Result<Committed<OperationReceipt>, TransactionError<crate::owner::Error>> {
        let uncertain = |error| {
            TransactionError::Indeterminate(StoreError::caused_by(
                CommitFailure::CommitIndeterminate {
                    commit_id: settlement.commit_id().clone(),
                },
                FailureStage::Recover,
                error,
            ))
        };
        let world = settlement.world().clone();
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
            commit_id: settlement.commit_id().clone(),
            input_digest: settlement.input_digest().clone(),
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
        batch.failed_work = Some(FailedWork {
            world,
            storage_id: self.identity_receipt().storage_id().to_owned(),
        });
        let proof = settlement.clone();
        let same_root = settlement.same_root(root);
        self.transact(batch, move |tx| {
            Box::pin(async move {
                if !same_root || proof.storage_id() != tx.storage_id {
                    return Err(invalid().into());
                }
                crate::owner::settle_failed_work(tx, &proof).await
            })
        })
        .await
    }
}
