use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    cli::{Cli, LaunchSpec},
    config::Config,
    rpc,
};

use super::{Execution, Session, Sessions, history, native, record};

impl Sessions {
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
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let mut waited = false;
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let admission = self.agent_guard(&agent_id).await;
            self.accepting()?;
            let config = self.0.config.snapshot().await;
            let mut execution = session.data.lock().await;
            execution.record.mutable()?;
            if execution.closing || execution.record.status == record::Status::Closed {
                return Err(super::not_sent(rpc::Error::conflict(
                    "session_closed",
                    "Resume the session before starting its native instance",
                )));
            }
            if execution.record.native_cleanup_failed {
                return Err(super::not_sent(rpc::Error::conflict(
                    "native_cleanup_unconfirmed",
                    "The previous CLI instance cleanup was not confirmed",
                )));
            }
            if let Some(error) = &execution.storage_fault {
                return Err(error.clone());
            }
            if waited && !execution.launching {
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
            if execution.launching || (execution.consuming && execution.cli.is_none()) {
                drop(execution);
                drop(admission);
                changed.await;
                waited = true;
                continue;
            }
            if execution.cli.is_some() {
                let mut snapshot = execution.native.view(
                    &execution.record.session_id,
                    &execution.record.agent_id,
                    execution.cli.as_ref().map(Cli::instance_id),
                );
                snapshot["launching"] = json!(false);
                return Ok(snapshot);
            }
            let spec = self.launch_spec(config, &execution)?;
            execution.launching = true;
            execution.launch_error = None;
            drop(execution);
            drop(admission);
            let started = self.start_instance(&session, spec).await;
            let mut execution = session.data.lock().await;
            execution.launching = false;
            execution.launch_error = started.as_ref().err().cloned();
            session.changed.notify_waiters();
            session.wake.notify_one();
            let cli = started?;
            execution.record.mutable()?;
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
                &execution.record.session_id,
                &execution.record.agent_id,
                Some(cli.instance_id()),
            );
            snapshot["launching"] = json!(false);
            return Ok(snapshot);
        }
    }

    pub(super) fn launch_spec(
        &self,
        config: Config,
        execution: &Execution,
    ) -> rpc::Result<LaunchSpec> {
        let agent_id = execution.record.agent_id.clone();
        let mut agent = config
            .agents
            .get(&agent_id)
            .cloned()
            .ok_or_else(|| rpc::Error::not_found("Agent"))?;
        if let Some(provider) = &execution.record.provider_id {
            agent.provider = Some(provider.clone());
        }
        if let Some(model) = &execution.record.model {
            agent.model = Some(model.clone());
        }
        if let Some(mode) = &execution.record.mode {
            agent.settings["permissions"]["defaultMode"] = json!(mode);
        }
        Ok(LaunchSpec {
            config,
            agent,
            agent_id,
            session_id: execution.record.session_id.clone(),
            paths: self.0.config.paths().clone(),
            resume: execution.record.native_started,
            fork_from: if execution.record.native_started {
                None
            } else {
                execution.record.forked_from.clone()
            },
        })
    }

    pub(super) async fn start_instance(
        &self,
        session: &Arc<Session>,
        mut spec: LaunchSpec,
    ) -> rpc::Result<Cli> {
        match history::locate(
            &self.0.config.paths().runtime(&spec.agent_id)?,
            &self.0.config.paths().workspace(&spec.agent_id)?,
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
        let (cli, receiver) = match Cli::start(spec, self.0.diagnostics.clone()).await {
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
        let started = {
            let mut execution = session.data.lock().await;
            execution.cli = Some(cli.clone());
            execution.native = native::Snapshot::default();
            execution.consuming = true;
            if let Some(active) = execution.active.as_mut() {
                active.ownership_ambiguous |= cli.has_autonomous_inputs();
            }
            self.0
                .events
                .append(
                    &execution.record.session_id,
                    execution
                        .active
                        .as_ref()
                        .map(|active| active.record.run.run_id.as_str()),
                    "cli.started",
                    json!({ "instanceId": cli.instance_id() }),
                )
                .await
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
            started?;
            let initialize = cli.initialized().await?;
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
            execution.native.initialize = Some(initialize);
            Ok(())
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
