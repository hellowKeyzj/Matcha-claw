use super::{AgentConfig, Config, ConfigStore};
use crate::rpc;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::SocketAddr, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Get {}

pub(crate) struct Field<T>(pub(crate) Option<T>);

impl<T> Default for Field<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Update {
    #[serde(default)]
    listen: Field<SocketAddr>,
    #[serde(default)]
    auth_token_env: Field<Option<String>>,
    #[serde(default)]
    cli: Field<CliUpdate>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliUpdate {
    #[serde(default)]
    command: Field<PathBuf>,
    #[serde(default)]
    args: Field<Vec<String>>,
    #[serde(default)]
    env: Field<BTreeMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View<'a> {
    listen: SocketAddr,
    auth_token_env: &'a Option<String>,
    cli: CliView<'a>,
    agents: BTreeMap<&'a str, AgentView<'a>>,
    providers: Vec<&'a str>,
    schedules: Vec<&'a str>,
    channels: Vec<&'a str>,
    application: &'static str,
    commit_state: &'static str,
}

#[derive(Serialize)]
struct CliView<'a> {
    command: &'a std::path::Path,
    env: &'a BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentView<'a> {
    name: &'a str,
    description: &'a Option<String>,
    model: &'a Option<String>,
    provider: &'a Option<String>,
    settings: &'a Value,
    tools: &'a Option<Vec<String>>,
    allowed_tools: &'a [String],
    disallowed_tools: &'a [String],
    channels: &'a [String],
}

impl<'a> From<&'a AgentConfig> for AgentView<'a> {
    fn from(agent: &'a AgentConfig) -> Self {
        Self {
            name: &agent.name,
            description: &agent.description,
            model: &agent.model,
            provider: &agent.provider,
            settings: &agent.settings,
            tools: &agent.tools,
            allowed_tools: &agent.allowed_tools,
            disallowed_tools: &agent.disallowed_tools,
            channels: &agent.channels,
        }
    }
}

fn view(config: &Config, unresolved: bool) -> rpc::Result<Value> {
    rpc::value(View {
        listen: config.listen,
        auth_token_env: &config.auth_token_env,
        cli: CliView {
            command: &config.cli.command,
            env: &config.cli.env,
        },
        agents: config
            .agents
            .iter()
            .map(|(id, agent)| (id.as_str(), AgentView::from(agent)))
            .collect(),
        providers: config.providers.keys().map(String::as_str).collect(),
        schedules: config.schedules.keys().map(String::as_str).collect(),
        channels: config.channels.keys().map(String::as_str).collect(),
        application: if unresolved {
            "unresolved"
        } else {
            "stored_only"
        },
        commit_state: if unresolved {
            "unresolved"
        } else {
            "confirmed"
        },
    })
}

pub async fn dispatch(method: &str, params: Value, config: &ConfigStore) -> rpc::Result<Value> {
    match method {
        "config.get" => {
            let _: Get = rpc::params(params)?;
            let (confirmed, unresolved) = config.read().await;
            view(&confirmed, unresolved)
        }
        "config.update" => {
            let update: Update = rpc::params(params)?;
            let stored = config
                .update(move |config| {
                    if let Some(listen) = update.listen.0 {
                        config.listen = listen;
                    }
                    if let Some(auth_token_env) = update.auth_token_env.0 {
                        config.auth_token_env = auth_token_env;
                    }
                    if let Some(cli) = update.cli.0 {
                        if let Some(command) = cli.command.0 {
                            config.cli.command = command;
                        }
                        if let Some(args) = cli.args.0 {
                            config.cli.args = args;
                        }
                        if let Some(env) = cli.env.0 {
                            config.cli.env = env;
                        }
                    }
                    view(config, false)
                })
                .await?;
            Ok(json!({
                "config": stored,
                "application": "stored_only",
                "commitState": "confirmed"
            }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}
