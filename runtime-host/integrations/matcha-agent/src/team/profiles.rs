use organization::{
    ManagedAgentReference, MemberProfile, TeamCreationFailure, TeamCreationFailureReason,
    TeamCreationFile, TeamCreationStage,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::client::{Client, Delivery, Error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Agent {
    pub agent_id: String,
    pub definition: Value,
    pub paths: Paths,
    pub revision: String,
    pub custody: Value,
}

#[derive(Deserialize)]
pub(super) struct Paths {
    pub workspace: String,
}

#[derive(Deserialize)]
pub(super) struct File {
    pub name: String,
    pub missing: bool,
    pub content: Option<String>,
    pub revision: String,
    pub instructions: Instructions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Instructions {
    pub managed_imports_present: bool,
    pub execution: String,
}

pub(super) async fn agent(
    client: &Client,
    id: &str,
    cancellation: &CancellationToken,
) -> Result<Agent, TeamCreationFailureReason> {
    let value = client
        .call_cancellable("agents.get", json!({"agentId": id}), cancellation)
        .await
        .map_err(|error| reason(&error))?;
    let agent: Agent =
        serde_json::from_value(value).map_err(|_| TeamCreationFailureReason::RpcProtocol)?;
    if agent.agent_id != id || !agent.definition.is_object() || agent.paths.workspace.is_empty() {
        return Err(TeamCreationFailureReason::NativeReadbackMismatch);
    }
    Ok(agent)
}

pub(super) async fn file(
    client: &Client,
    id: &str,
    name: &str,
    cancellation: &CancellationToken,
) -> Result<File, TeamCreationFailureReason> {
    let value = client
        .call_cancellable(
            "agents.files.get",
            json!({"agentId": id, "name": name}),
            cancellation,
        )
        .await
        .map_err(|error| reason(&error))?;
    let file: File =
        serde_json::from_value(value).map_err(|_| TeamCreationFailureReason::RpcProtocol)?;
    if file.name != name
        || file.missing == file.content.is_some()
        || file.instructions.execution != "notObserved"
    {
        return Err(TeamCreationFailureReason::NativeReadbackMismatch);
    }
    Ok(file)
}

pub(super) async fn set_file(
    client: &Client,
    id: &str,
    file: &File,
    content: &str,
    cancellation: &CancellationToken,
) -> Result<(), TeamCreationFailureReason> {
    client.call_cancellable("agents.files.set", json!({
        "agentId": id, "name": file.name, "content": content, "expectedRevision": file.revision,
    }), cancellation).await.map_err(|error| reason(&error))?;
    let observed = self::file(client, id, &file.name, cancellation).await?;
    if observed.content.as_deref() != Some(content)
        || !observed.instructions.managed_imports_present
    {
        return Err(TeamCreationFailureReason::NativeReadbackMismatch);
    }
    Ok(())
}

pub(super) fn absent(error: &Error) -> bool {
    error.code() == Some(-32001) && error.kind() == "not_found"
}

pub(super) fn reason(error: &Error) -> TeamCreationFailureReason {
    if error.is_cancelled() {
        TeamCreationFailureReason::ObservationInterrupted
    } else if absent(error) {
        TeamCreationFailureReason::AgentMissing
    } else if error.delivery() == Delivery::Unknown || error.code() == Some(-32006) {
        TeamCreationFailureReason::OutcomeUnknown
    } else if error.code().is_some() {
        TeamCreationFailureReason::RpcRejected
    } else {
        TeamCreationFailureReason::RpcUnavailable
    }
}

pub(super) async fn read(
    client: Client,
    agents: Vec<ManagedAgentReference>,
    cancellation: CancellationToken,
) -> Result<Vec<MemberProfile>, TeamCreationFailure> {
    let mut profiles = Vec::with_capacity(agents.len());
    for (index, id) in agents.into_iter().enumerate() {
        let failure = |reason, file| TeamCreationFailure {
            member_index: Some(index),
            file,
            ..TeamCreationFailure::new(TeamCreationStage::ReadingProfiles, reason)
        };
        let agent = agent(&client, id.as_str(), &cancellation)
            .await
            .map_err(|reason| failure(reason, None))?;
        let description = match agent.definition.get("description") {
            Some(Value::String(value)) => Some(value.clone()),
            None | Some(Value::Null) => None,
            _ => return Err(failure(TeamCreationFailureReason::InvalidConfig, None)),
        };
        let agents = file(&client, id.as_str(), "AGENTS.md", &cancellation)
            .await
            .map_err(|reason| failure(reason, Some(TeamCreationFile::AgentsMarkdown)))?;
        let soul = file(&client, id.as_str(), "SOUL.md", &cancellation)
            .await
            .map_err(|reason| failure(reason, Some(TeamCreationFile::SoulMarkdown)))?;
        profiles.push(MemberProfile {
            description,
            agents_markdown: agents
                .content
                .map(|content| super::materialization::strip_blocks(&content))
                .transpose()
                .map_err(|reason| failure(reason, Some(TeamCreationFile::AgentsMarkdown)))?,
            soul_markdown: soul.content,
        });
    }
    Ok(profiles)
}
