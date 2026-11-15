use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    cli::{Cli, LaunchSpec},
    config::Config,
    rpc,
};

use super::{AgentInstances, Session, Sessions, history, native, record};

impl AgentInstances {
    pub(crate) fn instances(&self) -> &[(String, String)] {
        &self.instances
    }
}

impl Sessions {
    pub(crate) async fn stable_agent_instances(
        &self,
        agent_id: &str,
    ) -> rpc::Result<AgentInstances> {
        'stable: loop {
            let scope = self.agent_scope(agent_id).await;
            self.accepting()?;
            let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
            let mut instances = Vec::new();
            for session in sessions {
                let changed = session.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let execution = session.data.lock().await;
                let record = session.record();
                if record.agent_id != agent_id {
                    continue;
                }
                if execution.launching {
                    // Launch captures its spec under the Agent scope, then starts without it.
                    drop(execution);
                    drop(scope);
                    changed.await;
                    continue 'stable;
                }
                if let Some(cli) = &execution.cli {
                    instances.push((
                        record.session_id.clone(),
                        cli.instance_id().to_owned(),
                    ));
                }
            }
            return Ok(AgentInstances { _scope: scope, instances });
        }
    }

    pub(crate) async fn apply_instance_permissions(
        &self,
        session_id: &str,
        instance_id: &str,
        patch: &Value,
        states: &std::collections::BTreeMap<String, bool>,
    ) -> rpc::Result<Vec<String>> {
        self.current_cli(session_id, Some(instance_id))
            .await?
            .apply_permissions(patch, states)
            .await
    }

    pub async fn ensure_native(&self, session_id: &str) -> rpc::Result<Value> {
        self.accepting()?;
        let session = self.session(session_id).await?;
        let owner = self.clone();
        tokio::spawn(async move { owner.ensure_instance(session).await })
            .await
            .map_err(|error| {
                rpc::Error::new(
                    -32006,
                    "native_start_unknown",
                    "Native instance startup could not be confirmed",
                )
                .with_source(error)
            })?
    }

    async fn ensure_instance(&self, session: Arc<Session>) -> rpc::Result<Value> {
        let agent_id = session.record().agent_id.clone();
        let mut waited = false;
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let (admission, operation) = self.session_admission(&session, &agent_id).await;
            self.accepting()?;
            let config = self.0.config.snapshot().await;
            let mut execution = session.data.lock().await;
            session.mutable()?;
            let record = session.record();
            if execution.closing || record.status == record::Status::Closed {
                return Err(super::not_sent(rpc::Error::conflict(
                    "session_closed",
                    "Resume the session before starting its native instance",
                )));
            }
            if execution.cleanup_failed || record.native_cleanup_failed {
                return Err(super::not_sent(rpc::Error::conflict(
                    "native_cleanup_unconfirmed",
                    "The previous CLI instance cleanup was not confirmed",
                )));
            }
            if let Some(error) = &execution.storage_fault {
                return Err(error.clone());
            }
            if waited && !execution.launching && !execution.idle.handing_off() {
                if let Some(error) = &execution.launch_error {
                    return Err(error.clone());
                }
                if execution.cli.is_none() {
                    return Err(super::not_sent(rpc::Error::unavailable(
                        "native_instance_absent",
                        "The awaited CLI instance is no longer live",
                    )));
                }
            }
            if execution.idle.handing_off()
                || execution.launching
                || (execution.consuming && execution.cli.is_none())
            {
                let launching = execution.launching;
                drop(execution);
                drop(operation);
                drop(admission);
                changed.await;
                waited |= launching;
                continue;
            }
            if execution.cli.is_some() {
                execution.idle.activity();
                session.wake.notify_one();
                let mut snapshot = execution.native.view(
                    &record.session_id,
                    &record.agent_id,
                    execution.cli.as_ref().map(Cli::instance_id),
                );
                snapshot["launching"] = json!(false);
                return Ok(snapshot);
            }
            let spec = self.launch_spec(config, &record)?;
            execution.launching = true;
            execution.launch_error = None;
            drop(execution);
            drop(operation);
            drop(admission);
            let started = self.start_instance(&session, spec).await;
            let mut execution = session.data.lock().await;
            execution.launching = false;
            execution.launch_error = started.as_ref().err().cloned();
            session.changed.notify_waiters();
            session.wake.notify_one();
            let cli = started?;
            session.mutable()?;
            if execution.closing
                || execution
                    .cli
                    .as_ref()
                    .is_none_or(|current| current.instance_id() != cli.instance_id())
            {
                return Err(rpc::Error::new(
                    -32006,
                    "native_instance_changed",
                    "The initialized CLI instance is no longer current",
                ));
            }
            let mut snapshot = execution.native.view(
                &record.session_id,
                &record.agent_id,
                Some(cli.instance_id()),
            );
            snapshot["launching"] = json!(false);
            return Ok(snapshot);
        }
    }

    pub(super) fn launch_spec(
        &self,
        config: Config,
        record: &record::Record,
    ) -> rpc::Result<LaunchSpec> {
        let agent_id = record.agent_id.clone();
        let mut agent = config
            .agents
            .get(&agent_id)
            .cloned()
            .ok_or_else(|| rpc::Error::not_found("Agent"))?;
        if let Some(provider) = &record.provider_id {
            agent.provider = Some(provider.clone());
        }
        if let Some(model) = &record.model {
            agent.model = Some(model.clone());
        }
        if let Some(mode) = &record.mode {
            agent.settings["permissions"]["defaultMode"] = json!(mode);
        }
        Ok(LaunchSpec {
            config,
            agent,
            agent_id,
            session_id: record.session_id.clone(),
            paths: self.0.config.paths().clone(),
            workspace: record.workspace.clone(),
            resume: record.native_started,
            effort: record.effort,
            fork_from: if record.native_started {
                None
            } else {
                record.forked_from.clone()
            },
        })
    }

    pub(super) async fn join_consumer(&self, session: &Session) -> rpc::Result<()> {
        if let Some(task) = session.consumer.lock().await.take()
            && let Err(error) = task.await
        {
            let failure = rpc::Error::internal("session_consumer_task").with_source(error);
            self.cleanup_result(session, "consumer", &Err(failure.clone()))
                .await;
            return Err(failure);
        }
        Ok(())
    }

    pub(super) async fn stop_instance(&self, session: &Session, cli: &Cli) -> rpc::Result<()> {
        // Keep the durable consumer draining until the owned reader has joined.
        let closed = cli.close().await;
        self.cleanup_result(session, cli.instance_id(), &closed)
            .await;
        let joined = self.join_consumer(session).await;
        match (closed, joined) {
            (Err(primary), Err(cleanup)) => {
                Err(primary.with_data(json!({"cleanupFailure":cleanup})))
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }

    pub(super) async fn start_instance(
        &self,
        session: &Arc<Session>,
        mut spec: LaunchSpec,
    ) -> rpc::Result<Cli> {
        match history::locate(
            &self.0.config.paths().runtime(&spec.agent_id)?,
            &spec.workspace,
            &spec.session_id,
        )
        .await?
        {
            Some(_) => {
                spec.resume = true;
                spec.fork_from = None;
            }
            None if spec.resume => return Err(rpc::Error::not_found("Native transcript")),
            None => {}
        }
        {
            let _search = self.search_guard().await;
            // Only the search projection is live-reconciled; other launch settings use this startup snapshot.
            spec.config.search = self.0.config.checked_snapshot().await?.search;
        }
        let initial_search = spec.config.search.clone();
        let provider = spec
            .agent
            .provider
            .as_ref()
            .map(|id| {
                crate::provider::ProviderConfig::parse(
                    spec.config
                        .providers
                        .get(id)
                        .ok_or_else(|| rpc::Error::not_found("Provider"))?,
                )
            })
            .transpose()?;
        let model = spec
            .agent
            .provider
            .as_deref()
            .filter(|id| id.starts_with("host-account-") || id.starts_with("host-session-"))
            .and(spec.agent.model.clone().or_else(|| {
                provider
                    .as_ref()
                    .and_then(|provider| provider.model.clone())
            }));
        let provider = provider.map(|provider| provider.kind);
        let (cli, receiver) = match Cli::start(spec, self.0.diagnostics.clone(), &self.0.iab).await {
            Ok(started) => started,
            Err(error) => {
                if error.data.as_ref().is_some_and(|data| {
                    data.get("cleanupFailures").is_some()
                        || data.get("cleanupComplete") == Some(&Value::Bool(false))
                }) {
                    self.cleanup_result(session, "launch", &Err(error.clone()))
                        .await;
                }
                return Err(error);
            }
        };
        let (started, closing) = {
            let mut execution = session.data.lock().await;
            if execution.closing {
                cli.revoke_iab();
            }
            execution.cli = Some(cli.clone());
            execution.native = native::Snapshot::default();
            execution.idle = super::idle::Idle::Dormant;
            execution.consuming = true;
            if let Some(active) = execution.active.as_mut() {
                active.ownership_ambiguous |= cli.has_autonomous_inputs();
            }
            let record = session.record();
            let started = self.0
                .events
                .append(
                    &record.session_id,
                    execution
                        .active
                        .as_ref()
                        .map(|active| active.record.run.run_id.as_str()),
                    "cli.started",
                    json!({ "instanceId": cli.instance_id() }),
                )
                .await;
            (started, execution.closing)
        };
        let owner = self.clone();
        let observed = session.clone();
        let instance = cli.instance_id().to_owned();
        let task = tokio::spawn(async move { owner.consume(observed, instance, receiver).await });
        let previous = session.consumer.lock().await.replace(task);
        session.changed.notify_waiters();
        let initialized = async {
            if let Some(previous) = previous {
                previous.await.map_err(|error| {
                    rpc::Error::internal("session_consumer_task").with_source(error)
                })?;
            }
            if closing {
                return Err(rpc::Error::new(
                    -32006, "native_instance_changed", "The Session closed during native startup",
                ));
            }
            started?;
            let initialize = cli.initialized().await?;
            cli.confirm_selection(model.as_deref(), provider).await?;
            if !cli.apply_search(initial_search.as_ref()).await? {
                return Err(rpc::Error::new(
                    -32006,
                    "search_native_readback",
                    "The initialized CLI search projection could not be confirmed",
                ));
            }
            let mut applied_search = initial_search;
            loop {
                self.accepting()?;
                let search = self.search_guard().await;
                let current = self.0.config.checked_snapshot().await?.search;
                let mut execution = session.data.lock().await;
                if execution.closing
                    || execution
                        .cli
                        .as_ref()
                        .is_none_or(|current| current.instance_id() != cli.instance_id())
                {
                    return Err(rpc::Error::new(
                        -32006,
                        "native_instance_changed",
                        "The initialized CLI instance is no longer current",
                    ));
                }
                if current == applied_search {
                    // Publish readiness with the projection check. A later project must see this instance.
                    execution.native.initialize = Some(initialize);
                    return Ok(());
                }
                drop(execution);
                drop(search);
                if !cli.apply_search(current.as_ref()).await? {
                    return Err(rpc::Error::new(
                        -32006,
                        "search_native_readback",
                        "The initialized CLI search projection could not be confirmed",
                    ));
                }
                applied_search = current;
            }
        }
        .await;
        if let Err(error) = initialized {
            let closed = cli.close().await;
            self.cleanup_result(session, cli.instance_id(), &closed)
                .await;
            return Err(match closed {
                Ok(()) => error,
                Err(cleanup) => error.with_data(json!({ "cleanupFailure": cleanup })),
            });
        }
        Ok(cli)
    }
}
