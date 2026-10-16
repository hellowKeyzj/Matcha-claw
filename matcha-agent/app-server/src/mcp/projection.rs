use std::{
    collections::{BTreeMap, BTreeSet},
    io::ErrorKind,
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{ServerInput, env_name, reference_name};
use crate::{
    config::{Config, ConfigStore, Paths},
    persistence::atomic_write,
    provider::PrivateProjection,
    rpc::{self, Error},
};

const SOURCE_PREFIX: &str = "MATCHA_MCP_";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManagedServer {
    enabled: bool,
    server: ServerInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    servers: BTreeMap<String, ManagedServer>,
    private_sources: BTreeMap<String, String>,
}

pub(super) async fn get(params: Value, config: &ConfigStore) -> rpc::Result {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    let _: Empty = rpc::params(params)?;
    let snapshot = config.snapshot().await;
    let mut servers = parse(&snapshot)?;
    add_preset(&mut servers, config.paths()).await?;
    Ok(json!({
        "servers": servers.iter().map(|(name, entry)| json!({
            "name": name, "transport": transport(&entry.server), "enabled": entry.enabled,
        })).collect::<Vec<_>>(),
        "configurationOnly": true, "scope": "hostManagedOverlay",
    }))
}

pub(super) async fn replace(params: Value, config: &ConfigStore) -> rpc::Result {
    let input: Replace = rpc::params(params)?;
    let mut expected = BTreeSet::new();
    let mut servers = BTreeMap::new();
    for (name, entry) in input.servers {
        validate_entry(&name, &entry)?;
        if entry.enabled {
            expected.extend(sources(&entry.server));
        }
        servers.insert(name, rpc::value(entry)?);
    }
    if input
        .private_sources
        .keys()
        .any(|name| !name.starts_with(SOURCE_PREFIX) || !env_name(name))
    {
        return Err(Error::invalid(
            "Managed MCP sources must use the MATCHA_MCP_ namespace",
        ));
    }
    let private = PrivateProjection::from_sources(input.private_sources)?;
    if expected != private.source_names().map(str::to_owned).collect() {
        return Err(Error::invalid(
            "Managed MCP projection must supply exactly the enabled source references",
        ));
    }
    let changed = config
        .update(move |config| {
            reject_source_collisions(config, &expected)?;
            let changed = config.mcp_servers != servers
                || config
                    .private_mcp_env
                    .source_names()
                    .collect::<BTreeSet<_>>()
                    != private.source_names().collect()
                || private
                    .source_names()
                    .any(|source| config.private_mcp_env.source(source) != private.source(source));
            config.mcp_servers = servers;
            config.private_mcp_env = private;
            Ok(changed)
        })
        .await?;
    Ok(
        json!({"persisted": true, "changed": changed, "projection": "nextLaunch", "live": "notApplied"}),
    )
}

pub fn validate_config(config: &Config) -> rpc::Result<()> {
    let servers = parse(config)?;
    let referenced = servers
        .values()
        .flat_map(|entry| sources(&entry.server))
        .collect();
    reject_source_collisions(config, &referenced)
}

fn parse(config: &Config) -> rpc::Result<BTreeMap<String, ManagedServer>> {
    config
        .mcp_servers
        .iter()
        .map(|(name, value)| {
            let entry: ManagedServer = serde_json::from_value(value.clone()).map_err(|source| {
                Error::invalid("Managed MCP configuration does not match the native schema")
                    .with_source(source)
            })?;
            validate_entry(name, &entry)?;
            Ok((name.clone(), entry))
        })
        .collect()
}

fn validate_entry(name: &str, entry: &ManagedServer) -> rpc::Result<()> {
    reference_name(name)?;
    if name != "matcha" && !name.starts_with("matcha-external.") {
        return Err(Error::invalid(
            "Managed MCP configuration requires a Host-owned server name",
        ));
    }
    entry.server.validate()?;
    let expandable = match &entry.server {
        ServerInput::Stdio { command, args, .. } => {
            command.contains("${") || args.iter().any(|arg| arg.contains("${"))
        }
        ServerInput::Http(remote) | ServerInput::Sse(remote) => remote.url.contains("${"),
    };
    if expandable {
        return Err(Error::invalid(
            "Managed MCP command, arguments and URLs cannot expand environment sources; use env/header references",
        ));
    }
    if sources(&entry.server)
        .iter()
        .any(|source| !source.starts_with(SOURCE_PREFIX))
    {
        return Err(Error::invalid(
            "Managed MCP references must use the MATCHA_MCP_ namespace",
        ));
    }
    Ok(())
}

fn sources(server: &ServerInput) -> BTreeSet<String> {
    let values = match server {
        ServerInput::Stdio { env, .. } => env,
        ServerInput::Http(remote) | ServerInput::Sse(remote) => &remote.headers,
    };
    values
        .values()
        .filter_map(|value| {
            value
                .strip_prefix("Bearer ")
                .unwrap_or(value)
                .strip_prefix("${")?
                .strip_suffix('}')
        })
        .map(|name| {
            if cfg!(windows) {
                name.to_ascii_uppercase()
            } else {
                name.to_owned()
            }
        })
        .collect()
}

fn reject_source_collisions(config: &Config, sources: &BTreeSet<String>) -> rpc::Result<()> {
    let mut provider_sources = crate::provider::configured_sources(config)?;
    for value in config.providers.values() {
        let provider = crate::provider::ProviderConfig::parse(value)?;
        provider_sources.extend(provider.env.keys().map(|name| {
            if cfg!(windows) {
                name.to_ascii_uppercase()
            } else {
                name.clone()
            }
        }));
    }
    if sources
        .iter()
        .any(|source| provider_sources.contains(source))
        || config.cli.env.keys().any(|target| {
            let target = if cfg!(windows) {
                target.to_ascii_uppercase()
            } else {
                target.clone()
            };
            sources.contains(&target)
        })
    {
        return Err(Error::invalid(
            "Managed MCP sources cannot alias server authentication or provider/CLI environment bindings",
        ));
    }
    Ok(())
}

pub async fn project(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    env: &mut BTreeMap<String, String>,
) -> rpc::Result<Vec<String>> {
    let mut servers = parse(config)?;
    let all_sources = servers
        .values()
        .flat_map(|entry| sources(&entry.server))
        .collect::<BTreeSet<_>>();
    // Inherited aliases, including disabled/removed sources, never reach the child.
    env.retain(|name, _| {
        let name = if cfg!(windows) {
            name.to_ascii_uppercase()
        } else {
            name.clone()
        };
        !name.starts_with(SOURCE_PREFIX)
            && !all_sources.contains(&name)
            && !config
                .private_mcp_env
                .source_names()
                .any(|source| source == name)
    });
    reject_source_collisions(config, &all_sources)?;
    add_preset(&mut servers, paths).await?;
    let mut enabled = BTreeMap::new();
    for (name, entry) in servers {
        if !entry.enabled {
            continue;
        }
        for source in sources(&entry.server) {
            let value = config.private_mcp_env.source(&source).ok_or_else(|| {
                Error::unavailable(
                    "mcp_private_source_unavailable",
                    "Managed MCP credentials require private Host reprojection before launch",
                )
            })?;
            env.insert(source, value.to_owned());
        }
        enabled.insert(name, rpc::value(entry.server)?);
    }
    if enabled.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = serde_json::to_vec(&json!({"mcpServers": enabled}))
        .map_err(|source| Error::internal("mcp_projection_encode").with_source(source))?;
    // Concurrent CLI launches must not read another launch's configuration snapshot.
    // Envref-only artifacts remain under Agent state and are removed with that Agent.
    let path = paths
        .state(agent_id)?
        .join(format!("mcp-{:x}.json", Sha256::digest(&bytes)));
    let parent = path.parent().expect("managed MCP file has parent");
    tokio::fs::create_dir_all(parent).await.map_err(|source| {
        Error::new(
            -32005,
            "mcp_projection_directory",
            "The managed MCP projection directory could not be created",
        )
        .with_source(source)
    })?;
    atomic_write(&path, &bytes).await?;
    let path = path.to_str().ok_or_else(|| {
        Error::unavailable(
            "mcp_projection_path_encoding",
            "The managed MCP projection path is not Unicode",
        )
    })?;
    Ok(vec!["--mcp-config".into(), path.into()])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preset {
    command: String,
    args: Vec<String>,
}

async fn add_preset(
    servers: &mut BTreeMap<String, ManagedServer>,
    paths: &Paths,
) -> rpc::Result<()> {
    if servers.contains_key("matcha") {
        return Ok(());
    }
    let bytes = match tokio::fs::read(paths.root().join("matcha-mcp.json")).await {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(Error::new(
                -32005,
                "mcp_preset_read",
                "The Host MCP preset could not be read",
            )
            .with_source(source));
        }
    };
    let preset: Preset = serde_json::from_slice(&bytes).map_err(|source| {
        Error::invalid("The Host MCP preset has an invalid schema").with_source(source)
    })?;
    if !Path::new(&preset.command).is_absolute()
        || preset.args.len() != 3
        || preset.args[0] != "mcp"
        || preset.args[1] != "--state-dir"
        || !Path::new(&preset.args[2]).is_absolute()
    {
        return Err(Error::invalid(
            "The Host MCP preset requires its absolute executable and state directory",
        ));
    }
    let entry = ManagedServer {
        enabled: true,
        server: ServerInput::Stdio {
            command: preset.command,
            args: preset.args,
            env: BTreeMap::new(),
        },
    };
    validate_entry("matcha", &entry)?;
    servers.insert("matcha".into(), entry);
    Ok(())
}

fn transport(server: &ServerInput) -> &'static str {
    match server {
        ServerInput::Stdio { .. } => "stdio",
        ServerInput::Http(_) => "http",
        ServerInput::Sse(_) => "sse",
    }
}
