use super::process::Launch;
use crate::{
    config::{AgentConfig, Config, Paths},
    persistence::atomic_write,
    provider::{ProviderConfig, ProviderKind, SELECTOR_ENVS, managed_env_names},
    rpc::{self, Error},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

static SETTINGS_WRITERS: Mutex<BTreeMap<PathBuf, Weak<tokio::sync::Mutex<()>>>> =
    Mutex::new(BTreeMap::new());

pub async fn environment(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
) -> rpc::Result<BTreeMap<String, String>> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| Error::not_found("agent"))?;
    let provider = provider(config, agent)?;
    let removed = managed_env_names();
    let sources = crate::provider::configured_sources(config)?;
    let mut environment = BTreeMap::new();
    for (name, value) in std::env::vars_os() {
        let name = env_name(name.into_string().map_err(|_| {
            Error::unavailable(
                "native_environment_encoding",
                "The inherited environment contains a non-Unicode variable name",
            )
        })?);
        if removed
            .iter()
            .any(|removed| env_name((*removed).into()) == name)
            || reserved_environment(&name)
            || sources.contains(&name)
            || name.starts_with("MATCHA_MCP_")
            || config
                .private_mcp_env
                .source_names()
                .any(|source| source == name)
            || config
                .private_provider_env
                .source_names()
                .any(|source| source == name)
        {
            continue;
        }
        let value = value.into_string().map_err(|_| {
            Error::unavailable(
                "native_environment_encoding",
                "The inherited environment contains a non-Unicode value",
            )
        })?;
        environment.insert(name, value);
    }
    let provider_sources = provider_sources(config)?;
    let mut references = BTreeMap::new();
    for (target, source) in &config.cli.env {
        // Explicit provider bindings own all provider targets; global CLI references cannot
        // reintroduce another provider's credentials or selector.
        if provider.is_some()
            && removed
                .iter()
                .any(|name| env_name((*name).into()) == env_name(target.clone()))
        {
            continue;
        }
        if provider_sources.contains(&env_name(source.clone()))
            || config.private_provider_env.source(source).is_some()
        {
            return Err(Error::invalid(
                "Provider source aliases must be projected through the Agent's provider binding",
            ));
        }
        if references
            .insert(env_name(target.clone()), source.clone())
            .is_some()
        {
            return Err(Error::invalid(
                "CLI environment contains case-equivalent variable names",
            ));
        }
    }
    if let Some(provider) = &provider {
        for (target, source) in &provider.env {
            references.insert(env_name(target.clone()), source.clone());
        }
    }
    for (target, source) in references {
        if target.starts_with("MATCHA_MCP_")
            || env_name(source.clone()).starts_with("MATCHA_MCP_")
            || config.private_mcp_env.source(&source).is_some()
            || config.private_mcp_env.source(&target).is_some()
        {
            return Err(Error::invalid(
                "Managed MCP sources must be projected through the Agent's MCP binding",
            ));
        }
        if reserved_environment(&target) || env_name(source.clone()).starts_with("MATCHA_SEALED_") {
            return Err(Error::invalid(
                "CLI environment cannot override the Agent's native directories, initialization, recovery policy, or scoped sealed access",
            ));
        }
        if config
            .auth_token_env
            .as_ref()
            .is_some_and(|token| env_name(token.clone()) == env_name(source.clone()))
        {
            return Err(Error::invalid(
                "The server authentication token cannot be referenced by a native CLI environment",
            ));
        }
        let private_required =
            agent.provider.as_deref().is_some_and(|id| {
                id.starts_with("host-account-") || id.starts_with("host-session-")
            }) && provider_sources.contains(&env_name(source.clone()));
        if private_required && sources.contains(&target) {
            return Err(Error::invalid(
                "Host provider source aliases cannot be injected as CLI targets",
            ));
        }
        let value = match config
            .private_provider_env
            .source(&source)
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(|| {
                if private_required {
                    Err(std::env::VarError::NotPresent)
                } else {
                    std::env::var(&source)
                }
            }) {
            Ok(value) if !value.is_empty() => value,
            Ok(_) => {
                return Err(Error::unavailable(
                    "native_env_source_empty",
                    "A configured CLI environment source is empty",
                ));
            }
            Err(std::env::VarError::NotPresent) => {
                return Err(Error::unavailable(
                    "native_env_source_missing",
                    "A configured CLI environment source is not set",
                ));
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(Error::unavailable(
                    "native_env_source_encoding",
                    "A configured CLI environment source is not Unicode",
                ));
            }
        };
        environment.insert(target, value);
    }
    if let Some(provider) = provider {
        for name in SELECTOR_ENVS {
            environment.insert(name.into(), "0".into());
        }
        environment.insert("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".into(), "1".into());
        if let Some(selector) = provider.kind.selector() {
            environment.insert(selector.into(), "1".into());
        }
        if let Some(base_url) = provider.base_url {
            environment.insert(provider.kind.base_url_env().into(), base_url);
        }
        if let Some(model) = agent.model.as_ref().or(provider.model.as_ref()) {
            let name = match provider.kind {
                ProviderKind::Openai | ProviderKind::OpenaiResponses => Some("OPENAI_MODEL"),
                ProviderKind::Gemini => Some("GEMINI_MODEL"),
                ProviderKind::Grok => Some("GROK_MODEL"),
                _ => None,
            };
            if let Some(name) = name {
                environment.insert(env_name(name.into()), model.clone());
            }
        }
    }
    let runtime = paths.runtime(agent_id)?;
    let workspace = paths.workspace(agent_id)?;
    tokio::fs::create_dir_all(&runtime)
        .await
        .map_err(|source| {
            Error::new(
                -32005,
                "native_runtime_create",
                "Creating the Agent's native runtime directory failed",
            )
            .with_source(source)
        })?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|source| {
            Error::new(
                -32005,
                "native_workspace_create",
                "Creating the Agent's workspace failed",
            )
            .with_source(source)
        })?;
    write_settings(config, paths, agent_id).await?;
    environment.insert(
        "WEIXIN_STATE_DIR".into(),
        path_string(runtime.join("channels").join("weixin"))?,
    );
    environment.insert("CLAUDE_CONFIG_DIR".into(), path_string(runtime)?);
    environment.insert("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS".into(), "1".into());
    Ok(environment)
}

pub(crate) fn provider_sources(config: &Config) -> rpc::Result<std::collections::BTreeSet<String>> {
    Ok(config
        .providers
        .values()
        .map(ProviderConfig::parse)
        .collect::<rpc::Result<Vec<_>>>()?
        .iter()
        .flat_map(|provider| provider.env.values().map(|source| env_name(source.clone())))
        .collect())
}

pub(crate) async fn launch(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    args: Vec<String>,
) -> rpc::Result<Launch> {
    if config.cli.args.iter().any(|argument| {
        let name = argument.split('=').next().unwrap_or(argument);
        matches!(
            name,
            "-p" | "--print"
                | "--input-format"
                | "--output-format"
                | "--verbose"
                | "--include-partial-messages"
                | "--replay-user-messages"
                | "--permission-prompt-tool"
                | "-c"
                | "--continue"
                | "-r"
                | "--resume"
                | "--fork-session"
                | "--session-id"
                | "--resume-session-at"
                | "--rewind-files"
                | "--no-session-persistence"
                | "--settings"
                | "--setting-sources"
                | "--mcp-config"
                | "--strict-mcp-config"
                | "--model"
                | "--agent"
                | "--agents"
                | "--system-prompt"
                | "--system-prompt-file"
                | "--append-system-prompt"
                | "--append-system-prompt-file"
                | "--tools"
                | "--allowedTools"
                | "--allowed-tools"
                | "--disallowedTools"
                | "--disallowed-tools"
                | "--channels"
                | "--dangerously-load-development-channels"
                | "--sdk-url"
                | "--bare"
                | "--"
        )
    }) {
        return Err(Error::invalid(
            "CLI prefix arguments cannot override Server-owned execution options",
        ));
    }
    let mut env = environment(config, paths, agent_id).await?;
    let mut command_args = config.cli.args.clone();
    // The native entrypoint dispatches this fast path only when weixin is argv[0].
    if args.first().map(String::as_str) != Some("weixin")
        && !args.iter().any(|argument| argument == "--settings")
    {
        command_args.push("--settings".into());
        command_args.push(path_string(settings_file(paths, agent_id)?)?);
    }
    if args
        .iter()
        .any(|argument| matches!(argument.as_str(), "-p" | "--print"))
    {
        command_args.extend(crate::mcp::project(config, paths, agent_id, &mut env).await?);
    }
    command_args.extend(args);
    Ok(Launch {
        command: config.cli.command.clone(),
        args: command_args,
        env,
        cwd: paths.workspace(agent_id)?,
    })
}

pub(super) fn model(config: &Config, agent: &AgentConfig) -> rpc::Result<Option<String>> {
    Ok(agent
        .model
        .clone()
        .or(provider(config, agent)?.and_then(|provider| provider.model)))
}

fn provider(config: &Config, agent: &AgentConfig) -> rpc::Result<Option<ProviderConfig>> {
    agent
        .provider
        .as_ref()
        .map(|id| {
            let value = config
                .providers
                .get(id)
                .ok_or_else(|| Error::not_found("provider"))?;
            ProviderConfig::parse(value)
        })
        .transpose()
}

fn settings_file(paths: &Paths, agent_id: &str) -> rpc::Result<PathBuf> {
    Ok(paths.state(agent_id)?.join("settings.json"))
}

pub(crate) fn env_name(name: String) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name
    }
}

fn reserved_environment(name: &str) -> bool {
    name.starts_with("MATCHA_SEALED_")
        || matches!(
            name,
            "CLAUDE_CONFIG_DIR"
                | "WEIXIN_STATE_DIR"
                | "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"
                | "CLAUDE_CODE_REMOTE_MEMORY_DIR"
                | "CLAUDE_CODE_RESUME_INTERRUPTED_TURN"
        )
}

fn path_string(path: PathBuf) -> rpc::Result<String> {
    path.into_os_string().into_string().map_err(|_| {
        Error::unavailable(
            "native_path_encoding",
            "The native CLI requires Unicode runtime and workspace paths",
        )
    })
}

pub(super) fn settings(paths: &Paths, agent_id: &str, agent: &AgentConfig) -> rpc::Result<Value> {
    crate::config::validate_settings(&agent.settings)?;
    let mut settings = agent.settings.clone();
    let object = settings
        .as_object_mut()
        .ok_or_else(|| Error::invalid("Agent settings must be an object"))?;
    object.insert(
        "autoMemoryDirectory".into(),
        Value::String(path_string(crate::memory::auto_memory_directory(
            paths, agent_id,
        )?)?),
    );
    Ok(settings)
}

async fn write_settings(config: &Config, paths: &Paths, agent_id: &str) -> rpc::Result<()> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| Error::not_found("agent"))?;
    let bytes = serde_json::to_vec_pretty(&settings(paths, agent_id, agent)?)
        .map_err(|source| Error::internal("native_settings_encode").with_source(source))?;
    let path = settings_file(paths, agent_id)?;
    let writer = {
        let mut writers = SETTINGS_WRITERS
            .lock()
            .map_err(|_| Error::internal("native_settings_writer"))?;
        writers.retain(|_, writer| writer.strong_count() > 0);
        if let Some(writer) = writers.get(&path).and_then(Weak::upgrade) {
            writer
        } else {
            let writer = Arc::new(tokio::sync::Mutex::new(()));
            writers.insert(path.clone(), Arc::downgrade(&writer));
            writer
        }
    };
    let _guard = writer.lock().await;
    tokio::fs::create_dir_all(paths.state(agent_id)?)
        .await
        .map_err(|source| {
            Error::new(
                -32005,
                "native_settings_directory_create",
                "Creating the execution settings directory failed",
            )
            .with_source(source)
        })?;
    atomic_write(&path, &bytes).await
}
