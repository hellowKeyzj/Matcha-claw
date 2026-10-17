use organization::{
    ManagedAgentReference, MaterializationOperationOutcome as Outcome, MaterializationReceipt,
    MaterializationRejection, NativeWorkspaceReceipt, RoleAgentMaterialization,
    RoleMaterializationAgent, RoleMaterializationOwnership, RoleMaterializationReceipt,
    TeamCreationFailure, TeamCreationFailureReason as Reason, TeamCreationStage,
    TeamMaterializationRemoval, TeamMaterializationRequest, TeamProvisionObserver,
    TeamProvisionStage, TeamProvisionUpdate,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    profiles::{self, Agent},
    skills,
};
use crate::client::Client;

fn owner(endpoint: &str, team: &str, role: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"matcha-team-agent-v1");
    for part in [endpoint, team, role] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("team-agent:{:x}", hash.finalize())
}

fn agent_id(owner: &str) -> String {
    format!(
        "team-{}",
        owner
            .strip_prefix("team-agent:")
            .expect("team owner prefix")
    )
}

fn managed(agent: &Agent, owner: &str) -> bool {
    agent.custody.get("kind").and_then(Value::as_str) == Some("managed")
        && agent.custody.get("owner").and_then(Value::as_str) == Some(owner)
        && agent
            .custody
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.is_empty())
}

fn tools(role: &RoleAgentMaterialization) -> Result<Option<Vec<String>>, Reason> {
    if role.tools().is_empty() {
        return Ok(None);
    }
    crate::agents::tools::native_tool_keys(role.tools())
        .map(Some)
        .map_err(|_| Reason::Unsupported)
}

fn tools_match(agent: &Agent, expected: &Option<Vec<String>>) -> bool {
    agent.definition.get("tools") == Some(&json!(expected))
}

fn external_tools_match(agent: &Agent, expected: &Option<Vec<String>>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let denied = agent
        .definition
        .get("disallowedTools")
        .and_then(Value::as_array);
    let available = agent.definition.get("tools");
    expected.iter().all(|tool| {
        !denied.is_some_and(|denied| {
            denied
                .iter()
                .any(|value| value.as_str() == Some(tool.as_str()))
        }) && match available {
            Some(Value::Null) => true,
            Some(Value::Array(available)) => available
                .iter()
                .any(|value| value.as_str() == Some(tool.as_str())),
            _ => false,
        }
    })
}

fn block(owner: &str, markdown: Option<&str>) -> Result<String, Reason> {
    let markdown = markdown.unwrap_or("");
    if markdown.contains("<!-- matcha-team:") {
        return Err(Reason::InvalidTeamRunBlocks);
    }
    Ok(format!(
        "<!-- matcha-team:{owner}:begin -->\n{markdown}\n<!-- matcha-team:{owner}:end -->"
    ))
}

fn block_range(content: &str, owner: &str) -> Result<Option<std::ops::Range<usize>>, Reason> {
    let begin = format!("<!-- matcha-team:{owner}:begin -->");
    let end = format!("<!-- matcha-team:{owner}:end -->");
    let begins = content.match_indices(&begin).collect::<Vec<_>>();
    let ends = content.match_indices(&end).collect::<Vec<_>>();
    match (begins.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([(start, _)], [(finish, _)]) if start < finish => Ok(Some(*start..*finish + end.len())),
        _ => Err(Reason::InvalidTeamRunBlocks),
    }
}

pub(super) fn strip_blocks(content: &str) -> Result<String, Reason> {
    let mut remaining = content;
    let mut output = String::new();
    while let Some(start) = remaining.find("<!-- matcha-team:") {
        output.push_str(&remaining[..start]);
        let header_end = remaining[start..]
            .find(":begin -->")
            .ok_or(Reason::InvalidTeamRunBlocks)?
            + start;
        let owner = &remaining[start + "<!-- matcha-team:".len()..header_end];
        let range = block_range(remaining, owner)?.ok_or(Reason::InvalidTeamRunBlocks)?;
        if range.start != start {
            return Err(Reason::InvalidTeamRunBlocks);
        }
        remaining = &remaining[range.end..];
    }
    output.push_str(remaining);
    Ok(output)
}

async fn apply_block(
    client: &Client,
    id: &str,
    owner: &str,
    markdown: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<(), Reason> {
    let file = profiles::file(client, id, "AGENTS.md", cancellation).await?;
    let mut content = file.content.clone().unwrap_or_default();
    let expected = block(owner, markdown)?;
    match block_range(&content, owner)? {
        Some(range) if content[range.clone()] == expected => {}
        Some(_) => return Err(Reason::NativeReadbackMismatch),
        None => content.push_str(&expected),
    }
    // The native file operation also ensures the CLI's CLAUDE.md imports.
    profiles::set_file(client, id, &file, &content, cancellation).await
}

async fn remove_block(
    client: &Client,
    id: &str,
    owner: &str,
    markdown: &str,
    read_only: bool,
    cancellation: &CancellationToken,
) -> Result<(), Reason> {
    let file = profiles::file(client, id, "AGENTS.md", cancellation).await?;
    let mut content = file.content.clone().unwrap_or_default();
    let Some(range) = block_range(&content, owner)? else {
        return Ok(());
    };
    if read_only || content[range.clone()] != block(owner, Some(markdown))? {
        return Err(Reason::NativeReadbackMismatch);
    }
    content.replace_range(range, "");
    profiles::set_file(client, id, &file, &content, cancellation).await
}

async fn verify_role(
    client: &Client,
    request: &TeamMaterializationRequest,
    role: &RoleAgentMaterialization,
    sources: &skills::Sources,
    cancellation: &CancellationToken,
) -> Result<RoleMaterializationReceipt, Reason> {
    let owner = owner(
        request.intent().endpoint().as_str(),
        request.intent().team().as_str(),
        role.role().as_str(),
    );
    let (id, ownership) = match role.agent() {
        RoleMaterializationAgent::Managed { .. } => {
            (agent_id(&owner), RoleMaterializationOwnership::Managed)
        }
        RoleMaterializationAgent::External { agent } => (
            agent.as_str().to_owned(),
            RoleMaterializationOwnership::External,
        ),
    };
    let agent = profiles::agent(client, &id, cancellation).await?;
    let expected_tools = tools(role)?;
    match role.agent() {
        RoleMaterializationAgent::Managed { name } => {
            if !managed(&agent, &owner)
                || agent.definition.get("name").and_then(Value::as_str) != Some(name.as_str())
                || !tools_match(&agent, &expected_tools)
            {
                return Err(Reason::NativeReadbackMismatch);
            }
        }
        RoleMaterializationAgent::External { .. }
            if !external_tools_match(&agent, &expected_tools) =>
        {
            return Err(Reason::Unsupported);
        }
        _ => {}
    }
    if ownership == RoleMaterializationOwnership::Managed || role.agents_markdown().is_some() {
        let file = profiles::file(client, &id, "AGENTS.md", cancellation).await?;
        let content = file.content.as_deref().unwrap_or("");
        let expected = block(&owner, role.agents_markdown())?;
        if !file.instructions.managed_imports_present
            || !block_range(content, &owner)?.is_some_and(|range| content[range] == expected)
        {
            return Err(Reason::NativeReadbackMismatch);
        }
    }
    let mut receipt = RoleMaterializationReceipt::with_native_workspace(
        role.role().clone(),
        ManagedAgentReference::try_new(id).map_err(|_| Reason::InvalidInput)?,
        ownership,
        request.intent().endpoint().clone(),
        NativeWorkspaceReceipt::try_new(agent.paths.workspace)
            .map_err(|_| Reason::WorkspaceMissing)?,
    );
    if let Some(markdown) = role.agents_markdown() {
        receipt = receipt.with_agents_markdown(markdown);
    }
    let verified = skills::verify(
        client,
        receipt.agent().as_str(),
        role.skills(),
        sources,
        cancellation,
    )
    .await?;
    Ok(receipt.with_skills(verified))
}

async fn verify(
    client: &Client,
    request: &TeamMaterializationRequest,
    sources: &skills::Sources,
    cancellation: &CancellationToken,
) -> Result<MaterializationReceipt, Reason> {
    let mut roles = Vec::with_capacity(request.intent().agents().len());
    for role in request.intent().agents() {
        roles.push(verify_role(client, request, role, sources, cancellation).await?);
    }
    MaterializationReceipt::try_new(
        request.intent().team().clone(),
        request.intent().endpoint().clone(),
        roles,
    )
    .map_err(|_| Reason::NativeReadbackMismatch)
}

async fn report(
    observer: Option<&TeamProvisionObserver>,
    stage: TeamCreationStage,
    reason: Reason,
) {
    if let Some(observer) = observer {
        observer
            .report(TeamProvisionUpdate::Failure(TeamCreationFailure::new(
                stage, reason,
            )))
            .await;
    }
}

fn rejected(reason: Reason) -> Outcome {
    match reason {
        Reason::Unsupported | Reason::InvalidInput | Reason::RpcRejected | Reason::AgentMissing => {
            Outcome::Rejected {
                rejection: MaterializationRejection::Permanent,
            }
        }
        Reason::RpcUnavailable => Outcome::Rejected {
            rejection: MaterializationRejection::Retryable,
        },
        _ => Outcome::OutcomeUnknown,
    }
}

pub(super) async fn materialize(
    client: Client,
    request: TeamMaterializationRequest,
    observer: Option<TeamProvisionObserver>,
    cancellation: CancellationToken,
) -> Outcome {
    if let Some(observer) = &observer {
        observer
            .report(TeamProvisionUpdate::Stage(
                TeamProvisionStage::ConfiguringTeam,
            ))
            .await;
    }
    let sources = match skills::sources(&client, &request, &cancellation).await {
        Ok(sources) => sources,
        Err(reason) => {
            report(
                observer.as_ref(),
                TeamCreationStage::ConfiguringTeam,
                reason,
            )
            .await;
            return rejected(reason);
        }
    };
    // Check all External tools, skills and owned-block conflicts before any native mutation.
    for role in request.intent().agents() {
        let expected_tools = match tools(role) {
            Ok(tools) => tools,
            Err(reason) => {
                report(
                    observer.as_ref(),
                    TeamCreationStage::ConfiguringTeam,
                    reason,
                )
                .await;
                return rejected(reason);
            }
        };
        if let Err(reason) = block(
            &owner(
                request.intent().endpoint().as_str(),
                request.intent().team().as_str(),
                role.role().as_str(),
            ),
            role.agents_markdown(),
        ) {
            report(
                observer.as_ref(),
                TeamCreationStage::ConfiguringTeam,
                reason,
            )
            .await;
            return rejected(reason);
        }
        if let RoleMaterializationAgent::External { agent: id } = role.agent() {
            let check = async {
                let agent = profiles::agent(&client, id.as_str(), &cancellation).await?;
                if !external_tools_match(&agent, &expected_tools) {
                    return Err(Reason::Unsupported);
                }
                skills::verify(&client, id.as_str(), role.skills(), &sources, &cancellation)
                    .await?;
                if let Some(markdown) = role.agents_markdown() {
                    let owner = owner(
                        request.intent().endpoint().as_str(),
                        request.intent().team().as_str(),
                        role.role().as_str(),
                    );
                    let file =
                        profiles::file(&client, id.as_str(), "AGENTS.md", &cancellation).await?;
                    let content = file.content.as_deref().unwrap_or("");
                    let expected = block(&owner, Some(markdown))?;
                    if block_range(content, &owner)?.is_some_and(|range| content[range] != expected)
                    {
                        return Err(Reason::NativeReadbackMismatch);
                    }
                }
                Ok(())
            }
            .await;
            if let Err(reason) = check {
                report(observer.as_ref(), TeamCreationStage::VerifyingTeam, reason).await;
                return rejected(reason);
            }
        }
    }
    for role in request.intent().agents() {
        let RoleMaterializationAgent::Managed { name } = role.agent() else {
            if let (RoleMaterializationAgent::External { agent }, Some(markdown)) =
                (role.agent(), role.agents_markdown())
            {
                let owner = owner(
                    request.intent().endpoint().as_str(),
                    request.intent().team().as_str(),
                    role.role().as_str(),
                );
                if let Err(reason) = apply_block(
                    &client,
                    agent.as_str(),
                    &owner,
                    Some(markdown),
                    &cancellation,
                )
                .await
                {
                    report(
                        observer.as_ref(),
                        TeamCreationStage::ConfiguringTeam,
                        reason,
                    )
                    .await;
                    return Outcome::OutcomeUnknown;
                }
            }
            continue;
        };
        let owner = owner(
            request.intent().endpoint().as_str(),
            request.intent().team().as_str(),
            role.role().as_str(),
        );
        let id = agent_id(&owner);
        let expected_tools = match tools(role) {
            Ok(tools) => tools,
            Err(_) => return Outcome::OutcomeUnknown,
        };
        let expected_block = match block(&owner, role.agents_markdown()) {
            Ok(block) => block,
            Err(_) => return Outcome::OutcomeUnknown,
        };
        let agent = match profiles::agent(&client, &id, &cancellation).await {
            Ok(agent) => agent,
            Err(Reason::AgentMissing) => {
                let created = client
                    .call_cancellable(
                        "agents.create",
                        json!({
                            "agentId": id, "owner": owner,
                            "definition": {"name": name, "tools": expected_tools},
                            "files": {"AGENTS.md": expected_block},
                        }),
                        &cancellation,
                    )
                    .await;
                if let Err(error) = created {
                    report(
                        observer.as_ref(),
                        TeamCreationStage::ConfiguringTeam,
                        profiles::reason(&error),
                    )
                    .await;
                    return Outcome::OutcomeUnknown;
                }
                match profiles::agent(&client, &id, &cancellation).await {
                    Ok(agent) => agent,
                    Err(reason) => {
                        report(observer.as_ref(), TeamCreationStage::VerifyingTeam, reason).await;
                        return Outcome::OutcomeUnknown;
                    }
                }
            }
            Err(reason) => {
                report(
                    observer.as_ref(),
                    TeamCreationStage::ConfiguringTeam,
                    reason,
                )
                .await;
                return Outcome::OutcomeUnknown;
            }
        };
        if !managed(&agent, &owner) {
            report(
                observer.as_ref(),
                TeamCreationStage::VerifyingTeam,
                Reason::StoreConflict,
            )
            .await;
            return Outcome::OutcomeUnknown;
        }
        if agent.definition.get("name").and_then(Value::as_str) != Some(name.as_str())
            || !tools_match(&agent, &expected_tools)
        {
            if let Err(error) = client.call_cancellable("agents.mutate", json!({
                "agentId": id, "revision": agent.revision, "patch": {"name": name, "tools": expected_tools},
            }), &cancellation).await {
                report(observer.as_ref(), TeamCreationStage::ConfiguringTeam, profiles::reason(&error)).await;
                return Outcome::OutcomeUnknown;
            }
        }
        if let Err(reason) =
            apply_block(&client, &id, &owner, role.agents_markdown(), &cancellation).await
        {
            report(
                observer.as_ref(),
                TeamCreationStage::ConfiguringTeam,
                reason,
            )
            .await;
            return Outcome::OutcomeUnknown;
        }
        if let Err(reason) =
            skills::install(&client, &id, role.skills(), &sources, &cancellation).await
        {
            report(
                observer.as_ref(),
                TeamCreationStage::ConfiguringTeam,
                reason,
            )
            .await;
            return Outcome::OutcomeUnknown;
        }
    }
    if let Some(observer) = &observer {
        observer
            .report(TeamProvisionUpdate::Stage(
                TeamProvisionStage::VerifyingTeam,
            ))
            .await;
    }
    match verify(&client, &request, &sources, &cancellation).await {
        Ok(receipt) => Outcome::Confirmed { receipt },
        Err(reason) => {
            report(observer.as_ref(), TeamCreationStage::VerifyingTeam, reason).await;
            Outcome::OutcomeUnknown
        }
    }
}

pub(super) async fn recover(
    client: Client,
    request: TeamMaterializationRequest,
    cancellation: CancellationToken,
) -> Outcome {
    // Recovery only observes the persisted intent; native mutations belong to materialize.
    let Ok(sources) = skills::sources(&client, &request, &cancellation).await else {
        return Outcome::OutcomeUnknown;
    };
    match verify(&client, &request, &sources, &cancellation).await {
        Ok(receipt) => Outcome::Confirmed { receipt },
        Err(_) => Outcome::OutcomeUnknown,
    }
}

fn deletion_complete(value: &Value, id: &str) -> bool {
    value.get("agentId").and_then(Value::as_str) == Some(id)
        && value.get("configurationRemoved") == Some(&Value::Bool(true))
        && value.get("dataDeleted") == Some(&Value::Bool(true))
        && value.get("deleteFiles") == Some(&Value::Bool(true))
        && value.get("cleanup").and_then(Value::as_str) == Some("complete")
        && value.get("failedCount").and_then(Value::as_u64) == Some(0)
        && value.get("purgeFailedCount").and_then(Value::as_u64) == Some(0)
        && value.get("cleanupFailure").is_none_or(Value::is_null)
}

fn retirement_complete(value: &Value, id: &str, owner: &str) -> bool {
    value["agentId"] == id
        && value["owner"] == owner
        && value["retired"] == true
        && value["cleanupComplete"] == true
        && value["configurationRemoved"] == true
        && value["deleteFiles"] == true
        && value["cleanup"] == "complete"
        && value["failedCount"] == 0
        && value["purgeFailedCount"] == 0
        && value.get("cleanupFailure").is_some_and(Value::is_null)
        && match value["state"].as_str() {
            Some("absent") => value["dataDeleted"] == false,
            Some("deleted") => {
                value["dataDeleted"] == true
                    && value["custody"]["kind"] == "managed"
                    && value["custody"]["owner"] == owner
                    && value["custody"]["token"]
                        .as_str()
                        .is_some_and(|token| !token.is_empty())
            }
            _ => false,
        }
}

async fn remove_receipt(
    client: &Client,
    receipt: &MaterializationReceipt,
    read_only: bool,
    cancellation: &CancellationToken,
) -> bool {
    for role in receipt.roles() {
        let owner = owner(
            receipt.endpoint().as_str(),
            receipt.team().as_str(),
            role.role().as_str(),
        );
        if role.ownership() == RoleMaterializationOwnership::External {
            if let Some(markdown) = role.agents_markdown() {
                if remove_block(
                    client,
                    role.agent().as_str(),
                    &owner,
                    markdown,
                    read_only,
                    cancellation,
                )
                .await
                .is_err()
                {
                    return false;
                }
            }
            continue;
        }
        if role.agent().as_str() != agent_id(&owner) {
            return false;
        }
        if !read_only {
            match profiles::agent(client, role.agent().as_str(), cancellation).await {
                Ok(agent)
                    if managed(&agent, &owner)
                        && role.native_workspace().is_some_and(|workspace| {
                            workspace.as_str() == agent.paths.workspace
                        }) => {}
                Err(Reason::AgentMissing) => {}
                _ => return false,
            }
        }
        let method = if read_only {
            "agents.deletion.get"
        } else {
            "agents.delete"
        };
        let mut params = json!({"agentId": role.agent().as_str(), "expectedOwner": owner});
        if !read_only {
            params["deleteFiles"] = json!(true);
        }
        match client.call_cancellable(method, params, cancellation).await {
            Ok(value) if deletion_complete(&value, role.agent().as_str()) => {}
            _ => return false,
        }
        match client
            .call_cancellable(
                "agents.get",
                json!({"agentId": role.agent().as_str()}),
                cancellation,
            )
            .await
        {
            Err(error) if profiles::absent(&error) => {}
            _ => return false,
        }
    }
    true
}

pub(super) async fn remove(
    client: Client,
    removal: TeamMaterializationRemoval,
    cancellation: CancellationToken,
) -> Outcome {
    if remove_receipt(&client, removal.receipt(), false, &cancellation).await {
        Outcome::Confirmed {
            receipt: removal.receipt().clone(),
        }
    } else {
        Outcome::OutcomeUnknown
    }
}

pub(super) async fn recover_removal(
    client: Client,
    removal: TeamMaterializationRemoval,
    cancellation: CancellationToken,
) -> Outcome {
    if remove_receipt(&client, removal.receipt(), true, &cancellation).await {
        Outcome::Confirmed {
            receipt: removal.receipt().clone(),
        }
    } else {
        Outcome::OutcomeUnknown
    }
}

pub(super) async fn remove_unconfirmed(
    client: Client,
    request: TeamMaterializationRequest,
    cancellation: CancellationToken,
) -> Outcome {
    let mut roles = Vec::with_capacity(request.intent().agents().len());
    for role in request.intent().agents() {
        let owner = owner(
            request.intent().endpoint().as_str(),
            request.intent().team().as_str(),
            role.role().as_str(),
        );
        let (id, ownership) = match role.agent() {
            RoleMaterializationAgent::External { agent } => (
                agent.as_str().to_owned(),
                RoleMaterializationOwnership::External,
            ),
            RoleMaterializationAgent::Managed { .. } => {
                (agent_id(&owner), RoleMaterializationOwnership::Managed)
            }
        };
        let agent = match profiles::agent(&client, &id, &cancellation).await {
            Ok(agent)
                if ownership == RoleMaterializationOwnership::External
                    || managed(&agent, &owner) =>
            {
                Some(agent)
            }
            Err(Reason::AgentMissing) if ownership == RoleMaterializationOwnership::Managed => None,
            _ => return Outcome::OutcomeUnknown,
        };
        if ownership == RoleMaterializationOwnership::Managed {
            let retired = match client
                .call_cancellable(
                    "agents.retire",
                    json!({"agentId": id, "expectedOwner": owner}),
                    &cancellation,
                )
                .await
            {
                Ok(value) => value,
                Err(_) => return Outcome::OutcomeUnknown,
            };
            if !retirement_complete(&retired, &id, &owner)
                || agent.as_ref().is_some_and(|agent| {
                    retired["state"] != "deleted" || retired["custody"] != agent.custody
                })
            {
                return Outcome::OutcomeUnknown;
            }
            match client
                .call_cancellable(
                    "agents.deletion.get",
                    json!({"agentId": id, "expectedOwner": owner}),
                    &cancellation,
                )
                .await
            {
                Ok(observed)
                    if retirement_complete(&observed, &id, &owner)
                        && observed["state"] == retired["state"]
                        && observed["custody"] == retired["custody"] => {}
                _ => return Outcome::OutcomeUnknown,
            }
            match client
                .call_cancellable("agents.get", json!({"agentId": id}), &cancellation)
                .await
            {
                Err(error) if profiles::absent(&error) => {}
                _ => return Outcome::OutcomeUnknown,
            }
        } else if let Some(markdown) = role.agents_markdown() {
            if remove_block(&client, &id, &owner, markdown, false, &cancellation)
                .await
                .is_err()
            {
                return Outcome::OutcomeUnknown;
            }
        }
        let workspace = agent.map(|agent| agent.paths.workspace).unwrap_or_default();
        let mut receipt = RoleMaterializationReceipt::with_ownership(
            role.role().clone(),
            match ManagedAgentReference::try_new(id) {
                Ok(id) => id,
                Err(_) => return Outcome::OutcomeUnknown,
            },
            ownership,
            request.intent().endpoint().clone(),
        );
        if !workspace.is_empty() {
            receipt = RoleMaterializationReceipt::with_native_workspace(
                receipt.role().clone(),
                receipt.agent().clone(),
                ownership,
                request.intent().endpoint().clone(),
                match NativeWorkspaceReceipt::try_new(workspace) {
                    Ok(workspace) => workspace,
                    Err(_) => return Outcome::OutcomeUnknown,
                },
            );
        }
        if let Some(markdown) = role.agents_markdown() {
            receipt = receipt.with_agents_markdown(markdown);
        }
        roles.push(receipt);
    }
    let receipt = match MaterializationReceipt::try_new(
        request.intent().team().clone(),
        request.intent().endpoint().clone(),
        roles,
    ) {
        Ok(receipt) => receipt,
        Err(_) => return Outcome::OutcomeUnknown,
    };
    Outcome::Confirmed { receipt }
}
