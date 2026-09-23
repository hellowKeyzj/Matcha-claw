use platform::state_dir::CanonicalStateDir;
use std::path::Path;

use serde_json::{Map, Value};

use crate::native_config::config_store::{OpenClawConfigMutation, OpenClawConfigStore};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedAgentConfigError {
    Rejected,
    Unavailable,
}

pub fn ensure_sealed_agent_config(
    state_dir: CanonicalStateDir,
    agent_id: &str,
    workspace: &Path,
) -> Result<(), SealedAgentConfigError> {
    let agent_id = canonical_agent_id(agent_id).ok_or(SealedAgentConfigError::Rejected)?;
    let workspace = workspace_value(workspace).ok_or(SealedAgentConfigError::Rejected)?;
    let mut result = Ok(false);

    OpenClawConfigStore::new(state_dir)
        .update_private_document(|document| {
            let mut agents = match agents_object(document.get("agents")) {
                Ok(agents) => agents,
                Err(error) => {
                    result = Err(error);
                    return OpenClawConfigMutation::unchanged();
                }
            };
            result = ensure_agent(&mut agents, agent_id, &workspace);
            match result {
                Ok(true) => {
                    document.insert("agents".into(), Value::Object(agents));
                    OpenClawConfigMutation::changed()
                }
                Ok(false) | Err(_) => OpenClawConfigMutation::unchanged(),
            }
        })
        .map_err(|_| SealedAgentConfigError::Unavailable)?;

    result.map(|_| ())
}

fn agents_object(value: Option<&Value>) -> Result<Map<String, Value>, SealedAgentConfigError> {
    match value {
        None => Ok(Map::new()),
        Some(Value::Object(value)) => Ok(value.clone()),
        Some(_) => Err(SealedAgentConfigError::Rejected),
    }
}

fn ensure_agent(
    agents: &mut Map<String, Value>,
    agent_id: &str,
    workspace: &str,
) -> Result<bool, SealedAgentConfigError> {
    if agents.contains_key("entries") || !agents.contains_key("list") {
        ensure_entries_agent(agents, agent_id, workspace)
    } else {
        ensure_list_agent(agents, agent_id, workspace)
    }
}

fn ensure_entries_agent(
    agents: &mut Map<String, Value>,
    agent_id: &str,
    workspace: &str,
) -> Result<bool, SealedAgentConfigError> {
    let entries = agents
        .entry("entries")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or(SealedAgentConfigError::Rejected)?;
    let Some(entry) = entries.get_mut(agent_id) else {
        entries.insert(
            agent_id.to_owned(),
            sealed_agent_entry(agent_id, workspace, false),
        );
        return Ok(true);
    };
    ensure_entry_fields(entry, workspace)
}

fn ensure_list_agent(
    agents: &mut Map<String, Value>,
    agent_id: &str,
    workspace: &str,
) -> Result<bool, SealedAgentConfigError> {
    let list = agents
        .get_mut("list")
        .and_then(Value::as_array_mut)
        .ok_or(SealedAgentConfigError::Rejected)?;
    let matches = list
        .iter()
        .enumerate()
        .filter(|(_, value)| value.get("id").and_then(Value::as_str) == Some(agent_id))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => {
            list.push(sealed_agent_entry(agent_id, workspace, true));
            Ok(true)
        }
        [index] => ensure_entry_fields(&mut list[*index], workspace),
        _ => Err(SealedAgentConfigError::Rejected),
    }
}

fn sealed_agent_entry(agent_id: &str, workspace: &str, include_id: bool) -> Value {
    let mut entry = Map::new();
    if include_id {
        entry.insert("id".into(), Value::String(agent_id.to_owned()));
    }
    entry.insert("workspace".into(), Value::String(workspace.to_owned()));
    entry.insert("skipBootstrap".into(), Value::Bool(true));
    Value::Object(entry)
}

fn ensure_entry_fields(entry: &mut Value, workspace: &str) -> Result<bool, SealedAgentConfigError> {
    let entry = entry
        .as_object_mut()
        .ok_or(SealedAgentConfigError::Rejected)?;
    let mut changed = false;
    if entry
        .get("workspace")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty() || value.contains('\0'))
    {
        entry.insert("workspace".into(), Value::String(workspace.to_owned()));
        changed = true;
    }
    if entry.get("skipBootstrap") != Some(&Value::Bool(true)) {
        entry.insert("skipBootstrap".into(), Value::Bool(true));
        changed = true;
    }
    Ok(changed)
}

fn workspace_value(path: &Path) -> Option<String> {
    (path.is_absolute())
        .then(|| path.to_str())?
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .map(str::to_owned)
}

fn canonical_agent_id(value: &str) -> Option<&str> {
    let value = value.trim();
    let mut bytes = value.bytes();
    let first = bytes.next()?;
    if value.len() > 64 || !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return None;
    }
    bytes
        .all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
        .then_some(value)
}
