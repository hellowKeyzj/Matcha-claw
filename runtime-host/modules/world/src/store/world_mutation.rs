use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    ids::{CommitId, Digest, Generation, OperationId, Revision, WorldRef},
    operation::{OperationAccepted, OperationReceipt, OperationResult},
};

use super::{
    ArchiveSnapshot, Committed, StoreError, WorldSnapshot, WorldStore, WorldTransaction,
    archive::conflict,
};

/// Only an authoritative read of the original durable intent can mint this capability.
#[derive(Clone)]
pub(crate) struct CommittedWorldMutation {
    pub(super) world: WorldRef,
    pub(super) storage_id: String,
    pub(super) commit: CommitId,
    pub(super) final_commit: CommitId,
    pub(super) operation: OperationAccepted,
    pub(super) kind: String,
    archive: Option<Digest>,
}

/// Borrowed refinement: a deletion capability can never prepare a restored runtime.
pub(crate) struct WorldRestoreIntent<'a>(&'a CommittedWorldMutation);

impl CommittedWorldMutation {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub(crate) fn final_commit_id(&self) -> &CommitId {
        &self.final_commit
    }
    pub(crate) fn operation(&self) -> &OperationAccepted {
        &self.operation
    }
    pub(crate) fn restore(&self) -> Option<WorldRestoreIntent<'_>> {
        (self.kind == "restoring").then_some(WorldRestoreIntent(self))
    }
}
impl WorldRestoreIntent<'_> {
    pub(crate) fn world(&self) -> &WorldRef {
        self.0.world()
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        self.0.commit_id()
    }
    pub(crate) fn final_commit_id(&self) -> &CommitId {
        self.0.final_commit_id()
    }
    pub(crate) fn operation(&self) -> &OperationAccepted {
        self.0.operation()
    }
    pub(crate) fn archive_digest(&self) -> &Digest {
        self.0.archive.as_ref().expect("restore intent has archive")
    }
}

#[derive(Clone)]
pub(crate) struct CommittedWorldRestore {
    world: WorldRef,
    storage_id: String,
    incarnation: Generation,
    operation: OperationId,
    intent: CommitId,
    commit: CommitId,
}
impl CommittedWorldRestore {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn intent_commit_id(&self) -> &CommitId {
        &self.intent
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub(crate) async fn recheck_read(
        &self,
        snapshot: &WorldSnapshot<'_>,
    ) -> Result<(), StoreError> {
        if snapshot.world() != &self.world {
            return Err(invalid());
        }
        let row = snapshot.query_opt("SELECT r.status,r.generation,r.mutation_kind,r.mutation_commit_id,r.mutation_operation_id,r.mutation_final_commit_id,s.storage_id FROM world_runtime_head r JOIN world_storage_head s USING(tenant_id,world_id) WHERE r.tenant_id=$1 AND r.world_id=$2",
            &[&self.world.tenant_id.as_str(), &self.world.world_id.as_str()]).await?.ok_or_else(invalid)?;
        if row.get::<_, String>("status") != "ready"
            || self.incarnation.0 >= i64::MAX as u64
            || row.get::<_, i64>("generation") as u64 != self.incarnation.0 + 1
            || row.get::<_, String>("storage_id") != self.storage_id
            || row.get::<_, Option<String>>("mutation_kind").as_deref() != Some("restoring")
            || row
                .get::<_, Option<String>>("mutation_commit_id")
                .as_deref()
                != Some(self.intent.as_str())
            || row
                .get::<_, Option<String>>("mutation_operation_id")
                .as_deref()
                != Some(self.operation.as_str())
            || row
                .get::<_, Option<String>>("mutation_final_commit_id")
                .as_deref()
                != Some(self.commit.as_str())
        {
            return Err(conflict(ConstraintCode::HeadGeneration));
        }
        Ok(())
    }
}

fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate)
}

impl WorldStore {
    pub(crate) async fn recover_committed_world_restore(
        &self,
        root: &crate::authorization::AuthorityRoot,
        world: &WorldRef,
    ) -> Result<Option<(CommittedWorldMutation, CommittedWorldRestore)>, StoreError> {
        let read_world = world.clone();
        let ids = self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let Some(row) = snapshot.query_opt("SELECT status,mutation_kind,mutation_commit_id,mutation_final_commit_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
                &[&read_world.tenant_id.as_str(), &read_world.world_id.as_str()]).await? else { return Ok::<_, StoreError>(None); };
            if row.get::<_, String>("status") != "ready"
                || row.get::<_, Option<String>>("mutation_kind").as_deref() != Some("restoring")
            { return Ok(None); }
            let intent = CommitId::try_new(row.get::<_, Option<String>>("mutation_commit_id").ok_or_else(invalid)?).map_err(|_| invalid())?;
            let completed = CommitId::try_new(row.get::<_, Option<String>>("mutation_final_commit_id").ok_or_else(invalid)?).map_err(|_| invalid())?;
            Ok(Some((intent, completed)))
        })).await?;
        let Some((intent_id, final_id)) = ids else {
            return Ok(None);
        };
        let committed = self
            .read_commit_for_recovery::<OperationReceipt>(root, world, &intent_id)
            .await?;
        let intent = self.committed_world_mutation(root, &committed).await?;
        if intent.final_commit_id() != &final_id {
            return Err(invalid());
        }
        let completed = self
            .read_commit_for_recovery::<OperationReceipt>(root, world, &final_id)
            .await?;
        let restored = self
            .committed_world_restore(root, &intent, &completed)
            .await?;
        Ok(Some((intent, restored)))
    }

    pub(crate) async fn committed_world_mutation(
        &self,
        root: &crate::authorization::AuthorityRoot,
        committed: &Committed<OperationReceipt>,
    ) -> Result<CommittedWorldMutation, StoreError> {
        let world = committed.receipt.world.clone();
        let commit = committed.receipt.commit_id.clone();
        let original = self
            .read_commit_for_recovery::<OperationReceipt>(root, &world, &commit)
            .await?;
        if original.receipt != committed.receipt
            || original.value != committed.value
            || original.value.accepted.world != world
        {
            return Err(invalid());
        }
        let operation = original.value.accepted;
        let read_world = world.clone();
        let read_commit = commit.clone();
        let operation_id = operation.operation_id.clone();
        let (kind, final_commit, archive) = self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt("SELECT status,mutation_kind,mutation_commit_id,mutation_operation_id,mutation_final_commit_id,mutation_archive_digest FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
                &[&read_world.tenant_id.as_str(), &read_world.world_id.as_str()]).await?.ok_or_else(invalid)?;
            let kind: Option<String> = row.get("mutation_kind");
            let status: String = row.get("status");
            if row.get::<_, Option<String>>("mutation_commit_id").as_deref() != Some(read_commit.as_str())
                || row.get::<_, Option<String>>("mutation_operation_id").as_deref() != Some(operation_id.as_str())
                || !matches!((kind.as_deref(), status.as_str()), (Some("restoring"), "restoring" | "ready") | (Some("deleting"), "deleting" | "retained")) {
                return Err(conflict(ConstraintCode::HeadGeneration));
            }
            let final_commit = CommitId::try_new(row.get::<_, Option<String>>("mutation_final_commit_id").ok_or_else(invalid)?).map_err(|_| invalid())?;
            let archive = row.get::<_, Option<String>>("mutation_archive_digest").map(Digest::try_new).transpose().map_err(|_| invalid())?;
            if (kind.as_deref() == Some("restoring")) != archive.is_some() { return Err(invalid()); }
            Ok::<_, StoreError>((kind.ok_or_else(invalid)?, final_commit, archive))
        })).await?;
        Ok(CommittedWorldMutation {
            world,
            storage_id: self.identity_receipt().storage_id().to_owned(),
            commit,
            final_commit,
            operation,
            kind,
            archive,
        })
    }

    pub(crate) async fn committed_world_restore(
        &self,
        root: &crate::authorization::AuthorityRoot,
        intent: &CommittedWorldMutation,
        committed: &Committed<OperationReceipt>,
    ) -> Result<CommittedWorldRestore, StoreError> {
        if intent.kind != "restoring"
            || intent.storage_id != self.identity_receipt().storage_id()
            || committed.receipt.world != intent.world
            || committed.receipt.commit_id != intent.final_commit
            || committed.value.accepted.operation_id != intent.operation.operation_id
            || !matches!(
                committed.value.result,
                Some(OperationResult::Restore { .. })
            )
        {
            return Err(invalid());
        }
        let original = self
            .read_commit_for_recovery::<OperationReceipt>(root, &intent.world, &intent.final_commit)
            .await?;
        if original.receipt != committed.receipt || original.value != committed.value {
            return Err(invalid());
        }
        let proof = CommittedWorldRestore {
            world: intent.world.clone(),
            storage_id: intent.storage_id.clone(),
            incarnation: intent.operation.incarnation.clone(),
            operation: intent.operation.operation_id.clone(),
            intent: intent.commit.clone(),
            commit: intent.final_commit.clone(),
        };
        self.snapshot(proof.world.clone(), move |snapshot| {
            Box::pin(async move {
                proof.recheck_read(snapshot).await?;
                Ok(proof)
            })
        })
        .await
    }
}

impl WorldTransaction<'_> {
    pub(crate) async fn begin_world_deletion(
        &self,
        expected: Generation,
        revision: Revision,
        operation: &OperationAccepted,
        final_commit: &CommitId,
    ) -> Result<(), StoreError> {
        self.begin_world_mutation(expected, Some(revision), operation, final_commit, None)
            .await
    }
    pub(crate) async fn begin_world_restore(
        &self,
        expected: Generation,
        operation: &OperationAccepted,
        snapshot: &ArchiveSnapshot,
        final_commit: &CommitId,
    ) -> Result<(), StoreError> {
        super::archive::validate(snapshot, self).await?;
        let manifest = serde_json::to_value(&snapshot.manifest).map_err(|_| invalid())?;
        let seal = self.query_opt("SELECT manifest FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND archive_digest=$3",
            &[&self.world().tenant_id.as_str(), &self.world().world_id.as_str(), &snapshot.digest().as_str()]).await?;
        if !seal.is_some_and(|row| row.get::<_, serde_json::Value>(0) == manifest) {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
        super::archive::validate_restore(snapshot, self).await?;
        self.begin_world_mutation(
            expected,
            None,
            operation,
            final_commit,
            Some(snapshot.digest()),
        )
        .await
    }
    async fn begin_world_mutation(
        &self,
        expected: Generation,
        revision: Option<Revision>,
        operation: &OperationAccepted,
        final_commit: &CommitId,
        archive: Option<&Digest>,
    ) -> Result<(), StoreError> {
        self.require_exclusive_storage()?;
        if operation.world != *self.world()
            || operation.incarnation != expected
            || final_commit == self.commit_id()
            || expected.0 >= i64::MAX as u64
            || revision.is_some_and(|value| value.0 >= i64::MAX as u64)
        {
            return Err(invalid());
        }
        let world = self.world();
        let row = self.query_opt("SELECT body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &operation.operation_id.as_str()]).await?.ok_or_else(invalid)?;
        let body: serde_json::Value = row.get(0);
        if body.pointer("/receipt/accepted")
            != Some(&serde_json::to_value(operation).map_err(|_| invalid())?)
        {
            return Err(invalid());
        }
        let kind = if archive.is_some() {
            "restoring"
        } else {
            "deleting"
        };
        let changed = self.execute("UPDATE world_runtime_head SET status=$5,mutation_kind=$5,revision=revision+1,mutation_commit_id=$6,mutation_operation_id=$7,mutation_final_commit_id=$8,mutation_archive_digest=$9,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND generation=$3 AND ($4::bigint IS NULL OR revision=$4) AND status='ready' AND revision<9223372036854775807",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &(expected.0 as i64), &revision.map(|value| value.0 as i64), &kind, &self.commit_id().as_str(), &operation.operation_id.as_str(), &final_commit.as_str(), &archive.map(Digest::as_str)]).await?;
        if changed != 1 {
            return Err(conflict(ConstraintCode::HeadGeneration));
        }
        Ok(())
    }

    pub(super) fn require_world_mutation(
        &self,
        intent: &CommittedWorldMutation,
        kind: &str,
    ) -> Result<(), StoreError> {
        if intent.world != self.world
            || intent.storage_id != self.storage_id
            || intent.kind != kind
            || self.commit_id != intent.final_commit
            || self.world_mutation.as_ref().is_none_or(|current| {
                current.commit != intent.commit
                    || current.operation != intent.operation
                    || current.kind != kind
            })
        {
            return Err(invalid());
        }
        Ok(())
    }
}
