use std::{
    collections::HashMap,
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{
    DriverCustody, StorageIdentity, StorageIdentityReceipt, StoreError, schema,
    transaction::{
        CommitRequest, Committed, PreparedBatch, StoreFuture, TransactionError, WorldSnapshot,
        WorldTransaction, decode_committed, encode_result,
    },
};
use deadpool_postgres::{Pool, PoolError};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::Notify;
use world_protocol::{
    commit::{CommitFailure, CommitReceipt},
    failure::FailureStage,
    ids::{CommitId, Digest, ResourceRef, WorldRef, WriterEpoch},
};

#[derive(Clone, Copy, Debug)]
pub struct StoreLimits {
    pub acquire_timeout: Duration,
    pub statement_timeout: Duration,
    pub transaction_timeout: Duration,
    pub close_timeout: Duration,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingCommit {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub input_digest: Digest,
    pub storage_epoch: WriterEpoch,
    pub fences: Vec<world_protocol::commit::WriteFence>,
}
enum CommitPhase {
    Committing(Arc<()>),
    Indeterminate,
}
struct CommitCustody {
    pending: PendingCommit,
    phase: CommitPhase,
}
struct Admission {
    closing: bool,
    active: usize,
    commits: HashMap<(WorldRef, CommitId), CommitCustody>,
}
pub(super) struct StoreInner {
    pub(super) pool: Pool,
    pub(super) limits: StoreLimits,
    pub(super) identity: StorageIdentityReceipt,
    drivers: DriverCustody,
    admission: Mutex<Admission>,
    drained: Notify,
    commit_changed: Notify,
    mechanisms_closed: std::sync::atomic::AtomicBool,
}
/// Host constructs this pool with private credentials and TLS. There is no fallback store.
#[derive(Clone)]
pub struct WorldStore {
    pub(super) inner: Arc<StoreInner>,
}
/// Dropping the COMMIT future retains its original custody, but no longer keeps waiters asleep.
struct CommitGuard {
    store: Arc<StoreInner>,
    key: (WorldRef, CommitId),
    token: Arc<()>,
}
impl CommitGuard {
    fn resolve(self) {
        let mut admission = self.store.admission.lock().expect("store admission poisoned");
        if admission.commits.get(&self.key).is_some_and(|custody| {
            matches!(&custody.phase, CommitPhase::Committing(token) if Arc::ptr_eq(token, &self.token))
        }) {
            admission.commits.remove(&self.key);
            self.store.commit_changed.notify_waiters();
        }
        drop(admission);
    }
}
impl Drop for CommitGuard {
    fn drop(&mut self) {
        let mut admission = self.store.admission.lock().expect("store admission poisoned");
        if let Some(custody) = admission.commits.get_mut(&self.key) {
            if matches!(&custody.phase, CommitPhase::Committing(token) if Arc::ptr_eq(token, &self.token)) {
                custody.phase = CommitPhase::Indeterminate;
                self.store.commit_changed.notify_waiters();
            }
        }
    }
}
pub(super) struct ActiveRequest(Arc<StoreInner>);
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        let mut admission = self.0.admission.lock().expect("store admission poisoned");
        admission.active -= 1;
        if admission.active == 0 {
            self.0.drained.notify_waiters();
        }
    }
}
/// An interrupted transaction must never return a possibly busy connection to the pool.
pub(super) struct Connection {
    client: Option<deadpool_postgres::Object>,
    pub(super) dirty: bool,
}
impl Deref for Connection {
    type Target = tokio_postgres::Client;
    fn deref(&self) -> &Self::Target {
        self.client.as_ref().expect("live connection")
    }
}
impl DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.client.as_mut().expect("live connection")
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if self.dirty {
            if let Some(client) = self.client.take() {
                drop(deadpool_postgres::Object::take(client));
            }
        }
    }
}

impl WorldStore {
    pub(crate) async fn inspect(pool: &Pool, limits: StoreLimits) -> Result<Option<String>, StoreError> {
        let client = tokio::time::timeout(limits.acquire_timeout, pool.get()).await
            .map_err(|error| StoreError::connection_failed(error))?
            .map_err(StoreError::connection_failed)?;
        let mut connection = Connection { client: Some(client), dirty: false };
        schema::inspect(&mut connection, &limits).await
    }

    pub async fn connect(
        pool: Pool,
        drivers: &DriverCustody,
        limits: StoreLimits,
        identity: StorageIdentity,
    ) -> Result<Self, StoreError> {
        if [
            limits.acquire_timeout,
            limits.statement_timeout,
            limits.transaction_timeout,
            limits.close_timeout,
        ]
        .iter()
        .any(|duration| duration.is_zero() || duration.as_millis() > i32::MAX as u128)
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        let store = Self {
            inner: Arc::new(StoreInner {
                pool,
                limits,
                identity: StorageIdentityReceipt::verified(&identity),
                drivers: drivers.clone(),
                admission: Mutex::new(Admission {
                    closing: false,
                    active: 0,
                    commits: HashMap::new(),
                }),
                drained: Notify::new(),
                commit_changed: Notify::new(),
                mechanisms_closed: std::sync::atomic::AtomicBool::new(false),
            }),
        };
        let initialized = async {
            let mut client = store.unverified_connection().await?;
            schema::migrate(&mut client, &identity, &limits).await
        }
        .await;
        if let Err(error) = initialized {
            return Err(match store.checked_close().await {
                Ok(()) => error,
                Err(cleanup) => error.with_cleanup(cleanup),
            });
        }
        Ok(store)
    }

    pub fn identity_receipt(&self) -> StorageIdentityReceipt {
        self.inner.identity.clone()
    }

    pub(super) fn require_storage(&self, storage_id: &str) -> Result<(), StoreError> {
        if self.inner.identity.storage_id() == storage_id {
            return Ok(());
        }
        Err(schema::installation(
            world_protocol::commit::InstallationFailure::StorageIdentityMismatch,
        ))
    }

    pub(super) async fn connection(&self) -> Result<Connection, StoreError> {
        let mut client = self.unverified_connection().await?;
        client.dirty = true;
        let row = tokio::time::timeout(
            self.inner.limits.statement_timeout,
            client.query_opt(
                "SELECT storage_id FROM public.world_storage_identity WHERE singleton",
                &[],
            ),
        )
        .await
        .map_err(|error| {
            StoreError::caused_by(
                CommitFailure::StatementTimeout,
                FailureStage::Prepare,
                error,
            )
        })?
        .map_err(|error| {
            if error.code() == Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE) {
                StoreError::caused_by(
                    CommitFailure::Installation {
                        reason:
                            world_protocol::commit::InstallationFailure::StorageIdentityMismatch,
                    },
                    FailureStage::Prepare,
                    error,
                )
            } else {
                StoreError::database(error, FailureStage::Prepare)
            }
        })?;
        if row
            .as_ref()
            .map(|row| row.get::<_, String>("storage_id"))
            .as_deref()
            != Some(self.inner.identity.storage_id())
        {
            return Err(schema::installation(
                world_protocol::commit::InstallationFailure::StorageIdentityMismatch,
            ));
        }
        client.dirty = false;
        Ok(client)
    }

    async fn unverified_connection(&self) -> Result<Connection, StoreError> {
        let client = tokio::time::timeout(self.inner.limits.acquire_timeout, self.inner.pool.get())
            .await
            .map_err(|error| {
                StoreError::caused_by(CommitFailure::PoolTimeout, FailureStage::Prepare, error)
            })?
            .map_err(|error| {
                let reason = match &error {
                    PoolError::Closed => CommitFailure::Closed,
                    PoolError::Timeout(_) => CommitFailure::PoolTimeout,
                    PoolError::Backend(_) => CommitFailure::Connection,
                    _ => CommitFailure::InternalFault,
                };
                StoreError::caused_by(reason, FailureStage::Prepare, error)
            })?;
        let mut connection = Connection {
            client: Some(client),
            dirty: true,
        };
        let writable = tokio::time::timeout(self.inner.limits.statement_timeout, connection.query_one(
            "SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off' AS writable", &[],
        )).await.map_err(|error| StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Prepare, error))?
            .map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        if !writable.get::<_, bool>("writable") {
            return Err(StoreError::new(
                CommitFailure::Connection,
                FailureStage::Prepare,
            ));
        }
        connection.dirty = false;
        Ok(connection)
    }

    pub(super) fn acquire(&self) -> Result<ActiveRequest, StoreError> {
        let mut admission = self
            .inner
            .admission
            .lock()
            .expect("store admission poisoned");
        if admission.closing {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        admission.active += 1;
        Ok(ActiveRequest(self.inner.clone()))
    }

    /// The owning task must await this through COMMIT; never select/drop it for cancellation.
    /// A dropped COMMIT still retains the original identity and quarantines its connection.
    pub(crate) async fn transact<T, E, F>(
        &self,
        batch: PreparedBatch,
        mutation: F,
    ) -> Result<Committed<T>, TransactionError<E>>
    where
        T: Serialize + DeserializeOwned + Send,
        E: From<StoreError> + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>) -> StoreFuture<'a, T, E> + Send,
    {
        let request = batch.request;
        let provision_storage = batch.provision_storage;
        let exclusive_domains = batch.exclusive_domains;
        let exclusive_storage = batch.exclusive_storage;
        let world_mutation = batch.world_mutation;
        let receipt_access = batch.receipt_access;
        let recovery_pin_release = batch.recovery_pin_release;
        let accepted_work = batch.accepted_work;
        let failed_work = batch.failed_work;
        let transfer_checkpoint = batch.transfer_checkpoint;
        let evaluation_report = batch.evaluation_report;
        let uncertain = |error: StoreError| {
            TransactionError::Indeterminate(StoreError::caused_by(
                CommitFailure::CommitIndeterminate {
                    commit_id: request.commit_id.clone(),
                },
                FailureStage::Recover,
                error,
            ))
        };
        let _active = self.acquire().map_err(&uncertain)?;
        self.await_conflicting_commits(&request)
            .await
            .map_err(&uncertain)?;
        let mut client = self.connection().await.map_err(&uncertain)?;
        client.dirty = true;
        let mut clean = false;
        // The async scope ends every transaction borrow before returning the connection to the pool.
        let result = async {
            let transaction = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::ReadCommitted)
                .start().await.map_err(|error| uncertain(StoreError::database(error, FailureStage::Commit)))?;
            self.configure(&transaction, &request.world).await.map_err(&uncertain)?;
            let mut transaction = WorldTransaction { transaction, world: request.world.clone(), token: Arc::new(()), storage_id: self.inner.identity.storage_id().to_owned(), commit_id: request.commit_id.clone(), fences: request.fences.clone(), provisioning: provision_storage.is_some(), exclusive_storage, world_mutation, receipt_access, recovery_pin_release, accepted_work, failed_work, transfer_checkpoint, evaluation_report, exclusive_domains, revisions: Vec::new(), outbox_ids: Vec::new() };
            let inserted = transaction.execute(
                "INSERT INTO world_commit_receipt(tenant_id,world_id,commit_id,input_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &request.commit_id.as_str(), &request.input_digest.as_str()],
            ).await.map_err(&uncertain)?;
            if inserted == 0 {
                let row = transaction.query_opt(
                    "SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
                    &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &request.commit_id.as_str()],
                ).await.map_err(&uncertain)?.ok_or_else(|| uncertain(StoreError::new(CommitFailure::InternalFault, FailureStage::Recover)))?;
                let outcome = decode_committed(&row, &request.input_digest, &request.commit_id, &request.world).map_err(TransactionError::Indeterminate)?;
                clean = tokio::time::timeout(self.inner.limits.statement_timeout, transaction.transaction.rollback()).await.is_ok_and(|result| result.is_ok());
                self.clear_commit(&request.world, &request.commit_id);
                return Ok(outcome);
            }
            // Acquiring the unique reservation has waited out all earlier same-ID transactions.
            // Only now can rejection prove that this original CommitId did not commit.
            self.clear_commit(&request.world, &request.commit_id);
            let prepared: Result<Committed<T>, E> = async {
                if let Some(storage_id) = &provision_storage {
                    self.require_storage(storage_id)?;
                    let inserted = transaction.execute(
                        "INSERT INTO world_storage_head(tenant_id,world_id,storage_id,writer_epoch,mode) VALUES($1,$2,$3,1,'active') ON CONFLICT DO NOTHING",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &storage_id],
                    ).await?;
                    if inserted != 1 { return Err(StoreError::new(CommitFailure::InvalidBatch, FailureStage::Admission).into()); }
                    for fence in &request.fences {
                        transaction.execute("INSERT INTO world_writer_gate(tenant_id,world_id,domain,writer_epoch,mode) VALUES($1,$2,$3,1,'active')",
                            &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &fence.domain.as_str()]).await?;
                    }
                    transaction.execute("INSERT INTO world_authority_head(tenant_id,world_id,policy_epoch,grant_epoch) VALUES($1,$2,1,1)",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str()]).await?;
                }
                let storage_lock = if exclusive_storage {
                    "SELECT writer_epoch,mode FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE"
                } else {
                    "SELECT writer_epoch,mode FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE"
                };
                let storage = transaction.query_opt(
                    storage_lock,
                    &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str()],
                ).await?.ok_or_else(|| StoreError::new(CommitFailure::NotConfigured, FailureStage::Admission))?;
                check_epoch(request.storage_epoch, &storage)?;
                if provision_storage.is_none() {
                    let draining = transaction.query_opt("SELECT 1 FROM world_storage_transfer t JOIN world_storage_head h USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND t.transfer_id=h.transfer_id AND t.phase='draining'",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str()]).await?.is_some();
                    let settlement = transaction.recovery_pin_release.as_ref().is_some_and(|proof| proof.matches(transaction.world(), &transaction.storage_id))
                        || transaction.accepted_work.as_ref().is_some_and(|proof| proof.matches(transaction.world(), &transaction.storage_id))
                        || transaction.failed_work.as_ref().is_some_and(|proof| proof.matches(transaction.world(), &transaction.storage_id))
                        || transaction.transfer_checkpoint.as_ref().is_some_and(|proof| proof.matches(transaction.world(), &transaction.storage_id))
                        || transaction.evaluation_report.as_ref().is_some_and(|proof| proof.matches(transaction.world(), &transaction.storage_id));
                    if draining && !settlement { return Err(StoreError::new(CommitFailure::Closed, FailureStage::Admission).into()); }
                }
                if provision_storage.is_none() {
                    let runtime = transaction.query_opt("SELECT status,mutation_kind,mutation_commit_id,mutation_operation_id,mutation_final_commit_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str()]).await?
                        .ok_or_else(|| StoreError::new(CommitFailure::Closed, FailureStage::Admission))?;
                    let admitted = match &transaction.world_mutation {
                        None => receipt_access || transaction.recovery_pin_release.as_ref().is_some_and(|release| release.matches(transaction.world(), &transaction.storage_id)) || transaction.accepted_work.as_ref().is_some_and(|checkpoint| checkpoint.matches(transaction.world(), &transaction.storage_id)) || transaction.failed_work.as_ref().is_some_and(|settlement| settlement.matches(transaction.world(), &transaction.storage_id)) || transaction.transfer_checkpoint.as_ref().is_some_and(|checkpoint| checkpoint.matches(transaction.world(), &transaction.storage_id)) || transaction.evaluation_report.as_ref().is_some_and(|report| report.matches(transaction.world(), &transaction.storage_id)) || runtime.get::<_, String>("status") == "ready",
                        Some(intent) => intent.storage_id == transaction.storage_id
                            && runtime.get::<_, String>("status") == intent.kind
                            && runtime.get::<_, Option<String>>("mutation_kind").as_deref() == Some(intent.kind.as_str())
                            && runtime.get::<_, Option<String>>("mutation_commit_id").as_deref() == Some(intent.commit.as_str())
                            && runtime.get::<_, Option<String>>("mutation_operation_id").as_deref() == Some(intent.operation.operation_id.as_str())
                            && runtime.get::<_, Option<String>>("mutation_final_commit_id").as_deref() == Some(intent.final_commit.as_str()),
                    };
                    if !admitted { return Err(StoreError::new(CommitFailure::Closed, FailureStage::Admission).into()); }
                }
                for fence in &request.fences {
                    let statement = if transaction.exclusive_domains.contains(&fence.domain) {
                        "SELECT writer_epoch,mode FROM world_writer_gate WHERE tenant_id=$1 AND world_id=$2 AND domain=$3 FOR UPDATE"
                    } else {
                        "SELECT writer_epoch,mode FROM world_writer_gate WHERE tenant_id=$1 AND world_id=$2 AND domain=$3 FOR SHARE"
                    };
                    let gate = transaction.query_opt(
                        statement,
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &fence.domain.as_str()],
                    ).await?.ok_or_else(|| StoreError::new(CommitFailure::Fenced { expected: fence.epoch, actual: WriterEpoch(0) }, FailureStage::Admission))?;
                    check_epoch(fence.epoch, &gate)?;
                }
                for basis in &request.watch_basis {
                    let watch = transaction.query_opt(
                        "SELECT generation FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR SHARE",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &basis.watch_id.as_str()],
                    ).await?;
                    if watch.as_ref().map(|row| row.get::<_, i64>("generation")) != Some(basis.generation.0 as i64) {
                        return Err(StoreError::new(CommitFailure::ReadDependencyChanged { resource: ResourceRef::Watch { id: basis.watch_id.clone() } }, FailureStage::Validate).into());
                    }
                }
                let value = tokio::time::timeout(self.inner.limits.transaction_timeout, mutation(&mut transaction)).await
                    .map_err(|error| StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Execute, error))??;
                if provision_storage.is_some() {
                    let head = transaction.query_opt("SELECT generation,revision,status FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
                        &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str()]).await?;
                    if !head.is_some_and(|head| head.get::<_, i64>("generation") == 1 && head.get::<_, i64>("revision") == 1 && head.get::<_, String>("status") == "ready") {
                        return Err(StoreError::new(CommitFailure::InvalidBatch, FailureStage::Admission).into());
                    }
                }
                let result = encode_result(&value)?;
                let committed_at = transaction.now().await?;
                let receipt = CommitReceipt {
                    world: request.world.clone(), commit_id: request.commit_id.clone(), committed_at,
                    revisions: std::mem::take(&mut transaction.revisions), outbox_ids: std::mem::take(&mut transaction.outbox_ids), fence: request.fences[0].clone(),
                };
                let encoded_receipt = serde_json::to_value(&receipt)
                    .map_err(|error| StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Commit, error))?;
                let changed = transaction.execute(
                    "UPDATE world_commit_receipt SET receipt=$4,result=$5,committed_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
                    &[&request.world.tenant_id.as_str(), &request.world.world_id.as_str(), &request.commit_id.as_str(), &encoded_receipt, &result],
                ).await?;
                if changed != 1 { return Err(StoreError::new(CommitFailure::InternalFault, FailureStage::Commit).into()); }
                Ok(Committed { value, receipt, replayed: false })
            }.await;
            let outcome = match prepared {
                Ok(outcome) => outcome,
                Err(error) => {
                    match tokio::time::timeout(self.inner.limits.statement_timeout, transaction.transaction.rollback()).await {
                        Ok(Ok(())) => clean = true,
                        Ok(Err(rollback)) => return Err(TransactionError::NotCommitted { error, cleanup: Some(StoreError::caused_by(CommitFailure::RollbackFailed, FailureStage::Commit, rollback)) }),
                        Err(rollback) => return Err(TransactionError::NotCommitted { error, cleanup: Some(StoreError::caused_by(CommitFailure::RollbackFailed, FailureStage::Commit, rollback)) }),
                    }
                    return Err(TransactionError::NotCommitted { error, cleanup: None });
                }
            };
            let commit = self.begin_commit(&request);
            match tokio::time::timeout(self.inner.limits.statement_timeout, transaction.transaction.commit()).await {
                Ok(Ok(())) => {
                    clean = true;
                    commit.resolve();
                    Ok(outcome)
                }
                Ok(Err(error)) if StoreError::proves_commit_aborted(&error) => {
                    commit.resolve();
                    Err(TransactionError::NotCommitted { error: E::from(StoreError::database(error, FailureStage::Commit)), cleanup: None })
                }
                Ok(Err(error)) => Err(uncertain(StoreError::database(error, FailureStage::Commit))),
                Err(error) => Err(uncertain(StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Commit, error))),
            }
        }.await;
        client.dirty = !clean;
        result
    }

    pub(crate) async fn read_commit<T: DeserializeOwned>(
        &self,
        world: &WorldRef,
        commit_id: &CommitId,
        digest: &Digest,
    ) -> Result<Committed<T>, StoreError> {
        self.read_commit_optional(world, commit_id, digest)
            .await?
            .ok_or_else(|| {
                StoreError::new(
                    CommitFailure::CommitIndeterminate {
                        commit_id: commit_id.clone(),
                    },
                    FailureStage::Recover,
                )
            })
    }

    /// Snapshot absence is not rollback proof. Only transact's unique reservation arbitrates retry.
    pub(crate) async fn read_commit_optional<T: DeserializeOwned>(
        &self,
        world: &WorldRef,
        commit_id: &CommitId,
        digest: &Digest,
    ) -> Result<Option<Committed<T>>, StoreError> {
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let transaction = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        self.configure(&transaction, world).await?;
        let row = transaction.query_opt(
            "SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &commit_id.as_str()],
        ).await.map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        let result = row
            .as_ref()
            .map(|row| decode_committed(row, digest, commit_id, world))
            .transpose()?;
        transaction
            .rollback()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        client.dirty = false;
        if result.is_some() {
            self.clear_commit(world, commit_id);
        }
        Ok(result)
    }

    /// Trusted recovery only: the persisted original digest is authoritative, never caller supplied.
    pub(crate) async fn read_commit_for_recovery<T: DeserializeOwned + Send>(
        &self,
        root: &crate::authorization::AuthorityRoot,
        world: &WorldRef,
        commit_id: &CommitId,
    ) -> Result<Committed<T>, StoreError> {
        self.read_commit_for_recovery_optional(root, world, commit_id)
            .await?
            .ok_or_else(|| {
                StoreError::new(
                    CommitFailure::CommitIndeterminate {
                        commit_id: commit_id.clone(),
                    },
                    FailureStage::Recover,
                )
            })
    }

    /// Original typed receipt only. Snapshot absence neither proves rollback nor clears custody.
    pub(crate) async fn read_commit_for_recovery_optional<T: DeserializeOwned + Send>(
        &self,
        _root: &crate::authorization::AuthorityRoot,
        world: &WorldRef,
        commit_id: &CommitId,
    ) -> Result<Option<Committed<T>>, StoreError> {
        let world = world.clone();
        let commit_id = commit_id.clone();
        let recovered_world = world.clone();
        let recovered_id = commit_id.clone();
        let committed = self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let Some(row) = snapshot.query_opt("SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &commit_id.as_str()]).await? else { return Ok(None); };
            let digest = Digest::try_new(row.get::<_, String>("input_digest")).map_err(|_| StoreError::new(CommitFailure::InternalFault, FailureStage::Recover))?;
            decode_committed(&row, &digest, &commit_id, &world).map(Some)
        })).await?;
        if committed.is_some() {
            self.clear_commit(&recovered_world, &recovered_id);
        }
        Ok(committed)
    }

    pub(crate) async fn snapshot<T, E, F>(&self, world: WorldRef, read: F) -> Result<T, E>
    where
        F: for<'a> FnOnce(&'a WorldSnapshot<'_>) -> StoreFuture<'a, T, E> + Send,
        T: Send,
        E: From<StoreError> + Send,
    {
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let result = {
            let transaction = client
                .build_transaction()
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .read_only(true)
                .start()
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Read))?;
            self.configure(&transaction, &world).await?;
            let snapshot = WorldSnapshot { transaction, world };
            let result =
                tokio::time::timeout(self.inner.limits.transaction_timeout, read(&snapshot))
                    .await
                    .map_err(|error| {
                        StoreError::caused_by(
                            CommitFailure::StatementTimeout,
                            FailureStage::Read,
                            error,
                        )
                    });
            snapshot.transaction.rollback().await.map_err(|error| {
                StoreError::caused_by(CommitFailure::RollbackFailed, FailureStage::Read, error)
            })?;
            result
        };
        client.dirty = false;
        result?
    }

    /// Authorization may write transient decisions; this inspection can only roll back.
    pub(crate) async fn inspect_world<T, E, F>(&self, world: WorldRef, read: F) -> Result<T, E>
    where
        T: Send,
        E: From<StoreError> + Send,
        F: for<'a> FnOnce(&'a WorldTransaction<'_>) -> StoreFuture<'a, T, E> + Send,
    {
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let result = {
            let transaction = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::ReadCommitted)
                .start().await.map_err(|error| StoreError::database(error, FailureStage::Read))?;
            self.configure(&transaction, &world).await?;
            let transaction = WorldTransaction {
                transaction, world, token: Arc::new(()), storage_id: self.inner.identity.storage_id().to_owned(),
                commit_id: CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
                fences: Vec::new(), provisioning: false, exclusive_storage: false, world_mutation: None,
                receipt_access: false, recovery_pin_release: None, accepted_work: None, failed_work: None,
                transfer_checkpoint: None, evaluation_report: None, exclusive_domains: Vec::new(), revisions: Vec::new(), outbox_ids: Vec::new(),
            };
            let result = tokio::time::timeout(self.inner.limits.transaction_timeout, read(&transaction)).await
                .map_err(|error| StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Read, error));
            tokio::time::timeout(self.inner.limits.statement_timeout, transaction.transaction.rollback()).await
                .map_err(|error| StoreError::caused_by(CommitFailure::RollbackFailed, FailureStage::Read, error))?
                .map_err(|error| StoreError::database(error, FailureStage::Read))?;
            result
        };
        client.dirty = false;
        result?
    }

    /// Trusted recovery enumeration only; no guest-selected SQL or cross-world mutation.
    pub(crate) async fn worlds(
        &self,
        _root: &crate::authorization::AuthorityRoot,
    ) -> Result<Vec<WorldRef>, StoreError> {
        let _active = self.acquire()?;
        let mut client = self.connection().await?;
        client.dirty = true;
        let transaction = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        transaction.query_one("SELECT set_config('statement_timeout',$1,true),set_config('app.world_catalog_read','on',true),set_config('search_path','pg_catalog,public',true)",
            &[&self.inner.limits.statement_timeout.as_millis().to_string()]).await.map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        let rows = transaction
            .query(
                "SELECT tenant_id,world_id FROM world_runtime_head ORDER BY tenant_id,world_id",
                &[],
            )
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        let worlds = rows
            .into_iter()
            .map(|row| {
                Ok(WorldRef {
                    tenant_id: world_protocol::ids::TenantId::try_new(
                        row.get::<_, String>("tenant_id"),
                    )
                    .map_err(|error| {
                        StoreError::caused_by(
                            CommitFailure::InternalFault,
                            FailureStage::Recover,
                            error,
                        )
                    })?,
                    world_id: world_protocol::ids::WorldId::try_new(
                        row.get::<_, String>("world_id"),
                    )
                    .map_err(|error| {
                        StoreError::caused_by(
                            CommitFailure::InternalFault,
                            FailureStage::Recover,
                            error,
                        )
                    })?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        transaction
            .rollback()
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
        client.dirty = false;
        Ok(worlds)
    }

    pub(super) async fn configure(
        &self,
        transaction: &tokio_postgres::Transaction<'_>,
        world: &WorldRef,
    ) -> Result<(), StoreError> {
        configure(transaction, world, &self.inner.limits).await
    }

    async fn await_conflicting_commits(&self, request: &CommitRequest) -> Result<(), StoreError> {
        tokio::time::timeout(self.inner.limits.statement_timeout, async {
            loop {
                let notified = self.inner.commit_changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let admission = self.inner.admission.lock().expect("store admission poisoned");
                    if admission.closing {
                        return Err(StoreError::new(CommitFailure::Closed, FailureStage::Admission));
                    }
                    let mut committing = false;
                    for custody in admission.commits.values() {
                        let pending = &custody.pending;
                        if pending.world != request.world
                            || pending.commit_id == request.commit_id
                            || !pending.fences.iter().any(|pending_fence| {
                                request.fences.iter().any(|fence| fence.domain == pending_fence.domain)
                            })
                        {
                            continue;
                        }
                        match &custody.phase {
                            CommitPhase::Committing(_) => committing = true,
                            CommitPhase::Indeterminate => return Err(StoreError::new(
                                CommitFailure::CommitIndeterminate { commit_id: pending.commit_id.clone() },
                                FailureStage::Recover,
                            )),
                        }
                    }
                    if !committing {
                        return Ok(());
                    }
                }
                notified.await;
            }
        })
        .await
        .map_err(|error| {
            StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Admission, error)
        })?
    }

    fn begin_commit(&self, request: &CommitRequest) -> CommitGuard {
        let pending = PendingCommit {
            world: request.world.clone(),
            commit_id: request.commit_id.clone(),
            input_digest: request.input_digest.clone(),
            storage_epoch: request.storage_epoch,
            fences: request.fences.clone(),
        };
        let key = (request.world.clone(), request.commit_id.clone());
        let token = Arc::new(());
        self.inner
            .admission
            .lock()
            .expect("store admission poisoned")
            .commits
            .insert(
                key.clone(),
                CommitCustody { pending, phase: CommitPhase::Committing(token.clone()) },
            );
        CommitGuard { store: self.inner.clone(), key, token }
    }
    fn clear_commit(&self, world: &WorldRef, commit_id: &CommitId) {
        if self.inner
            .admission
            .lock()
            .expect("store admission poisoned")
            .commits
            .remove(&(world.clone(), commit_id.clone()))
            .is_some()
        {
            self.inner.commit_changed.notify_waiters();
        }
    }
    pub(crate) fn pending_commits(&self) -> Vec<PendingCommit> {
        let admission = self
            .inner
            .admission
            .lock()
            .expect("store admission poisoned");
        let mut pending: Vec<_> = admission
            .commits
            .values()
            .map(|custody| custody.pending.clone())
            .collect();
        pending.sort_unstable_by(|a, b| (&a.world, &a.commit_id).cmp(&(&b.world, &b.commit_id)));
        pending.dedup_by(|a, b| a.world == b.world && a.commit_id == b.commit_id);
        pending
    }

    pub fn mechanisms_closed(&self) -> bool {
        self.inner
            .mechanisms_closed
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn close_admission(&self) {
        self.inner
            .admission
            .lock()
            .expect("store admission poisoned")
            .closing = true;
        self.inner.commit_changed.notify_waiters();
        self.inner.pool.close();
    }

    pub async fn checked_close(&self) -> Result<(), StoreError> {
        self.close_admission();
        let drained = tokio::time::timeout(self.inner.limits.close_timeout, async {
            loop {
                let notified = self.inner.drained.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self
                    .inner
                    .admission
                    .lock()
                    .expect("store admission poisoned")
                    .active
                    == 0
                {
                    break;
                }
                notified.await;
            }
        })
        .await;
        self.inner.pool.close();
        // Closing the pool rejects new acquisitions without killing a client's in-flight COMMIT.
        drained.map_err(|error| {
            StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Drain, error)
        })?;
        let joined = self
            .inner
            .drivers
            .checked_close(self.inner.limits.close_timeout)
            .await;
        if self.inner.drivers.is_closed().await {
            self.inner
                .mechanisms_closed
                .store(true, std::sync::atomic::Ordering::Release);
        }
        joined?;
        if let Some(pending) = self.pending_commits().first() {
            return Err(StoreError::new(
                CommitFailure::CommitIndeterminate {
                    commit_id: pending.commit_id.clone(),
                },
                FailureStage::Recover,
            ));
        }
        Ok(())
    }
}
pub(super) async fn configure(
    transaction: &tokio_postgres::Transaction<'_>,
    world: &WorldRef,
    limits: &StoreLimits,
) -> Result<(), StoreError> {
    transaction.query_one(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$2,true),set_config('search_path','pg_catalog,public',true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO,YMD',true),set_config('bytea_output','hex',true),set_config('app.world_tenant',$3,true),set_config('app.world_id',$4,true)",
        &[&limits.statement_timeout.as_millis().to_string(), &limits.transaction_timeout.as_millis().to_string(), &world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    Ok(())
}

fn check_epoch(expected: WriterEpoch, row: &tokio_postgres::Row) -> Result<(), StoreError> {
    let actual = WriterEpoch(row.get::<_, i64>("writer_epoch") as u64);
    if actual != expected || row.get::<_, String>("mode") != "active" {
        return Err(StoreError::new(
            CommitFailure::Fenced { expected, actual },
            FailureStage::Admission,
        ));
    }
    Ok(())
}
