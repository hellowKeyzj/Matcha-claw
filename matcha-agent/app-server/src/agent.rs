mod definition;
mod files;
mod retirement;
mod storage;
mod tools;

use crate::{
    config::{
        AgentConfig, AgentDeletion, AgentDeletionState, ConfigStore, DEFAULT_AGENT_ID,
        validate_agent_id_available, validate_id,
    },
    rpc,
    session::Sessions,
};
use definition::{Definition, Patch};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentParams {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    agent_id: String,
    definition: Definition,
    owner: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    agent_id: String,
    definition: Definition,
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mutate {
    agent_id: String,
    revision: Option<String>,
    patch: Patch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Delete {
    agent_id: String,
    #[serde(default)]
    delete_files: bool,
    expected_custody: Option<String>,
    expected_owner: Option<String>,
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "agents.list" => {
            let _: ListParams = rpc::params(params)?;
            let agents: Vec<_> = config.snapshot().await.agents.into_iter().map(|(agent_id, agent)| {
                Ok(json!({"workspace":config.paths().workspace(&agent_id)?,"agentId":agent_id,"name":agent.name,"model":agent.model,"provider":agent.provider}))
            }).collect::<rpc::Result<_>>()?;
            Ok(json!({"agents":agents,"defaultId":DEFAULT_AGENT_ID,"selectionRequired":false}))
        }
        "agents.get" => {
            let params: AgentParams = rpc::params(params)?;
            validate_id(&params.agent_id)?;
            let snapshot = config.snapshot().await;
            let agent = snapshot
                .agents
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            definition::view(&params.agent_id, agent, config.paths())
        }
        "agents.deletion.get" => {
            let params: Delete = rpc::params(params)?;
            validate_id(&params.agent_id)?;
            let snapshot = config.checked_snapshot().await?;
            let receipt = snapshot
                .agent_deletions
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent deletion receipt"))?;
            check_ownership(
                &params,
                receipt.custody.as_deref(),
                receipt.owner.as_deref(),
            )?;
            Ok(deletion_view(receipt))
        }
        "agents.configuration" => {
            let _: ListParams = rpc::params(params)?;
            let agents: Vec<_> = config.snapshot().await.agents.into_iter().map(|(agent_id, agent)| {
                json!({"id":agent_id,"description":agent.description,"model":agent.model,"skills":null})
            }).collect();
            Ok(json!({"defaults":{"model":null,"skills":[]},"agents":agents}))
        }
        "agents.create" | "agents.update" | "agents.mutate" | "agents.delete" | "agents.retire"
        | "agents.files.set" | "agents.tools.set" => {
            let method = method.to_owned();
            let config = config.clone();
            let sessions = sessions.clone();
            // Keep admission guard, config commit and data custody alive after caller disconnect.
            tokio::spawn(async move {
                match method.as_str() {
                    "agents.create" => create(rpc::params(params)?, &config, &sessions).await,
                    "agents.update" => replace(rpc::params(params)?, &config, &sessions).await,
                    "agents.mutate" => mutate(rpc::params(params)?, &config, &sessions).await,
                    "agents.delete" => delete(rpc::params(params)?, &config, &sessions).await,
                    "agents.retire" => {
                        retirement::retire(rpc::params(params)?, &config, &sessions).await
                    }
                    "agents.tools.set" => {
                        tools::dispatch(&method, params, &config, &sessions).await
                    }
                    _ => {
                        let target: AgentParams =
                            rpc::params(json!({"agentId":params.get("agentId")}))?;
                        let _guard = sessions.agent_guard(&target.agent_id).await;
                        files::dispatch(&method, params, &config).await
                    }
                }
            })
            .await
            .map_err(|error| {
                rpc::Error::new(
                    -32006,
                    "agent_mutation_unknown",
                    "The Agent mutation outcome could not be confirmed",
                )
                .with_source(error)
            })?
        }
        "agents.files.list" | "agents.files.get" => files::dispatch(method, params, config).await,
        "agents.tools.get" => tools::dispatch(method, params, config, sessions).await,
        _ => Err(rpc::Error::method(method)),
    }
}

pub(crate) async fn prepare_default(config: &ConfigStore) -> rpc::Result<()> {
    let snapshot = config.checked_snapshot().await?;
    let agent = snapshot
        .agents
        .get(DEFAULT_AGENT_ID)
        .ok_or_else(|| rpc::Error::internal("default_agent_missing"))?;
    storage::prepare_default(config.paths(), agent).await?;
    files::initialize(config, DEFAULT_AGENT_ID, &BTreeMap::new()).await
}

fn check_deletable(agent_id: &str) -> rpc::Result<()> {
    if agent_id.eq_ignore_ascii_case(DEFAULT_AGENT_ID) {
        return Err(rpc::Error::conflict(
            "default_agent_protected",
            "The default Agent cannot be deleted or retired",
        ));
    }
    Ok(())
}

async fn create(params: Create, config: &ConfigStore, sessions: &Sessions) -> rpc::Result<Value> {
    validate_id(&params.agent_id)?;
    files::validate(&params.files)?;
    if params
        .owner
        .as_ref()
        .is_some_and(|owner| owner.is_empty() || owner.contains('\0'))
    {
        return Err(rpc::Error::invalid(
            "owner must not be empty or contain NUL",
        ));
    }
    let mut agent: AgentConfig = params.definition.into();
    let token = Uuid::new_v4().to_string();
    agent.custody = Some(token.clone());
    agent.owner = params.owner;
    let _guard = sessions.agent_guard(&params.agent_id).await;
    let snapshot = config.checked_snapshot().await?;
    validate_agent_id_available(&snapshot, &params.agent_id)?;
    definition::validate(&agent, &snapshot)?;
    if sessions.is_agent_active(&params.agent_id).await {
        return Err(active_error());
    }
    let created = storage::create(
        config.paths(),
        &params.agent_id,
        &token,
        agent.owner.as_deref(),
    )
    .await?;
    let owner = agent.owner.clone();
    let agent_id = params.agent_id.clone();
    let paths = config.paths().clone();
    let result = config
        .update(move |current| {
            validate_agent_id_available(current, &agent_id)?;
            definition::validate(&agent, current)?;
            let response = definition::applied(&agent_id, &agent, &paths)?;
            current.agents.insert(agent_id, agent);
            Ok(response)
        })
        .await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => {
            let unknown = error.code == -32006;
            let failures = if unknown {
                Vec::new()
            } else {
                storage::rollback(&created, &params.agent_id, &token, owner.as_deref()).await
            };
            return Err(error.with_data(json!({
                "agentId":params.agent_id,"phase":"persistDefinition",
                "configurationEffect":if unknown {"unknown"} else {"unchanged"},
                "cleanup":if unknown {"notAttempted"} else if failures.is_empty() {"complete"} else {"incomplete"},
                "cleanupFailures":failures,
            })));
        }
    };
    match files::initialize(config, &params.agent_id, &params.files).await {
        Ok(()) => response["workspaceInitialized"] = json!(true),
        Err(error) => {
            response["workspaceInitialized"] = json!(false);
            response["initializationFailure"] = json!({"code":error.code,"kind":error.data.as_ref().and_then(|data| data.get("kind"))});
        }
    }
    Ok(response)
}

async fn replace(params: Replace, config: &ConfigStore, sessions: &Sessions) -> rpc::Result<Value> {
    validate_id(&params.agent_id)?;
    let _guard = sessions.agent_guard(&params.agent_id).await;
    let active = sessions.is_agent_active(&params.agent_id).await;
    let paths = config.paths().clone();
    config
        .update(move |current| {
            let previous = current
                .agents
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            definition::check_revision(
                params.revision.as_deref(),
                &params.agent_id,
                previous,
                &paths,
            )?;
            // Full replacement applies to the public definition, never native ownership/unknown fields.
            let mut agent: AgentConfig = params.definition.into();
            agent.custody = previous.custody.clone();
            agent.owner = previous.owner.clone();
            agent.extra = previous.extra.clone();
            if active && agent.provider != previous.provider {
                return Err(active_error());
            }
            definition::validate(&agent, current)?;
            let response = definition::applied(&params.agent_id, &agent, &paths)?;
            current.agents.insert(params.agent_id, agent);
            Ok(response)
        })
        .await
}

async fn mutate(params: Mutate, config: &ConfigStore, sessions: &Sessions) -> rpc::Result<Value> {
    validate_id(&params.agent_id)?;
    let _guard = sessions.agent_guard(&params.agent_id).await;
    let active = sessions.is_agent_active(&params.agent_id).await;
    let paths = config.paths().clone();
    config
        .update(move |current| {
            let previous = current
                .agents
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            definition::check_revision(
                params.revision.as_deref(),
                &params.agent_id,
                previous,
                &paths,
            )?;
            let mut agent = previous.clone();
            params.patch.apply(&mut agent);
            if active && agent.provider != previous.provider {
                return Err(active_error());
            }
            definition::validate(&agent, current)?;
            let response = definition::applied(&params.agent_id, &agent, &paths)?;
            current.agents.insert(params.agent_id, agent);
            Ok(response)
        })
        .await
}

async fn delete(params: Delete, config: &ConfigStore, sessions: &Sessions) -> rpc::Result<Value> {
    validate_id(&params.agent_id)?;
    let _guard = sessions.agent_guard(&params.agent_id).await;
    delete_guarded(params, config, sessions).await
}

async fn delete_guarded(
    params: Delete,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    check_deletable(&params.agent_id)?;
    let snapshot = config.checked_snapshot().await?;
    if let Some(receipt) = snapshot.agent_deletions.get(&params.agent_id) {
        if receipt.state == AgentDeletionState::Absent {
            return Err(rpc::Error::not_found("Agent"));
        }
        check_ownership(
            &params,
            receipt.custody.as_deref(),
            receipt.owner.as_deref(),
        )?;
        if params.delete_files != receipt.delete_files {
            return Err(rpc::Error::conflict(
                "agent_delete_intent_changed",
                "The deletion used a different data deletion intent",
            ));
        }
        return finish_deletion(receipt.clone(), config).await;
    }
    let agent = snapshot
        .agents
        .get(&params.agent_id)
        .ok_or_else(|| rpc::Error::not_found("Agent"))?;
    if sessions.is_agent_active(&params.agent_id).await {
        return Err(active_error());
    }
    check_ownership(&params, agent.custody.as_deref(), agent.owner.as_deref())?;
    if snapshot
        .channels
        .values()
        .chain(snapshot.schedules.values())
        .any(|binding| {
            binding.get("agentId").and_then(Value::as_str) == Some(params.agent_id.as_str())
        })
    {
        return Err(rpc::Error::conflict(
            "agent_referenced",
            "Remove the Agent's channel and schedule bindings before deletion",
        ));
    }
    if params.delete_files {
        storage::check_custody(
            config.paths(),
            &params.agent_id,
            agent.custody.as_deref(),
            agent.owner.as_deref(),
        )
        .await?;
    }
    let removed_sessions = sessions
        .delete_agent_sessions_guarded(&params.agent_id)
        .await?;
    // Retire the identity durably before purging. Retry never requires a live definition.
    let receipt = AgentDeletion {
        agent_id: params.agent_id.clone(),
        state: AgentDeletionState::Deleted,
        custody: agent.custody.clone(),
        owner: agent.owner.clone(),
        delete_files: params.delete_files,
        data_deleted: false,
        removed_sessions,
        completed: !params.delete_files,
    };
    let pending = receipt.clone();
    let expected = definition::revision(agent)?;
    let paths = config.paths().clone();
    config
        .update(move |current| {
            retirement::check_aliases(current, &params.agent_id)?;
            let agent = current
                .agents
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            definition::check_revision(Some(&expected), &params.agent_id, agent, &paths)?;
            if current
                .channels
                .values()
                .chain(current.schedules.values())
                .any(|binding| {
                    binding.get("agentId").and_then(Value::as_str) == Some(params.agent_id.as_str())
                })
            {
                return Err(rpc::Error::conflict(
                    "agent_referenced",
                    "Remove Agent bindings before deletion",
                ));
            }
            current.agents.remove(&params.agent_id);
            current.agent_deletions.insert(params.agent_id, receipt);
            Ok(())
        })
        .await
        .map_err(|error| {
            error.with_data(json!({"removedSessions":removed_sessions,"dataDeleted":false}))
        })?;
    finish_deletion(pending, config).await
}

fn check_ownership(params: &Delete, custody: Option<&str>, owner: Option<&str>) -> rpc::Result<()> {
    if params
        .expected_custody
        .as_deref()
        .is_some_and(|expected| custody != Some(expected))
        || params
            .expected_owner
            .as_deref()
            .is_some_and(|expected| owner != Some(expected))
    {
        return Err(rpc::Error::conflict(
            "agent_custody_changed",
            "The Agent ownership changed",
        ));
    }
    if params.delete_files
        && (custody.is_none()
            || params.expected_custody.is_none() && params.expected_owner.is_none())
    {
        return Err(rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "Data deletion requires managed custody and expectedCustody or expectedOwner",
        ));
    }
    Ok(())
}

async fn finish_deletion(mut receipt: AgentDeletion, config: &ConfigStore) -> rpc::Result<Value> {
    check_deletable(&receipt.agent_id)?;
    if receipt.completed {
        return Ok(deletion_view(&receipt));
    }
    let cleanup = if receipt.state == AgentDeletionState::Absent {
        storage::root_absent(config.paths(), &receipt.agent_id)
            .await
            .and_then(|absent| {
                if absent {
                    Ok(())
                } else {
                    Err(rpc::Error::new(
                        -32006,
                        "agent_retirement_cleanup_unknown",
                        "Agent data appeared after the absence retirement intent",
                    ))
                }
            })
    } else {
        storage::remove(
            config.paths(),
            &receipt.agent_id,
            receipt
                .custody
                .as_deref()
                .ok_or_else(|| rpc::Error::internal("agent_deletion_custody"))?,
            receipt.owner.as_deref(),
        )
        .await
    };
    if let Err(error) = cleanup {
        let mut view = deletion_view(&receipt);
        view["purgeFailedCount"] = json!(1);
        view["cleanupFailure"] =
            json!({"code":error.code,"kind":error.data.as_ref().and_then(|data|data.get("kind"))});
        return Ok(view);
    }
    receipt.data_deleted = receipt.state == AgentDeletionState::Deleted;
    receipt.completed = true;
    config
        .update(move |current| {
            let view = deletion_view(&receipt);
            current
                .agent_deletions
                .insert(receipt.agent_id.clone(), receipt);
            Ok(view)
        })
        .await
}

fn deletion_view(receipt: &AgentDeletion) -> Value {
    json!({"agentId":receipt.agent_id,"owner":receipt.owner,"state":receipt.state,"retired":true,
        "cleanupComplete":receipt.completed,"configurationRemoved":true,"dataDeleted":receipt.data_deleted,
        "deleteFiles":receipt.delete_files,"removedSessions":receipt.removed_sessions,
        "custody":match &receipt.custody {Some(token)=>json!({"kind":"managed","token":token,"owner":receipt.owner}),None=>json!({"kind":"external"})},
        "removedSessionsScope":"confirmedBatchBeforeRetirement",
        "failedCount":0,"purgeFailedCount":0,"cleanup":if receipt.completed {"complete"} else {"pending"},"cleanupFailure":null})
}

fn active_error() -> rpc::Error {
    rpc::Error::conflict(
        "agent_active",
        "Close all Agent sessions and CLI instances before deleting the Agent or changing its provider",
    )
}
