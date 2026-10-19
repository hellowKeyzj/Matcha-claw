use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use crate::{config, rpc};

use super::{Execution, Session, Sessions, history, native, record, run, validate_uuid};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    agent_id: String,
    session_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKey {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    session_id: String,
    #[serde(default)]
    history: bool,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    agent_id: Option<String>,
    limit: Option<usize>,
    before_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fork {
    session_id: String,
    new_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Submit {
    session_id: String,
    content: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunKey {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Runs {
    session_id: String,
    limit: Option<usize>,
    before_run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Model {
    session_id: String,
    model: String,
    provider_id: Option<String>,
    model_selection_id: Option<String>,
    provider_fingerprint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mode {
    session_id: String,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proactive {
    session_id: String,
    enabled: bool,
}

impl Sessions {
    pub async fn dispatch(&self, method: &str, params: Value) -> rpc::Result<Value> {
        match method {
            "sessions.create" => self.create(rpc::params(params)?, None).await,
            "sessions.list" => self.list(rpc::params(params)?).await,
            "sessions.get" => self.get(rpc::params(params)?).await,
            "sessions.rename" => self.rename(rpc::params(params)?).await,
            "sessions.delete" => self.delete(rpc::params(params)?).await,
            "sessions.retire" => self.retire(rpc::params(params)?).await,
            "sessions.native" => {
                let input: SessionKey = rpc::params(params)?;
                self.native_snapshot(&input.session_id).await
            }
            "sessions.close" => {
                let input: SessionKey = rpc::params(params)?;
                let session = self.session(&input.session_id).await?;
                let owner = self.clone();
                tokio::spawn(async move {
                    owner.close_execution(session.clone(), true).await?;
                    Ok(session.data.lock().await.record.view())
                })
                .await
                .map_err(|_| {
                    rpc::Error::new(
                        -32006,
                        "session_close_unknown",
                        "Session cleanup could not be confirmed",
                    )
                })?
            }
            "sessions.resume" => {
                let input: SessionKey = rpc::params(params)?;
                self.resume(&input.session_id).await
            }
            "sessions.fork" => self.fork(rpc::params(params)?).await,
            "sessions.setModel" => {
                let input: Model = rpc::params(params)?;
                self.set_selection(&input.session_id, &input.model, true, Some(&input))
                    .await
            }
            "sessions.setMode" => {
                let input: Mode = rpc::params(params)?;
                self.set_selection(&input.session_id, &input.mode, false, None)
                    .await
            }
            "sessions.setProactive" => {
                let input: Proactive = rpc::params(params)?;
                let owner = self.clone();
                tokio::spawn(async move { owner.set_proactive(input).await })
                    .await
                    .map_err(|error| {
                        rpc::Error::new(
                            -32006,
                            "proactive_control_unknown",
                            "The proactive control outcome could not be confirmed",
                        )
                        .with_source(error)
                    })?
            }
            "runs.submit" => {
                let input: Submit = rpc::params(params)?;
                let run_id = self.submit(&input.session_id, input.content).await?;
                Ok(json!({ "sessionId": input.session_id, "runId": run_id, "status": "queued" }))
            }
            "runs.get" => {
                let input: RunKey = rpc::params(params)?;
                validate_uuid(&input.run_id)?;
                rpc::value(record::get_run(&self.0.database, &input.run_id).await?.run)
            }
            "runs.list" => self.list_runs(rpc::params(params)?).await,
            "runs.cancel" => {
                let input: RunKey = rpc::params(params)?;
                let owner = self.clone();
                tokio::spawn(async move { owner.cancel(&input.run_id).await })
                    .await
                    .map_err(|_| {
                        rpc::Error::new(
                            -32006,
                            "run_cancel_unknown",
                            "The cancellation outcome could not be confirmed",
                        )
                    })?
            }
            _ => Err(rpc::Error::method(method)),
        }
    }

    async fn create(&self, input: Create, forked_from: Option<String>) -> rpc::Result<Value> {
        self.accepting()?;
        config::validate_id(&input.agent_id)?;
        if let Some(model) = &input.model {
            selection(model, "model")?;
        }
        if let Some(mode) = &input.mode {
            validate_mode(mode)?;
        }
        let session_id = input
            .session_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_uuid(&session_id)?;
        let owner = self.clone();
        tokio::spawn(async move {
            let _guard = owner.agent_guard(&input.agent_id).await;
            owner.accepting()?;
            if !owner
                .0
                .config
                .snapshot()
                .await
                .agents
                .contains_key(&input.agent_id)
            {
                return Err(rpc::Error::not_found("Agent"));
            }
            if let Some(existing) = owner.0.sessions.read().await.get(&session_id).cloned() {
                let execution = existing.data.lock().await;
                if execution.record.agent_id != input.agent_id {
                    return Err(rpc::Error::conflict(
                        "session_agent_mismatch",
                        "This session identity belongs to another Agent",
                    ));
                }
                execution.record.mutable()?;
                return Ok(execution.record.view());
            }
            record::assert_not_deleted(&owner.0.database, &session_id).await?;
            let source = if let Some(source_id) = &forked_from {
                let source = owner.session(source_id).await?;
                let execution = source.data.lock().await;
                execution.record.mutable()?;
                Some(execution.record.clone())
            } else {
                None
            };
            let now = rpc::now_ms();
            let record = record::Record {
                session_id: session_id.clone(),
                agent_id: input.agent_id.clone(),
                status: record::Status::Open,
                created_at_ms: now,
                updated_at_ms: now,
                model: input.model,
                mode: input.mode,
                title: None,
                provider_id: source
                    .as_ref()
                    .and_then(|record| record.provider_id.clone()),
                model_selection_id: source
                    .as_ref()
                    .and_then(|record| record.model_selection_id.clone()),
                provider_fingerprint: source
                    .as_ref()
                    .and_then(|record| record.provider_fingerprint.clone()),
                native_cleanup_failed: false,
                forked_from,
                native_started: false,
                workspace: owner.0.config.paths().workspace(&input.agent_id)?,
                runtime: owner.0.config.paths().runtime(&input.agent_id)?,
                transcript: None,
            };
            record::save_session(&owner.0.database, &record).await?;
            let result = record.view();
            let session = Arc::new(Session {
                data: Mutex::new(Execution {
                    record,
                    queue: Default::default(),
                    active: None,
                    cli: None,
                    native: native::Snapshot::default(),
                    idle: super::idle::Idle::Dormant,
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
            let mut sessions = owner.0.sessions.write().await;
            if sessions.contains_key(&session_id) {
                return Err(rpc::Error::conflict(
                    "session_identity_in_use",
                    "This session identity was created concurrently",
                ));
            }
            sessions.insert(session_id, session.clone());
            drop(sessions);
            owner.start_executor(session).await;
            Ok(result)
        })
        .await
        .map_err(|_| {
            rpc::Error::new(
                -32006,
                "session_creation_unknown",
                "Session creation could not be confirmed",
            )
        })?
    }

    async fn list(&self, input: List) -> rpc::Result<Value> {
        if let Some(agent_id) = &input.agent_id {
            config::validate_id(agent_id)?;
        }
        let sessions: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        let mut records = Vec::new();
        for session in sessions {
            records.push(session.data.lock().await.record.clone());
        }
        records.sort_by(|left, right| {
            (right.created_at_ms, &right.session_id).cmp(&(left.created_at_ms, &left.session_id))
        });
        let cursor = if let Some(id) = &input.before_session_id {
            validate_uuid(id)?;
            let record = records
                .iter()
                .find(|record| record.session_id == *id)
                .ok_or_else(|| rpc::Error::not_found("Session cursor"))?;
            Some((record.created_at_ms, record.session_id.clone()))
        } else {
            None
        };
        let limit = input.limit.unwrap_or(100);
        let mut selected: Vec<_> = records
            .into_iter()
            .filter(|record| {
                input
                    .agent_id
                    .as_ref()
                    .is_none_or(|agent| *agent == record.agent_id)
                    && cursor.as_ref().is_none_or(|(at, id)| {
                        (record.created_at_ms, &record.session_id) < (*at, id)
                    })
            })
            .take(limit.saturating_add(1))
            .collect();
        let more = selected.len() > limit;
        selected.truncate(limit);
        let next = if more {
            selected.last().map(|record| record.session_id.clone())
        } else {
            None
        };
        Ok(
            json!({ "sessions": selected.iter().map(record::Record::view).collect::<Vec<_>>(), "nextBeforeSessionId": next }),
        )
    }

    async fn get(&self, input: Get) -> rpc::Result<Value> {
        let session = self.session(&input.session_id).await?;
        let execution = session.data.lock().await;
        execution.record.mutable()?;
        let record = &execution.record;
        let mut result = record.view();
        if input.history {
            result["history"] = history::read(
                &self.0.database,
                &record.runtime,
                &record.workspace,
                &record.session_id,
                input.offset,
                input.limit.unwrap_or(80),
            )
            .await?;
        }
        Ok(result)
    }

    async fn resume(&self, session_id: &str) -> rpc::Result<Value> {
        self.accepting()?;
        let session = self.session(session_id).await?;
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let _guard = self.agent_guard(&agent_id).await;
        self.accepting()?;
        if !self
            .0
            .config
            .snapshot()
            .await
            .agents
            .contains_key(&agent_id)
        {
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
        if execution.closing
            || execution.idle.handing_off()
            || execution.launching
            || execution.sending
        {
            return Err(rpc::Error::conflict(
                "session_transition_in_progress",
                "Wait for session cleanup or startup to finish",
            ));
        }
        if execution.record.status == record::Status::Open {
            return Ok(execution.record.view());
        }
        let mut resumed = execution.record.clone();
        if resumed.native_started {
            resumed.transcript =
                history::locate(&resumed.runtime, &resumed.workspace, session_id).await?;
            if resumed.transcript.is_none() {
                return Err(rpc::Error::not_found("Native transcript"));
            }
        }
        resumed.status = record::Status::Open;
        resumed.updated_at_ms = rpc::now_ms();
        record::save_session(&self.0.database, &resumed).await?;
        execution.record = resumed;
        Ok(execution.record.view())
    }

    async fn fork(&self, input: Fork) -> rpc::Result<Value> {
        self.accepting()?;
        let source = self.session(&input.session_id).await?;
        let agent_id = source.data.lock().await.record.agent_id.clone();
        let guard = self.agent_guard(&agent_id).await;
        let execution = source.data.lock().await;
        execution.record.mutable()?;
        if execution.record.native_cleanup_failed {
            return Err(rpc::Error::conflict(
                "native_cleanup_unconfirmed",
                "The previous CLI instance cleanup was not confirmed",
            ));
        }
        if execution.active.is_some()
            || execution.launching
            || execution.sending
            || !execution.queue.is_empty()
            || execution.native.busy
            || execution.closing
            || execution.idle.handing_off()
        {
            return Err(rpc::Error::conflict(
                "session_busy",
                "Fork only after the native session is idle",
            ));
        }
        let path = history::locate(
            &execution.record.runtime,
            &execution.record.workspace,
            &input.session_id,
        )
        .await?;
        if path.is_none() {
            return Err(rpc::Error::not_found("Native transcript"));
        }
        let create = Create {
            agent_id,
            session_id: input.new_session_id,
            model: execution.record.model.clone(),
            mode: execution.record.mode.clone(),
        };
        if create.session_id.as_deref() == Some(input.session_id.as_str()) {
            return Err(rpc::Error::invalid("Fork requires a new session identity"));
        }
        drop(execution);
        drop(guard);
        self.create(create, Some(input.session_id)).await
    }

    async fn set_proactive(&self, input: Proactive) -> rpc::Result<Value> {
        let session = self
            .session(&input.session_id)
            .await
            .map_err(super::not_sent)?;
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let _guard = self.agent_guard(&agent_id).await;
        self.accepting().map_err(super::not_sent)?;
        let (control, previous) = {
            let mut execution = session.data.lock().await;
            execution.record.mutable().map_err(super::not_sent)?;
            if execution.closing || execution.idle.handing_off() {
                return Err(super::not_sent(rpc::Error::conflict(
                    "session_closing",
                    "Session cleanup is in progress",
                )));
            }
            let control = execution
                .cli
                .as_ref()
                .ok_or_else(|| {
                    super::not_sent(rpc::Error::unavailable(
                        "native_instance_absent",
                        "This session has no live CLI instance",
                    ))
                })?
                .admit()?;
            let previous = execution.native.proactive;
            execution.native.proactive = native::Proactive::OutcomeUnknown;
            if let Some(active) = execution.active.as_mut() {
                active.ownership_ambiguous = true;
            }
            (control, previous)
        };
        let instance_id = control.instance_id();
        let response = control
            .request(json!({ "subtype": "set_proactive", "enabled": input.enabled }))
            .await;
        let mut execution = session.data.lock().await;
        let same_instance = execution
            .cli
            .as_ref()
            .is_some_and(|cli| cli.instance_id() == instance_id);
        match response {
            Ok(_) => {
                if !same_instance {
                    return Err(rpc::Error::new(
                        -32006,
                        "proactive_instance_changed",
                        "The acknowledged CLI instance is no longer current",
                    )
                    .with_data(json!({ "nativeAcknowledged": true, "instanceId": instance_id })));
                }
                execution.native.proactive = if input.enabled {
                    native::Proactive::Enabled
                } else {
                    native::Proactive::Disabled
                };
                Ok(
                    json!({ "sessionId": input.session_id, "instanceId": instance_id, "enabled": input.enabled, "nativeAcknowledged": true }),
                )
            }
            Err(error) => {
                if same_instance
                    && error
                        .data
                        .as_ref()
                        .and_then(|data| data.get("delivery"))
                        .and_then(Value::as_str)
                        == Some("notSent")
                {
                    execution.native.proactive = previous;
                }
                Err(error)
            }
        }
    }

    async fn set_selection(
        &self,
        session_id: &str,
        selected: &str,
        model: bool,
        binding: Option<&Model>,
    ) -> rpc::Result<Value> {
        selection(selected, if model { "model" } else { "mode" })?;
        if !model {
            validate_mode(selected)?;
        }
        if let Some(binding) = binding {
            if let Some(id) = &binding.provider_id {
                config::validate_id(id)?;
            }
            if let Some(id) = &binding.model_selection_id {
                selection(id, "modelSelectionId")?;
            }
            if let Some(fingerprint) = &binding.provider_fingerprint {
                selection(fingerprint, "providerFingerprint")?;
            }
        }
        let session = self.session(session_id).await?;
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let _guard = self.agent_guard(&agent_id).await;
        self.accepting()?;
        let snapshot = self.0.config.snapshot().await;
        let (cli, control) = {
            let mut execution = session.data.lock().await;
            execution.record.mutable()?;
            if let Some(binding) = binding {
                let provider = binding
                    .provider_id
                    .as_ref()
                    .or(execution.record.provider_id.as_ref());
                if provider.is_some_and(|id| !snapshot.providers.contains_key(id)) {
                    return Err(rpc::Error::not_found("Provider"));
                }
                let effective_provider = execution.record.provider_id.as_ref().or_else(|| {
                    snapshot
                        .agents
                        .get(&agent_id)
                        .and_then(|agent| agent.provider.as_ref())
                });
                let provider_changed = binding
                    .provider_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != effective_provider);
                if provider_changed && execution.cli.is_some() {
                    return Err(rpc::Error::conflict(
                        "session_provider_requires_restart",
                        "Close the CLI instance before changing this session Provider",
                    )
                    .with_data(json!({ "requiresRestart": true, "nativeRequestSent": false })));
                }
            }
            if execution.closing
                || execution.idle.handing_off()
                || execution.launching
                || execution.sending
            {
                return Err(super::not_sent(rpc::Error::conflict(
                    "session_transition_in_progress",
                    "Wait for session startup or cleanup",
                )));
            }
            execution.idle.activity();
            session.wake.notify_one();
            (
                execution.cli.clone(),
                execution
                    .cli
                    .as_ref()
                    .map(crate::cli::Cli::admit)
                    .transpose()?,
            )
        };
        let response = if let Some(cli) = &cli {
            cli.initialized().await?;
            if model && cli.model_requires_restart() {
                return Err(rpc::Error::conflict("native_model_override", "The current CLI model is fixed by its Provider environment; close and select the model before resuming").with_data(json!({ "requiresRestart": true, "nativeRequestSent": false })));
            }
            Some(
                control
                    .as_ref()
                    .expect("CLI control admission")
                    .request(if model {
                        json!({ "subtype": "set_model", "model": selected })
                    } else {
                        json!({ "subtype": "set_permission_mode", "mode": selected })
                    })
                    .await?,
            )
        } else {
            None
        };
        let mut execution = session.data.lock().await;
        if let Some(cli) = &cli
            && !execution
                .cli
                .as_ref()
                .is_some_and(|current| current.instance_id() == cli.instance_id())
        {
            return Err(rpc::Error::new(
                -32006,
                "selection_instance_changed",
                "Native acknowledgement belongs to an instance that has since exited",
            )
            .with_data(json!({ "nativeAcknowledged": true })));
        }
        let mut updated = execution.record.clone();
        execution.record.mutable()?;
        if model {
            updated.model = Some(selected.to_owned());
            if let Some(binding) = binding {
                if let Some(provider) = &binding.provider_id {
                    if updated.provider_id.as_ref() != Some(provider) {
                        updated.model_selection_id = None;
                        updated.provider_fingerprint = None;
                    }
                    updated.provider_id = Some(provider.clone());
                }
                if let Some(selection) = &binding.model_selection_id {
                    updated.model_selection_id = Some(selection.clone());
                }
                if let Some(fingerprint) = &binding.provider_fingerprint {
                    updated.provider_fingerprint = Some(fingerprint.clone());
                }
            }
        } else {
            updated.mode = Some(selected.to_owned());
        }
        updated.updated_at_ms = rpc::now_ms();
        record::save_session(&self.0.database, &updated)
            .await
            .map_err(|error| {
                error.with_data(json!({ "nativeAcknowledged": response.is_some() }))
            })?;
        execution.record = updated;
        Ok(
            json!({ "session": execution.record.view(), "applied": response.is_some(), "response": response }),
        )
    }

    async fn list_runs(&self, input: Runs) -> rpc::Result<Value> {
        self.session(&input.session_id).await?;
        if let Some(cursor) = &input.before_run_id {
            validate_uuid(cursor)?;
        }
        rpc::value(
            record::list_runs(
                &self.0.database,
                &input.session_id,
                input.before_run_id.as_deref(),
                input.limit.unwrap_or(100),
            )
            .await?,
        )
    }

    async fn cancel(&self, run_id: &str) -> rpc::Result<Value> {
        validate_uuid(run_id)?;
        let record = record::get_run(&self.0.database, run_id).await?;
        if record.run.status.terminal() {
            return rpc::value(record.run);
        }
        let session = self.session(&record.run.session_id).await?;
        let mut execution = session.data.lock().await;
        execution.record.mutable()?;
        execution.idle.activity();
        session.wake.notify_one();
        if let Some(index) = execution
            .queue
            .iter()
            .position(|queued| queued.run.run_id == run_id)
        {
            let mut cancelled = execution.queue[index].clone();
            cancelled.finish(run::Status::Cancelled, "cancelled_before_send", None);
            self.save_run_locked(&mut execution, &cancelled).await?;
            execution.queue.remove(index);
            return rpc::value(cancelled.run);
        }
        let cli = execution.cli.clone();
        let control = execution
            .cli
            .as_ref()
            .map(crate::cli::Cli::admit)
            .transpose()?;
        let Some(active) = execution
            .active
            .as_mut()
            .filter(|active| active.record.run.run_id == run_id)
        else {
            drop(execution);
            return rpc::value(record::get_run(&self.0.database, run_id).await?.run);
        };
        if active.record.run.cancel_requested_at_ms.is_some() {
            return rpc::value(&active.record.run);
        }
        let mut requested = active.record.clone();
        requested.run.status = run::Status::CancelRequested;
        requested.run.cancel_requested_at_ms = Some(rpc::now_ms());
        self.save_run_locked(&mut execution, &requested).await?;
        let active = execution.active.as_mut().expect("active run checked");
        active.record = requested;
        let result = rpc::value(&active.record.run)?;
        if !active.input_started {
            return Ok(result);
        }
        let Some(cli) = cli else {
            return Ok(result);
        };
        execution.cancel_in_flight = true;
        drop(execution);
        // Bind this interrupt to the accepted input and instance. Wait only for the
        // prompt write, never for model execution or approval completion.
        let send = loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let execution = session.data.lock().await;
            if !execution
                .cli
                .as_ref()
                .is_some_and(|current| current.instance_id() == cli.instance_id())
                || !execution
                    .active
                    .as_ref()
                    .is_some_and(|active| active.record.run.run_id == run_id)
            {
                break false;
            }
            if !execution.sending {
                break true;
            }
            drop(execution);
            changed.await;
        };
        let response = if send {
            control
                .as_ref()
                .expect("CLI control admission")
                .request(json!({ "subtype": "interrupt" }))
                .await
                .map(|_| ())
        } else {
            Ok(())
        };
        session.data.lock().await.cancel_in_flight = false;
        session.changed.notify_waiters();
        session.wake.notify_one();
        response.map_err(|error| {
            error.with_data(json!({ "runId": run_id, "cancelRequested": true }))
        })?;
        Ok(result)
    }
}

pub(super) fn selection(value: &str, field: &str) -> rpc::Result<()> {
    if value.trim().is_empty() || value.contains(['\0', '\n', '\r']) {
        return Err(rpc::Error::invalid(format!(
            "{field} must be nonempty and single-line"
        )));
    }
    Ok(())
}

fn validate_mode(mode: &str) -> rpc::Result<()> {
    if !matches!(
        mode,
        "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
    ) {
        return Err(rpc::Error::invalid("Unknown native permission mode"));
    }
    Ok(())
}
