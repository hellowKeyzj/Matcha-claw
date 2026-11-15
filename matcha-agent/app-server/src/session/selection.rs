use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    cli::{Cli, LaunchSpec, effort, idle::Preparation},
    config,
    provider::ProviderConfig,
    rpc,
};

use super::{Execution, Session, Sessions, dispatch::selection, idle::Idle, record};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Model {
    session_id: String,
    model: String,
    provider_id: Option<String>,
    model_selection_id: Option<String>,
    provider_fingerprint: Option<String>,
}

impl Sessions {
    pub(super) async fn set_model(&self, input: Model) -> rpc::Result<Value> {
        selection(&input.model, "model")?;
        if let Some(id) = &input.provider_id {
            config::validate_id(id)?;
        }
        if let Some(id) = &input.model_selection_id {
            selection(id, "modelSelectionId")?;
        }
        if let Some(fingerprint) = &input.provider_fingerprint {
            selection(fingerprint, "providerFingerprint")?;
        }
        let session = self.session(&input.session_id).await?;
        let owner = self.clone();
        // Native mutation, cleanup and durable confirmation outlive the RPC caller.
        tokio::spawn(async move { owner.change_model(session, input).await })
            .await
            .map_err(|error| {
                rpc::Error::new(
                    -32006,
                    "selection_outcome_unknown",
                    "Session model selection could not be confirmed",
                )
                .with_data(json!({"persisted":null}))
                .with_source(error)
            })?
    }

    async fn change_model(&self, session: Arc<Session>, input: Model) -> rpc::Result<Value> {
        let agent_id = session.record().agent_id.clone();
        let (_agent, _closing) = self.session_admission(&session, &agent_id).await;
        self.accepting()?;
        let snapshot = self.0.config.checked_snapshot().await?;
        let (cli, spec, replay_state, level) = {
            let mut execution = session.data.lock().await;
            writable(&session, &execution)?;
            let record = session.record();
            let mut spec = self.launch_spec(snapshot, &record)?;
            let replay_state = replay_state(&record, &spec)?;
            spec.agent.model = Some(input.model.clone());
            if let Some(provider) = &input.provider_id {
                spec.agent.provider = Some(provider.clone());
            }
            if spec
                .agent
                .provider
                .as_ref()
                .is_some_and(|id| !spec.config.providers.contains_key(id))
            {
                return Err(super::not_sent(rpc::Error::not_found("Provider")));
            }
            let cli = execution.cli.clone();
            let level = record.effort;
            execution.selecting_provider = spec.agent.provider.clone();
            (cli, spec, replay_state, level)
        };
        drop(_agent);
        let result = async {
            self.validate_model_thinking(cli.as_ref(), level, &spec).await?;
            {
                let mut execution = session.data.lock().await;
                writable(&session, &execution)?;
                if cli.is_some() {
                    execution.idle = Idle::Handoff;
                }
            }
            self.apply_model(&session, &input, cli, spec, replay_state).await
        }
        .await;
        let mut execution = session.data.lock().await;
        execution.selecting_provider = None;
        execution.launching = false;
        execution.launch_error = result.as_ref().err().cloned();
        execution.idle = Idle::Dormant;
        drop(execution);
        session.changed.notify_waiters();
        session.wake.notify_one();
        result
    }

    async fn apply_model(
        &self,
        session: &Arc<Session>,
        input: &Model,
        previous: Option<Cli>,
        spec: LaunchSpec,
        replay_state: Option<Value>,
    ) -> rpc::Result<Value> {
        let mut current = previous.clone();
        let mut cleanup_required = false;
        let result = async {
            let response = if let Some(cli) = &previous {
                if cli.connection_matches(&spec)? {
                    let acknowledged = tokio::time::timeout(
                        effort::CONTROL_WINDOW,
                        cli.request(json!({"subtype":"set_model","model":input.model})),
                    ).await.map_err(|_| rpc::Error::new(-32006, "selection_ack_unknown", "Native model acknowledgement did not complete")
                        .with_data(json!({"delivery":"unknown"}))).and_then(|result| result);
                    let response = match acknowledged {
                        Ok(response) => { cleanup_required = true; response }
                        Err(error) => {
                            cleanup_required = error.code == -32006;
                            return Err(error);
                        }
                    };
                    confirm(cli, &spec).await?;
                    Some(response)
                } else {
                    cleanup_required = true;
                    match cli.prepare_handoff(replay_state).await {
                        Ok(Preparation::Ready) => {}
                        Ok(Preparation::Busy | Preparation::Resident) => {
                            cleanup_required = false;
                            return Err(super::not_sent(rpc::Error::conflict("session_native_resident", "Native activity or non-recoverable Session state prevents changing the Provider")));
                        }
                        Err(error) => return Err(error.with_data(json!({"stage":"provider_handoff_prepare","persisted":false}))),
                    }
                    self.stop_instance(session, cli).await?;
                    current = None;
                    if !cli.exited_gracefully() {
                        return Err(rpc::Error::new(-32006, "selection_handoff_exit_unknown", "The old CLI did not exit gracefully; Provider selection was not applied")
                            .with_data(json!({"cleanupComplete":true,"persisted":false})));
                    }
                    {
                        let mut execution = session.data.lock().await;
                        if let Some(error) = &execution.storage_fault {
                            return Err(error.clone());
                        }
                        execution.launching = true;
                    }
                    let cli = self.start_instance(session, spec).await?;
                    current = Some(cli.clone());
                    Some(cli.initialized().await?)
                }
            } else {
                // Offline desired state remains separate from native application.
                None
            };
            self.accepting()?;
            let mut execution = session.data.lock().await;
            session.mutable()?;
            if execution.closing
                || execution.cli.as_ref().map(Cli::instance_id) != current.as_ref().map(Cli::instance_id)
            {
                return Err(rpc::Error::new(-32006, "selection_instance_changed", "The acknowledged CLI instance is no longer current")
                    .with_data(json!({"nativeAcknowledged":response.is_some(),"persisted":false})));
            }
            if let Some(error) = &execution.storage_fault {
                return Err(error.clone());
            }
            let mut updated = (*session.record()).clone();
            updated.model = Some(input.model.clone());
            if let Some(provider) = &input.provider_id {
                if updated.provider_id.as_ref() != Some(provider) {
                    updated.model_selection_id = None;
                    updated.provider_fingerprint = None;
                }
                updated.provider_id = Some(provider.clone());
            }
            if let Some(selection) = &input.model_selection_id {
                updated.model_selection_id = Some(selection.clone());
            }
            if let Some(fingerprint) = &input.provider_fingerprint {
                updated.provider_fingerprint = Some(fingerprint.clone());
            }
            updated.updated_at_ms = rpc::now_ms();
            if let Err(error) = session.commit(&self.0.database, &mut execution, updated).await {
                execution.fault(error.clone());
                let persisted = if error.code == -32006 { Value::Null } else { Value::Bool(false) };
                return Err(error.with_data(json!({"nativeAcknowledged":response.is_some(),"persisted":persisted})));
            }
            Ok(json!({"session":session.record().view(),"applied":response.is_some(),"response":response}))
        }.await;
        if let Err(error) = &result {
            let mut error = error.clone();
            if error
                .data
                .as_ref()
                .and_then(|data| data.get("persisted"))
                .is_none()
            {
                error = error.with_data(json!({"persisted":false}));
            }
            if cleanup_required && error.code != -32006 {
                let cause_code = error.code;
                error.code = -32006;
                error = error.with_data(json!({"causeCode":cause_code,"nativeStateChanged":true}));
            }
            // A definite rejection leaves the old instance intact. Unknown or partially
            // applied native state must not serve later Runs under the old record.
            if cleanup_required {
                let cli = session.data.lock().await.cli.clone().or(current);
                if let Some(cli) = cli {
                    let cleanup = self.stop_instance(session, &cli).await;
                    return Err(error.with_data(
                        json!({"cleanupComplete":cleanup.is_ok(),"cleanupFailure":cleanup.err()}),
                    ));
                }
                self.join_consumer(session).await.map_err(|cleanup| {
                    error.clone().with_data(json!({"cleanupFailure":cleanup}))
                })?;
            }
            return Err(error);
        }
        result
    }
}

async fn confirm(cli: &Cli, spec: &LaunchSpec) -> rpc::Result<Value> {
    let provider = spec
        .agent
        .provider
        .as_ref()
        .map(|id| {
            ProviderConfig::parse(
                spec.config
                    .providers
                    .get(id)
                    .ok_or_else(|| rpc::Error::not_found("Provider"))?,
            )
            .map(|provider| provider.kind)
        })
        .transpose()?;
    let model = spec
        .agent
        .provider
        .as_deref()
        .filter(|id| id.starts_with("host-account-") || id.starts_with("host-session-"))
        .and(spec.agent.model.as_deref());
    cli.confirm_selection(model, provider).await
}

pub(super) fn replay_state(record: &record::Record, spec: &LaunchSpec) -> rpc::Result<Option<Value>> {
    let model = record
        .model
        .clone()
        .or_else(|| spec.agent.model.clone())
        .or_else(|| {
            let id = spec.agent.provider.as_ref()?;
            ProviderConfig::parse(spec.config.providers.get(id)?)
                .ok()?
                .model
        });
    let mode = record
        .mode
        .as_deref()
        .or_else(|| {
            spec.agent
                .settings
                .pointer("/permissions/defaultMode")
                .and_then(Value::as_str)
        })
        .unwrap_or("default");
    let mut replay = json!({
        "model":model,"permissionMode":mode,"effort":record.effort,
        "permissions":crate::cli::permissions::project(
            spec.agent.settings.get("permissions").cloned().unwrap_or_else(|| json!({})),
            &spec.agent.skill_states,
        )?,
        "initialization":{
            "systemPrompt":spec.agent.system_prompt,
            "appendSystemPrompt":crate::prompt::append_system_prompt(
                &spec.agent_id,
                spec.agent.append_system_prompt.as_deref(),
            ),
        },
    });
    if let Some(search) = &spec.config.search {
        replay["search"] = search.settings();
    }
    Ok(Some(replay))
}

fn writable(session: &Session, execution: &Execution) -> rpc::Result<()> {
    session.mutable()?;
    if execution.closing
        || execution.idle.handing_off()
        || execution.launching
        || (execution.consuming && execution.cli.is_none())
    {
        return Err(super::not_sent(rpc::Error::conflict(
            "session_transition_in_progress",
            "Wait for native Session startup or cleanup before selecting a model",
        )));
    }
    if execution.cleanup_failed || session.record().native_cleanup_failed {
        return Err(super::not_sent(rpc::Error::conflict(
            "native_cleanup_unconfirmed",
            "The previous CLI instance cleanup was not confirmed",
        )));
    }
    if let Some(error) = &execution.storage_fault {
        return Err(error.clone());
    }
    if execution.active.is_some()
        || !execution.queue.is_empty()
        || execution.sending
        || execution.cancel_in_flight
        || execution.native.busy
    {
        return Err(super::not_sent(rpc::Error::conflict(
            "session_busy",
            "Wait for the Session Run and native activity to finish before selecting a model",
        )));
    }
    Ok(())
}
