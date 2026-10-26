use world_protocol::{
    api::WorldCommand,
    failure::FailureStage,
    ids::{CommitId, Digest, WorldRef},
};

use crate::{
    authorization::AuthorityRoot,
    content::StagedCommit,
    definitions::canonical_digest,
    owner::{Error, OperationRecord, RunRecord, execution_commit_id},
    store::WorldStore,
};

pub(crate) const MIGRATION_COMMIT_KEY: &str = "binding.migrate";
pub(crate) const MIGRATION_CHECKPOINT_KEY: &str = "binding.migrate.checkpoint";
pub(crate) const MIGRATION_PREPARE_KEY: &str = "binding.migrate.prepare";

/// Enumerates original durable checkpoints, including completed and failed migrations.
/// A missing checkpoint is not an abort proof and never authorizes physical cleanup.
pub(crate) async fn stage_cleanup_inventory(
    store: &WorldStore,
    _root: &AuthorityRoot,
    world: &WorldRef,
) -> Result<Vec<CommitId>, Error> {
    let candidates = store.snapshot(world.clone(), |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let mut candidates = Vec::new();
        let mut after = String::new();
        loop {
            let rows = snapshot.query(
                "SELECT r.run_id,r.operation_id,r.body AS run_body,o.body AS operation_body FROM world_run r JOIN world_operation o USING(tenant_id,world_id,operation_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.kind='package.migrate' AND o.kind='package.migrate' AND r.run_id>$3 ORDER BY r.run_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after],
            ).await?;
            if rows.is_empty() { break; }
            for row in rows {
                let id: String = row.get("run_id");
                let operation_id: String = row.get("operation_id");
                let operation: OperationRecord = serde_json::from_value(row.get("operation_body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                let run: RunRecord = serde_json::from_value(row.get("run_body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                let WorldCommand::MigratePackage(request) = operation.input.command()? else {
                    return Err(Error::internal(FailureStage::Recover));
                };
                if operation.input.world() != world || operation.receipt.accepted.world != *world
                    || operation.receipt.accepted.operation_id.as_str() != operation_id
                    || run.id.as_str() != id || run.operation.world != *world
                    || run.operation.operation_id != operation.receipt.accepted.operation_id
                    || run.operation.incarnation != operation.receipt.accepted.incarnation
                {
                    return Err(Error::internal(FailureStage::Recover));
                }
                let business = execution_commit_id(world, &run.operation.operation_id, &run.id, MIGRATION_COMMIT_KEY)?;
                let input = canonical_digest(request)?;
                for key in [MIGRATION_CHECKPOINT_KEY, MIGRATION_PREPARE_KEY] {
                    let checkpoint = execution_commit_id(world, &run.operation.operation_id, &run.id, key)?;
                    if let Some(receipt) = snapshot.query_opt(
                        "SELECT input_digest FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
                        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &checkpoint.as_str()],
                    ).await? {
                        let digest = Digest::try_new(receipt.get::<_, String>("input_digest"))
                            .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                        candidates.push((checkpoint, digest, business.clone(), input.clone()));
                    }
                }
                after = id;
            }
        }
        Ok::<_, Error>(candidates)
    })).await?;
    let mut inventory = Vec::with_capacity(candidates.len());
    for (checkpoint, digest, business, input) in candidates {
        let original = store
            .read_commit::<StagedCommit>(world, &checkpoint, &digest)
            .await?;
        let request = original.value.request();
        if canonical_digest(&original.value)? != digest
            || request.world != *world
            || request.commit_id != business
            || request.input_digest != input
            || !request
                .fences
                .iter()
                .any(|fence| fence.domain.as_str() == "content")
        {
            return Err(Error::internal(FailureStage::Recover));
        }
        request.clone().prepare()?;
        inventory.push(checkpoint);
    }
    Ok(inventory)
}
