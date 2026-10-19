mod deletion;
mod dispatch;
mod execution;
mod history;
mod idle;
mod instance;
mod native;
mod observation;
mod record;
mod retirement;
mod run;

use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, RwLock};
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
    sessions: RwLock<BTreeMap<String, Arc<Session>>>,
    agent_guards: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    search_guard: Mutex<()>,
    history_reads: Arc<tokio::sync::Semaphore>,
    shutdown: AtomicBool,
    shutdown_guard: Mutex<()>,
}

struct Session {
    data: Mutex<Execution>,
    wake: Notify,
    changed: Notify,
    executor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    consumer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    close_guard: Mutex<()>,
    stopped: tokio_util::sync::CancellationToken,
}

struct Execution {
    record: record::Record,
    queue: VecDeque<run::Record>,
    active: Option<run::Active>,
    cli: Option<Cli>,
    native: native::Snapshot,
    idle: idle::Idle,
    launching: bool,
    launch_error: Option<rpc::Error>,
    sending: bool,
    closing: bool,
    consuming: bool,
    cancel_in_flight: bool,
    storage_fault: Option<rpc::Error>,
    run_storage_unknown: Option<rpc::Error>,
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
            sessions: RwLock::new(BTreeMap::new()),
            agent_guards: Mutex::new(BTreeMap::new()),
            search_guard: Mutex::new(()),
            history_reads: Arc::new(tokio::sync::Semaphore::new(8)),
            shutdown: AtomicBool::new(false),
            shutdown_guard: Mutex::new(()),
        }));
        for record in records {
            let session_id = record.session_id.clone();
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
                data: Mutex::new(Execution {
                    record,
                    queue: VecDeque::new(),
                    active: None,
                    cli: None,
                    native: native::Snapshot::default(),
                    idle: idle::Idle::Dormant,
                    launching: false,
                    launch_error: None,
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
            owner
                .0
                .sessions
                .write()
                .await
                .insert(session_id, session.clone());
            owner.start_executor(session).await;
        }
        Ok(owner)
    }

    pub async fn agent_guard(&self, agent_id: &str) -> OwnedMutexGuard<()> {
        let guard = self
            .0
            .agent_guards
            .lock()
            .await
            .entry(agent_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        guard.lock_owned().await
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
        session.data.lock().await.record.mutable()?;
        Ok(session)
    }

    pub(crate) async fn native_files(&self, session_id: &str) -> rpc::Result<NativeFiles> {
        let session = self.stored_session(session_id).await?;
        let execution = session.data.lock().await;
        execution.record.mutable()?;
        Ok(NativeFiles {
            session_id: execution.record.session_id.clone(),
            agent_id: execution.record.agent_id.clone(),
            runtime: execution.record.runtime.clone(),
            workspace: execution.record.workspace.clone(),
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
        let execution = session.data.lock().await;
        execution.record.mutable()?;
        history::read_all(
            &execution.record.runtime,
            &execution.record.workspace,
            &execution.record.session_id,
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
        self.accepting()?;
        run::validate_content(&content)?;
        let session = self.session(session_id).await?;
        let owner = self.clone();
        // The durable accept and executor wake outlive a disconnected RPC future.
        tokio::spawn(async move {
            let agent_id = session.data.lock().await.record.agent_id.clone();
            let _guard = owner.agent_guard(&agent_id).await;
            owner.accepting()?;
            let config = owner.0.config.snapshot().await;
            if !config.agents.contains_key(&agent_id) {
                return Err(rpc::Error::not_found("Agent"));
            }
            let mut execution = session.data.lock().await;
            execution.record.mutable()?;
            if execution.record.native_cleanup_failed {
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
            if execution.record.status == record::Status::Closed {
                return Err(rpc::Error::conflict(
                    "session_closed",
                    "Resume the closed session before submitting a new run",
                ));
            }
            if let Some(error) = &execution.storage_fault {
                return Err(error.clone());
            }
            let pending = run::Record::new(&execution.record.session_id, content);
            let run_id = pending.run.run_id.clone();
            owner.save_run_locked(&mut execution, &pending).await?;
            execution.queue.push_back(pending);
            execution.idle.activity();
            session.wake.notify_one();
            Ok(run_id)
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
        let execution = session.data.lock().await;
        execution.record.mutable().map_err(not_sent)?;
        if execution.closing || execution.idle.handing_off() {
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
        self.current_cli(session_id, Some(instance_id))
            .await?
            .respond(request_id, response)
            .await
    }

    pub async fn native_snapshot(&self, session_id: &str) -> rpc::Result<Value> {
        let session = self.session(session_id).await?;
        let execution = session.data.lock().await;
        execution.record.mutable()?;
        let mut snapshot = execution.native.view(
            &execution.record.session_id,
            &execution.record.agent_id,
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
                || execution.record.native_cleanup_failed;
            if let Some(cli) = &execution.cli {
                instances.push(cli.clone());
            }
        }
        (instances, transitioning)
    }

    pub async fn provider_agents(
        &self,
        provider_ids: &std::collections::BTreeSet<String>,
    ) -> rpc::Result<(Vec<String>, Vec<String>)> {
        let config = self.0.config.snapshot().await;
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut affected = std::collections::BTreeSet::new();
        let mut active = std::collections::BTreeSet::new();
        for session in sessions {
            let execution = session.data.lock().await;
            let provider = execution.record.provider_id.as_ref().or_else(|| {
                config
                    .agents
                    .get(&execution.record.agent_id)
                    .and_then(|agent| agent.provider.as_ref())
            });
            if provider.is_some_and(|id| provider_ids.contains(id)) {
                affected.insert(execution.record.agent_id.clone());
                if execution.cli.is_some()
                    || execution.idle.handing_off()
                    || execution.launching
                    || execution.consuming
                    || execution.record.native_cleanup_failed
                    || execution.active.is_some()
                    || !execution.queue.is_empty()
                {
                    active.insert(execution.record.agent_id.clone());
                }
            }
        }
        Ok((affected.into_iter().collect(), active.into_iter().collect()))
    }

    pub async fn is_agent_active(&self, agent_id: &str) -> bool {
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        for session in sessions {
            let execution = session.data.lock().await;
            if execution.record.agent_id == agent_id
                && (execution.record.status == record::Status::Open
                    || execution.cli.is_some()
                    || execution.launching
                    || execution.consuming
                    || execution.record.native_cleanup_failed
                    || execution.active.is_some()
                    || !execution.queue.is_empty())
            {
                return true;
            }
        }
        false
    }

    pub async fn shutdown(&self) -> rpc::Result<()> {
        let _guard = self.0.shutdown_guard.lock().await;
        self.0.shutdown.store(true, Ordering::Release);
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut closing = tokio::task::JoinSet::new();
        for session in sessions {
            let owner = self.clone();
            closing.spawn(async move {
                let session_id = session.data.lock().await.record.session_id.clone();
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
