use serde_json::Value;
use subagents::*;

fn text(value: &Value, key: &str) -> Result<String, ()> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(())
}

fn optional(value: &Value, key: &str) -> Result<Option<String>, ()> {
    match value.get(key).ok_or(())? {
        Value::Null => Ok(None),
        Value::String(value) => Ok(Some(value.clone())),
        _ => Err(()),
    }
}

pub(super) fn list(value: Value) -> Result<Outcome, ()> {
    let default_id = text(&value, "defaultId")?;
    let selection_required = value
        .get("selectionRequired")
        .and_then(Value::as_bool)
        .ok_or(())?;
    let agents: Vec<_> = value
        .get("agents")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|value| {
            Ok(AgentSummary {
                id: text(value, "agentId")?,
                name: Some(
                    value
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or(())?
                        .to_owned(),
                ),
                workspace: optional(value, "workspace")?,
                model: optional(value, "model")?,
                kind: AgentKind::Agent,
                sealed: false,
            })
        })
        .collect::<Result<_, ()>>()?;
    if !agents.iter().any(|agent| agent.id == default_id) {
        return Err(());
    }
    Ok(Outcome::Agents {
        default_id,
        selection_required,
        agents,
    })
}

pub(super) fn created(value: Value) -> Result<Outcome, ()> {
    let definition = value.get("definition").ok_or(())?;
    let agent = AgentCreated {
        agent_id: text(&value, "agentId")?,
        name: text(definition, "name")?,
        model: optional(definition, "model")?,
    };
    Ok(
        match value
            .get("workspaceInitialized")
            .and_then(Value::as_bool)
            .ok_or(())?
        {
            true => Outcome::Created(agent),
            false => Outcome::WorkspaceInitializationFailed(agent),
        },
    )
}

pub(super) fn updated(value: Value) -> Result<Outcome, ()> {
    Ok(Outcome::Updated(AgentUpdated {
        agent_id: text(&value, "agentId")?,
    }))
}

pub(super) fn deleted(value: Value) -> Result<Outcome, ()> {
    let cleanup = text(&value, "cleanup")?;
    let failed = value.get("failedCount").and_then(Value::as_u64).ok_or(())?;
    let purge_failed = value
        .get("purgeFailedCount")
        .and_then(Value::as_u64)
        .ok_or(())?;
    Ok(Outcome::Deleted(AgentDeleted {
        agent_id: text(&value, "agentId")?,
        native_ok: value
            .get("configurationRemoved")
            .and_then(Value::as_bool)
            .ok_or(())?
            && cleanup == "complete",
        removed_bindings: 0,
        failed_count: usize::try_from(failed).map_err(|_| ())?,
        purge_failed_count: usize::try_from(purge_failed).map_err(|_| ())?,
        // Matcha never owns a Host sealed package; there is no sealed work to perform.
        sealed_purge: SealedPurge::Completed,
    }))
}

fn file_view(value: &Value) -> Result<AgentFile, ()> {
    Ok(AgentFile {
        name: AgentFileName::parse(&text(value, "name")?)?,
        missing: value.get("missing").and_then(Value::as_bool).ok_or(())?,
        size: value.get("size").and_then(Value::as_u64),
        updated_at_ms: value.get("updatedAtMs").and_then(Value::as_u64),
        content: optional(value, "content")?,
    })
}

pub(super) fn file(value: Value) -> Result<Outcome, ()> {
    Ok(Outcome::File(file_view(&value)?))
}

pub(super) fn files(value: Value) -> Result<Outcome, ()> {
    Ok(Outcome::Files(AgentFiles {
        files: value
            .get("files")
            .and_then(Value::as_array)
            .ok_or(())?
            .iter()
            .map(file_view)
            .collect::<Result<_, _>>()?,
    }))
}

pub(super) fn configuration(value: Value) -> Result<Outcome, ()> {
    let agents = value
        .get("agents")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|value| {
            Ok(ConfigurationAgent {
                id: text(value, "id")?,
                description: optional(value, "description")?,
                model: optional(value, "model")?.map(|primary| ConfigurationModel {
                    primary: Some(primary),
                    fallbacks: Vec::new(),
                }),
                skills: None,
            })
        })
        .collect::<Result<_, ()>>()?;
    Ok(Outcome::Configuration(ConfigurationDisplay {
        defaults: ConfigurationDefaults::default(),
        agents,
    }))
}
