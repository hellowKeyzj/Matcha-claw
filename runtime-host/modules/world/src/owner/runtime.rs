use std::{collections::{BTreeMap, BTreeSet}, future::Future, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

use foundation::execution::{CommandRoute, OwnedTask, OwnerRuntimeConfig, OwnerRuntimeHandle, OwnerRuntimeSystem, OwnerSpec, QueryRoute};
use platform::capability::CapabilityDecisionVerifier;
use tokio::{sync::{oneshot, watch}, time::Instant};
use world_protocol::{api::{ApiFailure, TransportFailure}, commit::CommitFailure, failure::{FailureStage, Recovery}, ids::*, lifecycle::RetainedResource, operation::{CancelOperation, CancelReceipt, OperationKey, OperationReceipt}};

use crate::{authorization::{AuthorityRoot, ServiceIngress}, extensions::{bindings::PublicationGate, lifecycle::{LiveExtensions, retained_resources}}, sources::connectors::{SourceAccess, SourceError}, store::{DriverCustody, StorageIdentity, StorageIdentityReceipt, StoreError, StoreLimits, WorldLocator, WorldStore}};
use super::{Error, operation::{self, SignedRequest}, provision::{self, Provision, Provisioned}, recovery::{self, RecoveryInventory}};
#[path = "requests.rs"]
mod requests;
#[path = "storage_open.rs"]
mod storage_open;
#[path = "maintenance.rs"]
mod maintenance;
pub(super) use maintenance::State as MaintenanceState;
pub(super) async fn step_retention_roots(tx: &crate::store::WorldTransaction<'_>, step: &super::StepRecord, roots: &mut crate::store::RetentionRoots) -> Result<(), Error> {
    maintenance::step_retention_roots(tx, step, roots).await
}
#[path = "transfer.rs"]
pub(super) mod transfer;
pub use transfer::{StorageTransferPrepare, StorageTransferRequest, StorageTransferOutcome};
use world_protocol::api::{CommandEnvelope, CommandResult, PeerRequest, PeerResponse, QueryEnvelope, QueryResult};
use world_protocol::operation::{OperationRequest, OperationResponse};

pub trait WorldStorage: Send + Sync {
    fn configuration(&self, storage_id: &str) -> Result<StoreConfiguration, StoreError>;
    fn accept(&self, receipt: StorageIdentityReceipt) -> Result<(), StoreError>;
}

pub enum StoreConfiguration {
    NotConfigured,
    Unavailable(StoreError),
    Ready(WorldStore),
    Postgres { pool: deadpool_postgres::Pool, drivers: DriverCustody, limits: StoreLimits, identity: StorageIdentity },
}

#[derive(Clone)]
enum Storage { Initializing, Ready(WorldStore), Failed { error: Error, store: Option<WorldStore> } }

struct Shared {
    storage: watch::Sender<Storage>,
    closing: AtomicBool,
    worlds: Mutex<BTreeSet<WorldRef>>,
    ingress: Arc<ServiceIngress>,
    native: Arc<crate::authorization::NativeIngress>,
    authority: Arc<AuthorityRoot>,
    authorities: Mutex<BTreeMap<WorldRef, Arc<super::resources::WorldAuthorities>>>,
    cancellation: tokio_util::sync::CancellationToken,
    locator: Result<Arc<dyn WorldLocator>, Error>,
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>,
    resources: Result<super::WorldResources, Error>,
    stores: super::storage::Stores,
    world_resources: Mutex<std::collections::BTreeMap<(String, WorldRef), Result<Arc<super::resources::Resources>, Error>>>,
    startup_reports: Mutex<std::collections::BTreeMap<WorldRef, crate::extensions::lifecycle::StartupReport>>,
    // ponytail: one startup inventory; scope it per store before parallel recovery.
    startup_retry: tokio::sync::Mutex<()>,
    startup_failures: Mutex<std::collections::BTreeMap<WorldRef, Error>>,
    startup_inventory: AtomicBool,
    stage_cleanup: Mutex<std::collections::BTreeMap<(String, WorldRef, CommitId), crate::content::StageCleanupOutcome>>,
    pending_provisions: Mutex<std::collections::BTreeMap<(WorldRef, CommitId), provision::PendingProvision>>,
    pending_source_segments: Mutex<BTreeMap<(WorldRef, RunId), maintenance::PendingSegment>>,
    initialization_diagnostics: Mutex<Vec<Error>>,
    live: Arc<LiveExtensions>,
    tasks: Arc<super::tasks::Tasks>,
    hints: Arc<super::hints::Hints>,
    executing: Mutex<std::collections::BTreeMap<(WorldRef, OperationId), tokio_util::sync::CancellationToken>>,
}

pub struct WorldRuntime {
    handle: WorldHandle,
    shared: Arc<Shared>,
    owner: OwnedTask<()>,
    owner_joined: bool,
    store_closed: bool,
    store_closing: bool,
    diagnostics: Vec<Error>,
    durable_unsettled: Vec<OperationKey>,
    indeterminate_commits: Vec<(WorldRef, CommitId)>,
}

#[derive(Clone)]
pub struct WorldHandle {
    mailbox: OwnerRuntimeHandle<Command, Query>,
    shared: Arc<Shared>,
}

#[derive(Default)]
pub struct QuiesceOutcome {
    pub durable_unsettled: Vec<OperationKey>,
    pub indeterminate_commits: Vec<(WorldRef, CommitId)>,
    pub retained_resources: Vec<RetainedResource>,
    pub owner_remaining: bool,
    pub store_remaining: bool,
    /// Failures observed while closing; historical business diagnostics stay with their owner.
    pub diagnostics: Vec<Error>,
}

impl QuiesceOutcome {
    pub fn mechanisms_closed(&self) -> bool {
        !self.owner_remaining && !self.store_remaining && self.retained_resources.is_empty()
    }

    pub fn closed(&self) -> bool {
        self.mechanisms_closed() && self.indeterminate_commits.is_empty() && self.diagnostics.is_empty()
    }
}

impl WorldRuntime {
    pub fn spawn(system: &OwnerRuntimeSystem, storage: StoreConfiguration, resources: Result<super::WorldResources, Error>, storage_provider: Result<Arc<dyn WorldStorage>, StoreError>, authority: Arc<AuthorityRoot>, locator: Result<Arc<dyn WorldLocator>, StoreError>, source_access: Result<Arc<dyn SourceAccess>, SourceError>, issuer: String, verifier: Arc<tokio::sync::Mutex<CapabilityDecisionVerifier>>, native_verifiers: Vec<Result<Arc<dyn crate::authorization::NativeVerifier>, crate::authorization::NativeVerificationError>>, initial: Option<Provision>) -> Self {
        let (storage_state, _) = watch::channel(Storage::Initializing);
        let shared = Arc::new(Shared {
            storage: storage_state, closing: AtomicBool::new(false), worlds: Mutex::new(BTreeSet::new()),
            ingress: Arc::new(ServiceIngress::new(issuer, verifier)),
            native: Arc::new(crate::authorization::NativeIngress::new(authority.clone(), native_verifiers)), authority,
            authorities: Mutex::new(BTreeMap::new()),
            cancellation: tokio_util::sync::CancellationToken::new(),
            locator: locator.map_err(Error::from), source_access: source_access.map_err(Arc::new),
            resources, stores: super::storage::Stores::new(storage_provider.map_err(Error::from)),
            world_resources: Mutex::new(std::collections::BTreeMap::new()),
            startup_reports: Mutex::new(std::collections::BTreeMap::new()),
            startup_retry: tokio::sync::Mutex::new(()),
            startup_failures: Mutex::new(std::collections::BTreeMap::new()),
            startup_inventory: AtomicBool::new(false),
            stage_cleanup: Mutex::new(std::collections::BTreeMap::new()),
            pending_provisions: Mutex::new(std::collections::BTreeMap::new()),
            pending_source_segments: Mutex::new(BTreeMap::new()),
            initialization_diagnostics: Mutex::new(Vec::new()),
            live: Arc::new(LiveExtensions::new(PublicationGate::new())),
            tasks: Arc::new(super::tasks::Tasks::default()),
            hints: super::hints::Hints::new(),
            executing: Mutex::new(std::collections::BTreeMap::new()),
        });
        let config = OwnerRuntimeConfig::default();
        let (mailbox, owner) = system.spawn_owner(WorldOwner(shared.clone()), config);
        let handle = WorldHandle { mailbox, shared: shared.clone() };
        handle.mailbox.try_command(Command::Initialize(storage, initial, handle.clone())).expect("new World mailbox has capacity");
        let hints = shared.clone();
        let maintenance_owner = handle.clone();
        drop(shared.tasks.spawn(Box::pin(async move {
            let mut failures = BTreeSet::new();
            let mut maintenance_at = Instant::now();
            while !hints.closing.load(Ordering::Acquire) {
                let maintenance_due = Instant::now() >= maintenance_at;
                if maintenance_due { maintenance_at = Instant::now() + std::time::Duration::from_secs(1); }
                let worlds: Vec<_> = hints.worlds.lock().expect("world set poisoned").iter().cloned().collect();
                for world in worlds {
                    if hints.live.require_world_open(&world).is_err() { continue; }
                    let result = async {
                        let store = ready_for(&hints, &world).await?;
                        let page = store.read_hints(world.clone(), hints.hints.cursor(&world), 256).await?;
                        hints.hints.publish(world.clone(), page);
                        if maintenance_due {
                            let resources = self::resources(&hints, &store, &world)?;
                            maintenance::tick(maintenance_owner.clone(), store, resources, world.clone()).await;
                        }
                        Ok::<_, Error>(())
                    }.await;
                    if let Err(error) = result {
                        if failures.insert(world) { record_initialization_diagnostic(&hints, "hints", error); }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        })));
        Self { handle, shared, owner,
            owner_joined: false, store_closed: false, store_closing: false, diagnostics: Vec::new(),
            durable_unsettled: Vec::new(), indeterminate_commits: Vec::new() }
    }

    pub fn handle(&self) -> WorldHandle { self.handle.clone() }

    pub(crate) fn live_extensions(&self) -> Arc<LiveExtensions> { self.shared.live.clone() }

    /// No handler or COMMIT future is cancelled here. A deadline retains task/driver custody.
    pub async fn checked_quiesce(&mut self, deadline: Instant) -> QuiesceOutcome {
        self.shared.closing.store(true, Ordering::Release);
        self.shared.hints.close();
        self.shared.cancellation.cancel();
        let mut outcome = QuiesceOutcome::default();
        let mut worlds: Vec<_> = self.shared.worlds.lock().expect("world set poisoned").iter().cloned().collect();
        for world in &worlds { self.shared.live.close_all(world, false); }
        if !self.owner_joined {
            match tokio::time::timeout_at(deadline, self.owner.drain_and_join()).await {
                Ok(Ok(())) => self.owner_joined = true,
                Ok(Err(cause)) => {
                    self.owner_joined = true;
                    self.diagnostics.push(Error::internal(FailureStage::Stop).caused(cause));
                }
                Err(_) => {}
            }
        }
        let mut sync_joined = true;
        let resources: Vec<_> = self.shared.world_resources.lock().expect("world resources poisoned")
            .values().filter_map(|value| value.as_ref().ok().cloned()).collect();
        for resources in resources {
            match tokio::time::timeout_at(deadline, resources.sync.shutdown(deadline)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => { sync_joined = false; self.diagnostics.push(error.into()); }
                Err(_) => { sync_joined = false; self.diagnostics.push(deadline_error(FailureStage::Stop)); }
            }
        }
        let workers_joined = self.owner_joined && self.shared.tasks.checked_join(deadline, &mut self.diagnostics).await && sync_joined;
        let model_pending = self.shared.world_resources.lock().expect("world resources poisoned")
            .values().filter_map(|resources| resources.as_ref().ok()).any(|resources| resources.model_calls.has_pending());
        if model_pending {
            self.diagnostics.push(Error::new("world.generation_cleanup_retained", FailureStage::Stop,
                "模型调用仍保留待确认的输出或清理资源。", ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::Refresh));
        }
        let transfer_pending = self.shared.world_resources.lock().expect("world resources poisoned")
            .values().filter_map(|resources| resources.as_ref().ok())
            .any(|resources| resources.transfer.try_lock().map_or(true, |pending| pending.is_some()));
        if transfer_pending {
            self.diagnostics.push(Error::new("world.transfer_cleanup_retained", FailureStage::Stop,
                "原存储迁移仍持有待恢复的执行资源。", ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::ManualReview));
        }
        let source_pending = !self.shared.pending_source_segments.lock().expect("world source segment custody poisoned").is_empty();
        if source_pending {
            self.diagnostics.push(Error::new("world.source_admission_retained", FailureStage::Stop,
                "源同步执行段的原准入结果仍待确认。", ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::ManualReview));
        }
        let workers_joined = workers_joined && !model_pending && !transfer_pending;
        outcome.owner_remaining = !workers_joined;
        worlds = self.shared.worlds.lock().expect("world set poisoned").iter().cloned().collect();
        for world in &worlds { self.shared.live.close_all(world, false); }
        if workers_joined && !self.store_closing {
            let mut current = Vec::new();
            let mut complete_inventory = true;
            let mut pending = Vec::new();
            for store in self.shared.stores.connected() {
                pending.extend(store.pending_commits().into_iter().map(|pending| (pending.world, pending.commit_id)));
                match tokio::time::timeout_at(deadline, store.worlds(&self.shared.authority)).await {
                    Ok(Ok(stored_worlds)) => for world in stored_worlds {
                        match tokio::time::timeout_at(deadline, recovery::load(&store, world)).await {
                            Ok(Ok(inventory)) => current.extend(inventory.operations.into_iter().map(|receipt| OperationKey {
                                world: receipt.accepted.world, operation_id: receipt.accepted.operation_id,
                            })),
                            Ok(Err(error)) => { complete_inventory = false; self.diagnostics.push(error); }
                            Err(_) => { complete_inventory = false; self.diagnostics.push(deadline_error(FailureStage::Recover)); }
                        }
                    },
                    Ok(Err(error)) => { complete_inventory = false; self.diagnostics.push(error.into()); }
                    Err(_) => { complete_inventory = false; self.diagnostics.push(deadline_error(FailureStage::Recover)); }
                }
            }
            if complete_inventory { self.durable_unsettled = current; }
            self.indeterminate_commits = pending;
        }
        outcome.durable_unsettled = self.durable_unsettled.clone();
        outcome.indeterminate_commits = self.indeterminate_commits.clone();
        for world in &worlds {
            let remaining = self.shared.live.drain_until(world, deadline).await;
            outcome.retained_resources.extend(remaining.iter().flat_map(retained_resources));
            self.diagnostics.extend(self.shared.live.process_failures(world).into_iter()
                .map(|error| crate::extensions::lifecycle::LifecycleError::Process(error).into()));
        }
        if !self.store_closed && workers_joined && outcome.retained_resources.is_empty() {
            self.store_closing = true;
            self.store_closed = self.shared.stores.checked_close(deadline, &mut self.diagnostics).await;
        }
        outcome.store_remaining = !self.store_closed;
        outcome.diagnostics.extend(self.diagnostics.iter().cloned());
        platform::trace::runtime_trace("world.shutdown.settled", || {
            let historical = self.shared.initialization_diagnostics.lock().expect("world diagnostics poisoned");
            serde_json::json!({
                "closed": outcome.closed(),
                "ownerRemaining": outcome.owner_remaining,
                "storeRemaining": outcome.store_remaining,
                "retainedResources": outcome.retained_resources.len(),
                "durableUnsettled": outcome.durable_unsettled.len(),
                "indeterminateCommits": outcome.indeterminate_commits.len(),
                "shutdownDiagnosticCount": outcome.diagnostics.len(),
                "shutdownDiagnostics": outcome.diagnostics.iter().take(16).map(|error| {
                    let failure = error.safe_failure();
                    serde_json::json!({
                        "code": failure.code,
                        "stage": failure.stage,
                        "diagnosticIdHash": platform::trace::identifier_hash(failure.diagnostic_id.as_str()),
                    })
                }).collect::<Vec<_>>(),
                "historicalDiagnosticCount": historical.len(),
                "historicalDiagnostics": historical.iter().take(16).map(|error| {
                    let failure = error.safe_failure();
                    serde_json::json!({
                        "code": failure.code,
                        "stage": failure.stage,
                        "diagnosticIdHash": platform::trace::identifier_hash(failure.diagnostic_id.as_str()),
                    })
                }).collect::<Vec<_>>(),
            })
        });
        outcome
    }
}

impl crate::extensions::migration::StorageTarget for WorldHandle {
    fn open<'a>(&'a self, world: &'a WorldRef, storage_id: &'a str) -> crate::extensions::migration::TargetFuture<'a> {
        Box::pin(async move {
            self.admit(world)?;
            let store = self.shared.stores.open(storage_id).await?;
            let resources = resources(&self.shared, &store, world)?;
            Ok(crate::extensions::migration::OpenedTarget { store, content: resources.content.clone(), inventory: resources.inventory.clone() })
        })
    }
}

impl WorldHandle {
    pub fn subscribe_hints(&self) -> super::WorldHintSubscription { self.shared.hints.subscribe() }

    pub(crate) async fn maintain(&self, world: WorldRef) -> Result<(), Error> {
        let outcome = async {
            self.admit(&world)?;
            let store = ready_for(&self.shared, &world).await?;
            let resources = resources(&self.shared, &store, &world)?;
            maintenance::schedule(self.clone(), store, resources, world)
        }.await;
        if let Err(error) = outcome {
            record_initialization_diagnostic(&self.shared, "maintain", error);
        }
        Ok(())
    }

    pub(crate) async fn repair_startup(&self, world: WorldRef) -> Result<(), Error> {
        let outcome = async {
            let _retry = self.shared.startup_retry.lock().await;
            if self.shared.startup_failures.lock().expect("world startup failures poisoned").contains_key(&world) {
                let (store, _) = readable_for(&self.shared, &world).await?;
                initialize(&self.shared, &store, self.clone(), Some(&world)).await?;
                restore_ready(&self.shared)?;
            }
            Ok::<_, Error>(())
        }.await;
        if let Err(error) = outcome {
            record_initialization_diagnostic(&self.shared, "package_repair", error);
        }
        self.maintain(world).await
    }

    pub(crate) async fn start_source_service(&self, parent: crate::sources::sync::SourceParent) -> Result<(), Error> {
        self.admit(&parent.assignment.world)?;
        maintenance::start(self.clone(), parent).await
    }

    pub(crate) async fn query(&self, signed: SignedRequest, input: QueryEnvelope) -> Result<QueryResult, Error> {
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.query(Query::Request { signed, input, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub(crate) async fn command(&self, signed: SignedRequest, input: CommandEnvelope) -> Result<CommandResult, Error> {
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::Request { signed, input, target: self.clone(), reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub(crate) async fn operation(&self, signed: SignedRequest, input: OperationRequest) -> Result<OperationResponse, Error> {
        self.admit(input.world())?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::Operation { signed, input, target: self.clone(), reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub(crate) async fn peer(&self, proof: Vec<u8>, bytes: Vec<u8>, input: PeerRequest) -> Result<PeerResponse, Error> {
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::Peer { proof, bytes, input, target: self.clone(), reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub(crate) async fn status(&self, signed: SignedRequest, key: OperationKey) -> Result<OperationReceipt, Error> {
        self.admit(&key.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.query(Query::Status { signed, key, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub(crate) async fn cancel(&self, signed: SignedRequest, request: CancelOperation) -> Result<CancelReceipt, Error> {
        self.admit(&request.key.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::Cancel { signed, request, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn grant_access(&self, root: &Arc<AuthorityRoot>, input: crate::authorization::GrantRequest) -> Result<world_protocol::commit::CommitReceipt, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::GrantAccess { input, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn install_evaluation(&self, root: &Arc<AuthorityRoot>, input: crate::authorization::InstallEvaluation) -> Result<world_protocol::commit::CommitReceipt, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::InstallEvaluation { input, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn evaluation_status(&self, root: &Arc<AuthorityRoot>, world: WorldRef) -> Result<super::EvaluationStatus, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.query(Query::EvaluationStatus { world, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn inspect_storage(&self, root: &Arc<AuthorityRoot>, configuration: StoreConfiguration) -> Result<Option<String>, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) { return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into()); }
        if self.shared.closing.load(Ordering::Acquire) { return Err(closed()); }
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::InspectStorage { configuration, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn open_storage(&self, root: &Arc<AuthorityRoot>, storage_id: String) -> Result<Vec<WorldRef>, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) { return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into()); }
        if self.shared.closing.load(Ordering::Acquire) { return Err(closed()); }
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::OpenStorage { storage_id, target: self.clone(), reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    pub async fn provision(&self, root: &Arc<AuthorityRoot>, input: Provision) -> Result<Provisioned, Error> {
        if !Arc::ptr_eq(root, &self.shared.authority) {
            return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
        }
        self.admit(&input.world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.command(Command::Provision { input, target: self.clone(), reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    /// Trusted recovery is inspection only. It never recreates invocation authority or executes an old step.
    pub(crate) async fn recover(&self, _root: &AuthorityRoot, world: WorldRef) -> Result<RecoveryInventory, Error> {
        self.admit(&world)?;
        let (reply, response) = oneshot::channel();
        self.mailbox.query(Query::Recovery { world, reply }).await.map_err(|_| closed())?;
        response.await.map_err(|cause| closed().caused(cause))?
    }

    fn admit(&self, _world: &WorldRef) -> Result<(), Error> {
        if self.shared.closing.load(Ordering::Acquire) { return Err(closed()); }
        Ok(())
    }
}

enum Command {
    PrepareTransfer { input: StorageTransferPrepare, reply: oneshot::Sender<Result<StorageTransferRequest, Error>> },
    Transfer { input: StorageTransferRequest, target: WorldHandle, reply: oneshot::Sender<Result<StorageTransferOutcome, Error>> },
    Initialize(StoreConfiguration, Option<Provision>, WorldHandle),
    InspectStorage { configuration: StoreConfiguration, reply: oneshot::Sender<Result<Option<String>, Error>> },
    OpenStorage { storage_id: String, target: WorldHandle, reply: oneshot::Sender<Result<Vec<WorldRef>, Error>> },
    Request { signed: SignedRequest, input: CommandEnvelope, target: WorldHandle, reply: oneshot::Sender<Result<CommandResult, Error>> },
    Peer { proof: Vec<u8>, bytes: Vec<u8>, input: PeerRequest, target: WorldHandle, reply: oneshot::Sender<Result<PeerResponse, Error>> },
    Operation { signed: SignedRequest, input: OperationRequest, target: WorldHandle, reply: oneshot::Sender<Result<OperationResponse, Error>> },
    Provision { input: Provision, target: WorldHandle, reply: oneshot::Sender<Result<Provisioned, Error>> },
    GrantAccess { input: crate::authorization::GrantRequest, reply: oneshot::Sender<Result<world_protocol::commit::CommitReceipt, Error>> },
    InstallEvaluation { input: crate::authorization::InstallEvaluation, reply: oneshot::Sender<Result<world_protocol::commit::CommitReceipt, Error>> },
    Cancel { signed: SignedRequest, request: CancelOperation, reply: oneshot::Sender<Result<CancelReceipt, Error>> },
}
enum Query {
    Request { signed: SignedRequest, input: QueryEnvelope, reply: oneshot::Sender<Result<QueryResult, Error>> },
    Status { signed: SignedRequest, key: OperationKey, reply: oneshot::Sender<Result<OperationReceipt, Error>> },
    Recovery { world: WorldRef, reply: oneshot::Sender<Result<RecoveryInventory, Error>> },
    EvaluationStatus { world: WorldRef, reply: oneshot::Sender<Result<super::EvaluationStatus, Error>> },
}
#[derive(Clone, Eq, PartialEq, Hash)]
enum Lane { Operation(WorldRef, OperationId), Transfer(WorldRef, TransferId) }
struct WorldOwner(Arc<Shared>);

impl OwnerSpec for WorldOwner {
    type Command = Command;
    type Query = Query;
    type Key = Lane;
    type Shared = Arc<Shared>;
    type GlobalState = ();
    type LaneState = ();

    fn split(self) -> (Self::Shared, ()) { (self.0, ()) }
    fn route_command(command: &Command) -> CommandRoute<Self::Key> {
        match command {
            Command::PrepareTransfer { input, .. } => CommandRoute::Keyed(Lane::Transfer(input.world.clone(), input.transfer_id.clone())),
            Command::Transfer { input, .. } => CommandRoute::Keyed(Lane::Transfer(input.cut.world.clone(), input.cut.transfer_id.clone())),
            Command::Initialize(..) | Command::InspectStorage { .. } | Command::OpenStorage { .. } | Command::Provision { .. } | Command::GrantAccess { .. } | Command::InstallEvaluation { .. } => CommandRoute::Global,
            Command::Request { input, .. } => CommandRoute::Keyed(Lane::Operation(input.world.clone(), requests::operation_id(&input.world, &input.request_id, input.command.operation_name()))),
            Command::Peer { input, .. } => CommandRoute::Keyed(Lane::Operation(input.world.clone(), requests::operation_id(&input.world, &input.request_id, input.operation.operation_name()))),
            Command::Operation { input, .. } => {
                let key = match input { OperationRequest::Status(key) | OperationRequest::Result(key) => key,
                    OperationRequest::Cancel(request) => &request.key, OperationRequest::Resume(request) => &request.key };
                CommandRoute::Keyed(Lane::Operation(key.world.clone(), key.operation_id.clone()))
            }
            Command::Cancel { request, .. } => CommandRoute::Keyed(Lane::Operation(request.key.world.clone(), request.key.operation_id.clone())),
        }
    }
    fn route_query(_: &Query) -> QueryRoute<Self::Key> { QueryRoute::Direct }
    fn open_lane(_: &Self::Shared, _: &Self::Key) {}

    fn handle_keyed_command(shared: Self::Shared, _: Self::Key, _: &mut (), command: Command) -> impl Future<Output = ()> + Send {
        let work: Pin<Box<dyn Future<Output = ()> + Send>> = match command {
            Command::PrepareTransfer { input, reply } => Box::pin(async move {
                let result = transfer::prepare(&shared, input).await;
                let _ = reply.send(result);
            }),
            Command::Transfer { input, target, reply } => Box::pin(async move {
                let cut = input.cut.clone();
                let worker = shared.tasks.spawn_transfer(cut, transfer::execute(shared.clone(), input, target));
                let result = match worker {
                    Ok(worker) => worker.await.map_err(|cause| Error::internal(FailureStage::Migrate).caused(cause)).and_then(|result| result),
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }),
            Command::Cancel { signed, request, reply } => Box::pin(async move {
                let result = requests::cancel(&shared, signed, request).await;
                let _ = reply.send(result);
            }),
            Command::Request { signed, input, target, reply } => Box::pin(async move {
                let result = requests::command(shared, signed, input, target).await;
                let _ = reply.send(result);
            }),
            Command::Peer { proof, bytes, input, target, reply } => Box::pin(async move {
                let result = requests::peer(shared, proof, bytes, input, target).await;
                let _ = reply.send(result);
            }),
            Command::Operation { signed, input, target, reply } => Box::pin(async move {
                let result = requests::operation(shared, signed, input, target).await;
                let _ = reply.send(result);
            }),
            _ => Box::pin(async {}),
        };
        work
    }
    fn handle_global_command(shared: Self::Shared, _: &mut (), command: Command) -> impl Future<Output = ()> + Send {
        let work: Pin<Box<dyn Future<Output = ()> + Send>> = match command {
            Command::InspectStorage { configuration, reply } => Box::pin(async move {
                let _ = reply.send(shared.stores.inspect(configuration).await);
            }),
            Command::OpenStorage { storage_id, target, reply } => Box::pin(async move {
                let _ = reply.send(storage_open::open(&shared, storage_id, target).await);
            }),
            Command::InstallEvaluation { input, reply } => Box::pin(async move {
                let work = shared.tasks.spawn({
                    let shared = shared.clone();
                    async move {
                        let world = input.world.clone();
                        let store = ready_for(&shared, &world).await?;
                        let authority = shared.authority.evaluation_authority(world.clone(), &input.evaluation)?;
                        let receipt = super::access::install_evaluation(store, shared.authority.clone(), input).await?;
                        let _ = world_authorities(&shared, &world).evaluation.set(authority);
                        Ok::<_, Error>(receipt)
                    }
                });
                let result = work.await.map_err(|cause| closed().caused(cause)).and_then(|result| result);
                let _ = reply.send(result);
            }),
            Command::GrantAccess { input, reply } => Box::pin(async move {
                let work = shared.tasks.spawn({
                    let shared = shared.clone();
                    async move {
                        let store = ready_for(&shared, &input.world).await?;
                        super::access::grant(store, shared.authority.clone(), input).await
                    }
                });
                let result = work.await.map_err(|cause| closed().caused(cause)).and_then(|result| result);
                let _ = reply.send(result);
            }),
            Command::Provision { input, target, reply } => Box::pin(async move {
                let _retry = shared.startup_retry.lock().await;
                let result = match provision_world(&shared, input).await {
                    Ok((store, provisioned)) => {
                        let initial = match shared.storage.borrow().clone() {
                            Storage::Ready(initial) | Storage::Failed { store: Some(initial), .. } => initial,
                            _ => store.clone(),
                        };
                        let initialized = async {
                            if store.identity_receipt().storage_id() != initial.identity_receipt().storage_id() {
                                if let Err(error) = initialize(&shared, &store, target.clone(), Some(&provisioned.commit.world)).await {
                                    shared.startup_inventory.store(false, Ordering::Release);
                                    return Err(error);
                                }
                            }
                            initialize(&shared, &initial, target, Some(&provisioned.commit.world)).await?;
                            publish_ready(&shared, initial.clone())
                        }.await;
                        if let Err(error) = &initialized {
                            shared.storage.send_if_modified(|state| match state {
                                Storage::Failed { .. } => {
                                    *state = Storage::Failed { error: error.clone(), store: Some(initial.clone()) };
                                    true
                                }
                                _ => false,
                            });
                        }
                        initialized.map(|()| provisioned)
                    },
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }),
            Command::Initialize(configuration, initial, target) => Box::pin(async move {
                let _retry = shared.startup_retry.lock().await;
                let not_configured = matches!(&configuration, StoreConfiguration::NotConfigured);
                let initialized = shared.stores.initialize(configuration).await;
                let state = match initialized {
                    Ok(store) => match async {
                        if let Some(input) = initial { provision_world(&shared, input).await?; }
                        initialize(&shared, &store, target, None).await
                    }.await {
                        Ok(()) => Storage::Ready(store),
                        Err(error) => Storage::Failed { error, store: Some(store) },
                    },
                    Err(error) => Storage::Failed { error, store: None },
                };
                if !not_configured {
                    if let Storage::Failed { error, .. } = &state {
                        record_initialization_diagnostic(&shared, "initialize", error.clone());
                    }
                }
                shared.storage.send_replace(state);
            }),
            _ => Box::pin(async {}),
        };
        work
    }
    async fn handle_direct_query(shared: Self::Shared, query: Query) {
        match query {
            Query::Request { signed, input, reply } => {
                let work = shared.tasks.spawn(requests::query(shared.clone(), signed, input));
                let result = work.await.map_err(|cause| closed().caused(cause)).and_then(|result| result);
                let _ = reply.send(result);
            }
            Query::Status { signed, key, reply } => {
                let result = match readable_for(&shared, &key.world).await {
                    Ok((store, _)) => operation::status(&store, shared.ingress.clone(), signed, key).await,
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            Query::Recovery { world, reply } => {
                let result = match ready_for(&shared, &world).await { Ok(store) => recovery::load(&store, world).await, Err(error) => Err(error) };
                let _ = reply.send(result);
            }
            Query::EvaluationStatus { world, reply } => {
                let result = async {
                    let store = ready_for(&shared, &world).await?;
                    let installed = restore_evaluation(&shared, &store, &world).await?;
                    Ok(super::EvaluationStatus { world, configured: installed.is_some(), commit_id: installed.map(|installed| installed.commit_id) })
                }.await;
                let _ = reply.send(result);
            }
        }
    }
    async fn handle_keyed_query(shared: Self::Shared, _: Self::Key, _: &mut (), query: Query) { Self::handle_direct_query(shared, query).await; }
    async fn handle_global_query(shared: Self::Shared, _: &mut (), query: Query) { Self::handle_direct_query(shared, query).await; }
    async fn handle_exclusive_query(shared: Self::Shared, _: &mut (), query: Query) { Self::handle_direct_query(shared, query).await; }
}

async fn provision_world(shared: &Shared, input: Provision) -> Result<(WorldStore, Provisioned), Error> {
    let world = input.world.clone();
    let commit_id = input.commit_id.clone();
    let evaluation = input.evaluation.clone();
    if let Some(config) = &evaluation { shared.authority.evaluation_authority(world.clone(), config)?; }
    let evaluation_digest = evaluation.as_ref().map(|config| crate::authorization::installation_digest(
        &world, config, &input.principals, &input.grants, &input.policies, &input.retention_policies)).transpose()?;
    let maintenance = input.maintenance.as_ref().map(|config| shared.authority.maintenance_authority(world.clone(), config)).transpose()?;
    let store = shared.stores.reopen(&input.storage_id).await?;
    let key = (store.identity_receipt().storage_id().to_owned(), world.clone());
    let slot = world_authorities(shared, &world);
    let cached = shared.world_resources.lock().expect("world resources poisoned").get(&key)
        .and_then(|resources| resources.as_ref().ok()).cloned();
    let resources = match cached {
        Some(resources) => resources,
        None => shared.resources.as_ref().map_err(Clone::clone)?.open(&store, &world,
            shared.live.clone(), shared.tasks.clone(), slot.clone())?,
    };
    let attempt = provision::provision(&store, shared.authority.clone(), resources.content.clone(), input).await;
    if let Some(pending) = attempt.pending {
        shared.pending_provisions.lock().expect("world provision custody poisoned")
            .entry((pending.world.clone(), pending.commit_id.clone())).or_insert(pending);
    }
    let provisioned = attempt.result?;
    if let (Some(configuration), Some(digest)) = (evaluation, evaluation_digest) {
        super::access::backfill_evaluation(&store, &world, &commit_id, configuration, digest).await?;
    }
    if let Some(authority) = maintenance { let _ = slot.maintenance.set(authority); }
    restore_evaluation(shared, &store, &world).await?;
    shared.world_resources.lock().expect("world resources poisoned").entry(key)
        .and_modify(|cached| { if cached.is_err() { *cached = Ok(resources.clone()); } })
        .or_insert(Ok(resources));
    shared.pending_provisions.lock().expect("world provision custody poisoned").remove(&(world.clone(), commit_id));
    shared.worlds.lock().expect("world set poisoned").insert(world);
    Ok((store, provisioned))
}

// The caller owns startup_retry through storage selection and readiness publication.
async fn initialize(shared: &Arc<Shared>, store: &WorldStore, target: WorldHandle, retry_world: Option<&WorldRef>) -> Result<(), Error> {
    shared.startup_inventory.store(false, Ordering::Release);
    let worlds = store.worlds(&shared.authority).await?;
    shared.worlds.lock().expect("world set poisoned").extend(worlds.iter().cloned());
    let mut failure: Option<Error> = None;
    for world in worlds {
        let result = async {
            let current = locate(shared, store, &world).await?;
            recover_stage_cleanup(shared, &current, &world).await?;
            if let Some(input) = transfer::recover_startup(shared, &current, &world).await? {
                let cut = input.cut.clone();
                let work = shared.tasks.spawn_transfer(cut, transfer::execute(shared.clone(), input, target.clone()))?;
                work.await.map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))??;
            } else {
                initialize_world(shared, &current, &world, retry_world == Some(&world)).await?;
                let resources = resources(shared, &current, &world)?;
                for record in recovery::cleanup_candidates(&current, world.clone()).await? {
                    recovery::cleanup_committed(&current, &resources, &shared.authority, &world,
                        &record.receipt.accepted.operation_id).await?;
                }
            }
            let resources = resources(shared, &current, &world)?;
            maintenance::recover_sources(target.clone(), current.clone(), resources.clone(), world.clone()).await?;
            let parents = current.snapshot(world.clone(), |snapshot| Box::pin(async move {
                crate::sources::sync::segment_parents(snapshot).await.map_err(Error::from)
            })).await?;
            for parent in parents {
                maintenance::start_at(target.clone(), current.clone(), resources.clone(), parent).await?;
            }
            maintenance::schedule(target.clone(), current, resources, world.clone())?;
            Ok::<_, Error>(())
        }.await;
        if let Err(error) = result {
            shared.startup_failures.lock().expect("world startup failures poisoned").insert(world, error.clone());
            failure = Some(match failure { Some(previous) => previous.with_related(error), None => error });
        } else {
            shared.startup_failures.lock().expect("world startup failures poisoned").remove(&world);
        }
    }
    shared.startup_inventory.store(true, Ordering::Release);
    match failure { Some(error) => Err(error), None => Ok(()) }
}

async fn restore_evaluation(shared: &Shared, store: &WorldStore, world: &WorldRef) -> Result<Option<crate::authorization::InstalledEvaluation>, Error> {
    let installed = super::access::load_evaluation(store, world).await?;
    if let Some(installed) = &installed {
        let authority = shared.authority.evaluation_authority(world.clone(), &installed.configuration)?;
        let _ = world_authorities(shared, world).evaluation.set(authority);
    }
    Ok(installed)
}

fn world_authorities(shared: &Shared, world: &WorldRef) -> Arc<super::resources::WorldAuthorities> {
    shared.authorities.lock().expect("world authorities poisoned").entry(world.clone()).or_default().clone()
}

fn resources(shared: &Shared, store: &WorldStore, world: &WorldRef) -> Result<Arc<super::resources::Resources>, Error> {
    let mut worlds = shared.world_resources.lock().expect("world resources poisoned");
    worlds.entry((store.identity_receipt().storage_id().to_owned(), world.clone())).or_insert_with(|| {
        shared.resources.as_ref().map_err(Clone::clone)?.open(store, world, shared.live.clone(), shared.tasks.clone(), world_authorities(shared, world))
    }).clone()
}

async fn recover_stage_cleanup(shared: &Shared, store: &WorldStore, world: &WorldRef) -> Result<(), Error> {
    let resources = resources(shared, store, world)?;
    let checkpoints = crate::extensions::migration::stage_cleanup_inventory(store, &shared.authority, world).await?;
    for checkpoint in checkpoints {
        let outcome = super::workflows::activation::recover_stage_cleanup(store, &resources.content,
            &shared.authority, world, &checkpoint).await?;
        match outcome {
            crate::content::StageCleanupOutcome::Local | crate::content::StageCleanupOutcome::NonLocalOwner => {
                resources.bindings.release_stage_checkpoint(world, &checkpoint);
                shared.stage_cleanup.lock().expect("world stage cleanup outcomes poisoned")
                    .insert((store.identity_receipt().storage_id().to_owned(), world.clone(), checkpoint), outcome);
            }
        }
    }
    Ok(())
}

async fn initialize_world(shared: &Shared, store: &WorldStore, world: &WorldRef, explicit_retry: bool) -> Result<(), Error> {
    if !explicit_retry {
        if let Some(error) = shared.startup_failures.lock().expect("world startup failures poisoned").get(world).cloned() { return Err(error); }
        if shared.startup_reports.lock().expect("world startup reports poisoned").contains_key(world) { return Ok(()); }
    }
    let locator = shared.locator.as_ref().map_err(Clone::clone)?;
    store.initialize_locator(&shared.authority, world, locator.as_ref()).await?;
    restore_evaluation(shared, store, world).await?;
    let world_resources = resources(shared, store, world)?;
    let configured = shared.resources.as_ref().map_err(Clone::clone)?;
    let deadline = Instant::now() + configured.preparation.execution_policy().cleanup_timeout;
    let previous = shared.startup_reports.lock().expect("world startup reports poisoned").remove(world);
    if let Some(mut report) = previous {
        let retried = crate::extensions::lifecycle::retry_startup(store, &shared.authority, world.clone(), &world_resources.inventory,
            &world_resources.bindings, &shared.live, &configured.preparation, shared.cancellation.clone(), deadline, &mut report)
            .await.map_err(Error::from);
        let recorded = record_startup(shared, world, report);
        if let Err(error) = retried {
            return Err(match recorded { Ok(()) => error, Err(recorded) => error.with_related(recorded) });
        }
        recorded
    } else {
        let report = crate::extensions::lifecycle::startup(store, &shared.authority, world.clone(), &world_resources.inventory,
            &world_resources.bindings, &shared.live, &configured.preparation, shared.cancellation.clone(), deadline).await.map_err(Error::from)?;
        record_startup(shared, world, report)
    }
}

fn record_startup(shared: &Shared, world: &WorldRef, mut report: crate::extensions::lifecycle::StartupReport) -> Result<(), Error> {
    let mut errors = Vec::new();
    for (id, cause) in std::mem::take(&mut report.blocked_graphs) {
        let error = Error::from(cause);
        platform::trace::runtime_trace("world.startup.graph_failed", || {
            let failure = error.safe_failure();
            let native_reason = std::error::Error::source(&error)
                .and_then(|cause| cause.downcast_ref::<SourceError>())
                .and_then(SourceError::native_prepare_reason);
            serde_json::json!({
                "code": failure.code,
                "failureStage": failure.stage,
                "diagnosticIdHash": platform::trace::identifier_hash(failure.diagnostic_id.as_str()),
                "lockIdHash": platform::trace::identifier_hash(id.as_str()),
                "nativeReason": native_reason,
            })
        });
        report.blocked_graphs.insert(id, crate::extensions::lifecycle::LifecycleError::Binding(
            crate::extensions::bindings::BindingError::Operation(error.clone())));
        errors.push(error);
    }
    errors.extend(report.blocked_heads.values().chain(report.blocked_channels.values()).chain(report.blocked_retirements.values())
        .map(|failure| Error::from(crate::extensions::bindings::BindingError::from(failure.clone()))));
    if !report.retained.is_empty() {
        errors.push(Error::new("world.startup_retained", FailureStage::Prepare,
            "世界启动仍持有未完成的运行资源。", ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::Refresh));
    }
    let error = errors.into_iter().reduce(Error::with_related);
    shared.startup_reports.lock().expect("world startup reports poisoned").insert(world.clone(), report);
    let mut failures = shared.startup_failures.lock().expect("world startup failures poisoned");
    match error {
        Some(error) => { failures.insert(world.clone(), error.clone()); Err(error) }
        None => { failures.remove(world); Ok(()) }
    }
}

fn local_startup_failure(error: &Error) -> bool {
    if error.cleanup_errors().next().is_some() || error.unresolved_phase().is_some()
        || !error.related_errors().iter().all(local_startup_failure) {
        return false;
    }
    let mut cause = std::error::Error::source(error);
    while let Some(current) = cause {
        if current.is::<StoreError>()
            || current.downcast_ref::<crate::extensions::package::PackageError>().is_some_and(|error| error.cleanup_failed())
            || current.downcast_ref::<SourceError>().is_some_and(|error| !local_source_failure(&error.failure)
                || error.related_errors().iter().any(|related| !local_source_failure(&related.failure))) {
            return false;
        }
        cause = current.source();
    }
    match &error.safe_failure().details {
        ApiFailure::Operation(failure) => local_operation_failure(failure),
        ApiFailure::Authorization(_) | ApiFailure::NotConfigured => true,
        _ => false,
    }
}

fn local_operation_failure(failure: &world_protocol::operation::OperationFailure) -> bool {
    use world_protocol::{bindings::BindingFailure as B, lifecycle::LifecycleFailure as L,
        operation::OperationFailure as O, package::PackageFailure as P, process::ProcessFailure as R};
    match failure {
        O::Binding(B::LockRetiring { .. } | B::PackageUnavailable { .. } | B::Quarantined { .. }
            | B::ConfigurationChanged { .. } | B::MissingRequiredProvider { .. } | B::MissingNode { .. }
            | B::MissingPort { .. } | B::TrustBoundary { .. }) => true,
        O::Package(P::ConfigInvalid { .. } | P::FileMissing { .. } | P::TargetUnavailable { .. }
            | P::ArtifactInvalid { .. } | P::DependencyMissing { .. } | P::DependencyConflict { .. }
            | P::ContractMismatch { .. } | P::SignatureMissing | P::SignatureInvalid | P::PublisherUntrusted
            | P::ProcessNotTrusted | P::NativeNotTrusted | P::IoRead) => true,
        O::Lifecycle(L::MissingInstall { .. } | L::MissingConfiguration { .. } | L::MissingTrust { .. }
            | L::DependencyMissing { .. } | L::PrepareFailed { .. } | L::AcquisitionClosed
            | L::AuthorizationRevoked | L::ConcurrentCallLimit { .. }) => true,
        O::Process(R::SpawnFailed | R::SandboxUnavailable | R::StdioFailed | R::ReadinessFailed
            | R::HandshakeTimeout | R::HandshakeMismatch | R::ContractMismatch { .. } | R::ChildExited { .. }) => true,
        O::Authorization(_) | O::NotConfigured => true,
        O::Source(failure) => local_source_failure(failure),
        _ => false,
    }
}

fn local_source_failure(failure: &world_protocol::sources::SourceFailure) -> bool {
    use world_protocol::{operation::OperationFailure as O, process::HostFailure as H, sources::SourceFailure as S};
    match failure {
        S::Binding { failure } => local_operation_failure(&O::Binding(failure.clone())),
        S::Lifecycle { failure } => local_operation_failure(&O::Lifecycle(failure.clone())),
        S::Package { failure } => local_operation_failure(&O::Package(failure.clone())),
        S::PluginInvocation { failure } => match failure.as_ref() {
            H::Operation(failure) => local_operation_failure(failure),
            H::Process(failure) => local_operation_failure(&O::Process(failure.clone())),
            H::Binding(failure) => local_operation_failure(&O::Binding(failure.clone())),
            H::Source(failure) => local_source_failure(failure),
            H::Authorization(_) => true,
            _ => false,
        },
        S::Authorization { .. } | S::ConnectionMissing { .. } | S::Credential { .. }
            | S::Authentication | S::PermissionDenied | S::Connection | S::ConnectTimeout
            | S::ReadTimeout | S::RateLimited { .. } | S::ServiceUnavailable | S::CapabilityMissing { .. }
            | S::InvalidPlan { .. } => true,
        _ => false,
    }
}

fn record_initialization_diagnostic(shared: &Shared, producer: &'static str, error: Error) {
    platform::trace::runtime_trace("world.startup.diagnostic_recorded", || {
        let failure = error.safe_failure();
        serde_json::json!({
            "producer": producer,
            "code": failure.code,
            "failureStage": failure.stage,
            "diagnosticIdHash": platform::trace::identifier_hash(failure.diagnostic_id.as_str()),
        })
    });
    shared.initialization_diagnostics.lock().expect("world diagnostics poisoned").push(error);
}

fn publish_ready(shared: &Shared, store: WorldStore) -> Result<(), Error> {
    if shared.closing.load(Ordering::Acquire) || shared.cancellation.is_cancelled() { return Err(closed()); }
    if let Some(pending) = shared.pending_provisions.lock().expect("world provision custody poisoned").values().next() {
        return Err(StoreError::new(CommitFailure::CommitIndeterminate { commit_id: pending.commit_id.clone() }, FailureStage::Commit).into());
    }
    let worlds = shared.worlds.lock().expect("world set poisoned");
    let reports = shared.startup_reports.lock().expect("world startup reports poisoned");
    let failures = shared.startup_failures.lock().expect("world startup failures poisoned");
    if let Some(error) = failures.values().next() { return Err(error.clone()); }
    if !shared.startup_inventory.load(Ordering::Acquire) || worlds.iter().any(|world| !reports.contains_key(world)) {
        return Err(Error::new("world.startup_incomplete", FailureStage::Prepare, "世界启动尚未完成。",
            ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::Refresh));
    }
    shared.storage.send_replace(Storage::Ready(store));
    Ok(())
}

fn restore_ready(shared: &Shared) -> Result<(), Error> {
    if shared.closing.load(Ordering::Acquire) || shared.cancellation.is_cancelled() { return Err(closed()); }
    let worlds = shared.worlds.lock().expect("world set poisoned");
    let reports = shared.startup_reports.lock().expect("world startup reports poisoned");
    let failures = shared.startup_failures.lock().expect("world startup failures poisoned");
    if shared.startup_inventory.load(Ordering::Acquire) && failures.is_empty()
        && shared.pending_provisions.lock().expect("world provision custody poisoned").is_empty()
        && worlds.iter().all(|world| reports.contains_key(world)) {
        shared.storage.send_if_modified(|state| match state {
            Storage::Failed { store: Some(store), .. } => { *state = Storage::Ready(store.clone()); true }
            _ => false,
        });
    }
    Ok(())
}

async fn locate(shared: &Shared, initial: &WorldStore, world: &WorldRef) -> Result<WorldStore, Error> {
    let locator = shared.locator.as_ref().map_err(Clone::clone)?;
    let record = match locator.read(world).await? {
        Some(record) => record,
        None => initial.initialize_locator(&shared.authority, world, locator.as_ref()).await?,
    };
    if record.world != *world || record.generation.0 == 0 { return Err(StoreError::locator_conflict().into()); }
    shared.stores.open(&record.storage_id).await
}

async fn ready_for_operation(shared: &Shared, world: &WorldRef) -> Result<WorldStore, Error> {
    let initial = ready(shared).await?;
    locate(shared, &initial, world).await
}

// Connected storage is not execution readiness. Only metadata and the explicit
// package-repair allowlist may use a completed but blocked startup inventory.
async fn readable_for(shared: &Shared, world: &WorldRef) -> Result<(WorldStore, bool), Error> {
    shared.live.require_world_open(world)?;
    let mut state = shared.storage.subscribe();
    let (initial, maintenance) = loop {
        let current = state.borrow().clone();
        match current {
            Storage::Ready(store) => break (store, false),
            Storage::Failed { error, store } => {
                if !shared.startup_inventory.load(Ordering::Acquire)
                    || !shared.startup_reports.lock().expect("world startup reports poisoned").contains_key(world) {
                    return Err(error);
                }
                break (store.ok_or(error)?, true);
            }
            Storage::Initializing => state.changed().await.map_err(|_| closed())?,
        }
    };
    let store = locate(shared, &initial, world).await?;
    shared.live.require_world_open(world)?;
    Ok((store, maintenance))
}

async fn ready_for_maintenance(shared: &Shared, world: &WorldRef) -> Result<(WorldStore, bool), Error> {
    let admitted = readable_for(shared, world).await?;
    if !shared.pending_provisions.lock().expect("world provision custody poisoned").is_empty() {
        return Err(Error::internal(FailureStage::Recover));
    }
    let reports = shared.startup_reports.lock().expect("world startup reports poisoned");
    let failures = shared.startup_failures.lock().expect("world startup failures poisoned");
    if let Some(error) = failures.get(world) {
        let repairable = reports.get(world).is_some_and(|report| {
            !report.blocked_graphs.is_empty() && report.retained.is_empty()
                && report.blocked_heads.is_empty() && report.blocked_channels.is_empty()
                && report.blocked_retirements.is_empty() && local_startup_failure(error)
        });
        if !repairable { return Err(error.clone()); }
    }
    Ok(admitted)
}

async fn ready_for(shared: &Shared, world: &WorldRef) -> Result<WorldStore, Error> {
    shared.live.require_world_open(world)?;
    let initial = ready(shared).await?;
    let store = locate(shared, &initial, world).await?;
    shared.live.require_world_open(world)?;
    if let Some(error) = shared.startup_failures.lock().expect("world startup failures poisoned").get(world).cloned() { return Err(error); }
    Ok(store)
}

async fn ready(shared: &Shared) -> Result<WorldStore, Error> {
    let mut state = shared.storage.subscribe();
    loop {
        let current = state.borrow().clone();
        match current {
            Storage::Ready(store) => return Ok(store),
            Storage::Failed { error, .. } => return Err(error),
            Storage::Initializing => state.changed().await.map_err(|_| closed())?,
        }
    }
}
pub(super) fn closed() -> Error {
    Error::new("world.closed", FailureStage::Admission, "世界正在关闭，未接纳新请求。",
        ApiFailure::Operation(world_protocol::operation::OperationFailure::Commit(CommitFailure::Closed)), Recovery::None)
}
fn deadline_error(stage: FailureStage) -> Error {
    Error::new("world.quiesce_deadline", stage, "关闭截止时间已到，未完成资源仍由世界持有。",
        ApiFailure::Transport(TransportFailure::DeadlineExpired), Recovery::ManualReview)
}
