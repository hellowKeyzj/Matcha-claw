use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    cli::{
        Cli, LaunchSpec,
        effort::{self, Capabilities, Level},
    },
    config::Config,
    provider::{ProviderConfig, ProviderKind},
    rpc,
};

use super::{Execution, Sessions, record};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Set {
    session_id: String,
    #[serde(deserialize_with = "Option::<Level>::deserialize")]
    level: Option<Level>,
}

impl Sessions {
    fn thinking_config(&self, config: Config, execution: &Execution) -> rpc::Result<Config> {
        let spec = self.launch_spec(config, execution)?;
        let mut config = spec.config;
        config.agents.insert(spec.agent_id, spec.agent);
        Ok(config)
    }

    pub(super) async fn get_thinking(&self, session_id: &str) -> rpc::Result<Value> {
        let session = self.session(session_id).await?;
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let guard = self.agent_guard(&agent_id).await;
        self.accepting()?;
        let closing = session.close_guard.lock().await;
        let snapshot = self.0.config.snapshot().await;
        let execution = session.data.lock().await;
        readable(&execution)?;
        let level = execution.record.effort;
        let cli = execution.cli.clone();
        let control = cli.as_ref().map(Cli::admit).transpose()?;
        let config = self.thinking_config(snapshot, &execution)?;
        drop(execution);
        if let Some(control) = &control {
            let response =
                control_request(control, json!({"subtype":"get_settings"}), false).await?;
            let capabilities = effort::readback(&response)?;
            let execution = session.data.lock().await;
            readable(&execution)?;
            current_instance(&execution, cli.as_ref(), false)?;
            return Ok(capabilities.view(level));
        }
        let launch =
            effort::prepare(&config, self.0.config.paths(), &agent_id, level, None).await?;
        drop(closing);
        drop(guard);
        let capabilities = effort::inspect(&launch).await?;
        let _guard = self.agent_guard(&agent_id).await;
        self.accepting()?;
        let _closing = session.close_guard.lock().await;
        let snapshot = self.0.config.snapshot().await;
        let execution = session.data.lock().await;
        readable(&execution)?;
        current_instance(&execution, None, false)?;
        let current_level = execution.record.effort;
        let current = self.thinking_config(snapshot, &execution)?;
        drop(execution);
        effort::ensure_current(
            &launch,
            &current,
            self.0.config.paths(),
            &agent_id,
            current_level,
            None,
        )?;
        Ok(capabilities.view(level))
    }

    pub(super) async fn set_thinking(&self, input: Set) -> rpc::Result<Value> {
        let level = input.level;
        let owner = self.clone();
        tokio::spawn(async move { owner.apply_thinking(&input.session_id, level).await })
            .await
            .map_err(|source| {
                unknown(
                    "thinking_control_unknown",
                    "The thinking setting outcome could not be confirmed",
                )
                .with_source(source)
            })?
    }

    async fn apply_thinking(&self, session_id: &str, level: Option<Level>) -> rpc::Result<Value> {
        let tracing = std::env::var("MATCHACLAW_TRACE").as_deref() == Ok("1");
        let mut context = if tracing {
            json!({
                "sessionHash": format!("{:x}", Sha256::digest(session_id.as_bytes())),
                "level": level, "persisted": false, "applied": false,
                "provider": "unknown", "protocol": "unknown",
            })
        } else {
            Value::Null
        };
        let result = self.mutate_thinking(session_id, level, &mut context).await;
        if !tracing {
            return result;
        }
        let reason = match &result {
            Ok(_) => "thinking_persisted",
            Err(error) => {
                context["causeCode"] = json!(error.code);
                let data = error.data.as_ref();
                if let Some(request) = data
                    .and_then(|data| data.get("nativeRequestId"))
                    .and_then(Value::as_str)
                {
                    context["requestHash"] =
                        json!(format!("{:x}", Sha256::digest(request.as_bytes())));
                }
                if let Some(applied) = data.and_then(|data| data.get("nativeAcknowledged")) {
                    context["applied"] = applied.clone();
                }
                data.and_then(|data| data.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("thinking_failed")
            }
        };
        self.0
            .diagnostics
            .trace("session", "thinking_set", reason, context)
            .await;
        result
    }

    async fn mutate_thinking(
        &self,
        session_id: &str,
        level: Option<Level>,
        trace: &mut Value,
    ) -> rpc::Result<Value> {
        let session = self.session(session_id).await.map_err(super::not_sent)?;
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let _guard = self.agent_guard(&agent_id).await;
        self.accepting().map_err(super::not_sent)?;
        let _closing = session.close_guard.lock().await;
        let snapshot = self.0.config.snapshot().await;
        let mut execution = session.data.lock().await;
        readable(&execution).map_err(super::not_sent)?;
        let cli = execution.cli.clone();
        let control = cli.as_ref().map(Cli::admit).transpose()?;
        let config = self
            .thinking_config(snapshot, &execution)
            .map_err(super::not_sent)?;
        if !trace.is_null()
            && let Some(agent) = config.agents.get(&agent_id)
        {
            let provider = agent
                .provider
                .as_ref()
                .and_then(|id| config.providers.get(id))
                .and_then(|value| ProviderConfig::parse(value).ok());
            let kind = provider
                .as_ref()
                .map(|provider| provider.kind)
                .unwrap_or(ProviderKind::FirstParty);
            trace["provider"] = json!(kind);
            trace["protocol"] = json!(match kind {
                ProviderKind::Openai => "chat_completions",
                ProviderKind::OpenaiResponses => "responses",
                ProviderKind::Gemini => "gemini",
                ProviderKind::Grok => "grok",
                _ => "anthropic",
            });
        }
        execution.idle.activity();
        session.wake.notify_one();
        drop(execution);
        let capabilities = if let Some(control) = &control {
            if !trace.is_null() {
                trace["applied"] = Value::Null;
            }
            let response = control_request(
                control,
                json!({"subtype":"set_effort", "effort":level}),
                true,
            )
            .await?;
            if !trace.is_null() {
                trace["applied"] = json!(true);
            }
            effort::acknowledgement(&response, level).map_err(|source| {
                unknown("thinking_native_ack_invalid", "Native thinking acknowledgement is invalid; read the current setting before retrying")
                    .with_data(json!({"nativeAcknowledged":true,"persisted":false}))
                    .with_source(source)
            })?
        } else {
            let capabilities =
                effort::query(&config, self.0.config.paths(), &agent_id, level, None)
                    .await
                    .map_err(super::not_sent)?;
            capabilities
        };
        if !trace.is_null() {
            trace["modelHash"] = json!(format!(
                "{:x}",
                Sha256::digest(capabilities.model.as_bytes())
            ));
            trace["supportsEffort"] = json!(capabilities.supports_effort);
            trace["options"] = json!(capabilities.supported_effort_levels);
            trace["effective"] = json!(capabilities.effective_level);
        }
        ensure_supported(&capabilities, level)?;
        let applied = cli.is_some();
        let mut execution = session.data.lock().await;
        current_instance(&execution, cli.as_ref(), applied)?;
        readable(&execution).map_err(|error| {
            if applied {
                unknown("thinking_session_changed", "The Session changed after native acknowledgement; the setting was not persisted")
                    .with_data(json!({"nativeAcknowledged":true,"persisted":false}))
                    .with_source(error)
            } else {
                super::not_sent(error)
            }
        })?;
        // Native metadata can advance while control is pending; merge only into the latest locked record.
        let mut updated = execution.record.clone();
        updated.effort = level;
        updated.updated_at_ms = rpc::now_ms();
        record::save_session(&self.0.database, &updated)
            .await
            .map_err(|error| {
                error.with_data(json!({"nativeAcknowledged":applied,"persisted":false}))
            })?;
        execution.record = updated;
        if !trace.is_null() {
            trace["persisted"] = json!(true);
        }
        let mut result = capabilities.view(level);
        result["persisted"] = json!(true);
        result["applied"] = json!(applied);
        Ok(result)
    }

    pub(super) async fn validate_model_thinking(
        &self,
        execution: &Execution,
        spec: &LaunchSpec,
    ) -> rpc::Result<()> {
        let Some(level) = execution.record.effort else {
            return Ok(());
        };
        writable(execution)?;
        let capabilities = if let Some(cli) = &execution.cli
            && cli.connection_matches(spec)?
        {
            let control = cli.admit()?;
            let response = control_request(
                &control,
                json!({"subtype":"get_effort_capabilities","model":spec.agent.model,"effort":level}),
                false,
            )
            .await?;
            effort::decode(&response)?
        } else {
            let mut config = spec.config.clone();
            config
                .agents
                .insert(spec.agent_id.clone(), spec.agent.clone());
            effort::query(&config, &spec.paths, &spec.agent_id, Some(level), None).await?
        };
        if !capabilities.accepts(level) {
            return Err(rpc::Error::conflict("thinking_level_model_conflict", "Clear the Session thinking override with sessions.thinking.set level:null before selecting this model")
                .with_data(json!({"level":level,"options":capabilities.supported_effort_levels,"nativeRequestSent":false})));
        }
        Ok(())
    }
}

fn readable(execution: &Execution) -> rpc::Result<()> {
    execution.record.mutable()?;
    if execution.closing
        || execution.idle.handing_off()
        || execution.launching
        || (execution.consuming && execution.cli.is_none())
    {
        return Err(rpc::Error::conflict(
            "session_transition_in_progress",
            "Wait for native Session startup or cleanup before reading or changing thinking",
        ));
    }
    if execution.record.native_cleanup_failed {
        return Err(rpc::Error::conflict(
            "native_cleanup_unconfirmed",
            "The previous CLI instance cleanup was not confirmed",
        ));
    }
    if let Some(error) = &execution.storage_fault {
        return Err(error.clone());
    }
    Ok(())
}

fn writable(execution: &Execution) -> rpc::Result<()> {
    readable(execution)?;
    if execution.active.is_some()
        || !execution.queue.is_empty()
        || execution.sending
        || execution.cancel_in_flight
        || execution.native.busy
    {
        return Err(rpc::Error::conflict(
            "session_busy",
            "Wait for the Session Run and native execution to finish before changing thinking",
        ));
    }
    Ok(())
}

fn current_instance(
    execution: &Execution,
    expected: Option<&Cli>,
    acknowledged: bool,
) -> rpc::Result<()> {
    let matches = execution.cli.as_ref().map(Cli::instance_id) == expected.map(Cli::instance_id);
    let eligible = expected.map(Cli::admit).transpose();
    if !matches || eligible.is_err() {
        return Err(if acknowledged {
            unknown(
                "thinking_instance_changed",
                "Native thinking acknowledgement belongs to an instance that is no longer eligible",
            )
            .with_data(json!({"nativeAcknowledged":true,"persisted":false}))
        } else {
            rpc::Error::unavailable(
                "thinking_instance_changed",
                "The native instance changed while reading thinking; retry the read",
            )
        });
    }
    Ok(())
}

fn ensure_supported(capabilities: &Capabilities, level: Option<Level>) -> rpc::Result<()> {
    if level.is_some_and(|level| !capabilities.accepts(level)) {
        return Err(super::not_sent(rpc::Error::conflict("thinking_level_unsupported", "This thinking level is not supported by the Session model and Provider; choose an available option or clear it with null")
            .with_data(json!({"options":capabilities.supported_effort_levels,"persisted":false}))));
    }
    Ok(())
}

async fn control_request(
    control: &crate::cli::idle::Control,
    request: Value,
    mutation: bool,
) -> rpc::Result<Value> {
    tokio::time::timeout(effort::CONTROL_WINDOW, control.request(request)).await.map_err(|_| {
        if mutation {
            unknown("thinking_control_timeout", "Native thinking acknowledgement timed out; read the current setting before retrying")
                .with_data(json!({"persisted":false}))
        } else {
            rpc::Error::unavailable("thinking_read_timeout", "Native thinking settings did not respond before the read deadline")
        }
    })?
}

fn unknown(kind: &str, message: &str) -> rpc::Error {
    rpc::Error::new(-32006, kind, message).with_data(json!({"delivery":"unknown"}))
}
