mod catalog;
mod deletion;
mod dispatch;
mod execution;
mod history;
mod idle;
mod instance;
mod investigation;
pub(crate) mod iab;
mod native;
mod observation;
mod record;
mod retirement;
mod run;
mod selection;
mod title;
mod thinking;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, RwLock as Committed, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};
use tokio::sync::{
    Mutex, MutexGuard, Notify, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
};
use uuid::Uuid;

use crate::{
    cli::Cli, config::ConfigStore, diagnostics::Diagnostics, events::Events,
    interaction::Interactions, persistence::Database, rpc,
};

pub(crate) use record::assert_live_session;

pub async fn prepare_database(database: &Database) -> rpc::Result<()> {
    record::prepare_database(database).await
}

#[derive(Clone)]
pub struct Sessions(Arc<Inner>);

#[must_use]
pub(crate) struct AgentScope {
    sessions: Sessions,
    agent_id: String,
    _admission: OwnedRwLockWriteGuard<()>,
}

impl AgentScope {
    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) async fn is_active(&self) -> bool {
        self.sessions.is_agent_active(&self.agent_id).await
    }
}

#[must_use]
pub(crate) struct AgentInstances {
    _scope: AgentScope,
    instances: Vec<(String, String)>,
}

pub(crate) struct NativeFiles {
    pub session_id: String,
    pub agent_id: String,
    pub runtime: PathBuf,
    pub workspace: PathBuf,
}

struct Inner {
    config: Arc<ConfigStore>,
    database: Database,
    events: Events,
    interactions: Interactions,
    diagnostics: Diagnostics,
    media: crate::workspace::Media,
    sessions: RwLock<catalog::Catalog>,
    agent_guards: Mutex<BTreeMap<String, Arc<RwLock<()>>>>,
    registrations: Mutex<BTreeMap<String, Weak<Mutex<()>>>>,
    search_guard: Mutex<()>,
    history_reads: Arc<tokio::sync::Semaphore>,
    catalog_changes: tokio::sync::watch::Sender<()>,
    shutdown: AtomicBool,
    shutdown_guard: Mutex<()>,
    iab: iab::Owner,
}

struct Session {
    committed: Committed<Arc<record::Record>>,
    deleting: AtomicBool,
    data: Mutex<Execution>,
    wake: Notify,
    changed: Notify,
    executor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    consumer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    close_guard: Mutex<()>,
    stopped: tokio_util::sync::CancellationToken,
}

struct Execution {
    title_attempted: bool,
    cleanup_failed: bool,
    record_unknown: Option<rpc::Error>,
    queue: VecDeque<run::Record>,
    active: Option<run::Active>,
    cli: Option<Cli>,
    native: native::Snapshot,
    idle: idle::Idle,
    launching: bool,
    launch_error: Option<rpc::Error>,
    selecting_provider: Option<String>,
    sending: bool,
    closing: bool,
    consuming: bool,
    cancel_in_flight: bool,
    storage_fault: Option<rpc::Error>,
    run_storage_unknown: Option<rpc::Error>,
}

impl Session {
    fn record(&self) -> Arc<record::Record> {
        self.committed.read().expect("Session committed record").clone()
    }

    fn readable_record(&self) -> rpc::Result<Arc<record::Record>> {
        let record = self.record();
        if self.deleting.load(Ordering::Acquire) {
            return Err(record::deleting());
        }
        record.mutable()?;
        Ok(record)
    }

    fn mutable(&self) -> rpc::Result<()> {
        self.readable_record().map(|_| ())
    }

    async fn commit(
        &self,
        database: &Database,
        execution: &mut Execution,
        mut updated: record::Record,
    ) -> rpc::Result<()> {
        updated.title_attempted |= execution.title_attempted;
        updated.native_cleanup_failed |= execution.cleanup_failed;
        let deleting = updated.status == record::Status::Deleting;
        if !deleting {
            if let Some(error) = &execution.record_unknown {
                return Err(error.clone());
            }
            self.mutable()?;
        }
        let result = if deleting {
            record::begin_delete(database, &updated).await
        } else {
            record::save_session(database, &updated).await
        };
        if let Err(error) = result {
            if error.code == -32006
                || error.data.as_ref().and_then(|data| data.get("storageOutcome"))
                    .and_then(Value::as_str) == Some("unknown")
            {
                execution.record_unknown = Some(error.clone());
            }
            return Err(error);
        }
        // The mutation owner stays locked until the complete committed record is published.
        *self.committed.write().expect("Session committed record") = Arc::new(updated);
        Ok(())
    }
}

impl Execution {
    fn fault(&mut self, error: rpc::Error) {
        self.storage_fault = Some(match self.storage_fault.take() {
            Some(primary) => {
                let mut related = primary
                    .data
                    .as_ref()
                    .and_then(|data| data.get("relatedFailures"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                related.push(json!({ "code": error.code, "data": error.data }));
                primary.with_data(json!({ "relatedFailures": related }))
            }
            None => error,
        });
    }
}

impl Sessions {
    pub async fn open(
        config: Arc<ConfigStore>,
        database: Database,
        events: Events,
        interactions: Interactions,
        diagnostics: Diagnostics,
        media: crate::workspace::Media,
    ) -> rpc::Result<Self> {
        let records = record::open(&database).await?;
        let owner = Self(Arc::new(Inner {
            config,
            database,
            events,
            interactions,
            diagnostics,
            media,
            sessions: RwLock::new(catalog::Catalog::default()),
            agent_guards: Mutex::new(BTreeMap::new()),
            registrations: Mutex::new(BTreeMap::new()),
            search_guard: Mutex::new(()),
            history_reads: Arc::new(tokio::sync::Semaphore::new(8)),
            catalog_changes: tokio::sync::watch::channel(()).0,
            shutdown: AtomicBool::new(false),
            shutdown_guard: Mutex::new(()),
            iab: iab::Owner::default(),
        }));
        for mut record in records {
            record.workspace = crate::workspace::native_path(record.workspace);
            if record.runtime != owner.0.config.paths().runtime(&record.agent_id)? {
                return Err(rpc::Error::new(
                    -32007,
                    "session_runtime_mismatch",
                    "The Session runtime is outside its configured Agent custody",
                ));
            }
            let session_id = record.session_id.clone();
            let created_at_ms = record.created_at_ms;
            let agent_id = record.agent_id.clone();
            let pending_runs = if record.status == record::Status::Deleting {
                Vec::new()
            } else {
                record::pending_runs(&owner.0.database, &session_id).await?
            };
            for mut pending in pending_runs {
                pending.finish(run::Status::OutcomeUnknown, "server_restarted", None);
                record::save_run(&owner.0.events, &pending).await?;
            }
            let session = Arc::new(Session {
                deleting: AtomicBool::new(record.status == record::Status::Deleting),
                committed: Committed::new(Arc::new(record)),
                data: Mutex::new(Execution {
                    title_attempted: false,
                    cleanup_failed: false,
                    record_unknown: None,
                    queue: VecDeque::new(),
                    active: None,
                    cli: None,
                    native: native::Snapshot::default(),
                    idle: idle::Idle::Dormant,
                    launching: false,
                    launch_error: None,
                    selecting_provider: None,
                    sending: false,
                    closing: false,
                    consuming: false,
                    cancel_in_flight: false,
                    storage_fault: None,
                    run_storage_unknown: None,
                }),
                wake: Notify::new(),
                changed: Notify::new(),
                executor: Mutex::new(None),
                consumer: Mutex::new(None),
                close_guard: Mutex::new(()),
                stopped: tokio_util::sync::CancellationToken::new(),
            });
            owner.0.sessions.write().await.insert(
                session_id,
                created_at_ms,
                agent_id,
                session.clone(),
            );
            owner.start_executor(session).await;
        }
        Ok(owner)
    }

    pub(crate) fn iab_peer(&self) -> iab::Peer {
        self.0.iab.peer()
    }

    pub fn catalog_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.0.catalog_changes.subscribe()
    }

    async fn agent_gate(&self, agent_id: &str) -> Arc<RwLock<()>> {
        self.0.agent_guards.lock().await
            .entry(agent_id.to_owned())
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone()
    }

    pub(crate) async fn agent_scope(&self, agent_id: &str) -> AgentScope {
        AgentScope {
            sessions: self.clone(),
            agent_id: agent_id.to_owned(),
            _admission: self.agent_gate(agent_id).await.write_owned().await,
        }
    }

    async fn agent_admission(&self, agent_id: &str) -> OwnedRwLockReadGuard<()> {
        self.agent_gate(agent_id).await.read_owned().await
    }

    async fn registration_guard(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let guard = {
            let mut registrations = self.0.registrations.lock().await;
            registrations.retain(|_, guard| guard.strong_count() != 0);
            match registrations.get(session_id).and_then(Weak::upgrade) {
                Some(guard) => guard,
                None => {
                    let guard = Arc::new(Mutex::new(()));
                    registrations.insert(session_id.to_owned(), Arc::downgrade(&guard));
                    guard
                }
            }
        };
        guard.lock_owned().await
    }

    async fn session_admission<'a>(
        &self,
        session: &'a Session,
        agent_id: &str,
    ) -> (OwnedRwLockReadGuard<()>, MutexGuard<'a, ()>) {
        let gate = self.agent_gate(agent_id).await;
        loop {
            let agent = gate.clone().read_owned().await;
            if let Ok(operation) = session.close_guard.try_lock() {
                return (agent, operation);
            }
            // Never reserve an Agent while another Session operation waits on native I/O.
            drop(agent);
            let operation = session.close_guard.lock().await;
            if let Ok(agent) = gate.clone().try_read_owned() {
                return (agent, operation);
            }
            drop(operation);
        }
    }

    async fn close_admission<'a>(
        &self,
        session: &'a Session,
        budget: Option<(&str, &tokio_util::sync::CancellationToken)>,
    ) -> Option<MutexGuard<'a, ()>> {
        let run_id = budget.map(|(run_id, _)| run_id);
        let cancelled = async {
            match budget {
                Some((_, stopping)) => tokio::select! {
                    _ = stopping.cancelled() => {},
                    _ = session.stopped.cancelled() => {},
                },
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(cancelled);
        let cli = {
            let mut execution = session.data.lock().await;
            if run_id.is_some_and(|run_id| {
                execution.active.as_ref()
                    .is_none_or(|active| active.record.run.run_id != run_id)
            }) {
                return None;
            }
            if session.record().status != record::Status::Deleting {
                execution.closing = true;
            }
            execution.cli.clone()
        };
        let closing = session.close_guard.lock();
        tokio::pin!(closing);
        let closing = if let Some(cli) = cli {
            // Enqueue the real Session guard before waiting for native controls to unblock.
            tokio::select! {
                biased;
                _ = &mut cancelled => {
                    // Instance close owns its cleanup task; join that same captured instance before leaving.
                    let closed = cli.close().await;
                    self.cleanup_result(session, cli.instance_id(), &closed).await;
                    return None;
                }
                closing = &mut closing => closing,
                closed = cli.close() => {
                    self.cleanup_result(session, cli.instance_id(), &closed).await;
                    tokio::select! {
                        biased;
                        _ = &mut cancelled => return None,
                        closing = &mut closing => closing,
                    }
                }
            }
        } else {
            tokio::select! {
                biased;
                _ = &mut cancelled => return None,
                closing = &mut closing => closing,
            }
        };
        let mut execution = session.data.lock().await;
        if run_id.is_some_and(|run_id| {
            execution.active.as_ref()
                .is_none_or(|active| active.record.run.run_id != run_id)
        }) {
            return None;
        }
        if session.record().status != record::Status::Deleting {
            execution.closing = true;
        }
        Some(closing)
    }

    async fn stored_session(&self, session_id: &str) -> rpc::Result<Arc<Session>> {
        validate_uuid(session_id)?;
        self.0
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| rpc::Error::not_found("Session"))
    }

    async fn session(&self, session_id: &str) -> rpc::Result<Arc<Session>> {
        let session = self.stored_session(session_id).await?;
        session.mutable()?;
        Ok(session)
    }

    pub(crate) async fn native_files(&self, session_id: &str) -> rpc::Result<NativeFiles> {
        let session = self.stored_session(session_id).await?;
        let record = session.readable_record()?;
        Ok(NativeFiles {
            session_id: record.session_id.clone(),
            agent_id: record.agent_id.clone(),
            runtime: record.runtime.clone(),
            workspace: record.workspace.clone(),
        })
    }

    pub(crate) async fn persisted_history(&self, session_id: &str) -> rpc::Result<Vec<Value>> {
        let session = self.stored_session(session_id).await?;
        let permit = self
            .0
            .history_reads
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| rpc::Error::internal("history_reader_closed"))?;
        let _execution = session.data.lock().await;
        session.mutable()?;
        let record = session.record();
        history::read_all(
            &record.runtime,
            &record.workspace,
            &record.session_id,
            permit,
        )
        .await
    }

    fn accepting(&self) -> rpc::Result<()> {
        if self.0.shutdown.load(Ordering::Acquire) {
            Err(rpc::Error::unavailable(
                "server_shutting_down",
                "The server is shutting down",
            ))
        } else {
            Ok(())
        }
    }

    pub async fn submit(&self, session_id: &str, content: Value) -> rpc::Result<String> {
        Ok(self
            .submit_run(session_id, content, None, None, None, None, None)
            .await?
            .run_id)
    }

    async fn submit_run(
        &self,
        session_id: &str,
        content: Value,
        request_id: Option<String>,
        budget: Option<run::Budget>,
        world_envelope: Option<investigation::Envelope>,
        world_request_digest: Option<String>,
        original_params: Option<Value>,
    ) -> rpc::Result<run::Run> {
        self.accepting()?;
        run::validate_content(&content)?;
        if let Some(request_id) = &request_id {
            run::validate_request_id(request_id)?;
        }
        if world_envelope.is_some() && (request_id.is_none() || budget.is_some() || world_request_digest.is_none()) {
            return Err(investigation::denied("investigation_accept_identity_invalid"));
        }
        let digest = request_id
            .as_ref()
            .map(|_| run::content_budget_digest(&content, &budget))
            .transpose()?;
        let session = self.session(session_id).await?;
        let owner = self.clone();
        // The durable accept and executor wake outlive a disconnected RPC future.
        tokio::spawn(async move {
            let agent_id = session.record().agent_id.clone();
            let (_guard, _operation) = owner.session_admission(&session, &agent_id).await;
            owner.accepting()?;
            let config = owner.0.config.snapshot().await;
            if !config.agents.contains_key(&agent_id) {
                return Err(rpc::Error::not_found("Agent"));
            }
            let mut execution = session.data.lock().await;
            session.mutable()?;
            if let Some(request_id) = &request_id {
                if let Some(existing) = record::get_run_by_request(
                    &owner.0.database,
                    &session.record().session_id,
                    request_id,
                )
                .await?
                {
                    if existing.run.content_budget_digest != digest
                        || existing.run.world_investigation.as_ref().map(|world| &world.request_digest) != world_request_digest.as_ref()
                    {
                        return Err(not_sent(rpc::Error::conflict(
                            "request_payload_conflict",
                            "requestId was already accepted with different content or budget",
                        )));
                    }
                    return Ok(existing.run);
                }
            }
            if let Some(params) = &original_params {
                crate::world::verify_investigation(params).map_err(not_sent)?;
            }
            if let Some(budget) = &budget {
                budget.validate().map_err(not_sent)?;
            }
            if execution.cleanup_failed || session.record().native_cleanup_failed {
                return Err(rpc::Error::conflict(
                    "native_cleanup_unconfirmed",
                    "The previous CLI instance cleanup was not confirmed",
                ));
            }
            if execution.closing {
                return Err(rpc::Error::conflict(
                    "session_closing",
                    "Session cleanup is in progress",
                ));
            }
            if session.record().status == record::Status::Closed {
                return Err(rpc::Error::conflict(
                    "session_closed",
                    "Resume the closed session before submitting a new run",
                ));
            }
            if let Some(error) = &execution.storage_fault {
                return Err(error.clone());
            }
            let world = world_envelope.map(|envelope| investigation::Investigation::accept(
                envelope, world_request_digest.expect("verified World request digest"),
                original_params.expect("verified World accepted params"), rpc::now_ms(),
            )).transpose()?;
            let pending = run::Record::new(
                &session.record().session_id,
                content,
                request_id,
                digest,
                budget,
                world,
            );
            let accepted = pending.run.clone();
            owner.save_run_locked(&mut execution, &pending).await?;
            execution.queue.push_back(pending);
            session.changed.notify_waiters();
            execution.idle.activity();
            session.wake.notify_one();
            Ok(accepted)
        })
        .await
        .map_err(|_| {
            rpc::Error::new(
                -32006,
                "run_acceptance_unknown",
                "Run acceptance could not be confirmed",
            )
        })?
    }

    async fn current_cli(
        &self,
        session_id: &str,
        instance_id: Option<&str>,
    ) -> rpc::Result<crate::cli::idle::Control> {
        let session = self.session(session_id).await.map_err(not_sent)?;
        let _operation = session.close_guard.lock().await;
        self.current_cli_locked(&session, instance_id).await
    }

    async fn current_cli_locked(
        &self,
        session: &Session,
        instance_id: Option<&str>,
    ) -> rpc::Result<crate::cli::idle::Control> {
        let execution = session.data.lock().await;
        session.mutable().map_err(not_sent)?;
        if execution.closing || execution.idle.handing_off() || execution.launching {
            return Err(not_sent(rpc::Error::unavailable(
                "native_instance_handoff",
                "The native CLI instance is handing off; the control request was not sent",
            )));
        }
        let cli = execution.cli.as_ref().ok_or_else(|| {
            not_sent(rpc::Error::unavailable(
                "native_instance_absent",
                "This session has no live CLI instance",
            ))
        })?;
        if instance_id.is_some_and(|expected| expected != cli.instance_id()) {
            return Err(not_sent(rpc::Error::conflict(
                "native_instance_changed",
                "The requested CLI instance is no longer current",
            )));
        }
        cli.admit()
    }

    pub async fn control(&self, session_id: &str, request: Value) -> rpc::Result<Value> {
        self.current_cli(session_id, None)
            .await?
            .request(request)
            .await
    }

    pub async fn control_instance(
        &self,
        session_id: &str,
        instance_id: &str,
        request: Value,
    ) -> rpc::Result<Value> {
        self.current_cli(session_id, Some(instance_id))
            .await?
            .request(request)
            .await
    }

    pub async fn control_observed(&self, session_id: &str, request: Value) -> rpc::Result<Value> {
        let cli = self.current_cli(session_id, None).await?;
        let response = cli.request(request).await?;
        Ok(
            json!({ "sessionId": session_id, "instanceId": cli.instance_id(), "response": response }),
        )
    }

    pub async fn respond(
        &self,
        session_id: &str,
        instance_id: &str,
        request_id: &str,
        response: Value,
    ) -> rpc::Result<()> {
        let session = self.session(session_id).await.map_err(not_sent)?;
        self.current_cli_locked(&session, Some(instance_id))
            .await?
            .respond(request_id, response)
            .await
    }

    pub async fn native_snapshot(&self, session_id: &str) -> rpc::Result<Value> {
        let session = self.session(session_id).await?;
        let execution = session.data.lock().await;
        session.mutable()?;
        let record = session.record();
        let mut snapshot = execution.native.view(
            &record.session_id,
            &record.agent_id,
            execution.cli.as_ref().map(Cli::instance_id),
        );
        snapshot["launching"] = json!(execution.launching);
        Ok(snapshot)
    }

    pub(crate) async fn search_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.search_guard.lock().await
    }

    pub(crate) async fn search_instances(&self) -> (Vec<Cli>, bool) {
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut instances = Vec::new();
        let mut transitioning = false;
        for session in sessions {
            let execution = session.data.lock().await;
            transitioning |= execution.launching
                || execution.closing
                || execution.idle.handing_off()
            || execution.cleanup_failed
            || session.record().native_cleanup_failed;
            if !execution.closing
                && (!execution.launching || execution.native.initialize.is_some())
                && let Some(cli) = &execution.cli
            {
                instances.push(cli.clone());
            }
        }
        (instances, transitioning)
    }

    pub async fn provider_agents(
        &self,
        provider_ids: &BTreeSet<String>,
    ) -> rpc::Result<(Vec<String>, Vec<String>, BTreeSet<String>)> {
        let config = self.0.config.snapshot().await;
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut affected = BTreeSet::new();
        let mut active = BTreeSet::new();
        let mut selecting = BTreeSet::new();
        for session in sessions {
            let execution = session.data.lock().await;
            let record = session.record();
            let provider = record.provider_id.as_ref().or_else(|| {
                config
                    .agents
                    .get(&record.agent_id)
                    .and_then(|agent| agent.provider.as_ref())
            });
            let providers = provider.into_iter().chain(execution.selecting_provider.as_ref());
            let mut matched = false;
            for id in providers.filter(|id| provider_ids.contains(*id)) {
                matched = true;
                if execution.selecting_provider.is_some() {
                    selecting.insert(id.clone());
                }
            }
            if matched {
                affected.insert(session.record().agent_id.clone());
                if execution.cli.is_some()
                    || execution.idle.handing_off()
                    || execution.launching
                    || execution.consuming
                    || execution.cleanup_failed
                    || session.record().native_cleanup_failed
                    || execution.active.is_some()
                    || !execution.queue.is_empty()
                    || session.close_guard.try_lock().is_err()
                {
                    active.insert(session.record().agent_id.clone());
                }
            }
        }
        Ok((affected.into_iter().collect(), active.into_iter().collect(), selecting))
    }

    pub async fn is_agent_active(&self, agent_id: &str) -> bool {
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        for session in sessions {
            let execution = session.data.lock().await;
            if session.record().agent_id == agent_id
                && (session.record().status == record::Status::Open
                    || execution.cli.is_some()
                    || execution.launching
                    || execution.consuming
                    || execution.cleanup_failed
                    || session.record().native_cleanup_failed
                    || execution.active.is_some()
                    || !execution.queue.is_empty()
                    || session.close_guard.try_lock().is_err())
            {
                return true;
            }
        }
        false
    }

    pub async fn shutdown(&self) -> rpc::Result<()> {
        let _guard = self.0.shutdown_guard.lock().await;
        self.0.shutdown.store(true, Ordering::Release);
        self.0.iab.shutdown();
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut closing = tokio::task::JoinSet::new();
        for session in sessions {
            let owner = self.clone();
            closing.spawn(async move {
                let session_id = session.record().session_id.clone();
                owner
                    .close_execution(session, false)
                    .await
                    .map_err(|error| error.with_data(json!({ "sessionId": session_id })))
            });
        }
        let mut failures = Vec::new();
        while let Some(result) = closing.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(error),
                Err(_) => failures.push(rpc::Error::internal("session_shutdown_task")),
            }
        }
        combined(failures)
    }
}

fn validate_uuid(value: &str) -> rpc::Result<()> {
    if value.len() != 36 || Uuid::parse_str(value).is_err() {
        return Err(rpc::Error::invalid(
            "Session and run identities must be UUID strings",
        ));
    }
    Ok(())
}

fn not_sent(error: rpc::Error) -> rpc::Error {
    error.with_data(json!({ "delivery": "notSent" }))
}

fn combined(mut failures: Vec<rpc::Error>) -> rpc::Result<()> {
    if failures.is_empty() {
        return Ok(());
    }
    let first = failures.remove(0);
    if failures.is_empty() {
        return Err(first);
    }
    let related: Vec<_> = failures
        .iter()
        .map(|error| {
            json!({
                "code": error.code, "kind": error.data.as_ref().and_then(|data| data.get("kind")),
                "sessionId": error.data.as_ref().and_then(|data| data.get("sessionId")),
                "stage": error.data.as_ref().and_then(|data| data.get("stage")),
                "relatedFailures": error.data.as_ref().and_then(|data| data.get("relatedFailures")),
            })
        })
        .collect();
    Err(first.with_data(json!({ "relatedFailures": related })))
}
