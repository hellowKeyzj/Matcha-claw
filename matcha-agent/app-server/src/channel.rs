mod login;
mod operations;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    config::{self, Config, ConfigStore},
    rpc::{self, Error},
    session::Sessions,
};

const WEIXIN: &str = "plugin:weixin@builtin";

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Definition {
    agent_id: String,
    enabled: bool,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

impl Definition {
    fn validate(&self) -> rpc::Result<()> {
        config::validate_id(&self.agent_id)?;
        if self.source != WEIXIN {
            return Err(Error::unavailable(
                "channel_source_unsupported",
                "Only the built-in WeChat channel is currently supported",
            ));
        }
        if self.enabled && self.session_id.is_none() {
            return Err(Error::invalid(
                "Enabling WeChat requires an explicit sessionId; one account must have one polling consumer",
            ));
        }
        if let Some(session_id) = &self.session_id {
            uuid::Uuid::parse_str(session_id)
                .map_err(|_| Error::invalid("sessionId must be a UUID"))?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configure {
    id: String,
    agent_id: String,
    enabled: bool,
    source: String,
    session_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    agent_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    id: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Login {
    id: String,
    restart_flow_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelLogin {
    id: String,
    flow_id: Option<String>,
}

fn definition(snapshot: &Config, id: &str) -> rpc::Result<Definition> {
    config::validate_id(id)?;
    let definition: Definition = serde_json::from_value(
        snapshot
            .channels
            .get(id)
            .ok_or_else(|| Error::not_found("Channel"))?
            .clone(),
    )
    .map_err(|_| Error::invalid("Stored channel definition is invalid"))?;
    definition.validate()?;
    if !snapshot.agents.contains_key(&definition.agent_id) {
        return Err(Error::not_found("Agent"));
    }
    Ok(definition)
}

pub(crate) fn validate_config(config: &Config) -> rpc::Result<()> {
    let mut enabled = std::collections::BTreeSet::new();
    for id in config.channels.keys() {
        let definition = definition(config, id)?;
        if !config
            .agents
            .get(&definition.agent_id)
            .is_some_and(|agent| agent.channels.contains(id))
        {
            return Err(Error::conflict(
                "channel_reference_missing",
                "A registered channel must be referenced by its owning Agent",
            ));
        }
        if definition.enabled && !enabled.insert((definition.agent_id, definition.source)) {
            return Err(Error::conflict(
                "channel_consumer_exists",
                "An Agent's WeChat account must have one enabled session binding",
            ));
        }
    }
    for (agent_id, agent) in &config.agents {
        for channel_id in &agent.channels {
            let definition = definition(config, channel_id)?;
            if definition.agent_id != *agent_id {
                return Err(Error::conflict(
                    "channel_agent_binding",
                    "An Agent may only reference its own registered channel ids",
                ));
            }
        }
    }
    Ok(())
}

async fn validate_binding(definition: &Definition, sessions: &Sessions) -> rpc::Result<()> {
    if let Some(session_id) = &definition.session_id {
        let session = sessions
            .dispatch("sessions.get", json!({"sessionId":session_id}))
            .await?;
        if session.get("agentId").and_then(Value::as_str) != Some(&definition.agent_id) {
            return Err(Error::conflict(
                "channel_session_agent",
                "The bound session belongs to another Agent",
            ));
        }
    }
    Ok(())
}

fn view(id: &str, definition: &Definition) -> Value {
    json!({"id":id,"definition":definition,"application":"nextSessionLaunch",
        "adapter":"nativeWeixin","accountStatus":"notInspected"})
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "channels.list" => {
            let params: List = rpc::params(params)?;
            if let Some(agent_id) = &params.agent_id {
                config::validate_id(agent_id)?;
            }
            let snapshot = config.snapshot().await;
            let mut channels = Vec::new();
            for id in snapshot.channels.keys() {
                let definition = definition(&snapshot, id)?;
                if params
                    .agent_id
                    .as_ref()
                    .is_none_or(|agent_id| *agent_id == definition.agent_id)
                {
                    channels.push(view(id, &definition));
                }
            }
            Ok(json!({"channels":channels,"supportedSources":[WEIXIN]}))
        }
        "channels.configure" => {
            let params: Configure = rpc::params(params)?;
            config::validate_id(&params.id)?;
            let next = Definition {
                agent_id: params.agent_id,
                enabled: params.enabled,
                source: params.source,
                session_id: params.session_id,
            };
            next.validate()?;
            validate_binding(&next, sessions).await?;
            // Use the same admission guards as Session launch; lock old/new Agents in stable order.
            let snapshot = config.snapshot().await;
            let expected = snapshot.channels.get(&params.id).cloned();
            let mut agent_ids = vec![next.agent_id.clone()];
            if let Some(previous) = &expected {
                let previous: Definition = serde_json::from_value(previous.clone())
                    .map_err(|_| Error::invalid("Stored channel definition is invalid"))?;
                if previous == next {
                    return Ok(view(&params.id, &next));
                }
                agent_ids.push(previous.agent_id);
            }
            agent_ids.sort();
            agent_ids.dedup();
            let mut admission = Vec::new();
            for agent_id in agent_ids {
                admission.push(sessions.agent_guard(&agent_id).await);
                login::ensure_idle(&agent_id).await?;
            }
            // Closing a live polling consumer is explicit: configuration is not a fake hot-apply ACK.
            let snapshot = config.snapshot().await;
            if snapshot.channels.get(&params.id) != expected.as_ref() {
                return Err(Error::conflict(
                    "channel_changed",
                    "The channel binding changed while admission was acquired; inspect its current configuration",
                ));
            }
            if let Some(previous) = snapshot.channels.get(&params.id) {
                let previous: Definition = serde_json::from_value(previous.clone())
                    .map_err(|_| Error::invalid("Stored channel definition is invalid"))?;
                if let Some(session_id) = previous.session_id {
                    let native = sessions.native_snapshot(&session_id).await?;
                    if native
                        .get("instanceId")
                        .is_some_and(|value| !value.is_null())
                        || native.get("launching").and_then(Value::as_bool) == Some(true)
                    {
                        return Err(Error::conflict(
                            "channel_session_running",
                            "Close the previous channel session before changing its binding or enablement",
                        ));
                    }
                }
            }
            if let Some(session_id) = &next.session_id {
                let native = sessions.native_snapshot(session_id).await?;
                if native
                    .get("instanceId")
                    .is_some_and(|value| !value.is_null())
                    || native.get("launching").and_then(Value::as_bool) == Some(true)
                {
                    return Err(Error::conflict(
                        "channel_session_running",
                        "Close the target session before applying a channel launch binding",
                    ));
                }
            }
            let id = params.id.clone();
            let stored = next.clone();
            config.update(move |config| {
                if config.channels.get(&id) != expected.as_ref() { return Err(Error::conflict("channel_changed", "The channel binding changed before commit")); }
                if !config.agents.contains_key(&stored.agent_id) { return Err(Error::not_found("Agent")); }
                for (other_id, value) in &config.channels {
                    if *other_id == id { continue; }
                    let other: Definition = serde_json::from_value(value.clone()).map_err(|_| Error::invalid("Stored channel definition is invalid"))?;
                    if stored.enabled && other.enabled && stored.agent_id == other.agent_id && stored.source == other.source {
                        return Err(Error::conflict("channel_consumer_exists", "This Agent's WeChat account already has an enabled session binding"));
                    }
                }
                for agent in config.agents.values_mut() { agent.channels.retain(|channel_id| channel_id != &id); }
                config.agents.get_mut(&stored.agent_id).ok_or_else(|| Error::not_found("Agent"))?.channels.push(id.clone());
                config.channels.insert(id, rpc::value(stored)?);
                Ok(())
            }).await?;
            Ok(view(&params.id, &next))
        }
        "channels.status" => {
            let params: Id = rpc::params(params)?;
            let snapshot = config.snapshot().await;
            let definition = definition(&snapshot, &params.id)?;
            let mut response = view(&params.id, &definition);
            response["login"] = login::status(&params.id, &definition.agent_id)
                .await
                .unwrap_or(Value::Null);
            if let Some(session_id) = &definition.session_id {
                let session = sessions
                    .dispatch("sessions.get", json!({"sessionId":session_id}))
                    .await?;
                let native = sessions.native_snapshot(session_id).await?;
                response["sessionStatus"] = session.get("status").cloned().unwrap_or(Value::Null);
                response["instanceId"] = native.get("instanceId").cloned().unwrap_or(Value::Null);
                response["launching"] = native.get("launching").cloned().unwrap_or(Value::Null);
                if native
                    .get("instanceId")
                    .is_some_and(|value| !value.is_null())
                {
                    match sessions
                        .control(session_id, json!({"subtype":"mcp_status"}))
                        .await
                    {
                        Ok(status) => {
                            let servers = status
                                .get("mcpServers")
                                .and_then(Value::as_array)
                                .ok_or_else(|| {
                                    Error::unavailable(
                                        "channel_native_status_shape",
                                        "Native MCP status did not include its server list",
                                    )
                                })?;
                            response["nativeServers"] = Value::Array(servers.iter()
                                .filter(|server|server.get("name").and_then(Value::as_str).is_some_and(|name|name.starts_with("plugin:weixin:")))
                                .map(|server|json!({"name":server.get("name"),"status":server.get("status"),
                                    "channelCapability":server.pointer("/capabilities/experimental/claude~1channel").is_some_and(|value|!value.is_null() && *value != Value::Bool(false))}))
                                .collect());
                        }
                        Err(error) => {
                            response["nativeStatusError"] = json!({"code":error.code,"kind":error.data.as_ref().and_then(|data|data.get("kind"))})
                        }
                    }
                }
            }
            Ok(response)
        }
        "channels.login" => {
            let params: Login = rpc::params(params)?;
            let snapshot = config.snapshot().await;
            let binding = definition(&snapshot, &params.id)?;
            let _admission = sessions.agent_guard(&binding.agent_id).await;
            let snapshot = config.snapshot().await;
            let current = definition(&snapshot, &params.id)?;
            if current != binding {
                return Err(Error::conflict(
                    "channel_changed",
                    "The channel binding changed before login",
                ));
            }
            let flow = login::start(
                &params.id,
                &binding.agent_id,
                snapshot,
                config.paths().clone(),
                params.restart_flow_id.as_deref(),
            )
            .await?;
            Ok(
                json!({"id":params.id,"login":flow,"application":"nativeAccountStore","credentialsReturned":false}),
            )
        }
        "channels.login.cancel" => {
            let params: CancelLogin = rpc::params(params)?;
            let snapshot = config.snapshot().await;
            let binding = definition(&snapshot, &params.id)?;
            let _admission = sessions.agent_guard(&binding.agent_id).await;
            let snapshot = config.snapshot().await;
            if definition(&snapshot, &params.id)? != binding {
                return Err(Error::conflict(
                    "channel_changed",
                    "The channel binding changed before login cancellation",
                ));
            }
            login::cancel(&params.id, &binding.agent_id, params.flow_id.as_deref()).await?;
            Ok(
                json!({"id":params.id,"stopped":true,"cleanupConfirmed":true,"accountStatus":"notInspected"}),
            )
        }
        "channels.stop" | "channels.logout" | "channels.delete" => {
            let params: Id = rpc::params(params)?;
            let config = config.clone();
            let sessions = sessions.clone();
            let operation = match method {
                "channels.stop" => operations::Operation::Stop,
                "channels.logout" => operations::Operation::Logout,
                _ => operations::Operation::Delete,
            };
            // Cleanup is owned even if the RPC observer disconnects.
            operations::dispatch(operation, params.id, config, sessions).await
        }
        "channels.pair" => {
            let params: Pair = rpc::params(params)?;
            if params.code.len() != 6 || !params.code.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(Error::invalid(
                    "WeChat pairing code must be six decimal digits",
                ));
            }
            operations::dispatch(
                operations::Operation::Pair(params.code),
                params.id,
                config.clone(),
                sessions.clone(),
            )
            .await
        }
        _ => Err(Error::method(method)),
    }
}

pub async fn shutdown() -> rpc::Result<()> {
    let operations = operations::shutdown().await;
    let login = login::shutdown().await;
    match (operations, login) {
        (Ok(()), login) => login,
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(login)) => Err(error.with_data(json!({
            "loginCleanupError": {"code":login.code,"kind":login.data.as_ref().and_then(|data|data.get("kind"))}
        }))),
    }
}
