use std::{collections::BTreeMap, sync::{Arc, atomic::Ordering}};

use tokio::time::Instant;

use serde::{Deserialize, Serialize};
use world_protocol::{
    failure::FailureStage,
    ids::{TransferId, WorldRef, WriterEpoch},
};

use crate::{
    authorization::AuthorityRoot,
    extensions::{
        bindings::PreparedTransfer,
        lifecycle::{AcceptedTransferSelection, ClosingTransfer, DrainedTransfer, TransferHydration},
        migration,
    },
    store::{SourceResumeReceipt, SourceRetirementReceipt, TargetActivationReceipt, TransferCut, WorldStore},
};
use super::{Error, WorldHandle, Command, Shared, resources};
use super::super::{TransferWorkCheckpoint, resources::Resources};

/// Private Host control input. Storage credentials and writer epochs are never caller supplied.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageTransferPrepare {
    pub(super) world: WorldRef,
    pub(super) target_storage_id: String,
    pub(super) transfer_id: TransferId,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum TransferAction { Resume, Abort }

/// Deserialization carries only an identity; the source primary must prove the original cut.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageTransferRequest {
    pub(super) action: TransferAction,
    pub(super) cut: TransferCut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum TransferStatus { Activated, Aborted }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTransferOutcome {
    pub(super) cut: TransferCut,
    pub(super) status: TransferStatus,
    pub(super) writer_epoch: WriterEpoch,
}

pub(crate) struct PendingTransfer {
    cut: TransferCut,
    state: tokio::sync::Mutex<PendingState>,
}

struct PendingState {
    closing: Option<ClosingTransfer>,
    selection: AcceptedTransferSelection,
    checkpoint: TransferWorkCheckpoint,
    runs: Option<Vec<world_protocol::ids::RunId>>,
    drained: Option<DrainedTransfer>,
    completion: Option<Completion>,
    hydration: Option<Arc<TransferHydration>>,
    prepared: Option<Arc<PreparedTransfer>>,
    published: bool,
}

enum Completion {
    Target { activation: Arc<TargetActivationReceipt>, retirement: Arc<SourceRetirementReceipt> },
    Source(Arc<SourceResumeReceipt>),
}

pub(super) async fn prepare(shared: &Shared, input: StorageTransferPrepare) -> Result<StorageTransferRequest, Error> {
    running(shared)?;
    let initial = control_store(shared).await?;
    let current = super::locate(shared, &initial, &input.world).await?;
    shared.stores.open(&input.target_storage_id).await?;
    let mut original = None;
    for store in shared.stores.connected() {
        if let Some(cut) = store.read_transfer_by_id(&input.world, &input.transfer_id).await? {
            if cut.target_storage_id != input.target_storage_id || original.as_ref().is_some_and(|held| held != &cut) {
                return Err(conflict(&input.transfer_id));
            }
            original = Some(cut);
        }
    }
    let source = match original {
        Some(cut) => shared.stores.open(&cut.source_storage_id).await?,
        None => current,
    };
    let cut = source.prepare_transfer(&shared.authority, &input.world, &input.target_storage_id, &input.transfer_id).await?;
    retain_original(shared, &source, &cut).await?;
    Ok(StorageTransferRequest { action: TransferAction::Resume, cut })
}

async fn retain_original(shared: &Shared, source: &WorldStore, cut: &TransferCut) -> Result<Option<Arc<PendingTransfer>>, Error> {
    let draining = source.begin_transfer_draining(cut).await?;
    let resources = resources(shared, source, &cut.world)?;
    let mut held = resources.transfer.lock().await;
    if let Some(pending) = held.as_ref() {
        if pending.cut != *cut { return Err(conflict(&pending.cut.transfer_id)); }
        return Ok(Some(pending.clone()));
    }
    if shared.live.transfer_applied(cut) { return Ok(None); }
    let closing = shared.live.begin_transfer(&draining)?;
    let selection = shared.live.accepted_transfer(&closing)?;
    let checkpoint = TransferWorkCheckpoint::new(source, shared.authority.clone(), draining,
        selection.clone(), shared.live.clone(), shared.tasks.clone())?;
    let pending = Arc::new(PendingTransfer { cut: cut.clone(), state: tokio::sync::Mutex::new(PendingState {
        closing: Some(closing), selection, checkpoint, runs: None, drained: None,
        completion: None, hydration: None, prepared: None, published: false,
    }) });
    *held = Some(pending.clone());
    Ok(Some(pending))
}

pub(super) async fn recover_startup(shared: &Shared, store: &WorldStore, world: &WorldRef) -> Result<Option<StorageTransferRequest>, Error> {
    let Some(cut) = store.read_current_transfer(world).await? else { return Ok(None); };
    let source = shared.stores.open(&cut.source_storage_id).await?;
    let state = source.read_transfer(&cut).await?;
    let action = if state.phase == crate::store::TransferPhase::Aborted { TransferAction::Abort } else { TransferAction::Resume };
    retain_original(shared, &source, &cut).await.map_err(|error| recoverable(&cut, error))?;
    Ok(Some(StorageTransferRequest { action, cut }))
}

pub(super) async fn execute(
    shared: Arc<Shared>, input: StorageTransferRequest, target: WorldHandle,
) -> Result<StorageTransferOutcome, Error> {
    let cut = input.cut.clone();
    let result = execute_original(&shared, input, target).await;
    match result {
        Ok(outcome) => { super::restore_ready(&shared)?; Ok(outcome) }
        Err(error) => Err(recoverable(&cut, error)),
    }
}

async fn execute_original(
    shared: &Arc<Shared>, input: StorageTransferRequest, target: WorldHandle,
) -> Result<StorageTransferOutcome, Error> {
    running(shared)?;
    let cut = &input.cut;
    let source = shared.stores.open(&cut.source_storage_id).await?;
    let source_resources = resources(shared, &source, &cut.world)?;
    let Some(pending) = retain_original(shared, &source, cut).await? else {
        return applied_outcome(shared, &source, &input).await;
    };
    let mut state = pending.state.lock().await;
    let deadline = Instant::now() + source_resources.preparation.execution_policy().cleanup_timeout;
    if state.hydration.is_none() {
        if state.runs.is_none() {
            let source_state = source.read_transfer(cut).await?;
            let checkpoint = if source_state.phase == crate::store::TransferPhase::Draining {
                source.checkpoint_transfer_work(&shared.authority, &state.checkpoint).await?
            } else {
                source.read_commit::<Vec<world_protocol::ids::RunId>>(&cut.world,
                    state.checkpoint.commit_id(), state.checkpoint.input_digest()).await?
            };
            shared.tasks.seal_transfer_runs(&checkpoint.value, shared.live.clone(), &state.selection);
            state.runs = Some(checkpoint.value);
        }
        let runs = state.runs.as_ref().expect("confirmed transfer checkpoint");
        shared.tasks.cancel_join_runs(&cut.world, runs, deadline).await?;
        shared.tasks.join_world_runs(&cut.world, deadline).await?;
        tokio::time::timeout_at(deadline, source_resources.sync.shutdown(deadline)).await
            .map_err(|_| retained("world.transfer_sync_retained", "源读取任务尚未停止，未开始复制。"))?
            .map_err(Error::from)?;
        if state.drained.is_none() {
            let closing = state.closing.take().expect("original transfer closing");
            match closing.drain_until(deadline).await {
                Ok(drained) => state.drained = Some(drained),
                Err((closing, remaining)) => {
                    state.closing = Some(closing);
                    return Err(Error::new("world.transfer_extensions_retained", FailureStage::Drain,
                        "扩展仍持有执行资源，未开始复制。", world_protocol::api::ApiFailure::Operation(
                            world_protocol::operation::OperationFailure::Lifecycle(world_protocol::lifecycle::LifecycleFailure::Retained {
                                stage: world_protocol::lifecycle::LifecycleStage::Join,
                                remaining_resources: remaining.iter().flat_map(crate::extensions::lifecycle::retained_resources).collect(),
                            })), world_protocol::failure::Recovery::ReadTransfer { transfer_id: cut.transfer_id.clone() }));
                }
            }
        }
        for record in super::super::recovery::cleanup_candidates(&source, cut.world.clone()).await? {
            super::super::recovery::cleanup_committed(&source, &source_resources, &shared.authority,
                &cut.world, &record.receipt.accepted.operation_id).await?;
        }
        super::recover_stage_cleanup(shared, &source, &cut.world).await?;
        quiescent(&source, &source_resources, &cut.world).await?;
        running(shared)?;
        if state.completion.is_none() {
            let locator = shared.locator.as_ref().map_err(Clone::clone)?;
            state.completion = Some(match input.action {
                TransferAction::Resume => {
                    let transferred = migration::transfer_storage(&shared.authority, &source, &source_resources.content,
                        &source_resources.inventory, &shared.live, state.drained.as_ref().expect("drained transfer"),
                        &target, locator.as_ref(), cut.clone(), &shared.cancellation).await?;
                    Completion::Target { activation: Arc::new(transferred.activation), retirement: Arc::new(transferred.retirement) }
                }
                TransferAction::Abort => Completion::Source(Arc::new(migration::abort_storage_transfer(
                    &shared.authority, &source, &target, locator.as_ref(), cut,
                ).await?)),
            });
        }
        let drained = state.drained.as_ref().expect("drained transfer");
        state.hydration = Some(match state.completion.as_ref().expect("original transfer completion") {
            Completion::Target { activation, retirement } => {
                if !matches!(input.action, TransferAction::Resume) { return Err(conflict(&cut.transfer_id)); }
                shared.live.hydrate_transfer_target(drained, activation.clone(), retirement.clone())?
            }
            Completion::Source(resumed) => {
                if !matches!(input.action, TransferAction::Abort) { return Err(conflict(&cut.transfer_id)); }
                shared.live.hydrate_transfer_source(drained, resumed.clone())?
            }
        });
    }
    let hydration = state.hydration.as_ref().expect("original transfer hydration").clone();
    let activated = hydration.storage_id() == cut.target_storage_id;
    if activated != matches!(input.action, TransferAction::Resume) { return Err(conflict(&cut.transfer_id)); }
    let current = shared.stores.open(hydration.storage_id()).await?;
    let current_resources = resources(shared, &current, &cut.world)?;
    if !state.published {
        running(shared)?;
        if state.prepared.is_none() {
            state.prepared = Some(current_resources.bindings.prepare_transfer(&hydration, &current_resources.inventory,
                &current_resources.preparation, &shared.cancellation, deadline).await?);
        }
        running(shared)?;
        let prepared = state.prepared.as_ref().expect("retained transfer preparation").clone();
        if let Err(error) = current_resources.bindings.publish_transferred(&hydration, &prepared, &current_resources.inventory).await {
            state.prepared = None;
            return Err(error.into());
        }
        state.published = true;
    }
    running(shared)?;
    recover_retirements(shared, &current, &current_resources, &cut.world, deadline).await?;
    running(shared)?;
    if !shared.live.transfer_applied(cut) { return Err(conflict(&cut.transfer_id)); }
    let outcome = StorageTransferOutcome { cut: cut.clone(), status: if activated { TransferStatus::Activated } else { TransferStatus::Aborted },
        writer_epoch: hydration.writer_epoch() };
    drop(state);
    let mut held = source_resources.transfer.lock().await;
    if held.as_ref().is_some_and(|held| Arc::ptr_eq(held, &pending)) { *held = None; }
    Ok(outcome)
}

async fn applied_outcome(shared: &Shared, source: &WorldStore, input: &StorageTransferRequest) -> Result<StorageTransferOutcome, Error> {
    let cut = &input.cut;
    let source_state = source.read_transfer(cut).await?;
    let target = shared.stores.open(&cut.target_storage_id).await?;
    let target_state = target.read_transfer(cut).await?;
    let locator = shared.locator.as_ref().map_err(Clone::clone)?.read(&cut.world).await?
        .ok_or_else(|| conflict(&cut.transfer_id))?;
    let (status, storage, epoch) = match input.action {
        TransferAction::Resume if source_state.phase == crate::store::TransferPhase::Retired
            && target_state.phase == crate::store::TransferPhase::Activated =>
            (TransferStatus::Activated, &cut.target_storage_id, cut.target_epoch),
        TransferAction::Abort if source_state.phase == crate::store::TransferPhase::Aborted
            && target_state.phase == crate::store::TransferPhase::Aborted =>
            (TransferStatus::Aborted, &cut.source_storage_id, source_state.writer_epoch),
        _ => return Err(conflict(&cut.transfer_id)),
    };
    if locator.world != cut.world || locator.storage_id != *storage || locator.writer_epoch != epoch
        || locator.transfer_id.as_ref() != Some(&cut.transfer_id) || !shared.live.transfer_applied(cut) {
        return Err(conflict(&cut.transfer_id));
    }
    running(shared)?;
    Ok(StorageTransferOutcome { cut: cut.clone(), status, writer_epoch: epoch })
}

async fn quiescent(store: &WorldStore, resources: &Resources, world: &WorldRef) -> Result<(), Error> {
    if store.pending_commits().iter().any(|pending| &pending.world == world) {
        return Err(retained("world.transfer_commit_retained", "原提交结果仍待确认，未开始复制。"));
    }
    if resources.model_calls.has_pending() {
        return Err(retained("world.transfer_generation_retained", "模型输出或清理仍待确认，未开始复制。"));
    }
    if resources.archive.has_any_pending() || resources.releases.has_any_pending() || resources.actions.has_any_pending() {
        return Err(retained("world.transfer_cleanup_retained", "原业务仍持有清理或效果资源，未开始复制。"));
    }
    if crate::generation::has_unsettled_world(store, world).await? {
        return Err(retained("world.transfer_generation_unresolved", "原模型调用尚未确认，未开始复制。"));
    }
    if crate::evaluation::has_unsettled_world(store, world).await? {
        return Err(retained("world.transfer_evaluation_unresolved", "原评测尚未结算，未开始复制。"));
    }
    if crate::actions::has_unsettled_world(store, world).await? {
        return Err(retained("world.transfer_effect_unresolved", "原外部效果尚未确认，未开始复制。"));
    }
    let inventory = super::super::recovery::load(store, world.clone()).await?;
    if inventory.operations.iter().any(|receipt| matches!(receipt.phase,
        world_protocol::operation::OperationPhase::CommitIndeterminate | world_protocol::operation::OperationPhase::EffectIndeterminate)) {
        return Err(retained("world.transfer_operation_unresolved", "原操作仍有未确认结果，未开始复制。"));
    }
    Ok(())
}

async fn recover_retirements(shared: &Shared, store: &WorldStore, resources: &Resources, world: &WorldRef, deadline: Instant) -> Result<(), Error> {
    let recovery = crate::extensions::lifecycle::load_recovery(store, world.clone()).await?;
    let mut report = crate::extensions::lifecycle::StartupReport {
        restored: Vec::new(), blocked_graphs: BTreeMap::new(), blocked_heads: recovery.blocked_heads.clone(),
        blocked_channels: recovery.blocked_channels.clone(), retained: Vec::new(), drained_retirements: Vec::new(),
        retiring: Vec::new(), blocked_retirements: BTreeMap::new(),
    };
    crate::extensions::lifecycle::recover_retirements(&shared.authority, world, &resources.bindings, &recovery, deadline, &mut report).await;
    super::record_startup(shared, world, report)
}

async fn control_store(shared: &Shared) -> Result<WorldStore, Error> {
    let mut state = shared.storage.subscribe();
    loop {
        let current = state.borrow().clone();
        match current {
            super::Storage::Ready(store) | super::Storage::Failed { store: Some(store), .. } => return Ok(store),
            super::Storage::Failed { error, store: None } => return Err(error),
            super::Storage::Initializing => state.changed().await.map_err(|_| super::closed())?,
        }
    }
}

fn running(shared: &Shared) -> Result<(), Error> {
    if shared.closing.load(Ordering::Acquire) || shared.cancellation.is_cancelled() { Err(super::closed()) } else { Ok(()) }
}

fn retained(code: &str, message: &str) -> Error {
    Error::new(code, FailureStage::Drain, message, world_protocol::api::ApiFailure::Operation(
        world_protocol::operation::OperationFailure::CleanupFailed), world_protocol::failure::Recovery::Refresh)
}

fn conflict(transfer_id: &TransferId) -> Error {
    Error::new("world.transfer_identity_conflict", FailureStage::Migrate, "只能继续原存储迁移，不能替换迁移身份或目标。",
        world_protocol::api::ApiFailure::RevisionConflict, world_protocol::failure::Recovery::ReadTransfer { transfer_id: transfer_id.clone() })
}

fn recoverable(cut: &TransferCut, error: Error) -> Error {
    use world_protocol::{api::ApiFailure, commit::CommitFailure, failure::Recovery, operation::OperationFailure};
    if error.unresolved_phase().is_some() || matches!(&error.safe_failure().details,
        ApiFailure::Operation(OperationFailure::Commit(CommitFailure::TransferIndeterminate { .. }))) {
        Error::from(crate::store::StoreError::new(CommitFailure::TransferIndeterminate { transfer_id: cut.transfer_id.clone() },
            error.safe_failure().stage)).with_related(error)
    } else {
        error.with_recovery(Recovery::ReadTransfer { transfer_id: cut.transfer_id.clone() })
    }
}

impl WorldHandle {
    pub async fn prepare_storage_transfer(
        &self, root: &Arc<AuthorityRoot>, input: StorageTransferPrepare,
    ) -> Result<StorageTransferRequest, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&input.world)?;
        let (reply, response) = tokio::sync::oneshot::channel();
        self.mailbox.command(Command::PrepareTransfer { input, reply }).await
            .map_err(|_| super::closed())?;
        response.await.map_err(|cause| Error::internal(FailureStage::Migrate).caused(cause))?
    }

    pub async fn transfer_storage(
        &self, root: &Arc<AuthorityRoot>, input: StorageTransferRequest,
    ) -> Result<StorageTransferOutcome, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&input.cut.world)?;
        let (reply, response) = tokio::sync::oneshot::channel();
        self.mailbox.command(Command::Transfer { input, target: self.clone(), reply }).await
            .map_err(|_| super::closed())?;
        response.await.map_err(|cause| Error::internal(FailureStage::Migrate).caused(cause))?
    }
}
