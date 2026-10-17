use serde_json::{Value, json};
use subagents::{
    ToolCatalog, ToolConfigurationOutcome, ToolConfigurationView, ToolOption, ToolPolicy,
    ToolProfile,
};

use crate::client::Error;

/// Only equivalent availability keys; never translate spawn, groups, or permission rules.
pub(crate) fn native_tool_keys(keys: &[String]) -> Result<Vec<String>, ()> {
    keys.iter()
        .map(|key| {
            Ok(match key.as_str() {
                "exec" | "Bash" => "Bash",
                "read" | "Read" => "Read",
                "write" | "Write" => "Write",
                "edit" | "Edit" => "Edit",
                "web_fetch" | "WebFetch" => "WebFetch",
                "web_search" | "WebSearch" => "WebSearch",
                "Glob" => "Glob",
                "Grep" => "Grep",
                "NotebookEdit" => "NotebookEdit",
                "Skill" => "Skill",
                "Agent" => "Agent",
                "TodoWrite" => "TodoWrite",
                "AskUserQuestion" => "AskUserQuestion",
                _ => return Err(()),
            }
            .to_owned())
        })
        .collect()
}

pub(super) fn selection(selection: subagents::ToolSelection) -> Value {
    match selection {
        subagents::ToolSelection::InheritDefaultTools => json!({"type":"inherit"}),
        subagents::ToolSelection::Policy {
            profile,
            allow,
            deny,
        } => json!({"type":"policy","profile":profile,"allow":allow,"deny":deny}),
    }
}

pub(super) fn outcome(result: Result<Value, Error>, mutation: bool) -> ToolConfigurationOutcome {
    match result {
        Ok(value) => match view(&value) {
            Ok(view) if mutation => ToolConfigurationOutcome::Updated(view),
            Ok(view) => ToolConfigurationOutcome::View(view),
            Err(()) if mutation => ToolConfigurationOutcome::AppliedReadbackFailed(
                subagents::ConfigurationReadFailure::Protocol,
            ),
            Err(()) => {
                ToolConfigurationOutcome::Unavailable(subagents::ConfigurationReadFailure::Protocol)
            }
        },
        Err(error) if error.kind() == "agent_revision_stale" => error
            .data()
            .and_then(|data| data.get("latestView"))
            .and_then(|value| view(value).ok())
            .map(ToolConfigurationOutcome::Stale)
            .unwrap_or(ToolConfigurationOutcome::OutcomeUnknown),
        Err(error)
            if error
                .data()
                .and_then(|data| data.get("unknownToolKeys"))
                .is_some() =>
        {
            let keys = error
                .data()
                .and_then(|data| data.get("unknownToolKeys"))
                .and_then(|keys| serde_json::from_value::<Vec<String>>(keys.clone()).ok());
            keys.map(ToolConfigurationOutcome::InvalidToolKeys)
                .unwrap_or(ToolConfigurationOutcome::Rejected)
        }
        Err(error) if error.kind() == "agent_capability_unsupported" => {
            ToolConfigurationOutcome::Unsupported
        }
        Err(error) => match super::failure(&error, mutation) {
            subagents::Outcome::Unknown => ToolConfigurationOutcome::OutcomeUnknown,
            subagents::Outcome::Rejected => ToolConfigurationOutcome::Rejected,
            subagents::Outcome::Unsupported => ToolConfigurationOutcome::Unsupported,
            _ => ToolConfigurationOutcome::Unavailable(
                subagents::ConfigurationReadFailure::Unavailable,
            ),
        },
    }
}

fn view(value: &Value) -> Result<ToolConfigurationView, ()> {
    let string = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(())
    };
    let strings = |value: &Value, key: &str| {
        value
            .get(key)
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
            .ok_or(())
    };
    let catalog = value.get("catalog").ok_or(())?;
    let profiles = catalog
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|value| {
            Ok(ToolProfile {
                key: string(value, "key")?,
                display_name: string(value, "displayName")?,
            })
        })
        .collect::<Result<_, ()>>()?;
    let options = catalog
        .get("options")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|value| {
            Ok(ToolOption {
                key: string(value, "key")?,
                display_name: string(value, "displayName")?,
                description: None,
                source: string(value, "source")?,
                plugin_id: None,
                optional: value.get("optional").and_then(Value::as_bool),
                risk: None,
                tags: strings(value, "tags")?,
                default_profiles: strings(value, "defaultProfiles")?,
                denied_by_global_policy: value
                    .get("deniedByGlobalPolicy")
                    .and_then(Value::as_bool)
                    .ok_or(())?,
                group_key: None,
                group_display_name: None,
            })
        })
        .collect::<Result<_, ()>>()?;
    let policy = match value.get("policy").ok_or(())? {
        Value::Null => None,
        value => Some(ToolPolicy {
            profile: string(value, "profile")?,
            allow: strings(value, "allow")?,
            deny: strings(value, "deny")?,
        }),
    };
    Ok(ToolConfigurationView {
        agent_id: string(value, "agentId")?,
        configured: value.get("configured").and_then(Value::as_bool).ok_or(())?,
        policy,
        catalog: ToolCatalog {
            profiles,
            groups: Vec::new(),
            options,
        },
        revision: string(value, "revision")?,
    })
}
