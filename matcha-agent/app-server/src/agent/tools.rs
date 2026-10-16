use super::definition;
use crate::{
    config::{AgentConfig, ConfigStore},
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};

// Configurable built-in subset from native tools.ts; not a claim of live availability.
const TOOLS: &[&str] = &[
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Skill",
    "Agent",
    "TodoWrite",
    "AskUserQuestion",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Set {
    agent_id: String,
    revision: String,
    selection: Selection,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Selection {
    Inherit,
    Policy {
        profile: String,
        allow: Vec<String>,
        deny: Vec<String>,
    },
}

fn unsupported() -> rpc::Error {
    rpc::Error::unavailable(
        "agent_capability_unsupported",
        "This tool policy cannot be represented by the native configurable subset",
    )
}

fn view(agent_id: &str, agent: &AgentConfig) -> rpc::Result<Value> {
    if agent
        .tools
        .iter()
        .flatten()
        .chain(&agent.disallowed_tools)
        .any(|name| !TOOLS.contains(&name.as_str()))
    {
        return Err(unsupported());
    }
    let policy = if agent.tools.is_some() || !agent.disallowed_tools.is_empty() {
        Some(json!({
            "profile":if agent.tools.is_some() {"native"} else {"default"},
            "allow":agent.tools.clone().unwrap_or_default(),"deny":agent.disallowed_tools,
        }))
    } else {
        None
    };
    Ok(json!({
        "agentId":agent_id,"configured":true,"policy":policy,
        "revision":definition::revision(agent)?,
        "catalog":{
            "profiles":[{"key":"default","displayName":"原生默认工具"},{"key":"native","displayName":"原生显式工具列表"}],
            "groups":[],
            "options":TOOLS.iter().map(|name| json!({
                "key":name,"displayName":name,"description":null,"source":"native", "pluginId":null,
                "optional":true,"risk":null,"tags":[],"defaultProfiles":[],"deniedByGlobalPolicy":false,
                "groupKey":null,"groupDisplayName":null,
            })).collect::<Vec<_>>(),
        },
        "catalogSource":"native_configurable_subset_not_observed",
        "application":"futureCliInstances", "nativePermissions":"enforcedByCli",
    }))
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    if method == "agents.tools.get" {
        let params: Target = rpc::params(params)?;
        crate::config::validate_id(&params.agent_id)?;
        let snapshot = config.snapshot().await;
        let agent = snapshot
            .agents
            .get(&params.agent_id)
            .ok_or_else(|| rpc::Error::not_found("Agent"))?;
        return view(&params.agent_id, agent);
    }
    let params: Set = rpc::params(params)?;
    crate::config::validate_id(&params.agent_id)?;
    let _guard = sessions.agent_guard(&params.agent_id).await;
    config
        .update(move |current| {
            let agent = current
                .agents
                .get_mut(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            if params.revision != definition::revision(agent)? {
                return Err(rpc::Error::conflict(
                    "agent_revision_stale",
                    "The Agent definition changed",
                )
                .with_data(json!({"latestView":view(&params.agent_id,agent)?})));
            }
            match params.selection {
                Selection::Inherit => {
                    agent.tools = None;
                    agent.disallowed_tools.clear();
                }
                Selection::Policy {
                    profile,
                    allow,
                    deny,
                } => {
                    if profile != "native" && profile != "default"
                        || profile == "default" && !allow.is_empty()
                    {
                        return Err(unsupported());
                    }
                    let invalid: Vec<_> = allow
                        .iter()
                        .chain(&deny)
                        .filter(|name| !TOOLS.contains(&name.as_str()))
                        .cloned()
                        .collect();
                    if !invalid.is_empty() {
                        return Err(rpc::Error::invalid(
                            "Tool keys are outside the native configurable subset",
                        )
                        .with_data(json!({"unknownToolKeys":invalid})));
                    }
                    agent.tools = (profile == "native").then_some(allow);
                    agent.disallowed_tools = deny;
                    // Do not map availability to allowedTools: that would bypass native prompts.
                }
            }
            view(&params.agent_id, agent)
        })
        .await
}
