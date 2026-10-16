use crate::{
    config::{AgentConfig, Config, Field, Paths, validate_id, validate_settings},
    rpc,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Definition {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Option<String>,
    #[serde(default = "empty_settings")]
    pub settings: Value,
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

fn empty_settings() -> Value {
    json!({})
}

impl From<Definition> for AgentConfig {
    fn from(value: Definition) -> Self {
        Self {
            name: value.name,
            description: value.description,
            model: value.model,
            provider: value.provider,
            system_prompt: value.system_prompt,
            append_system_prompt: value.append_system_prompt,
            settings: value.settings,
            tools: value.tools,
            allowed_tools: value.allowed_tools,
            disallowed_tools: value.disallowed_tools,
            channels: value.channels,
            ..Self::default()
        }
    }
}

impl From<&AgentConfig> for Definition {
    fn from(value: &AgentConfig) -> Self {
        Self {
            name: value.name.clone(),
            description: value.description.clone(),
            model: value.model.clone(),
            provider: value.provider.clone(),
            system_prompt: value.system_prompt.clone(),
            append_system_prompt: value.append_system_prompt.clone(),
            settings: value.settings.clone(),
            tools: value.tools.clone(),
            allowed_tools: value.allowed_tools.clone(),
            disallowed_tools: value.disallowed_tools.clone(),
            channels: value.channels.clone(),
        }
    }
}

// Omission preserves a field, while explicit null clears nullable fields.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Patch {
    #[serde(default)]
    name: Field<String>,
    #[serde(default)]
    description: Field<Option<String>>,
    #[serde(default)]
    model: Field<Option<String>>,
    #[serde(default)]
    provider: Field<Option<String>>,
    #[serde(default)]
    system_prompt: Field<Option<String>>,
    #[serde(default)]
    append_system_prompt: Field<Option<String>>,
    #[serde(default)]
    settings: Field<Value>,
    #[serde(default)]
    tools: Field<Option<Vec<String>>>,
    #[serde(default)]
    allowed_tools: Field<Vec<String>>,
    #[serde(default)]
    disallowed_tools: Field<Vec<String>>,
    #[serde(default)]
    channels: Field<Vec<String>>,
}

impl Patch {
    pub(super) fn apply(self, agent: &mut AgentConfig) {
        macro_rules! set {
            ($($field:ident),+ $(,)?) => { $(
                if let Some(value) = self.$field.0 { agent.$field = value; }
            )+ };
        }
        set!(
            name,
            description,
            model,
            provider,
            system_prompt,
            append_system_prompt,
            settings,
            tools,
            allowed_tools,
            disallowed_tools,
            channels
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    agent_id: String,
    definition: Definition,
    paths: AgentPaths,
    revision: String,
    custody: Value,
}

#[derive(Serialize)]
struct AgentPaths {
    workspace: PathBuf,
    runtime: PathBuf,
    state: PathBuf,
}

pub(super) fn revision(agent: &AgentConfig) -> rpc::Result<String> {
    let bytes = serde_json::to_vec(agent)
        .map_err(|error| rpc::Error::internal("agent_revision_encode").with_source(error))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn view(agent_id: &str, agent: &AgentConfig, paths: &Paths) -> rpc::Result<Value> {
    let relative = |path: PathBuf| {
        path.strip_prefix(paths.root())
            .map(|path| path.to_path_buf())
            .map_err(|_| rpc::Error::internal("agent_path_mapping"))
    };
    rpc::value(View {
        agent_id: agent_id.to_owned(),
        definition: agent.into(),
        paths: AgentPaths {
            workspace: relative(paths.workspace(agent_id)?)?,
            runtime: relative(paths.runtime(agent_id)?)?,
            state: relative(paths.state(agent_id)?)?,
        },
        revision: revision(agent)?,
        custody: match &agent.custody {
            Some(token) => json!({"kind":"managed", "owner":agent.owner, "token":token}),
            None => json!({"kind":"external"}),
        },
    })
}

pub(super) fn applied(agent_id: &str, agent: &AgentConfig, paths: &Paths) -> rpc::Result<Value> {
    let mut value = view(agent_id, agent, paths)?;
    value["appliesTo"] = json!("futureCliInstances");
    Ok(value)
}

pub(super) fn check_revision(
    expected: Option<&str>,
    agent_id: &str,
    agent: &AgentConfig,
    paths: &Paths,
) -> rpc::Result<()> {
    if let Some(expected) = expected
        && expected != revision(agent)?
    {
        return Err(
            rpc::Error::conflict("agent_revision_stale", "The Agent definition changed")
                .with_data(json!({"latestView": view(agent_id, agent, paths)?})),
        );
    }
    Ok(())
}

pub(super) fn validate(agent: &AgentConfig, config: &Config) -> rpc::Result<()> {
    if agent.name.trim().is_empty() || agent.name.contains('\0') {
        return Err(rpc::Error::invalid(
            "definition.name must not be empty or contain NUL",
        ));
    }
    validate_settings(&agent.settings)?;
    if let Some(description) = &agent.description
        && description.contains('\0')
    {
        return Err(rpc::Error::invalid(
            "definition.description must not contain NUL",
        ));
    }
    if let Some(model) = &agent.model {
        argument(model, "definition.model")?;
    }
    if let Some(provider) = &agent.provider {
        validate_id(provider)?;
        if !config.providers.contains_key(provider) {
            return Err(rpc::Error::new(
                -32602,
                "agent_provider_not_configured",
                "definition.provider must reference a configured Provider",
            ));
        }
    }
    for prompt in [&agent.system_prompt, &agent.append_system_prompt]
        .into_iter()
        .flatten()
    {
        if prompt.is_empty() || prompt.contains('\0') {
            return Err(rpc::Error::invalid(
                "Prompt text must be nonempty without NUL; use null to clear",
            ));
        }
    }
    for tool in agent
        .tools
        .iter()
        .flatten()
        .chain(&agent.allowed_tools)
        .chain(&agent.disallowed_tools)
    {
        argument(tool, "definition tool entries")?;
    }
    for channel in &agent.channels {
        argument(channel, "definition.channels entries")?;
    }
    Ok(())
}

fn argument(value: &str, field: &str) -> rpc::Result<()> {
    if value.trim().is_empty() || value.contains('\0') || value.trim_start().starts_with('-') {
        return Err(rpc::Error::invalid(format!(
            "{field} must not be empty, contain NUL, or begin with '-'"
        )));
    }
    Ok(())
}
