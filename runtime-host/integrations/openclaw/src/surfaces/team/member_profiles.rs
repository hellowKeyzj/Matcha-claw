use std::{sync::Arc, time::Instant};

use futures_util::{StreamExt, TryStreamExt, stream};
use organization::{ManagedAgentReference, MemberIntroductionError, MemberProfile};
use platform::trace::{identifier_hash, session_trace};
use serde_json::{Value, json};

use crate::{
    agents::{AgentFile, AgentFileName, OpenClawAgents},
    gateway::{
        client::{GatewayClient, GatewayClientError},
        wire::{self, GatewayResponse},
    },
};

use super::{
    buddy::strip_teamrun_blocks,
    provider::{ReadFailure, next_request_id},
};

pub(super) async fn read(
    gateway: Arc<GatewayClient>,
    requested: Vec<ManagedAgentReference>,
) -> Result<Vec<MemberProfile>, MemberIntroductionError> {
    if requested.is_empty() {
        session_trace(
            "runtime.team.profile.end",
            json!({"outcome":"Succeeded","count":0}),
        );
        return Ok(Vec::new());
    }
    let started = Instant::now();
    let agents = OpenClawAgents::new(Arc::clone(&gateway));
    session_trace(
        "runtime.team.profile.native-list.request",
        json!({"count":requested.len()}),
    );
    let native = agents
        .list()
        .await
        .inspect(|native| session_trace("runtime.team.profile.native-list.end", json!({"outcome":"Succeeded","count":native.agents.len(),"elapsedMs":started.elapsed().as_millis()})))
        .map_err(|error| {
            session_trace("runtime.team.profile.native-list.end", json!({"outcome":format!("{:?}", ReadFailure::from(error)),"elapsedMs":started.elapsed().as_millis()}));
            MemberIntroductionError::Unavailable
        })?;
    for (index, requested) in requested.iter().enumerate() {
        let agent_hash = identifier_hash(requested.as_str());
        let mut matching = native
            .agents
            .iter()
            .filter(|agent| agent.id == requested.as_str());
        let agent = matching.next().ok_or_else(|| {
            session_trace(
                "runtime.team.profile.native-check",
                json!({"index":index,"agentHash":agent_hash,"exists":false}),
            );
            MemberIntroductionError::Unavailable
        })?;
        let duplicate = matching.next().is_some();
        // Keep the original short circuit: workspace is only inspected for a unique native agent.
        let workspace_present = (!duplicate).then(|| {
            agent
                .workspace
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
        });
        session_trace(
            "runtime.team.profile.native-check",
            json!({"index":index,"agentHash":agent_hash,"exists":true,"duplicate":duplicate,"workspacePresent":workspace_present}),
        );
        if duplicate || workspace_present == Some(false) {
            return Err(MemberIntroductionError::Unavailable);
        }
    }
    session_trace("runtime.team.profile.config-get.request", json!({}));
    let config_started = Instant::now();
    let request = wire::team::config_get_request(next_request_id("member-profiles-config"))
        .map_err(|_| {
            session_trace("runtime.team.profile.config-get.end", json!({"reason":"request-shape","outcome":"Protocol","elapsedMs":config_started.elapsed().as_millis()}));
            MemberIntroductionError::Unavailable
        })?;
    let response = gateway
        .rpc_query(request)
        .await
        .map_err(|error| {
            let class = match error { GatewayClientError::Protocol | GatewayClientError::RpcFailed => "Protocol", _ => "Unavailable" };
            session_trace("runtime.team.profile.config-get.end", json!({"reason":"transport","outcome":class,"elapsedMs":config_started.elapsed().as_millis()}));
            MemberIntroductionError::Unavailable
        })?;
    let valid_shape = matches!(&response, GatewayResponse::Success { payload: Some(payload), .. }
        if payload.get("valid") == Some(&Value::Bool(true)));
    session_trace(
        "runtime.team.profile.config-get.rpc-end",
        json!({"successValidShape":valid_shape,"outcome":if matches!(&response, GatewayResponse::Failure { .. }) {"Rejected"} else {"Succeeded"},"elapsedMs":config_started.elapsed().as_millis()}),
    );
    if !valid_shape {
        session_trace(
            "runtime.team.profile.config-get.end",
            json!({"reason":"success-validshape","outcome":"Unavailable","elapsedMs":config_started.elapsed().as_millis()}),
        );
        return Err(MemberIntroductionError::Unavailable);
    }
    let (_, document, _) = wire::team::decode_config_get(response)
        .map_err(|_| {
            session_trace("runtime.team.profile.config-get.end", json!({"reason":"decode","outcome":"Protocol","elapsedMs":config_started.elapsed().as_millis()}));
            MemberIntroductionError::Unavailable
        })?
        .into_source_and_runtime_config_parts();
    session_trace(
        "runtime.team.profile.config-get.end",
        json!({"reason":"decode","outcome":"Succeeded","elapsedMs":config_started.elapsed().as_millis()}),
    );
    let descriptions = requested
        .iter()
        .enumerate()
        .map(|(index, agent)| description(&document, agent.as_str(), index))
        .collect::<Result<Vec<_>, _>>()?;
    drop(document);
    let result = stream::iter(
        requested
            .into_iter()
            .zip(descriptions)
            .enumerate()
            .map(|(index, (agent, description))| {
                let agents = &agents;
                async move {
                    let agent_hash = identifier_hash(agent.as_str());
                    let read_file = |name, file: &'static str| {
                        let agent = &agent;
                        let agent_hash = &agent_hash;
                        async move {
                            let file_started = Instant::now();
                            session_trace("runtime.team.profile.file.request", json!({"index":index,"agentHash":agent_hash,"file":file}));
                            agents.files_get(agent.as_str().to_owned(), name).await
                                .inspect(|content| session_trace("runtime.team.profile.file.end", json!({"index":index,"agentHash":agent_hash,"file":file,"outcome":"Succeeded","missing":content.missing,"contentBytes":content.content.as_ref().map(String::len),"elapsedMs":file_started.elapsed().as_millis()})))
                                .inspect_err(|error| session_trace("runtime.team.profile.file.end", json!({"index":index,"agentHash":agent_hash,"file":file,"outcome":format!("{:?}", ReadFailure::from(*error)),"elapsedMs":file_started.elapsed().as_millis()})))
                        }
                    };
                    let (agents_file, soul_file) = tokio::try_join!(
                        read_file(AgentFileName::Agents, "AGENTS"),
                        read_file(AgentFileName::Soul, "SOUL"),
                    )
                    .map_err(|_| MemberIntroductionError::Unavailable)?;
                    Ok(MemberProfile {
                        description,
                        agents_markdown: markdown(agents_file, index, &agent_hash, "AGENTS")?,
                        soul_markdown: markdown(soul_file, index, &agent_hash, "SOUL")?,
                    })
                }
            }),
    )
    .buffered(4)
    .try_collect()
    .await;
    session_trace(
        "runtime.team.profile.end",
        json!({"outcome":if result.is_ok() {"Succeeded"} else {"Unavailable"},"elapsedMs":started.elapsed().as_millis()}),
    );
    result
}

fn description(
    document: &Value,
    agent_id: &str,
    index: usize,
) -> Result<Option<String>, MemberIntroductionError> {
    let agent_hash = identifier_hash(agent_id);
    let unavailable = |reason| {
        session_trace(
            "runtime.team.profile.description.end",
            json!({"index":index,"agentHash":agent_hash,"outcome":"Unavailable","reason":reason}),
        );
        MemberIntroductionError::Unavailable
    };
    let Some(agents) = document.get("agents") else {
        session_trace(
            "runtime.team.profile.description.end",
            json!({"index":index,"agentHash":agent_hash,"outcome":"Succeeded","reason":"agents-missing"}),
        );
        return Ok(None);
    };
    let agents = agents
        .as_object()
        .ok_or_else(|| unavailable("agents-shape"))?;
    // Same entries-first native config shape as agent_configuration; only inspect the selected description.
    let entry = if let Some(entries) = agents.get("entries") {
        entries
            .as_object()
            .ok_or_else(|| unavailable("entries-shape"))?
            .get(agent_id)
    } else if let Some(list) = agents.get("list") {
        let mut matching = list
            .as_array()
            .ok_or_else(|| unavailable("list-shape"))?
            .iter()
            .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(agent_id));
        let entry = matching.next();
        if matching.next().is_some() {
            return Err(unavailable("duplicate-entry"));
        }
        entry
    } else {
        None
    };
    let Some(entry) = entry else {
        session_trace(
            "runtime.team.profile.description.end",
            json!({"index":index,"agentHash":agent_hash,"outcome":"Succeeded","reason":"entry-missing"}),
        );
        return Ok(None);
    };
    let entry = entry
        .as_object()
        .ok_or_else(|| unavailable("entry-shape"))?;
    match entry.get("description") {
        None | Some(Value::Null) => {
            session_trace("runtime.team.profile.description.end", json!({"index":index,"agentHash":agent_hash,"outcome":"Succeeded","reason":"description-missing"}));
            Ok(None)
        }
        Some(Value::String(content)) => strip_teamrun_blocks(content)
            .inspect(|stripped| session_trace("runtime.team.profile.description.end", json!({"index":index,"agentHash":agent_hash,"outcome":"Succeeded","contentBytes":content.len(),"strippedBytes":stripped.len()})))
            .map(Some)
            .map_err(|_| unavailable("strip-error")),
        Some(_) => Err(unavailable("description-shape")),
    }
}

fn markdown(
    file: AgentFile,
    index: usize,
    agent_hash: &str,
    name: &'static str,
) -> Result<Option<String>, MemberIntroductionError> {
    if file.missing {
        return Ok(None);
    }
    let content = file.content.ok_or_else(|| {
        session_trace("runtime.team.profile.file.strip-end", json!({"index":index,"agentHash":agent_hash,"file":name,"outcome":"Unavailable","reason":"content-missing"}));
        MemberIntroductionError::Unavailable
    })?;
    strip_teamrun_blocks(&content)
        .inspect(|stripped| session_trace("runtime.team.profile.file.strip-end", json!({"index":index,"agentHash":agent_hash,"file":name,"outcome":"Succeeded","strippedBytes":stripped.len()})))
        .map(Some)
        .map_err(|_| {
            session_trace("runtime.team.profile.file.strip-end", json!({"index":index,"agentHash":agent_hash,"file":name,"outcome":"Unavailable","reason":"strip-error"}));
            MemberIntroductionError::Unavailable
        })
}
