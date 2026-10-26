use std::sync::Arc;

use world_protocol::{
    api::ApiFailure, failure::{FailureStage, Recovery}, ids::*,
    operation::OperationPhase,
};
use crate::{
    extensions::lifecycle::{AcceptedClosing, ClosingInstall, LiveExtensions, WorldClosing},
    store::{CommittedWorldMutation, WorldTransaction},
};
use super::{Error, ExecutionContext, RunRecord, execution_commit_id, ledger, run, tasks::Tasks};

/// Minted only from the lifecycle's original closing capability; never caller-supplied run IDs.
#[derive(Clone)]
pub(crate) struct AcceptedWorkCheckpoint {
    closing: AcceptedClosing,
    live: Arc<LiveExtensions>,
    tasks: Arc<Tasks>,
    authority: Arc<crate::authorization::AuthorityRoot>,
    storage_id: String,
    commit: CommitId,
    input: Digest,
}

impl AcceptedWorkCheckpoint {
    fn new(ctx: &ExecutionContext, closing: AcceptedClosing) -> Result<Self, Error> {
        if closing.world() != &ctx.operation.world || closing.operation().operation_id != ctx.operation.operation_id
            || closing.operation().incarnation != ctx.operation.incarnation { return Err(invalid()); }
        let input = crate::definitions::canonical_digest(&(
            "world.accepted-work.checkpoint.v1", closing.world(), closing.commit_id(),
            closing.operation(), closing.install(), closing.revision(), closing.final_commit_id(),
        ))?;
        Ok(Self { closing, live: ctx.resources.live.clone(), tasks: ctx.resources.tasks.clone(),
            authority: ctx.authority.clone(), storage_id: ctx.store.identity_receipt().storage_id().to_owned(),
            commit: execution_commit_id(&ctx.operation.world, &ctx.operation.operation_id, &ctx.run.id, "accepted-work.checkpoint")?, input })
    }

    pub(crate) fn world(&self) -> &WorldRef { self.closing.world() }
    pub(crate) fn commit_id(&self) -> &CommitId { &self.commit }
    pub(crate) fn input_digest(&self) -> &Digest { &self.input }
    pub(crate) fn storage_id(&self) -> &str { &self.storage_id }
    pub(crate) fn same_root(&self, root: &crate::authorization::AuthorityRoot) -> bool { std::ptr::eq(self.authority.as_ref(), root) }
    pub(crate) fn closing(&self) -> &AcceptedClosing { &self.closing }
    pub(crate) fn mutation(&self) -> Option<&CommittedWorldMutation> { self.closing.world_intent() }
    pub(crate) fn validate(&self) -> bool { self.live.validate_accepted_closing(&self.closing) }
}

impl ExecutionContext {
    pub(crate) async fn checkpoint_world_mutation(&self, intent: &CommittedWorldMutation, closing: &WorldClosing) -> Result<(), Error> {
        let closing = self.resources.live.accepted_world_closing(intent, closing)?;
        self.checkpoint_accepted(closing).await
    }

    pub(crate) async fn checkpoint_disable(&self, intent: &crate::extensions::package::CommittedDisable, closing: &ClosingInstall) -> Result<(), Error> {
        let closing = self.resources.live.accepted_install_closing(intent, closing)?;
        self.checkpoint_accepted(closing).await
    }

    async fn checkpoint_accepted(&self, closing: AcceptedClosing) -> Result<(), Error> {
        let proof = AcceptedWorkCheckpoint::new(self, closing)?;
        let committed = self.store.checkpoint_accepted_work(&self.authority, &proof).await?;
        self.resources.tasks.seal_runs(&committed.value, self.resources.live.clone(), &proof.closing);
        self.resources.tasks.cancel_join_runs(&self.operation.world, &committed.value, self.deadline).await
    }
}

/// The store's finite lane calls this reducer only, after reserving the original CommitId.
pub(crate) async fn checkpoint_accepted_work(tx: &mut WorldTransaction<'_>, proof: &AcceptedWorkCheckpoint) -> Result<Vec<RunId>, Error> {
    if tx.world() != proof.world() || !proof.validate() { return Err(invalid()); }
    let affected = checkpoint_runs(tx, &proof.tasks, proof.closing.install(), Some(&proof.closing.operation().operation_id)).await?;
    if !proof.validate() { return Err(invalid()); }
    Ok(affected)
}

pub(super) async fn checkpoint_runs(
    tx: &mut WorldTransaction<'_>, tasks: &Tasks, install: Option<&InstallId>, excluded: Option<&OperationId>,
) -> Result<Vec<RunId>, Error> {
    let mut after = String::new();
    let mut affected = Vec::new();
    loop {
        let rows = tx.query("SELECT run_id,operation_id,body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND terminal_at IS NULL AND run_id>$3 ORDER BY run_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("run_id");
            let record: RunRecord = serde_json::from_value(row.get("body")).map_err(|cause| invalid().caused(cause))?;
            if record.operation.world != *tx.world() || record.id.as_str() != after
                || record.operation.operation_id.as_str() != row.get::<_, String>("operation_id") { return Err(invalid()); }
            if excluded == Some(&record.operation.operation_id) || ledger::terminal(record.phase) { continue; }
            if let Some(install) = install {
                let Some(lock) = &record.activation_lock_id else { continue; };
                let graph = crate::extensions::bindings::read_graph_history_in_transaction(tx, lock).await
                    .map_err(|cause| invalid().caused(cause))?;
                if !graph.lock().nodes.iter().any(|node| &node.implementation.install_id == install) { continue; }
            }
            let mut operation = ledger::read(tx, &record.operation.operation_id).await?;
            let record = run::read_run(tx, &record.id).await?;
            if operation.receipt.progress.run_id.as_ref() != Some(&record.id)
                || operation.receipt.accepted.incarnation != record.operation.incarnation { return Err(invalid()); }
            if ledger::terminal(operation.receipt.phase) { continue; }
            if let Some(usage) = tasks.usage(tx.world(), &record.id) {
                run::checkpoint_usage(tx, &record, run::confirmed_usage(&record.usage, usage)?).await?;
            }
            operation.receipt.progress.stage = FailureStage::Drain;
            if !matches!(operation.receipt.phase, OperationPhase::CommitIndeterminate | OperationPhase::EffectIndeterminate | OperationPhase::Retained) {
                operation.receipt.phase = OperationPhase::Draining;
            }
            ledger::save(tx, &mut operation, &tx.now().await?).await?;
            run::settle(tx, &operation.receipt).await?;
            affected.push(record.id);
        }
        if done { break; }
    }
    Ok(affected)
}

fn invalid() -> Error {
    Error::new("world.accepted_work_checkpoint_conflict", FailureStage::Drain,
        "关闭意图或已接收执行的归属已变化，不能取消原任务。", ApiFailure::RevisionConflict, Recovery::Refresh)
}
