use super::{Delete, active_error, check_deletable, delete_guarded, finish_deletion, storage};
use crate::{
    config::{
        AgentDeletion, AgentDeletionState, Config, ConfigStore, validate_agent_id_available,
        validate_id,
    },
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Params {
    agent_id: String,
    expected_owner: String,
}

pub(super) async fn retire(
    params: Params,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    validate_id(&params.agent_id)?;
    check_deletable(&params.agent_id)?;
    if params.expected_owner.is_empty() || params.expected_owner.contains('\0') {
        return Err(rpc::Error::invalid(
            "expectedOwner must not be empty or contain NUL",
        ));
    }
    let _guard = sessions.agent_guard(&params.agent_id).await;
    let snapshot = config.checked_snapshot().await?;
    check_aliases(&snapshot, &params.agent_id)?;
    if let Some(receipt) = snapshot.agent_deletions.get(&params.agent_id) {
        if receipt.owner.as_deref() != Some(params.expected_owner.as_str()) {
            return Err(ownership_changed());
        }
        if !receipt.delete_files {
            return Err(rpc::Error::conflict(
                "agent_delete_intent_changed",
                "The existing deletion retained Agent data",
            ));
        }
        if receipt.state == AgentDeletionState::Deleted && receipt.custody.is_none() {
            return Err(rpc::Error::new(
                -32007,
                "agent_data_not_owned",
                "Retiring an existing Agent requires managed custody",
            ));
        }
        return finish_deletion(receipt.clone(), config).await;
    }
    if let Some(agent) = snapshot.agents.get(&params.agent_id) {
        return delete_guarded(
            Delete {
                agent_id: params.agent_id,
                delete_files: true,
                expected_custody: agent.custody.clone(),
                expected_owner: Some(params.expected_owner),
            },
            config,
            sessions,
        )
        .await;
    }
    if sessions.is_agent_active(&params.agent_id).await {
        return Err(active_error());
    }
    check_references(&snapshot, &params.agent_id)?;
    let custody =
        storage::orphan_custody(config.paths(), &params.agent_id, &params.expected_owner).await?;
    let removed_sessions = sessions
        .delete_agent_sessions_guarded(&params.agent_id)
        .await?;
    let receipt = AgentDeletion {
        agent_id: params.agent_id.clone(),
        state: if custody.is_some() {
            AgentDeletionState::Deleted
        } else {
            AgentDeletionState::Absent
        },
        custody,
        owner: Some(params.expected_owner),
        delete_files: true,
        data_deleted: false,
        removed_sessions,
        completed: false,
    };
    let pending = receipt.clone();
    config.update(move |current| {
        check_aliases(current, &params.agent_id)?;
        validate_agent_id_available(current, &params.agent_id)?;
        check_references(current, &params.agent_id)?;
        current.agent_deletions.insert(params.agent_id, receipt);
        Ok(())
    }).await.map_err(|error| {
        error.with_data(json!({"removedSessions":removed_sessions,"dataDeleted":false,"cleanupComplete":false}))
    })?;
    // The durable identity fence precedes this readback; absence is not historical nonexistence.
    finish_deletion(pending, config).await
}

pub(super) fn check_aliases(config: &Config, agent_id: &str) -> rpc::Result<()> {
    if config
        .agents
        .keys()
        .chain(config.agent_deletions.keys())
        .any(|id| id != agent_id && id.eq_ignore_ascii_case(agent_id))
    {
        return Err(rpc::Error::conflict(
            "agent_id_case_conflict",
            "A case alias of this Agent identity is already configured or retired",
        ));
    }
    Ok(())
}

fn check_references(config: &Config, agent_id: &str) -> rpc::Result<()> {
    if config
        .channels
        .values()
        .chain(config.schedules.values())
        .any(|binding| binding.get("agentId").and_then(Value::as_str) == Some(agent_id))
    {
        return Err(rpc::Error::conflict(
            "agent_referenced",
            "Remove the Agent's channel and schedule bindings before retirement",
        ));
    }
    Ok(())
}

fn ownership_changed() -> rpc::Error {
    rpc::Error::conflict("agent_custody_changed", "The Agent ownership changed")
}
