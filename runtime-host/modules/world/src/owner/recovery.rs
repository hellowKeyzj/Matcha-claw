use world_protocol::{failure::FailureStage, ids::*, operation::OperationReceipt};

use crate::store::WorldStore;
use super::{Error, ledger::OperationRecord, run::{RunRecord, StepRecord}};

pub(crate) async fn cleanup_committed(
    store: &WorldStore, resources: &std::sync::Arc<super::resources::Resources>,
    root: &crate::authorization::AuthorityRoot, world: &WorldRef, operation: &OperationId,
) -> Result<(), Error> {
    let id = operation.clone();
    let record = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        super::ledger::read_record_snapshot(snapshot, &id).await
    })).await?;
    if !super::ledger::terminal(record.receipt.phase) { return Ok(()); }
    let super::ledger::OperationInput::Command(input) = &record.input else { return Ok(()); };
    match (&input.command, &record.receipt.result) {
        (world_protocol::api::WorldCommand::ImportMaterials(_) | world_protocol::api::WorldCommand::ProposeMaterialDraft(_), _) => {
            let run = record.receipt.progress.run_id.as_ref().ok_or_else(|| Error::internal(FailureStage::Recover))?;
            super::workflows::materials::cleanup_terminal(store, root, &record.receipt.accepted, run, &input.command).await
        }
        (world_protocol::api::WorldCommand::ResolveTask(request), _) => {
            let run = record.receipt.progress.run_id.as_ref().ok_or_else(|| Error::internal(FailureStage::Recover))?;
            crate::learning::investigation::cleanup_terminal(store, &resources.content, root, &record.receipt.accepted, run, request).await
        }
        (world_protocol::api::WorldCommand::Publish(_) | world_protocol::api::WorldCommand::Rollback(_), _) => {
            resources.releases.cleanup_committed(store, &resources.content, root, world, operation).await
        }
        (world_protocol::api::WorldCommand::Backup(_), _)
        | (world_protocol::api::WorldCommand::Restore(_), Some(world_protocol::operation::OperationResult::Restore { .. }))
        | (world_protocol::api::WorldCommand::DeleteWorld(_), Some(world_protocol::operation::OperationResult::Delete { .. })) => {
            let run = record.receipt.progress.run_id.as_ref().ok_or_else(|| Error::internal(FailureStage::Recover))?;
            resources.archive.recover_committed(store, resources, root, world, operation, run).await
        }
        _ => Ok(()),
    }
}

pub(crate) async fn cleanup_candidates(store: &WorldStore, world: WorldRef) -> Result<Vec<OperationRecord>, Error> {
    store.snapshot(world, |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let mut after = String::new();
        let mut records = Vec::new();
        loop {
            let rows = snapshot.query("SELECT operation_id,body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND terminal_at IS NOT NULL AND operation_id>$3 ORDER BY operation_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after]).await?;
            let done = rows.len() < 256;
            for row in rows {
                after = row.get("operation_id");
                let record: OperationRecord = serde_json::from_value(row.get("body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                if record.receipt.accepted.world != *world || record.input.world() != world
                    || record.receipt.accepted.operation_id.as_str() != after || !super::ledger::terminal(record.receipt.phase) {
                    return Err(Error::internal(FailureStage::Recover));
                }
                let super::ledger::OperationInput::Command(input) = &record.input else { continue; };
                if matches!(&input.command, world_protocol::api::WorldCommand::Publish(_) | world_protocol::api::WorldCommand::Rollback(_)
                    | world_protocol::api::WorldCommand::Backup(_) | world_protocol::api::WorldCommand::Restore(_) | world_protocol::api::WorldCommand::DeleteWorld(_)
                    | world_protocol::api::WorldCommand::ImportMaterials(_) | world_protocol::api::WorldCommand::ProposeMaterialDraft(_)
                    | world_protocol::api::WorldCommand::ResolveTask(_)) {
                    records.push(record);
                }
            }
            if done { return Ok(records); }
        }
    })).await
}

/// Durable inspection, not a runnable queue. In-flight steps require effect/commit
/// verification and a fresh current admission before any domain can resume them.
pub(crate) struct RecoveryInventory {
    pub operations: Vec<OperationReceipt>,
    pub runs: Vec<RunRecord>,
    pub unsettled_steps: Vec<StepRecord>,
}

pub(crate) async fn load(store: &WorldStore, world: WorldRef) -> Result<RecoveryInventory, Error> {
    store.snapshot(world, |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let mut inventory = RecoveryInventory { operations: Vec::new(), runs: Vec::new(), unsettled_steps: Vec::new() };
        let mut after = String::new();
        loop {
            let rows = snapshot.query(
                "SELECT operation_id,body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND terminal_at IS NULL AND operation_id>$3 ORDER BY operation_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after],
            ).await?;
            if rows.is_empty() { break }
            for row in rows {
                let id: String = row.get("operation_id");
                let record: OperationRecord = serde_json::from_value(row.get("body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                if record.receipt.accepted.world != *world || record.receipt.accepted.operation_id.as_str() != id || record.input.world() != world {
                    return Err(Error::internal(FailureStage::Recover));
                }
                after = id;
                inventory.operations.push(record.receipt);
            }
        }
        let mut after = String::new();
        loop {
            let rows = snapshot.query(
                "SELECT r.run_id,r.body FROM world_run r JOIN world_operation o USING(tenant_id,world_id,operation_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND o.terminal_at IS NULL AND r.run_id>$3 ORDER BY r.run_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after],
            ).await?;
            if rows.is_empty() { break }
            for row in rows {
                let id: String = row.get("run_id");
                let record: RunRecord = serde_json::from_value(row.get("body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                if record.operation.world != *world || record.id.as_str() != id { return Err(Error::internal(FailureStage::Recover)); }
                after = id;
                inventory.runs.push(record);
            }
        }
        let mut after = (String::new(), String::new());
        loop {
            let rows = snapshot.query(
                "SELECT s.run_id,s.step_id,s.body FROM world_step s JOIN world_run r USING(tenant_id,world_id,run_id) JOIN world_operation o USING(tenant_id,world_id,operation_id) WHERE s.tenant_id=$1 AND s.world_id=$2 AND o.terminal_at IS NULL AND (s.run_id,s.step_id)>($3,$4) ORDER BY s.run_id,s.step_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after.0, &after.1],
            ).await?;
            if rows.is_empty() { break }
            for row in rows {
                let run: String = row.get("run_id");
                let id: String = row.get("step_id");
                let record: StepRecord = serde_json::from_value(row.get("body"))
                    .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
                if record.run_id.as_str() != run || record.id.as_str() != id { return Err(Error::internal(FailureStage::Recover)); }
                after = (run, id);
                if record.result.is_none() { inventory.unsettled_steps.push(record); }
            }
        }
        Ok(inventory)
    })).await
}
