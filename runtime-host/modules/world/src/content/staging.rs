use serde::{Deserialize, Serialize};
use world_protocol::{ids::WriterDomain, materials::MaterialFailure};

use super::{Content, Error, PreparedBlob, blob};
use crate::{
    authorization::AuthorityRoot,
    store::{CommitRequest, Committed, WorldStore},
};

/// A durable cleanup checkpoint, never a prepared blob or publication capability.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StagedCommit {
    request: CommitRequest,
    stages: Vec<blob::StageCleanup>,
}

impl StagedCommit {
    pub(crate) fn request(&self) -> &CommitRequest {
        &self.request
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StageCleanupOutcome {
    Local,
    /// Local stages were cleaned; foreign stages belong to another physical content owner.
    NonLocalOwner,
}

impl Content {
    pub(crate) fn stage_commit(
        &self,
        request: CommitRequest,
        blobs: &[&PreparedBlob],
    ) -> Result<StagedCommit, Error> {
        self.check_world(&request.world)?;
        request.clone().prepare()?;
        let content = WriterDomain::try_new("content").expect("fixed content domain");
        if blobs.len() > 65_536 || !request.fences.iter().any(|fence| fence.domain == content) {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let stages = blobs
            .iter()
            .map(|prepared| {
                self.check_world(&prepared.world)?;
                self.blobs
                    .stage_cleanup(&prepared.staged)
                    .map_err(Error::from)
            })
            .collect::<Result<_, _>>()?;
        Ok(StagedCommit { request, stages })
    }

    /// Re-reads both original receipts before accepting any restart cleanup witness.
    pub(crate) async fn discard_committed_stages(
        &self,
        store: &WorldStore,
        authority: &AuthorityRoot,
        checkpoint: &Committed<StagedCommit>,
    ) -> Result<StageCleanupOutcome, Error> {
        self.check_world(&checkpoint.receipt.world)?;
        let original = store
            .read_commit_for_recovery::<StagedCommit>(
                authority,
                &self.world,
                &checkpoint.receipt.commit_id,
            )
            .await?;
        self.discard_verified_stages(store, checkpoint, original)
            .await
    }

    /// Built-in cleanup uses the original checkpoint identity, without root recovery authority.
    pub(crate) async fn discard_checkpoint_stages(
        &self,
        store: &WorldStore,
        checkpoint_request: &CommitRequest,
        checkpoint: &Committed<StagedCommit>,
    ) -> Result<StageCleanupOutcome, Error> {
        self.check_world(&checkpoint_request.world)?;
        checkpoint_request.clone().prepare()?;
        if checkpoint_request.commit_id != checkpoint.receipt.commit_id {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let original = store
            .read_commit_optional::<StagedCommit>(
                &self.world,
                &checkpoint_request.commit_id,
                &checkpoint_request.input_digest,
            )
            .await?
            .ok_or_else(|| Error::material(MaterialFailure::InputInvalid))?;
        self.discard_verified_stages(store, checkpoint, original)
            .await
    }

    async fn discard_verified_stages(
        &self,
        store: &WorldStore,
        checkpoint: &Committed<StagedCommit>,
        original: Committed<StagedCommit>,
    ) -> Result<StageCleanupOutcome, Error> {
        self.check_world(&checkpoint.receipt.world)?;
        if original.receipt != checkpoint.receipt
            || super::encode(&original.value)? != super::encode(&checkpoint.value)?
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        self.check_world(&original.value.request.world)?;
        original.value.request.clone().prepare()?;
        if original.value.request.commit_id == checkpoint.receipt.commit_id
            || original.value.stages.len() > 65_536
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let request = &original.value.request;
        if store
            .read_commit_optional::<serde_json::Value>(
                &self.world,
                &request.commit_id,
                &request.input_digest,
            )
            .await?
            .is_none()
        {
            // The unique reservation, not a missing row, proves the original did not commit.
            let outcome: Result<
                Committed<serde_json::Value>,
                crate::store::TransactionError<crate::store::StoreError>,
            > = store
                .transact(request.clone().prepare()?, |_| {
                    Box::pin(async {
                        Err(crate::store::StoreError::new(
                            world_protocol::commit::CommitFailure::RolledBack,
                            world_protocol::failure::FailureStage::Recover,
                        ))
                    })
                })
                .await;
            match outcome {
                Err(crate::store::TransactionError::Indeterminate(error))
                | Err(crate::store::TransactionError::NotCommitted {
                    cleanup: Some(error),
                    ..
                }) => {
                    return Err(error.into());
                }
                Ok(_) | Err(crate::store::TransactionError::NotCommitted { cleanup: None, .. }) => {
                }
            }
        }
        let mut outcome = StageCleanupOutcome::Local;
        for stage in &original.value.stages {
            if self.blobs.is_local_stage(stage)? {
                self.blobs.discard_stage(stage)?;
            } else {
                // A copied receipt cannot authorize touching this owner's files or reopening its source.
                outcome = StageCleanupOutcome::NonLocalOwner;
            }
        }
        Ok(outcome)
    }
}
