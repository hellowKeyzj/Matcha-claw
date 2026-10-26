use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    commit::CommitFailure,
    failure::{Failure, FailureStage},
    generation::GenerationReceipt,
    ids::{CommitId, Digest, ModelCallId, RunId, WorldRef},
    operation::OperationFailure,
    time::DurationMs,
};

use super::{
    RecordedGeneration,
    error::codec,
    ledger::{self, PreparedCall},
    run::{
        check_request_output, complete_usage, confirm_dispatch, empty_usage, hash, output_usage,
        read_terminal, reservation_error, settle_usage,
    },
};
use crate::{
    authorization::{Admission, AuthorityRoot},
    content::{Content, ContentOwner, PreparedBlob, StageCleanupOutcome, StagedCommit},
    extensions::invocation::CallBudget,
    owner::{Error, RunRecord},
    store::{CommitRequest, Committed, StoreError, StoreFuture, TransactionError, WorldStore, WorldTransaction},
};

/// Live capabilities only. Canonical model-call state remains in the existing commit ledger.
#[derive(Default)]
pub(crate) struct GenerationRecovery {
    execution: Mutex<BTreeMap<ModelCallId, Weak<tokio::sync::Mutex<()>>>>,
    pending: Mutex<BTreeMap<ModelCallId, Arc<Pending>>>,
}

/// Proof of original generation settlement only, never output or workflow-return authority.
#[derive(Clone)]
pub(crate) struct SettledRunGeneration {
    storage_id: String,
    root: usize,
    run: RunRecord,
    calls: Vec<(ModelCallId, Digest)>,
    stages: Digest,
}

const SETTLED_CALLS: &str = "SELECT m.model_call_id,m.input_digest,m.request,m.receipt,m.status,c.receipt AS finish_receipt,c.result AS finish_result,c.input_digest AS finish_digest FROM world_model_call m LEFT JOIN world_commit_receipt c ON c.tenant_id=m.tenant_id AND c.world_id=m.world_id AND c.commit_id='model-' || m.model_call_id || '-finish' WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.run_id=$3 ORDER BY m.model_call_id";
const LIVE_MODEL_PINS: &str = "SELECT 1 FROM world_blob_pin p JOIN world_model_call m ON m.tenant_id=p.tenant_id AND m.world_id=p.world_id AND p.pin_id LIKE 'model-' || m.model_call_id || '-%' WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.run_id=$3 AND p.kind='recovery' AND p.released_at IS NULL LIMIT 1";
const MODEL_STAGES: &str = "SELECT c.commit_id,c.input_digest,c.receipt,c.result FROM world_commit_receipt c JOIN world_model_call m ON m.tenant_id=c.tenant_id AND m.world_id=c.world_id AND c.commit_id LIKE 'model-' || m.model_call_id || '-stage-%' WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.run_id=$3 ORDER BY c.commit_id";

fn stage_digest(rows: Vec<tokio_postgres::Row>) -> Result<Digest, Error> {
    let stages = rows.into_iter().map(|row| (
        row.get::<_, String>("commit_id"), row.get::<_, String>("input_digest"),
        row.get::<_, Option<serde_json::Value>>("receipt"), row.get::<_, Option<serde_json::Value>>("result"),
    )).collect::<Vec<_>>();
    hash(&stages)
}

impl SettledRunGeneration {
    async fn validate_inner(
        &self,
        tx: &WorldTransaction<'_>,
        recovery: &GenerationRecovery,
        root: &AuthorityRoot,
    ) -> Result<(), Error> {
        if self.root != root as *const AuthorityRoot as usize || tx.world() != &self.run.operation.world
            || recovery.has_pending_run(&self.run.id)
        {
            return Err(Error::internal(FailureStage::Recover));
        }
        let storage = tx.query_opt(
            "SELECT storage_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
        ).await?.ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let current = crate::owner::read_run(tx, &self.run.id).await?;
        if storage.get::<_, String>("storage_id") != self.storage_id
            || hash(&current)? != hash(&self.run)?
            || tx.query_opt(LIVE_MODEL_PINS, &[
                &tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &self.run.id.as_str(),
            ]).await?.is_some()
        {
            return Err(Error::internal(FailureStage::Recover));
        }
        let rows = tx.query(SETTLED_CALLS, &[
            &tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &self.run.id.as_str(),
        ]).await?;
        if stage_digest(tx.query(MODEL_STAGES, &[
            &tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &self.run.id.as_str(),
        ]).await?)? != self.stages {
            return Err(Error::internal(FailureStage::Recover));
        }
        validate_settled_calls(&self.run, &self.calls, rows)
    }

    pub(crate) async fn validate(
        &self,
        tx: &WorldTransaction<'_>,
        recovery: &GenerationRecovery,
        root: &AuthorityRoot,
    ) -> Result<(), Error> {
        self.validate_inner(tx, recovery, root).await.map_err(settlement_error)
    }
}

#[derive(Clone)]
pub(super) struct Pending {
    pub plan: Plan,
    pub call: PreparedCall,
    pub observed: Observed,
    pub primary: Option<Error>,
    pub output: Option<Arc<PreparedBlob>>,
    pub stage: Option<(CommitRequest, StagedCommit)>,
    pub attempt: u32,
}

impl GenerationRecovery {
    pub(crate) fn has_pending(&self) -> bool {
        !self
            .pending
            .lock()
            .expect("generation custody poisoned")
            .is_empty()
    }

    pub(crate) fn has_pending_run(&self, run: &RunId) -> bool {
        self.pending
            .lock()
            .expect("generation custody poisoned")
            .values()
            .any(|pending| &pending.call.input.request.run_id == run)
    }

    pub(super) fn execution(&self, id: &ModelCallId) -> Arc<tokio::sync::Mutex<()>> {
        let mut execution = self
            .execution
            .lock()
            .expect("generation execution poisoned");
        execution.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = execution.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        execution.insert(id.clone(), Arc::downgrade(&lock));
        lock
    }

    pub(super) fn get(&self, id: &ModelCallId) -> Option<Arc<Pending>> {
        self.pending
            .lock()
            .expect("generation custody poisoned")
            .get(id)
            .cloned()
    }

    pub(super) fn retain(&self, pending: Pending) -> Arc<Pending> {
        let pending = Arc::new(pending);
        self.pending
            .lock()
            .expect("generation custody poisoned")
            .insert(pending.call.id.clone(), pending.clone());
        pending
    }

    pub(super) fn remove(&self, id: &ModelCallId) {
        self.pending
            .lock()
            .expect("generation custody poisoned")
            .remove(id);
    }
}

/// Original business requests live in the existing commit ledger, not in a second call store.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Plan {
    pub prepare: CommitRequest,
    pub dispatch: CommitRequest,
    pub observed: CommitRequest,
    pub finish: CommitRequest,
    pub failed: CommitRequest,
    stage: CommitRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Observed {
    pub receipt: Option<GenerationReceipt>,
    pub raw_receipt: Option<GenerationReceipt>,
    pub failure: Option<Failure<OperationFailure>>,
}

impl Plan {
    pub(super) fn allowance(&self, id: &ModelCallId) -> Result<CommitRequest, Error> {
        let mut request = self.dispatch.clone();
        request.commit_id = commit_id(id, "allowance")?;
        Ok(request)
    }

    fn chunk(&self, index: usize) -> Result<CommitRequest, Error> {
        let mut request = self.observed.clone();
        request.commit_id =
            CommitId::try_new(format!("{}-chunk-{index}", request.commit_id.as_str()))
                .map_err(codec)?;
        Ok(request)
    }

    pub(super) fn stage(&self, attempt: u32) -> Result<CommitRequest, Error> {
        let mut request = self.stage.clone();
        request.commit_id = CommitId::try_new(format!("{}-{attempt}", request.commit_id.as_str()))
            .map_err(codec)?;
        Ok(request)
    }

    pub(super) fn validate(
        &self,
        world: &WorldRef,
        id: &ModelCallId,
        digest: &Digest,
    ) -> Result<(), Error> {
        for (request, phase) in [
            (&self.prepare, "prepare"),
            (&self.dispatch, "dispatch"),
            (&self.observed, "observed"),
            (&self.finish, "finish"),
            (&self.failed, "prepare-failed"),
            (&self.stage, "stage"),
        ] {
            if request.world != *world
                || request.commit_id != commit_id(id, phase)?
                || request.input_digest != *digest
            {
                return Err(ledger::conflict(id));
            }
            request.clone().prepare()?;
        }
        Ok(())
    }
}

pub(super) fn commit_id(id: &ModelCallId, phase: &str) -> Result<CommitId, Error> {
    CommitId::try_new(format!("model-{}-{phase}", id.as_str())).map_err(codec)
}

pub(super) async fn plan(
    store: &WorldStore,
    world: &WorldRef,
    id: &ModelCallId,
    digest: &Digest,
) -> Result<Plan, Error> {
    let plan_id = commit_id(id, "plan")?;
    if let Some(saved) = store
        .read_commit_optional::<Plan>(world, &plan_id, digest)
        .await?
    {
        saved.value.validate(world, id, digest)?;
        return Ok(saved.value);
    }
    let (storage_epoch, fences) = store
        .snapshot(world.clone(), |snapshot| {
            Box::pin(async move {
                crate::owner::writer_fences(snapshot, &["content", "generation", "operation"]).await
            })
        })
        .await?;
    let request = |phase| -> Result<CommitRequest, Error> {
        Ok(CommitRequest {
            world: world.clone(),
            commit_id: commit_id(id, phase)?,
            input_digest: digest.clone(),
            storage_epoch,
            fences: fences.clone(),
            watch_basis: Vec::new(),
        })
    };
    let plan = Plan {
        prepare: request("prepare")?,
        dispatch: request("dispatch")?,
        observed: request("observed")?,
        finish: request("finish")?,
        failed: request("prepare-failed")?,
        stage: request("stage")?,
    };
    let batch = request("plan")?.prepare()?;
    let saved = store
        .transact(batch, move |_| {
            Box::pin(async move { Ok::<_, Error>(plan) })
        })
        .await
        .map_err(Error::from)?;
    saved.value.validate(world, id, digest)?;
    Ok(saved.value)
}

const CHUNK_BYTES: usize = 256 * 1024;
const MAX_CHUNKS: usize = 32_768;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationHeader {
    bytes: u64,
    digest: Digest,
    chunks: Vec<Digest>,
}

fn digest(bytes: &[u8]) -> Digest {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("SHA256 digest syntax")
}

pub(super) async fn save_observed(
    store: &WorldStore,
    plan: &Plan,
    observed: &Observed,
) -> Result<(), Error> {
    let bytes = serde_json::to_vec(observed).map_err(codec)?;
    let count = bytes.len().div_ceil(CHUNK_BYTES);
    if count == 0 || count > MAX_CHUNKS {
        return Err(Error::from(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Recover,
        )));
    }
    let mut chunks = Vec::with_capacity(count);
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        let expected = digest(chunk);
        let saved = chunk.to_vec();
        let original = store
            .transact(plan.chunk(index)?.prepare()?, move |_| {
                Box::pin(async move { Ok::<_, Error>(saved) })
            })
            .await
            .map_err(Error::from)?;
        if original.value.len() != chunk.len() || digest(&original.value) != expected {
            return Err(Error::from(StoreError::new(
                CommitFailure::CommitIdPayloadConflict {
                    commit_id: plan.chunk(index)?.commit_id,
                },
                FailureStage::Recover,
            )));
        }
        chunks.push(expected);
    }
    let header = ObservationHeader {
        bytes: bytes.len() as u64,
        digest: digest(&bytes),
        chunks,
    };
    let original = store
        .transact(plan.observed.clone().prepare()?, move |_| {
            Box::pin(async move { Ok::<_, Error>(header) })
        })
        .await
        .map_err(Error::from)?;
    if original.value.bytes != bytes.len() as u64 || original.value.digest != digest(&bytes) {
        return Err(Error::from(StoreError::new(
            CommitFailure::CommitIdPayloadConflict {
                commit_id: plan.observed.commit_id.clone(),
            },
            FailureStage::Recover,
        )));
    }
    Ok(())
}

pub(super) async fn read_observed(
    store: &WorldStore,
    plan: &Plan,
) -> Result<Option<Observed>, Error> {
    let Some(saved) = read::<ObservationHeader>(store, &plan.observed).await? else {
        return Ok(None);
    };
    let header = saved.value;
    let maximum = usize::try_from(header.bytes).map_err(codec)?;
    let invalid = || {
        Error::from(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Recover,
        ))
    };
    if maximum == 0
        || header.chunks.is_empty()
        || header.chunks.len() > MAX_CHUNKS
        || maximum.div_ceil(CHUNK_BYTES) != header.chunks.len()
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    for (index, expected) in header.chunks.iter().enumerate() {
        let chunk = read::<Vec<u8>>(store, &plan.chunk(index)?)
            .await?
            .ok_or_else(invalid)?
            .value;
        let expected_size = CHUNK_BYTES.min(maximum - bytes.len());
        if chunk.len() != expected_size || digest(&chunk) != *expected {
            return Err(invalid());
        }
        bytes.try_reserve(chunk.len()).map_err(codec)?;
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != maximum || digest(&bytes) != header.digest {
        return Err(invalid());
    }
    world_protocol::wire::decode(&bytes, maximum)
        .map(Some)
        .map_err(codec)
}

pub(super) async fn read<T: DeserializeOwned>(
    store: &WorldStore,
    request: &CommitRequest,
) -> Result<Option<Committed<T>>, Error> {
    store
        .read_commit_optional(&request.world, &request.commit_id, &request.input_digest)
        .await
        .map_err(Into::into)
}

/// Absence is not abort proof: the original unique reservation waits out every earlier attempt.
pub(super) async fn resolve<T: Serialize + DeserializeOwned + Send>(
    store: &WorldStore,
    request: &CommitRequest,
) -> Result<Committed<T>, TransactionError<Error>> {
    match read(store, request).await {
        Ok(Some(committed)) => return Ok(committed),
        Ok(None) => {}
        Err(error) => return Err(uncertain(request, error)),
    }
    let batch = request
        .clone()
        .prepare()
        .map_err(|error| uncertain(request, error))?;
    store
        .transact(batch, |_| {
            Box::pin(async {
                Err(Error::from(StoreError::new(
                    CommitFailure::RolledBack,
                    FailureStage::Recover,
                )))
            })
        })
        .await
}

fn uncertain(
    request: &CommitRequest,
    cause: impl std::error::Error + Send + Sync + 'static,
) -> TransactionError<Error> {
    TransactionError::Indeterminate(StoreError::caused_by(
        CommitFailure::CommitIndeterminate {
            commit_id: request.commit_id.clone(),
        },
        FailureStage::Recover,
        cause,
    ))
}

fn settlement_error(error: Error) -> Error {
    let mut failure = match error.operation_failure() {
        Some(failure) => failure,
        None => return Error::internal(FailureStage::Recover),
    };
    // Keep safe typed reasons, but never related errors, private causes or output references.
    match &mut failure.details {
        OperationFailure::Generation(generation) => generation.receipt = None,
        OperationFailure::Material(_) | OperationFailure::Commit(_)
        | OperationFailure::BudgetExceeded { .. } | OperationFailure::Authorization(_)
        | OperationFailure::RevisionConflict | OperationFailure::InternalFault
        | OperationFailure::Cancelled | OperationFailure::CleanupFailed => {}
        _ => failure.details = OperationFailure::DetailsWithheld,
    }
    Error::from(failure)
}

async fn settle_run(
    store: &WorldStore,
    recovery: &GenerationRecovery,
    authority: &AuthorityRoot,
    world: &WorldRef,
    run: &RunId,
    content: Arc<Content>,
) -> Result<SettledRunGeneration, Error> {
    if content.world() != world {
        return Err(Error::internal(FailureStage::Recover));
    }
    let saved_run = run.clone();
    let (original, calls) = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let row = snapshot.query_opt(
            "SELECT body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str()],
        ).await?.ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let original: RunRecord = serde_json::from_value(row.get("body")).map_err(codec)?;
        let rows = snapshot.query(
            "SELECT model_call_id,input_digest FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 ORDER BY model_call_id",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str()],
        ).await?;
        let calls = rows.into_iter().map(|row| Ok::<_, Error>((
            ModelCallId::try_new(row.get::<_, String>("model_call_id")).map_err(codec)?,
            Digest::try_new(row.get::<_, String>("input_digest")).map_err(codec)?,
        ))).collect::<Result<Vec<_>, Error>>()?;
        Ok::<_, Error>((original, calls))
    })).await?;
    if original.id != *run || original.operation.world != *world || calls.is_empty() {
        return Err(Error::internal(FailureStage::Recover));
    }
    let mut unresolved = None;
    for (id, digest) in &calls {
        let outcome = async {
            let execution = recovery.execution(id);
            let _execution = execution.lock().await;
            let plan = store.read_commit_optional::<Plan>(world, &commit_id(id, "plan")?, digest)
                .await?.ok_or_else(|| ledger::indeterminate(id))?.value;
            plan.validate(world, id, digest)?;
            let prepared = read::<PreparedCall>(store, &plan.prepare).await?
                .ok_or_else(|| ledger::indeterminate(id))?;
            let call = prepared.value;
            if call.id != *id || call.input.request.world != *world || call.run() != run
                || hash(&(&call.input.request, &call.input.sources, &call.input.model, &call.input.descriptor_digest))? != *digest
            {
                return Err(ledger::conflict(id));
            }
            call.recovery_pins(world, run)?;
            resolve::<()>(store, &plan.dispatch).await.map_err(Error::from)?;
            read_allowance(store, &plan, &call).await?;
            let pending = match recovery.get(id) {
                Some(pending) => {
                    if hash(&pending.call)? != hash(&call)? || hash(&pending.plan)? != hash(&plan)? {
                        return Err(ledger::conflict(id));
                    }
                    pending
                }
                None => {
                    let observed = read_observed(store, &plan).await?
                        .ok_or_else(|| ledger::indeterminate(id))?;
                    recovery.retain(Pending {
                        plan: plan.clone(), call, observed, primary: None,
                        output: None, stage: None, attempt: 0,
                    })
                }
            };
            let covered = pending.observed.raw_receipt.as_ref().is_some_and(complete_usage);
            settle_observation(store, recovery, None, original.usage.elapsed, &content, pending).await?;
            if !covered {
                return Err(super::error::rejected(
                    world_protocol::generation::GenerationStage::Output,
                    world_protocol::generation::GenerationFailureKind::InvalidOutput,
                ));
            }
            Ok::<_, Error>(())
        }.await;
        if let Err(error) = outcome {
            unresolved.get_or_insert(error);
        }
    }
    if let Some(error) = unresolved {
        return Err(error);
    }
    let saved_run = run.clone();
    let (checkpoints, cleaned_stages) = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let rows = snapshot.query(MODEL_STAGES, &[
            &snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str(),
        ]).await?;
        let checkpoints = rows.iter().map(|row| (
            row.get::<_, String>("commit_id"), row.get::<_, String>("input_digest"),
        )).collect::<Vec<_>>();
        Ok::<_, Error>((checkpoints, stage_digest(rows)?))
    })).await?;
    for (checkpoint, digest) in checkpoints {
        let (id, expected) = calls.iter().find(|(id, _)| checkpoint.starts_with(&format!("model-{}-stage-", id.as_str())))
            .ok_or_else(|| Error::internal(FailureStage::Recover))?;
        if digest != expected.as_str() { return Err(ledger::conflict(id)); }
        let attempt = checkpoint.strip_prefix(&format!("model-{}-stage-", id.as_str()))
            .ok_or_else(|| ledger::conflict(id))?.parse::<u32>().map_err(codec)?;
        let plan = store.read_commit_optional::<Plan>(world, &commit_id(id, "plan")?, expected)
            .await?.ok_or_else(|| ledger::indeterminate(id))?.value;
        plan.validate(world, id, expected)?;
        let request = plan.stage(attempt)?;
        if request.commit_id.as_str() != checkpoint { return Err(ledger::conflict(id)); }
        let stage = read::<StagedCommit>(store, &request).await?.ok_or_else(|| ledger::indeterminate(id))?;
        let cleanup = content.discard_checkpoint_stages(store, &request, &stage).await?;
        require_local_cleanup(cleanup, None, id)?;
    }
    let saved_run = run.clone();
    let expected_calls = calls.clone();
    let (current, stages) = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let row = snapshot.query_opt(
            "SELECT body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str()],
        ).await?.ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let current: RunRecord = serde_json::from_value(row.get("body")).map_err(codec)?;
        let rows = snapshot.query(SETTLED_CALLS, &[
            &snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str(),
        ]).await?;
        validate_settled_calls(&current, &expected_calls, rows)?;
        if snapshot.query_opt(LIVE_MODEL_PINS, &[
            &snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str(),
        ]).await?.is_some() {
            return Err(Error::internal(FailureStage::Recover));
        }
        let stages = stage_digest(snapshot.query(MODEL_STAGES, &[
            &snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &saved_run.as_str(),
        ]).await?)?;
        Ok::<_, Error>((current, stages))
    })).await?;
    if current.id != *run || current.operation != original.operation || recovery.has_pending_run(run)
        || stages != cleaned_stages
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    Ok(SettledRunGeneration {
        storage_id: store.identity_receipt().storage_id().to_owned(),
        root: authority as *const AuthorityRoot as usize,
        run: current,
        calls,
        stages,
    })
}

fn validate_settled_calls(
    run: &RunRecord,
    expected: &[(ModelCallId, Digest)],
    rows: Vec<tokio_postgres::Row>,
) -> Result<(), Error> {
    if expected.is_empty() || rows.len() != expected.len() {
        return Err(Error::internal(FailureStage::Recover));
    }
    let mut observed = empty_usage();
    for ((id, digest), row) in expected.iter().zip(rows) {
        let input: ledger::LedgerInput = serde_json::from_value(row.get("request")).map_err(codec)?;
        let receipt: GenerationReceipt = row.get::<_, Option<serde_json::Value>>("receipt")
            .map(serde_json::from_value).transpose().map_err(codec)?
            .ok_or_else(|| ledger::indeterminate(id))?;
        let finish: world_protocol::commit::CommitReceipt = row.get::<_, Option<serde_json::Value>>("finish_receipt")
            .map(serde_json::from_value).transpose().map_err(codec)?
            .ok_or_else(|| ledger::indeterminate(id))?;
        if row.get::<_, String>("model_call_id") != id.as_str()
            || row.get::<_, String>("input_digest") != digest.as_str()
            || row.get::<_, Option<String>>("finish_digest").as_deref() != Some(digest.as_str())
            || row.get::<_, Option<serde_json::Value>>("finish_result") != Some(serde_json::Value::Null)
            || finish.world != run.operation.world || finish.commit_id != commit_id(id, "finish")?
            || !matches!(row.get::<_, String>("status").as_str(), "completed" | "failed")
            || input.request.world != run.operation.world || input.request.run_id != run.id
            || input.request.binding != input.model.reference
            || hash(&(&input.request, &input.sources, &input.model, &input.descriptor_digest))? != *digest
        {
            return Err(ledger::indeterminate(id));
        }
        if !complete_usage(&receipt) {
            return Err(super::error::rejected(
                world_protocol::generation::GenerationStage::Output,
                world_protocol::generation::GenerationFailureKind::InvalidOutput,
            ));
        }
        ledger::validate_receipt(&input.request, &receipt, id)?;
        let usage = output_usage(&receipt);
        observed.bytes = observed.bytes.checked_add(usage.bytes).ok_or_else(|| ledger::conflict(id))?;
        observed.input_tokens = observed.input_tokens.checked_add(usage.input_tokens).ok_or_else(|| ledger::conflict(id))?;
        observed.output_tokens = observed.output_tokens.checked_add(usage.output_tokens).ok_or_else(|| ledger::conflict(id))?;
    }
    if observed.bytes > run.usage.bytes || observed.input_tokens > run.usage.input_tokens
        || observed.output_tokens > run.usage.output_tokens || run.usage.model_calls < expected.len() as u64
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    Ok(())
}

async fn read_allowance(
    store: &WorldStore,
    plan: &Plan,
    call: &PreparedCall,
) -> Result<world_protocol::budget::Usage, Error> {
    let allowance = read::<world_protocol::budget::Usage>(store, &plan.allowance(&call.id)?).await?
        .ok_or_else(|| ledger::indeterminate(&call.id))?.value;
    super::run::validate_allowance(&call.id, &call.input, &allowance)?;
    Ok(allowance)
}

async fn check_allowance(
    store: &WorldStore,
    plan: &Plan,
    call: &PreparedCall,
    receipt: &GenerationReceipt,
) -> Result<(), Error> {
    let allowance = read_allowance(store, plan, call).await?;
    let usage = output_usage(receipt);
    for (dimension, used, maximum) in [
        (world_protocol::budget::BudgetDimension::Bytes, usage.bytes, allowance.bytes),
        (world_protocol::budget::BudgetDimension::InputTokens, usage.input_tokens, allowance.input_tokens),
        (world_protocol::budget::BudgetDimension::OutputTokens, usage.output_tokens, allowance.output_tokens),
    ] {
        if used > maximum {
            return Err(Error::from_host_failure(
                world_protocol::process::HostFailure::BudgetExceeded { dimension }, FailureStage::Recover,
            ));
        }
    }
    Ok(())
}

pub(crate) async fn settle_observed_run(
    store: &WorldStore,
    recovery: &GenerationRecovery,
    authority: &AuthorityRoot,
    world: &WorldRef,
    run: &RunId,
    content: Arc<Content>,
) -> Result<SettledRunGeneration, Error> {
    settle_run(store, recovery, authority, world, run, content)
        .await
        .map_err(settlement_error)
}

pub(super) fn settle_observed<'a>(
    store: &'a WorldStore,
    recovery: &'a GenerationRecovery,
    admission: &'a Admission,
    budget: &'a CallBudget,
    content: &'a Arc<Content>,
    pending: Arc<Pending>,
) -> StoreFuture<'a, RecordedGeneration, Error> {
    Box::pin(async move {
        settle_observation(store, recovery, Some(budget), budget.usage().elapsed, content, pending.clone()).await?;
        // Settlement never grants delivery; even a paid error receipt needs fresh output authority.
        let outcome = read_terminal(
            store,
            admission,
            &pending.call.id,
            &pending.plan.finish.input_digest,
        )
        .await?
        .unwrap_or_else(|| Err(ledger::indeterminate(&pending.call.id)));
        match (outcome, &pending.primary) {
            (Err(error), Some(primary)) => Err(error.with_related(primary.clone())),
            (outcome, _) => outcome,
        }
    })
}

async fn settle_observation(
    store: &WorldStore,
    recovery: &GenerationRecovery,
    budget: Option<&CallBudget>,
    elapsed: DurationMs,
    content: &Arc<Content>,
    pending: Arc<Pending>,
) -> Result<(), Error> {
    let plan = &pending.plan;
    let call = &pending.call;
    if let Some(receipt) = &pending.observed.receipt {
        ledger::validate_receipt(&call.input.request, receipt, &call.id)?;
    }
    save_observed(store, plan, &pending.observed)
        .await
        .map_err(|error| pending_error(error, &pending))?;
    let dispatch_error = budget.and_then(|budget| confirm_dispatch(budget, &plan.dispatch.commit_id).err());
    if read::<()>(store, &plan.finish).await?.is_some() {
        return finish_observed(store, recovery, budget, content, &pending).await;
    }
    if let (Some(budget), Some(receipt)) = (budget, &pending.observed.raw_receipt) {
        let _ = settle_usage(budget, &call.id, &plan.finish.commit_id, receipt);
    }
    match resolve::<()>(store, &plan.finish).await {
        Ok(_) => {
            return finish_observed(store, recovery, budget, content, &pending).await;
        }
        Err(TransactionError::NotCommitted { cleanup: None, .. }) => {}
        Err(error) => return Err(pending_error(error.into(), &pending)),
    }
    let mut failure = pending.observed.failure.clone();
    if let Some(receipt) = &pending.observed.raw_receipt {
        let actual = match budget {
            Some(budget) => settle_usage(budget, &call.id, &plan.finish.commit_id, receipt),
            None => check_allowance(store, plan, call, receipt).await,
        };
        if failure.is_none() {
            failure = check_request_output(&call.input.request, receipt)
                .and(actual).as_ref().err().map(observed_failure).transpose()?;
        }
    }
    if failure.is_none() {
        failure = dispatch_error.as_ref().map(observed_failure).transpose()?;
    }
    let mut held = (*pending).clone();
    if let Some((request, stage)) = &held.stage {
        match resolve::<crate::content::StagedCommit>(store, request).await {
            Ok(committed) => {
                if hash(&committed.value)? != hash(stage)? {
                    return Err(pending_error(ledger::conflict(&call.id), &pending));
                }
                let cleanup = content
                    .discard_checkpoint_stages(store, request, &committed)
                    .await
                    .map_err(|error| pending_error(error.into(), &pending))?;
                require_local_cleanup(cleanup, budget, &call.id)?;
                held.attempt = held
                    .attempt
                    .checked_add(1)
                    .ok_or_else(|| ledger::conflict(&call.id))?;
            }
            Err(TransactionError::NotCommitted { cleanup: None, .. }) => {
                if let Some(output) = &held.output {
                    content
                        .discard_prepared(output)
                        .map_err(|error| pending_error(error.into(), &pending))?;
                }
            }
            Err(error) => return Err(pending_error(error.into(), &pending)),
        }
        held.output = None;
        held.stage = None;
        recovery.retain(held.clone());
    }
    if held.output.is_none() {
        loop {
            let request = plan.stage(held.attempt)?;
            match resolve::<crate::content::StagedCommit>(store, &request).await {
                Ok(stage) => {
                    let cleanup = content
                        .discard_checkpoint_stages(store, &request, &stage)
                        .await
                        .map_err(|error| pending_error(error.into(), &pending))?;
                    require_local_cleanup(cleanup, budget, &call.id)?;
                    held.attempt = held
                        .attempt
                        .checked_add(1)
                        .ok_or_else(|| ledger::conflict(&call.id))?;
                }
                Err(TransactionError::NotCommitted { cleanup: None, .. }) => break,
                Err(error) => return Err(pending_error(error.into(), &pending)),
            }
        }
        if let Some(receipt) = &held.observed.receipt {
            match content.prepare_blob(
                &mut receipt.text.as_bytes(),
                None,
                &CancellationToken::new(),
            ) {
                Ok(output) => held.output = Some(Arc::new(output)),
                Err(error) => return Err(pending_error(error.into(), &pending)),
            }
        }
    }
    if held.stage.is_none() {
        if let Some(output) = &held.output {
            let staged = match content.stage_commit(plan.finish.clone(), &[output.as_ref()]) {
                Ok(staged) => staged,
                Err(error) => {
                    recovery.retain(held);
                    return Err(pending_error(error.into(), &pending));
                }
            };
            held.stage = Some((plan.stage(held.attempt)?, staged));
        }
    }
    let pending = recovery.retain(held);
    if let Some((request, stage)) = &pending.stage {
        let staged = stage.clone();
        if let Err(error) = store
            .transact(request.clone().prepare()?, move |_| {
                Box::pin(async move { Ok::<_, Error>(staged) })
            })
            .await
        {
            return Err(pending_error(error.into(), &pending));
        }
    }
    let mut receipt = pending.observed.receipt.clone();
    if let Some(receipt) = &mut receipt {
        if !complete_usage(receipt) {
            receipt.state = world_protocol::generation::GenerationState::Partial;
        }
    }
    if let (Some(receipt), Some(output)) = (&mut receipt, &pending.output) {
        receipt.output = Some(output.reference().clone());
    }
    if let Some(Failure {
        details: OperationFailure::Generation(failure),
        ..
    }) = &mut failure
    {
        failure.receipt = receipt.clone().map(Box::new);
    }
    let saved = pending.call.clone();
    let output = pending.output.clone();
    let content_owner = content.clone();
    let elapsed = budget.map(|budget| budget.usage().elapsed).unwrap_or(elapsed);
    let observed_usage = pending
        .observed
        .raw_receipt
        .as_ref()
        .map(output_usage)
        .unwrap_or_else(empty_usage);
    let result = store
        .transact(plan.finish.clone().prepare()?, move |tx| {
            Box::pin(async move {
                if let Some(output) = &output {
                    content_owner
                        .retain_prepared(
                            tx,
                            output,
                            ContentOwner::Run {
                                id: saved.input.request.run_id.clone(),
                            },
                        )
                        .await?;
                }
                ledger::finish(
                    tx,
                    &saved,
                    receipt.as_ref(),
                    failure.as_ref(),
                    &observed_usage,
                    elapsed,
                )
                .await
            })
        })
        .await;
    match result {
        Ok(_) => finish_observed(store, recovery, budget, content, &pending).await,
        Err(error) => Err(pending_error(error.into(), &pending)),
    }
}

fn require_local_cleanup(
    cleanup: StageCleanupOutcome,
    budget: Option<&CallBudget>,
    id: &ModelCallId,
) -> Result<(), Error> {
    if budget.is_none() && cleanup == StageCleanupOutcome::NonLocalOwner {
        return Err(ledger::indeterminate(id));
    }
    Ok(())
}

async fn finish_observed(
    store: &WorldStore,
    recovery: &GenerationRecovery,
    budget: Option<&CallBudget>,
    content: &Content,
    pending: &Pending,
) -> Result<(), Error> {
    if let Some(budget) = budget {
        if budget.reserved_usage(&pending.plan.finish.commit_id).is_some() {
            budget
                .ack_actual(&pending.plan.finish.commit_id)
                .map_err(reservation_error)?;
        }
    }
    let mut attempt = 0u32;
    loop {
        let request = pending.plan.stage(attempt)?;
        let Some(stage) = read::<crate::content::StagedCommit>(store, &request).await? else {
            break;
        };
        let cleanup = content
            .discard_checkpoint_stages(store, &request, &stage)
            .await
            .map_err(|error| pending_error(error.into(), pending))?;
        require_local_cleanup(cleanup, budget, &pending.call.id)?;
        attempt = attempt
            .checked_add(1)
            .ok_or_else(|| ledger::conflict(&pending.call.id))?;
    }
    let prepared = read::<PreparedCall>(store, &pending.plan.prepare)
        .await?
        .ok_or_else(|| ledger::conflict(&pending.call.id))?;
    store
        .release_generation_pins(&pending.plan.prepare, &prepared)
        .await
        .map_err(|error| pending_error(pin_release_error(error), pending))?;
    recovery.remove(&pending.call.id);
    Ok(())
}

pub(super) fn pin_release_error(error: TransactionError<crate::store::StoreError>) -> Error {
    match error {
        TransactionError::Indeterminate(error) => error.into(),
        TransactionError::NotCommitted { error, cleanup } => {
            let primary = Error::from(error);
            match cleanup {
                Some(cleanup) => primary.with_related(cleanup.into()),
                None => primary,
            }
        }
    }
}

pub(super) fn observed_failure(error: &Error) -> Result<Failure<OperationFailure>, Error> {
    use world_protocol::operation::OperationPhase;
    let mut selected = error.operation_failure().ok_or_else(|| error.clone())?;
    let rank = |failure: &OperationFailure| match crate::owner::unresolved_failure_phase(failure) {
        Some(OperationPhase::CommitIndeterminate) => 3,
        Some(OperationPhase::EffectIndeterminate) => 2,
        Some(_) => 1,
        None => 0,
    };
    let mut pending = vec![error];
    while let Some(error) = pending.pop() {
        let failures = error.operation_failure().into_iter().chain(
            error
                .cleanup_errors()
                .filter_map(|cleanup| Error::from(cleanup.clone()).operation_failure()),
        );
        for failure in failures {
            if rank(&failure.details) > rank(&selected.details) {
                selected = failure;
            }
        }
        pending.extend(error.related_errors());
    }
    Ok(selected)
}

fn pending_error(error: Error, pending: &Pending) -> Error {
    let error = match error.operation_failure() {
        Some(mut failure) if matches!(&failure.details, OperationFailure::Generation(failure) if failure.receipt.is_some()) =>
        {
            if let OperationFailure::Generation(generation) = &mut failure.details {
                generation.receipt = None;
            }
            Error::from(failure).with_related(error)
        }
        _ => error,
    };
    match &pending.primary {
        Some(primary) => error.with_related(primary.clone()),
        None => error,
    }
}
