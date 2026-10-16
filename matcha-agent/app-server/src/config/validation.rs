use super::{Config, DEFAULT_AGENT_ID};
use crate::rpc;
use serde_json::Value;
#[cfg(any(windows, target_os = "macos"))]
use std::collections::BTreeSet;

pub fn validate_id(id: &str) -> rpc::Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(rpc::Error::new(
            -32602,
            "config_id_invalid",
            "IDs must contain only ASCII letters, digits, hyphens and underscores and must not be empty",
        ));
    }
    #[cfg(windows)]
    {
        let upper = id.to_ascii_uppercase();
        let numbered_device = upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
        if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
            return Err(rpc::Error::new(
                -32602,
                "config_id_reserved",
                "The ID is a reserved Windows device name",
            ));
        }
    }
    Ok(())
}

pub fn validate_agent_id_available(config: &Config, agent_id: &str) -> rpc::Result<()> {
    validate_id(agent_id)?;
    if config
        .agent_deletions
        .values()
        .any(|receipt| receipt.agent_id.eq_ignore_ascii_case(agent_id))
    {
        return Err(rpc::Error::conflict(
            "agent_id_retired",
            "A deleted Agent identity cannot be reused",
        ));
    }
    if config.agents.contains_key(agent_id) {
        return Err(rpc::Error::conflict(
            "agent_exists",
            "The Agent ID is already configured",
        ));
    }
    #[cfg(any(windows, target_os = "macos"))]
    if config
        .agents
        .keys()
        .any(|id| id.eq_ignore_ascii_case(agent_id))
    {
        return Err(agent_path_collision());
    }
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn agent_path_collision() -> rpc::Error {
    rpc::Error::conflict(
        "config_agent_path_collision",
        "Agent IDs must not differ only by case on this platform",
    )
}

pub(super) fn env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn validate(config: &Config) -> rpc::Result<()> {
    if config.agent_deletions.iter().any(|(id, receipt)| {
        id.eq_ignore_ascii_case(DEFAULT_AGENT_ID)
            || receipt.agent_id.eq_ignore_ascii_case(DEFAULT_AGENT_ID)
    }) {
        return Err(rpc::Error::conflict(
            "agent_id_retired",
            "The default Agent identity has a deletion receipt and cannot be reused",
        ));
    }
    if config
        .agents
        .keys()
        .any(|id| id != DEFAULT_AGENT_ID && id.eq_ignore_ascii_case(DEFAULT_AGENT_ID))
    {
        return Err(rpc::Error::conflict(
            "agent_id_case_conflict",
            "A case alias of the default Agent identity is already configured",
        ));
    }
    if !config.agents.contains_key(DEFAULT_AGENT_ID) {
        return Err(rpc::Error::conflict(
            "default_agent_required",
            "The default Agent identity must remain configured",
        ));
    }
    if config
        .auth_token_env
        .as_deref()
        .is_some_and(|name| !env_name(name))
    {
        return Err(rpc::Error::new(
            -32602,
            "config_auth_token_env",
            "authTokenEnv must name a source environment variable, not contain a token",
        ));
    }
    if !config.listen.ip().is_loopback() && config.auth_token_env.is_none() {
        return Err(rpc::Error::new(
            -32602,
            "config_listen_auth_required",
            "A non-loopback listener requires authTokenEnv",
        ));
    }
    if config.cli.command.as_os_str().is_empty() {
        return Err(rpc::Error::new(
            -32602,
            "config_cli_command_empty",
            "The CLI command must not be empty",
        ));
    }
    #[cfg(windows)]
    let mut env_targets = BTreeSet::new();
    for (target, source) in &config.cli.env {
        if !env_name(target) {
            return Err(rpc::Error::new(
                -32602,
                "config_cli_env_target",
                "CLI environment keys must be environment variable names",
            ));
        }
        #[cfg(windows)]
        if !env_targets.insert(target.to_ascii_lowercase()) {
            return Err(rpc::Error::conflict(
                "config_cli_env_target_collision",
                "CLI environment targets must not differ only by case on Windows",
            ));
        }
        if !env_name(source) {
            return Err(rpc::Error::new(
                -32602,
                "config_cli_env_source",
                "CLI environment values must name source environment variables, not contain their values",
            ));
        }
    }
    #[cfg(any(windows, target_os = "macos"))]
    let mut agent_paths = BTreeSet::new();
    for (agent_id, agent) in &config.agents {
        validate_id(agent_id)?;
        #[cfg(any(windows, target_os = "macos"))]
        if !agent_paths.insert(agent_id.to_ascii_lowercase()) {
            return Err(agent_path_collision());
        }
        validate_settings(&agent.settings)?;
    }
    for (provider_id, provider) in &config.providers {
        validate_id(provider_id)?;
        crate::provider::ProviderConfig::parse(provider)?;
    }
    crate::mcp::validate_config(config)?;
    crate::schedule::validate_config(config)?;
    crate::channel::validate_config(config)?;
    Ok(())
}

/// Server trust-boundary checks only; the CLI remains the authority for native settings semantics.
pub fn validate_settings(settings: &Value) -> rpc::Result<()> {
    let settings = settings.as_object().ok_or_else(|| {
        rpc::Error::new(
            -32602,
            "config_settings_object",
            "Agent settings must be a JSON object",
        )
    })?;
    if settings.keys().any(|key| {
        matches!(
            key.as_str(),
            "agent"
                | "model"
                | "modelType"
                | "provider"
                | "systemPrompt"
                | "appendSystemPrompt"
                | "tools"
                | "allowedTools"
                | "disallowedTools"
                | "cwd"
                | "workspace"
                | "configDir"
                | "claudeConfigDir"
                | "autoMemoryDirectory"
        )
    }) {
        return Err(rpc::Error::new(
            -32602,
            "config_settings_binding_conflict",
            "Agent, provider, workspace and execution bindings must use their structured server configuration fields",
        ));
    }
    validate_fields(settings)
}

fn validate_fields(fields: &serde_json::Map<String, Value>) -> rpc::Result<()> {
    for (key, value) in fields {
        let key = normalized_key(key);
        if key == "env" {
            return Err(rpc::Error::new(
                -32602,
                "config_settings_env_forbidden",
                "Settings must not contain environment values; use CLI source environment references",
            ));
        }
        if secret_field(&key) && !value.is_null() {
            return Err(rpc::Error::new(
                -32602,
                "config_settings_secret_forbidden",
                "Settings must not contain credentials; use native authentication or source environment references",
            ));
        }
        if key == "headers" {
            validate_headers(value)?;
        } else {
            validate_value(value)?;
        }
    }
    Ok(())
}

fn validate_value(value: &Value) -> rpc::Result<()> {
    match value {
        Value::Object(fields) => validate_fields(fields),
        Value::Array(items) => {
            for item in items {
                validate_value(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn secret_field(key: &str) -> bool {
    matches!(
        key,
        "apikey"
            | "workspaceapikey"
            | "accesskey"
            | "accesskeyid"
            | "secretaccesskey"
            | "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "oauthtoken"
            | "oauthaccesstoken"
            | "oauthrefreshtoken"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "privatekey"
            | "credential"
            | "credentials"
            | "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "xapikey"
            | "anthropicapikey"
            | "anthropicauthtoken"
            | "claudecodeoauthtoken"
            | "openaiapikey"
            | "geminiapikey"
            | "googleapikey"
            | "grokapikey"
            | "xaiapikey"
    )
}

fn validate_headers(headers: &Value) -> rpc::Result<()> {
    let Some(headers) = headers.as_object() else {
        return validate_value(headers); // Native schema validation owns the headers shape.
    };
    for (name, value) in headers {
        if secret_field(&normalized_key(name)) {
            if !value.as_str().is_some_and(header_env_reference) {
                return Err(rpc::Error::new(
                    -32602,
                    "config_settings_header_secret",
                    "Credential headers must contain only a native environment reference",
                ));
            }
        } else {
            validate_value(value)?;
        }
    }
    Ok(())
}

fn header_env_reference(value: &str) -> bool {
    let value = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or(value);
    let Some(name) = value.strip_prefix('$') else {
        return false;
    };
    let name = if let Some(name) = name.strip_prefix('{') {
        let Some(name) = name.strip_suffix('}') else {
            return false;
        };
        name
    } else {
        name
    };
    env_name(name)
}
