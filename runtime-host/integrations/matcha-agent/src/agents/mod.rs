mod projection;
pub(crate) mod tools;

use serde_json::{Value, json};
use subagents::{Command, NativeEndpoint, Outcome};

use crate::{
    client::{Client, Delivery, Error},
    driver::MatchaRuntimeDriver,
};

impl subagents::SubagentOps for MatchaRuntimeDriver {
    fn subagents<'a>(&'a self, command: Command) -> subagents::SubagentFuture<'a, Outcome> {
        Box::pin(async move {
            if command.endpoint() != NativeEndpoint::MatchaAgentLocal {
                return Outcome::Unsupported;
            }
            execute(&self.native_client(), command).await
        })
    }

    fn subagent_runtime_ready(&self) -> bool {
        self.lifecycle_handle().snapshot().phase()
            == foundation::process::supervision::SupervisorPhase::Running
    }
}

async fn execute(client: &Client, command: Command) -> Outcome {
    match command {
        Command::List { .. } => project(client.call("agents.list", json!({})).await, false, projection::list),
        Command::Create { input, workspace_initialization, .. } => {
            if input.workspace != subagents::AgentWorkspace::Managed { return Outcome::Unsupported; }
            let files = if workspace_initialization == subagents::WorkspaceInitialization::MainAgentTemplate {
                json!({
                    "AGENTS.md":include_str!("../../../../../resources/agent-workspace-templates/main-agent/AGENTS.md"),
                    "SOUL.md":include_str!("../../../../../resources/agent-workspace-templates/main-agent/SOUL.md"),
                    "USER.md":include_str!("../../../../../resources/agent-workspace-templates/main-agent/USER.md"),
                    "IDENTITY.md":include_str!("../../../../../resources/agent-workspace-templates/main-agent/IDENTITY.md"),
                    "HEARTBEAT.md":include_str!("../../../../../resources/agent-workspace-templates/main-agent/HEARTBEAT.md"),
                })
            } else { json!({}) };
            project(client.call("agents.create", json!({
                "agentId":uuid::Uuid::new_v4().to_string(),
                "definition":{"name":input.name,"model":input.model},"files":files,
            })).await, true, projection::created)
        }
        Command::Update { input, .. } => {
            if input.workspace.is_some() { return Outcome::Unsupported; }
            let mut patch = serde_json::Map::new();
            if let Some(name) = input.name { patch.insert("name".into(), json!(name)); }
            if let subagents::AgentModelUpdate::Set(model) = input.model { patch.insert("model".into(), json!(model)); }
            mutate(client, &input.agent_id, Value::Object(patch), false).await
        }
        Command::Delete { input, .. } => {
            let mut params = json!({"agentId":input.agent_id,"deleteFiles":input.delete_files});
            if input.delete_files {
                let view = match client.call("agents.get", json!({"agentId":input.agent_id})).await {
                    Ok(value) => value,
                    Err(error) if error.code() == Some(-32001) => match client.call("agents.deletion.get", json!({"agentId":input.agent_id})).await {
                        Ok(value) => value,
                        Err(error) => return failure(&error, false),
                    },
                    Err(error) => return failure(&error, false),
                };
                let Some(token) = view.pointer("/custody/token").and_then(Value::as_str) else { return Outcome::Rejected; };
                params["expectedCustody"] = json!(token);
            }
            project(client.call("agents.delete", params).await, true, projection::deleted)
        }
        Command::ListFiles { agent_id, .. } => project(client.call("agents.files.list", json!({"agentId":agent_id})).await, false, projection::files),
        Command::GetFile { agent_id, name, .. } => project(client.call("agents.files.get", json!({"agentId":agent_id,"name":name.as_str()})).await, false, projection::file),
        Command::SetFile { agent_id, name, content, .. } => {
            let value = match client.call("agents.files.get", json!({"agentId":agent_id,"name":name.as_str()})).await {
                Ok(value) => value,
                Err(error) => return failure(&error, false),
            };
            let Some(revision) = value.get("revision").and_then(Value::as_str) else { return Outcome::Unavailable; };
            project(client.call("agents.files.set", json!({"agentId":agent_id,"name":name.as_str(),"content":content,"expectedRevision":revision})).await, true, projection::file)
        }
        Command::DisplayConfiguration { .. } => project(client.call("agents.configuration", json!({})).await, false, projection::configuration),
        Command::SetDescription { agent_id, description, .. } => mutate(client, &agent_id, json!({"description":description}), true).await,
        Command::SetConfigurationModel { agent_id, model, .. } => {
            if model.as_ref().is_some_and(|model| !model.fallbacks.is_empty()) { return Outcome::Unsupported; }
            mutate(client, &agent_id, json!({"model":model.and_then(|model| model.primary)}), true).await
        }
        Command::ToolConfiguration { agent_id, .. } => Outcome::ToolConfiguration(tools::outcome(client.call("agents.tools.get", json!({"agentId":agent_id})).await, false)),
        Command::SetToolConfiguration { agent_id, revision, selection, .. } => Outcome::ToolConfiguration(tools::outcome(client.call("agents.tools.set", json!({"agentId":agent_id,"revision":revision,"selection":tools::selection(selection)})).await, true)),
        Command::SetSkills { .. } | Command::SkillConfiguration { .. } | Command::SetSkillConfiguration { .. }
        | Command::ExportPackage { .. } | Command::ExportCloudPackage { .. } | Command::InstallPackage { .. } => Outcome::Unsupported,
    }
}

async fn mutate(client: &Client, agent_id: &str, patch: Value, configuration: bool) -> Outcome {
    let current = match client.call("agents.get", json!({"agentId":agent_id})).await {
        Ok(value) => value,
        Err(error) => return failure(&error, false),
    };
    let Some(revision) = current.get("revision").and_then(Value::as_str) else {
        return Outcome::Unavailable;
    };
    let result = client
        .call(
            "agents.mutate",
            json!({"agentId":agent_id,"revision":revision,"patch":patch}),
        )
        .await;
    project(result, true, |value| {
        let outcome = projection::updated(value)?;
        Ok(if configuration {
            Outcome::ConfigurationApplied
        } else {
            outcome
        })
    })
}

fn project(
    result: Result<Value, Error>,
    mutation: bool,
    projection: impl FnOnce(Value) -> Result<Outcome, ()>,
) -> Outcome {
    match result {
        Ok(value) => projection(value).unwrap_or(if mutation {
            Outcome::Unknown
        } else {
            Outcome::Unavailable
        }),
        Err(error) => failure(&error, mutation),
    }
}

pub(super) fn failure(error: &Error, mutation: bool) -> Outcome {
    if error.delivery() == Delivery::Unknown {
        return if mutation {
            Outcome::Unknown
        } else {
            Outcome::Unavailable
        };
    }
    if error.kind() == "agent_capability_unsupported" || error.code() == Some(-32601) {
        return Outcome::Unsupported;
    }
    if mutation
        && (error.code() == Some(-32006)
            || error
                .data()
                .is_some_and(|data| data.get("fileWritten") == Some(&json!(true))))
    {
        return Outcome::Unknown;
    }
    match error.code() {
        Some(-32602 | -32001 | -32002 | -32007) => Outcome::Rejected,
        _ => Outcome::Unavailable,
    }
}
