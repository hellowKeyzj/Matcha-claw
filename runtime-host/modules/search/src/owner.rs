use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};

use foundation::execution::{CommandRoute, OwnerSpec, QueryRoute};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use runtime_directory::RuntimeEndpointDirectorySource;
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout},
};

use crate::{
    RuntimeSearchPhase, RuntimeSearchPort, RuntimeSearchProjection, SearchConfig, SearchError,
    SearchHit, SearchRuntimeState, SearchServicePhase, SearchServiceState, SearchSnapshot,
    SearchVerification, SearchVerifyRequest, store::Store,
};

const NATIVE_DEADLINE: Duration = Duration::from_secs(30);
const OBSERVE_DEADLINE: Duration = Duration::from_secs(2);

pub struct SearchOwnerInput {
    pub state_dir: PathBuf,
    pub service: Arc<searxng::Service>,
    pub runtime: Arc<dyn RuntimeSearchPort>,
    pub directory: Arc<dyn RuntimeEndpointDirectorySource>,
}

#[derive(Clone)]
pub(crate) struct Shared {
    service: Arc<searxng::Service>,
    runtime: Arc<dyn RuntimeSearchPort>,
    directory: Arc<dyn RuntimeEndpointDirectorySource>,
    snapshot: watch::Sender<SnapshotState>,
    stopping: watch::Sender<bool>,
}

enum SnapshotState {
    Initializing,
    Ready(SearchSnapshot),
    Failed(SearchError),
}

impl SnapshotState {
    fn snapshot(&self) -> Result<&SearchSnapshot, SearchError> {
        match self {
            Self::Initializing => Err(SearchError::initializing()),
            Self::Ready(snapshot) => Ok(snapshot),
            Self::Failed(error) => Err(*error),
        }
    }
}

pub(crate) enum Command {
    Initialize(PathBuf),
    Replace {
        expected_revision: u64,
        config: SearchConfig,
        reply: oneshot::Sender<Result<SearchSnapshot, SearchError>>,
    },
    Operate {
        operation: Operation,
        reply: oneshot::Sender<Result<SearchSnapshot, SearchError>>,
    },
}

#[derive(Clone, Copy)]
pub(crate) enum Operation {
    Prepare,
    Restart,
    Stop,
    StartSaved,
    Reconcile,
}

pub(crate) enum Query {
    Snapshot(oneshot::Sender<Result<SearchSnapshot, SearchError>>),
    Verify(
        SearchVerifyRequest,
        oneshot::Sender<Result<SearchVerification, SearchError>>,
    ),
    Logs(oneshot::Sender<Vec<String>>),
}

pub(crate) struct SearchOwner {
    pub shared: Shared,
}

#[derive(Default)]
pub(crate) struct GlobalState {
    store: Option<Store>,
    initialization: Option<JoinHandle<Result<Store, SearchError>>>,
}

impl SearchOwner {
    pub fn new(input: SearchOwnerInput) -> Self {
        Self {
            shared: Shared {
                service: input.service,
                runtime: input.runtime,
                directory: input.directory,
                snapshot: watch::channel(SnapshotState::Initializing).0,
                stopping: watch::channel(false).0,
            },
        }
    }
}

impl Shared {
    pub fn begin_shutdown(&self) {
        self.stopping.send_replace(true);
    }

    pub fn check_accepting(&self) -> Result<(), SearchError> {
        if *self.stopping.borrow() {
            Err(SearchError::unavailable())
        } else {
            Ok(())
        }
    }

    pub fn check_initialized(&self) -> Result<(), SearchError> {
        self.snapshot.borrow().snapshot()?;
        self.check_accepting()
    }

    pub async fn wait_initialized(&self) -> Result<(), SearchError> {
        let mut snapshot = self.snapshot.subscribe();
        let initialized = snapshot
            .wait_for(|snapshot| !matches!(snapshot, SnapshotState::Initializing))
            .await
            .map_err(|_| SearchError::unavailable())?;
        initialized.snapshot().map(|_| ())
    }
}

async fn finish_initialization(shared: &Shared, global: &mut GlobalState) {
    let Some(initialization) = global.initialization.as_mut() else {
        return;
    };
    // Keep the join in actor state if its handler is cancelled while Store::open changes ACLs.
    let result = initialization
        .await
        .unwrap_or_else(|_| Err(SearchError::storage()));
    global.initialization = None;
    match result {
        Ok(store) => {
            let saved = store.saved();
            let snapshot = SearchSnapshot {
                revision: saved.revision,
                applied_revision: None,
                config: saved.config.clone(),
                service: SearchServiceState {
                    phase: SearchServicePhase::Stopped,
                    error: None,
                },
                engines: Vec::new(),
                runtimes: Vec::new(),
            };
            global.store = Some(store);
            shared.snapshot.send_replace(SnapshotState::Ready(snapshot));
        }
        Err(error) => {
            shared.snapshot.send_replace(SnapshotState::Failed(error));
        }
    }
}

impl OwnerSpec for SearchOwner {
    type Command = Command;
    type Query = Query;
    type Key = ();
    type Shared = Shared;
    type GlobalState = GlobalState;
    type LaneState = ();

    fn split(self) -> (Shared, GlobalState) {
        (self.shared, GlobalState::default())
    }
    fn route_command(_: &Command) -> CommandRoute<()> {
        CommandRoute::Global
    }
    fn route_query(_: &Query) -> QueryRoute<()> {
        QueryRoute::Direct
    }
    fn open_lane(_: &Shared, _: &()) {}
    async fn handle_keyed_command(_: Shared, _: (), _: &mut (), _: Command) {}
    async fn handle_keyed_query(_: Shared, _: (), _: &mut (), _: Query) {}
    async fn handle_global_query(_: Shared, _: &mut GlobalState, _: Query) {}
    async fn handle_exclusive_query(_: Shared, _: &mut GlobalState, _: Query) {}

    async fn handle_global_command(shared: Shared, global: &mut GlobalState, command: Command) {
        let (result, reply) = match command {
            Command::Initialize(path) => {
                global.initialization =
                    Some(tokio::task::spawn_blocking(move || Store::open(&path)));
                finish_initialization(&shared, global).await;
                return;
            }
            Command::Replace {
                expected_revision,
                config,
                reply,
            } => (
                match initialized_store(&shared, global) {
                    Ok(store) => replace(&shared, store, expected_revision, config).await,
                    Err(error) => Err(error),
                },
                reply,
            ),
            Command::Operate { operation, reply } => (
                match initialized_store(&shared, global) {
                    Ok(store) => operate(&shared, store, operation).await,
                    Err(error) => Err(error),
                },
                reply,
            ),
        };
        let _ = reply.send(result);
    }

    async fn handle_direct_query(shared: Shared, query: Query) {
        match query {
            Query::Snapshot(reply) => {
                let _ = reply.send(snapshot(&shared).await);
            }
            Query::Verify(request, reply) => {
                // Drain waits for Direct handlers before shutdown; drop the actual I/O future here.
                let mut stopping = shared.stopping.subscribe();
                let result = tokio::select! {
                    biased;
                    _ = stopping.wait_for(|stopping| *stopping) => Err(SearchError::unavailable()),
                    result = verify(&shared, request) => result,
                };
                let _ = reply.send(result);
            }
            Query::Logs(reply) => {
                let _ = reply.send(shared.service.logs());
            }
        }
    }

    async fn shutdown(shared: Shared, global: &mut GlobalState, _: Vec<((), ())>) {
        shared.begin_shutdown();
        finish_initialization(&shared, global).await;
        if let Err(error) = shutdown(&shared, global.store.is_some()).await {
            panic!("[search] shutdown failed: {error}");
        }
    }
}

fn initialized_store<'a>(
    shared: &Shared,
    global: &'a mut GlobalState,
) -> Result<&'a mut Store, SearchError> {
    shared.check_initialized()?;
    global.store.as_mut().ok_or_else(SearchError::storage)
}

fn read_snapshot(shared: &Shared) -> Result<SearchSnapshot, SearchError> {
    shared.snapshot.borrow().snapshot().cloned()
}

fn update(shared: &Shared, change: impl FnOnce(&mut SearchSnapshot)) {
    shared.snapshot.send_modify(|snapshot| {
        let SnapshotState::Ready(snapshot) = snapshot else {
            panic!("search store is initialized");
        };
        change(snapshot);
    });
}

fn service_phase(shared: &Shared, phase: SearchServicePhase, error: Option<SearchError>) {
    update(shared, |snapshot| {
        snapshot.service = SearchServiceState {
            phase,
            error: error.map(|error| error.to_string()),
        };
        if phase != SearchServicePhase::Running {
            snapshot.applied_revision = None;
        }
    });
}

fn publish_saved(shared: &Shared, store: &Store) {
    update(shared, |snapshot| {
        snapshot.revision = store.saved().revision;
        snapshot.config = store.saved().config.clone();
    });
}

async fn local_endpoints(
    shared: &Shared,
    deadline: Duration,
) -> Result<Vec<RuntimeEndpoint>, SearchError> {
    let directory = timeout(deadline, shared.directory.runtime_endpoint_directory())
        .await
        .map_err(|_| SearchError::unavailable())?
        .map_err(|_| SearchError::unavailable())?;
    directory
        .endpoints()
        .iter()
        .filter(|endpoint| endpoint.location().kind() == "local")
        .map(|endpoint| {
            RuntimeEndpoint::try_new(
                endpoint.runtime_adapter_id(),
                endpoint.runtime_instance_id(),
            )
            .map_err(|_| SearchError::unavailable())
        })
        .collect()
}

async fn replace(
    shared: &Shared,
    store: &mut Store,
    expected_revision: u64,
    mut config: SearchConfig,
) -> Result<SearchSnapshot, SearchError> {
    if store.saved().revision != expected_revision {
        return Err(SearchError::conflict());
    }
    config.validate()?;
    let endpoints = local_endpoints(shared, OBSERVE_DEADLINE).await?;
    if config
        .runtimes
        .iter()
        .any(|runtime| !endpoints.contains(&runtime.endpoint))
    {
        return Err(SearchError::invalid());
    }
    if !store.is_persisted() || config.enabled || !config.engines.is_empty() {
        let names = shared
            .service
            .validate_config(&config.service_config())
            .map_err(SearchError::from)?;
        if !store.is_persisted() {
            let configured: HashSet<_> = config.engines.iter().map(|engine| &engine.name).collect();
            let disabled = names
                .into_iter()
                .filter(|name| !configured.contains(name))
                .map(|name| crate::SearchEngineConfig {
                    name,
                    enabled: false,
                    timeout_seconds: None,
                    weight: None,
                })
                .collect::<Vec<_>>();
            config.engines.extend(disabled);
        }
    }
    let observed = read_snapshot(shared)?;
    if config.categories.iter().any(|category| {
        !observed
            .engines
            .iter()
            .any(|engine| engine.categories.contains(category))
    }) && config.categories != ["general"]
        && !config.categories.is_empty()
    {
        return Err(SearchError::catalog_required());
    }
    store.replace(expected_revision, config)?;
    update(shared, |snapshot| snapshot.applied_revision = None);
    publish_saved(shared, store);
    apply(shared, store, true).await
}

async fn operate(
    shared: &Shared,
    store: &mut Store,
    operation: Operation,
) -> Result<SearchSnapshot, SearchError> {
    match operation {
        Operation::Stop => {
            let restored = restore_runtimes(shared).await;
            let stopped = shared.service.stop().await.map_err(SearchError::from);
            service_phase(
                shared,
                if stopped.is_ok() {
                    SearchServicePhase::Stopped
                } else {
                    SearchServicePhase::Failed
                },
                stopped.as_ref().err().copied(),
            );
            restored?;
            stopped?;
            snapshot(shared).await
        }
        Operation::StartSaved
            if !store.saved().config.enabled || !store.saved().config.auto_start =>
        {
            restore_runtimes(shared).await?;
            snapshot(shared).await
        }
        Operation::Reconcile => {
            if !store.saved().config.enabled {
                return apply(shared, store, false).await;
            }
            if shared.service.is_running() {
                settle_runtimes(shared, store, false).await?;
            }
            snapshot(shared).await
        }
        Operation::Prepare => {
            service_phase(shared, SearchServicePhase::Preparing, None);
            if let Err(error) = shared.service.prepare().await.map_err(SearchError::from) {
                service_phase(shared, SearchServicePhase::Failed, Some(error));
                return Err(error);
            }
            if store.saved().config.enabled {
                apply(shared, store, false).await
            } else {
                service_phase(shared, SearchServicePhase::Stopped, None);
                snapshot(shared).await
            }
        }
        Operation::Restart | Operation::StartSaved => apply(shared, store, false).await,
    }
}

async fn apply(
    shared: &Shared,
    store: &mut Store,
    authorize: bool,
) -> Result<SearchSnapshot, SearchError> {
    if !store.saved().config.enabled {
        let restored = restore_runtimes(shared).await;
        let stopped = shared.service.stop().await.map_err(SearchError::from);
        service_phase(
            shared,
            if stopped.is_ok() {
                SearchServicePhase::Stopped
            } else {
                SearchServicePhase::Failed
            },
            stopped.as_ref().err().copied(),
        );
        let settled = restored?;
        stopped?;
        if settled {
            store.applied()?;
            update(shared, |snapshot| {
                snapshot.applied_revision = Some(store.saved().revision)
            });
            publish_saved(shared, store);
        }
        return snapshot(shared).await;
    }
    service_phase(shared, SearchServicePhase::Starting, None);
    let config = store.saved().config.service_config();
    if let Err(error) = shared
        .service
        .start(&config)
        .await
        .map_err(SearchError::from)
    {
        service_phase(shared, SearchServicePhase::Failed, Some(error));
        return Err(error);
    }
    let engines = match shared.service.catalog().await.map_err(SearchError::from) {
        Ok(engines) => engines,
        Err(error) => {
            service_phase(shared, SearchServicePhase::Failed, Some(error));
            return Err(error);
        }
    };
    update(shared, |snapshot| {
        snapshot.engines = engines.into_iter().map(Into::into).collect()
    });
    service_phase(shared, SearchServicePhase::Running, None);
    settle_runtimes(shared, store, authorize).await?;
    snapshot(shared).await
}

async fn settle_runtimes(
    shared: &Shared,
    store: &mut Store,
    authorize: bool,
) -> Result<(), SearchError> {
    let config = &store.saved().config;
    let base_url = shared
        .service
        .base_url()
        .ok_or_else(SearchError::unavailable)?;
    let projection = RuntimeSearchProjection {
        base_url,
        categories: config.categories.join(","),
        language: config.language.clone(),
        safe_search: config.safe_search,
        result_count: config.result_count,
        revision: store.saved().revision.to_string(),
    };
    let mut states = Vec::new();
    let mut failure = None;
    let mut settled = true;
    for endpoint in local_endpoints(shared, OBSERVE_DEADLINE).await? {
        let enabled = config
            .runtimes
            .iter()
            .any(|runtime| runtime.enabled && runtime.endpoint == endpoint);
        let applied = timeout(
            NATIVE_DEADLINE,
            shared.runtime.apply(
                &endpoint,
                enabled.then_some(&projection),
                authorize && enabled,
            ),
        )
        .await
        .unwrap_or_else(|_| Err(SearchError::unavailable()));
        let observed = match applied {
            Ok(RuntimeSearchPhase::PendingRestart) => Ok(RuntimeSearchPhase::PendingRestart),
            Ok(_) => timeout(OBSERVE_DEADLINE, shared.runtime.observe(&endpoint))
                .await
                .unwrap_or_else(|_| Err(SearchError::unavailable())),
            Err(error) => Err(error),
        };
        let (phase, error) = match observed {
            Ok(phase) => {
                settled &= if enabled {
                    phase == RuntimeSearchPhase::Ready
                } else {
                    matches!(
                        phase,
                        RuntimeSearchPhase::Disabled | RuntimeSearchPhase::NotConfigured
                    )
                };
                (phase, None)
            }
            Err(error) => {
                failure.get_or_insert(error);
                settled = false;
                (RuntimeSearchPhase::Failed, Some(error.to_string()))
            }
        };
        platform::trace::runtime_trace("search.runtime.apply", || {
            serde_json::json!({
                "revision": store.saved().revision,
                "authorize": authorize && enabled,
                "enabled": enabled,
                "phase": format!("{phase:?}"),
                "has_error": error.is_some(),
                "is_openclaw": endpoint.runtime_adapter_id() == "openclaw",
            })
        });
        states.push(SearchRuntimeState {
            endpoint,
            enabled,
            phase,
            error,
        });
    }
    update(shared, |snapshot| snapshot.runtimes = states);
    if let Some(error) = failure {
        return Err(error);
    }
    if settled {
        store.applied()?;
        update(shared, |snapshot| {
            snapshot.applied_revision = Some(store.saved().revision)
        });
        publish_saved(shared, store);
    } else {
        update(shared, |snapshot| snapshot.applied_revision = None);
    }
    Ok(())
}

async fn restore_runtimes(shared: &Shared) -> Result<bool, SearchError> {
    let mut failure = None;
    let mut settled = true;
    let mut states = Vec::new();
    let config = read_snapshot(shared)?.config;
    for endpoint in local_endpoints(shared, OBSERVE_DEADLINE).await? {
        let applied = timeout(
            NATIVE_DEADLINE,
            shared.runtime.apply(&endpoint, None, false),
        )
        .await
        .unwrap_or_else(|_| Err(SearchError::unavailable()));
        let observed = match applied {
            Ok(RuntimeSearchPhase::PendingRestart) => Ok(RuntimeSearchPhase::PendingRestart),
            Ok(_) => timeout(OBSERVE_DEADLINE, shared.runtime.observe(&endpoint))
                .await
                .unwrap_or_else(|_| Err(SearchError::unavailable())),
            Err(error) => Err(error),
        };
        let (phase, error) = match observed {
            Ok(phase) => {
                settled &= matches!(
                    phase,
                    RuntimeSearchPhase::Disabled | RuntimeSearchPhase::NotConfigured
                );
                (phase, None)
            }
            Err(error) => {
                failure.get_or_insert(error);
                settled = false;
                (RuntimeSearchPhase::Failed, Some(error.to_string()))
            }
        };
        let enabled = config
            .runtimes
            .iter()
            .any(|runtime| runtime.enabled && runtime.endpoint == endpoint);
        states.push(SearchRuntimeState {
            endpoint,
            enabled,
            phase,
            error,
        });
    }
    update(shared, |snapshot| {
        snapshot.runtimes = states;
        snapshot.applied_revision = None;
    });
    failure.map_or(Ok(settled), Err)
}

async fn snapshot(shared: &Shared) -> Result<SearchSnapshot, SearchError> {
    let mut snapshot = read_snapshot(shared)?;
    let running = shared.service.is_running();
    if snapshot.service.phase == SearchServicePhase::Running && !running {
        snapshot.service = SearchServiceState {
            phase: SearchServicePhase::Failed,
            error: Some(SearchError::unavailable().to_string()),
        };
    }
    let mut states = Vec::new();
    for endpoint in local_endpoints(shared, OBSERVE_DEADLINE).await? {
        let enabled = snapshot
            .config
            .runtimes
            .iter()
            .any(|runtime| runtime.enabled && runtime.endpoint == endpoint);
        let observed = timeout(OBSERVE_DEADLINE, shared.runtime.observe(&endpoint))
            .await
            .unwrap_or_else(|_| Err(SearchError::unavailable()));
        let previous = snapshot
            .runtimes
            .iter()
            .find(|runtime| runtime.endpoint == endpoint);
        let observed = match observed {
            Ok(RuntimeSearchPhase::Ready)
                if previous
                    .is_some_and(|runtime| runtime.phase == RuntimeSearchPhase::PendingRestart) =>
            {
                Ok(RuntimeSearchPhase::PendingRestart)
            }
            observed => observed,
        };
        let (phase, error) = match (observed, previous) {
            (Ok(RuntimeSearchPhase::Ready), _) if enabled && !running => (
                RuntimeSearchPhase::Failed,
                Some(SearchError::unavailable().to_string()),
            ),
            (
                Ok(RuntimeSearchPhase::Disabled | RuntimeSearchPhase::NotConfigured),
                Some(previous),
            ) if snapshot.config.enabled
                && enabled
                && previous.phase == RuntimeSearchPhase::Failed
                && previous.error.is_some() =>
            {
                (previous.phase, previous.error.clone())
            }
            (Ok(phase), _) => (phase, None),
            (Err(error), _) => (RuntimeSearchPhase::Failed, Some(error.to_string())),
        };
        states.push(SearchRuntimeState {
            endpoint,
            enabled,
            phase,
            error,
        });
    }
    snapshot.runtimes = states;
    if (snapshot.config.enabled && !running)
        || snapshot.runtimes.iter().any(|runtime| {
            if snapshot.config.enabled && runtime.enabled {
                runtime.phase != RuntimeSearchPhase::Ready
            } else {
                !matches!(
                    runtime.phase,
                    RuntimeSearchPhase::Disabled | RuntimeSearchPhase::NotConfigured
                )
            }
        })
    {
        snapshot.applied_revision = None;
    }
    Ok(snapshot)
}

async fn verify(
    shared: &Shared,
    request: SearchVerifyRequest,
) -> Result<SearchVerification, SearchError> {
    if request.query.trim().is_empty() || request.query.len() > 4096 || request.query.contains('\0')
    {
        return Err(SearchError::invalid());
    }
    let snapshot = read_snapshot(shared)?;
    let engines = request
        .engines
        .as_ref()
        .filter(|engines| !engines.is_empty());
    let categories = request
        .categories
        .as_ref()
        .filter(|categories| !categories.is_empty());
    if engines.is_some_and(|names| {
        names.len() > 1024
            || names
                .iter()
                .any(|name| !snapshot.engines.iter().any(|engine| &engine.name == name))
    }) || categories.is_some_and(|names| {
        names.len() > 32
            || names.iter().any(|name| {
                !snapshot
                    .engines
                    .iter()
                    .any(|engine| engine.categories.contains(name))
            })
    }) {
        return Err(SearchError::invalid());
    }
    let search = searxng::SearchRequest {
        query: request.query,
        engines: engines.map(|engines| engines.join(",")),
        categories: categories
            .map(|categories| categories.join(","))
            .or_else(|| {
                engines
                    .is_none()
                    .then(|| snapshot.config.categories.join(","))
            }),
        language: Some(snapshot.config.language),
        safe_search: Some(snapshot.config.safe_search),
        count: snapshot.config.result_count as usize,
    };
    if let Some(endpoint) = request.endpoint {
        if !local_endpoints(shared, OBSERVE_DEADLINE)
            .await?
            .contains(&endpoint)
        {
            return Err(SearchError::invalid());
        }
        let mut result = timeout(
            Duration::from_secs(150),
            shared.runtime.verify(&endpoint, &search),
        )
        .await
        .map_err(|_| SearchError::unavailable())??;
        result.unresponsive_engines =
            safe_unresponsive(result.unresponsive_engines, &snapshot.engines);
        return safe_verification(result);
    }
    let started = Instant::now();
    let result = shared
        .service
        .search(&search)
        .await
        .map_err(SearchError::from)?;
    safe_verification(SearchVerification {
        results: result
            .results
            .into_iter()
            .map(|hit| SearchHit {
                title: hit.title,
                url: hit.url,
                snippet: hit.snippet,
            })
            .collect(),
        unresponsive_engines: safe_unresponsive(result.unresponsive_engines, &snapshot.engines),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

async fn shutdown(shared: &Shared, initialized: bool) -> Result<(), SearchError> {
    if initialized && let Err(error) = restore_runtimes(shared).await {
        eprintln!(
            "[search] shutdown native projection restore failed: {error}; local service will still be stopped"
        );
    }
    shared.service.stop().await.map_err(SearchError::from)
}

fn safe_verification(result: SearchVerification) -> Result<SearchVerification, SearchError> {
    if result.results.len() > 10
        || result.results.iter().any(|hit| {
            hit.title.len() > 16 * 1024
                || hit.snippet.len() > 64 * 1024
                || hit.url.len() > 8192
                || hit.title.contains('\0')
                || hit.snippet.contains('\0')
                || hit.url.chars().any(char::is_control)
                || reqwest::Url::parse(&hit.url).map_or(true, |url| {
                    !matches!(url.scheme(), "http" | "https")
                        || url.host_str().is_none()
                        || !url.username().is_empty()
                        || url.password().is_some()
                })
        })
    {
        return Err(SearchError::native_failed());
    }
    Ok(result)
}

fn safe_unresponsive(
    value: serde_json::Value,
    catalog: &[crate::SearchEngine],
) -> serde_json::Value {
    // Native engine failures may contain upstream request URLs or credentials; only engine identities cross the public seam.
    let names = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_array()?.first()?.as_str())
        .filter(|name| catalog.iter().any(|engine| engine.name == *name))
        .map(|name| serde_json::json!([name, "unavailable"]))
        .collect::<Vec<_>>();
    serde_json::Value::Array(names)
}
