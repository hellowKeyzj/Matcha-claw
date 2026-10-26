use world_protocol::{commit::CommitFailure, failure::FailureStage, ids::WorldRef};

use super::{CommitRequest, Committed, StoreError, TransactionError, WorldStore};
use crate::{authorization::AuthorityRoot, evaluation::EvaluationSettlement};

/// Only an already awaited evaluation may settle its existing report, never execute work.
pub(super) struct EvaluationReport {
    world: WorldRef,
    storage_id: String,
}
impl EvaluationReport {
    pub(super) fn matches(&self, world: &WorldRef, storage_id: &str) -> bool {
        &self.world == world && self.storage_id == storage_id
    }
}

pub(super) fn allows(statement: &str) -> bool {
    matches!(
        statement,
        "INSERT INTO world_commit_receipt(tenant_id,world_id,commit_id,input_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING"
            | "UPDATE world_commit_receipt SET receipt=$4,result=$5,committed_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3"
            | "UPDATE world_evaluation_run SET revision=$4,phase=$5,body=$6,terminal_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3 AND revision=$8"
            | "INSERT INTO world_evaluation_report(tenant_id,world_id,evaluation_id,revision,content_digest,verdict,body) VALUES($1,$2,$3,$4,$5,$6,$7)"
    )
}
fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Admission)
}

impl WorldStore {
    pub(crate) async fn settle_evaluation_report(
        &self,
        root: &AuthorityRoot,
        settlement: &EvaluationSettlement,
    ) -> Result<Committed<()>, TransactionError<crate::evaluation::Error>> {
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
        let mut batch = CommitRequest {
            world: world.clone(),
            commit_id: settlement.commit_id().clone(),
            input_digest: settlement.input_digest().clone(),
            storage_epoch: settlement.storage_epoch(),
            fences: vec![settlement.fence().clone()],
            watch_basis: Vec::new(),
        }
        .prepare()
        .map_err(&uncertain)?;
        batch.evaluation_report = Some(EvaluationReport {
            world,
            storage_id: self.identity_receipt().storage_id().to_owned(),
        });
        let proof = settlement.clone();
        let same_root = settlement.same_root(root);
        self.transact(batch, move |tx| {
            Box::pin(async move {
                if !same_root
                    || proof.storage_id() != tx.storage_id
                    || proof.fence().domain.as_str() != "evaluation"
                {
                    return Err(invalid().into());
                }
                crate::evaluation::settle_report(tx, &proof).await
            })
        })
        .await
    }
}
