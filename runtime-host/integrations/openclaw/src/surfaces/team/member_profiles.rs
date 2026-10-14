use std::{sync::Arc, time::Instant};

use futures_util::{StreamExt, stream};
use organization::{
    ManagedAgentReference, MemberProfile, TeamCreationFailure, TeamCreationFailureReason,
    TeamCreationFile, TeamCreationStage,
};
use platform::trace::{identifier_hash, session_trace};
use serde_json::{Value, json};

use crate::{
    agents::{AgentFile, AgentFileName, AgentsReadFailure, OpenClawAgents},
    gateway::{
        client::GatewayClient,
        wire::{self, GatewayResponse},
    },
};

use super::{buddy::strip_teamrun_blocks, provider::next_request_id};

pub(super) async fn read(
    gateway: Arc<GatewayClient>,
    requested: Vec<ManagedAgentReference>,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<Vec<MemberProfile>, TeamCreationFailure> {
    if requested.is_empty() {
        session_trace(
            "runtime.team.profile.end",
            || json!({"outcome":"Succeeded","count":0}),
        );
        return Ok(Vec::new());
    }
    let started = platform::trace::enabled().then(Instant::now);
    let agents = OpenClawAgents::new(Arc::clone(&gateway)).with_cancellation(cancellation.clone());
    session_trace(
        "runtime.team.profile.native-list.request",
        || json!({"count":requested.len()}),
    );
    let native = agents
        .list()
        .await
        .inspect(|native| session_trace("runtime.team.profile.native-list.end", || json!({"outcome":"Succeeded","count":native.agents.len(),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()})))
        .map_err(|error| {
            session_trace("runtime.team.profile.native-list.end", || json!({"outcome":format!("{error:?}"),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
            rpc_failure(error)
        })?;
    for (index, requested) in requested.iter().enumerate() {
        let agent_hash = || identifier_hash(requested.as_str());
        let mut matching = native
            .agents
            .iter()
            .filter(|agent| agent.id == requested.as_str());
        let agent = matching.next().ok_or_else(|| {
            session_trace(
                "runtime.team.profile.native-check",
                || json!({"index":index,"agentHash":agent_hash(),"exists":false}),
            );
            TeamCreationFailure {
                member_index: Some(index),
                ..failure(TeamCreationFailureReason::AgentMissing)
            }
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
            || json!({"index":index,"agentHash":agent_hash(),"exists":true,"duplicate":duplicate,"workspacePresent":workspace_present}),
        );
        if duplicate || workspace_present == Some(false) {
            return Err(TeamCreationFailure {
                member_index: Some(index),
                ..failure(if duplicate {
                    TeamCreationFailureReason::AgentDuplicate
                } else {
                    TeamCreationFailureReason::WorkspaceMissing
                })
            });
        }
    }
    session_trace("runtime.team.profile.config-get.request", || json!({}));
    let config_started = platform::trace::enabled().then(Instant::now);
    let request = wire::team::config_get_request(next_request_id("member-profiles-config"))
        .map_err(|_| {
            session_trace("runtime.team.profile.config-get.end", || json!({"reason":"request-shape","outcome":"Protocol","elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
            failure(TeamCreationFailureReason::RpcProtocol)
        })?;
    let response = gateway
        .rpc_query_cancellable(request, &cancellation)
        .await
        .map_err(|error| {
            let error = AgentsReadFailure::from(error);
            session_trace("runtime.team.profile.config-get.end", || json!({"reason":"transport","outcome":format!("{error:?}"),"elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
            rpc_failure(error)
        })?;
    let valid_shape = matches!(&response, GatewayResponse::Success { payload: Some(payload), .. }
        if payload.get("valid") == Some(&Value::Bool(true)));
    session_trace(
        "runtime.team.profile.config-get.rpc-end",
        || json!({"successValidShape":valid_shape,"outcome":if matches!(&response, GatewayResponse::Failure { .. }) {"Rejected"} else {"Succeeded"},"elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
    );
    if !valid_shape {
        session_trace(
            "runtime.team.profile.config-get.end",
            || json!({"reason":"success-validshape","outcome":"Unavailable","elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        return Err(failure(match &response {
            GatewayResponse::Failure { .. } => TeamCreationFailureReason::RpcRejected,
            GatewayResponse::Success { payload: Some(payload), .. }
                if payload.get("valid") == Some(&Value::Bool(false)) =>
            {
                TeamCreationFailureReason::InvalidConfig
            }
            _ => TeamCreationFailureReason::RpcProtocol,
        }));
    }
    let (_, document, _) = wire::team::decode_config_get(response)
        .map_err(|_| {
            session_trace("runtime.team.profile.config-get.end", || json!({"reason":"decode","outcome":"Protocol","elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
            failure(TeamCreationFailureReason::RpcProtocol)
        })?
        .into_source_and_runtime_config_parts();
    session_trace(
        "runtime.team.profile.config-get.end",
        || json!({"reason":"decode","outcome":"Succeeded","elapsedMs":config_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
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
                    let agent_hash = || identifier_hash(agent.as_str());
                    let read_file = |name, file: TeamCreationFile| {
                        let agent = &agent;
                        let agent_hash = &agent_hash;
                        async move {
                            let file_started = platform::trace::enabled().then(Instant::now);
                            session_trace("runtime.team.profile.file.request", || json!({"index":index,"agentHash":agent_hash(),"file":file}));
                            agents.files_get(agent.as_str().to_owned(), name).await
                                .inspect(|content| session_trace("runtime.team.profile.file.end", || json!({"index":index,"agentHash":agent_hash(),"file":file,"outcome":"Succeeded","missing":content.missing,"contentBytes":content.content.as_ref().map(String::len),"elapsedMs":file_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()})))
                                .map_err(|error| {
                                    session_trace("runtime.team.profile.file.end", || json!({"index":index,"agentHash":agent_hash(),"file":file,"outcome":format!("{error:?}"),"elapsedMs":file_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
                                    TeamCreationFailure {
                                        member_index: Some(index),
                                        file: Some(file),
                                        ..rpc_failure(error)
                                    }
                                })
                        }
                    };
                    let (agents_file, soul_file) = tokio::join!(
                        read_file(AgentFileName::Agents, TeamCreationFile::AgentsMarkdown),
                        read_file(AgentFileName::Soul, TeamCreationFile::SoulMarkdown),
                    );
                    Ok(MemberProfile {
                        description,
                        agents_markdown: markdown(agents_file?, index, agent.as_str(), TeamCreationFile::AgentsMarkdown)?,
                        soul_markdown: markdown(soul_file?, index, agent.as_str(), TeamCreationFile::SoulMarkdown)?,
                    })
                }
            }),
    )
    .buffered(4)
    .collect::<Vec<Result<_, TeamCreationFailure>>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>();
    session_trace(
        "runtime.team.profile.end",
        || json!({"outcome":if result.is_ok() {"Succeeded"} else {"Unavailable"},"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
    );
    result
}

fn description(
    document: &Value,
    agent_id: &str,
    index: usize,
) -> Result<Option<String>, TeamCreationFailure> {
    let agent_hash = || identifier_hash(agent_id);
    let invalid_config = |reason, member_index| {
        session_trace(
            "runtime.team.profile.description.end",
            || json!({"index":index,"agentHash":agent_hash(),"outcome":"Unavailable","reason":reason}),
        );
        TeamCreationFailure {
            member_index,
            ..failure(TeamCreationFailureReason::InvalidConfig)
        }
    };
    let Some(agents) = document.get("agents") else {
        session_trace(
            "runtime.team.profile.description.end",
            || json!({"index":index,"agentHash":agent_hash(),"outcome":"Succeeded","reason":"agents-missing"}),
        );
        return Ok(None);
    };
    let agents = agents
        .as_object()
        .ok_or_else(|| invalid_config("agents-shape", None))?;
    // Same entries-first native config shape as agent_configuration; only inspect the selected description.
    let entry = if let Some(entries) = agents.get("entries") {
        entries
            .as_object()
            .ok_or_else(|| invalid_config("entries-shape", None))?
            .get(agent_id)
    } else if let Some(list) = agents.get("list") {
        let mut matching = list
            .as_array()
            .ok_or_else(|| invalid_config("list-shape", None))?
            .iter()
            .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(agent_id));
        let entry = matching.next();
        if matching.next().is_some() {
            return Err(invalid_config("duplicate-entry", Some(index)));
        }
        entry
    } else {
        None
    };
    let Some(entry) = entry else {
        session_trace(
            "runtime.team.profile.description.end",
            || json!({"index":index,"agentHash":agent_hash(),"outcome":"Succeeded","reason":"entry-missing"}),
        );
        return Ok(None);
    };
    let entry = entry
        .as_object()
        .ok_or_else(|| invalid_config("entry-shape", Some(index)))?;
    match entry.get("description") {
        None | Some(Value::Null) => {
            session_trace("runtime.team.profile.description.end", || json!({"index":index,"agentHash":agent_hash(),"outcome":"Succeeded","reason":"description-missing"}));
            Ok(None)
        }
        Some(Value::String(content)) => strip_teamrun_blocks(content)
            .inspect(|stripped| session_trace("runtime.team.profile.description.end", || json!({"index":index,"agentHash":agent_hash(),"outcome":"Succeeded","contentBytes":content.len(),"strippedBytes":stripped.len()})))
            .map(Some)
            .map_err(|_| {
                session_trace("runtime.team.profile.description.end", || json!({"index":index,"agentHash":agent_hash(),"outcome":"Unavailable","reason":"strip-error"}));
                TeamCreationFailure {
                    member_index: Some(index),
                    file: Some(TeamCreationFile::Description),
                    ..failure(TeamCreationFailureReason::InvalidTeamRunBlocks)
                }
            }),
        Some(_) => {
            session_trace("runtime.team.profile.description.end", || json!({"index":index,"agentHash":agent_hash(),"outcome":"Unavailable","reason":"description-shape"}));
            Err(TeamCreationFailure {
                member_index: Some(index),
                file: Some(TeamCreationFile::Description),
                ..failure(TeamCreationFailureReason::InvalidDescription)
            })
        }
    }
}

fn markdown(
    file: AgentFile,
    index: usize,
    agent_id: &str,
    name: TeamCreationFile,
) -> Result<Option<String>, TeamCreationFailure> {
    if file.missing {
        return Ok(None);
    }
    let content = file.content.ok_or_else(|| {
        session_trace("runtime.team.profile.file.strip-end", || json!({"index":index,"agentHash":identifier_hash(agent_id),"file":name,"outcome":"Unavailable","reason":"content-missing"}));
        TeamCreationFailure {
            member_index: Some(index),
            file: Some(name),
            ..failure(TeamCreationFailureReason::InvalidContent)
        }
    })?;
    strip_teamrun_blocks(&content)
        .inspect(|stripped| session_trace("runtime.team.profile.file.strip-end", || json!({"index":index,"agentHash":identifier_hash(agent_id),"file":name,"outcome":"Succeeded","strippedBytes":stripped.len()})))
        .map(Some)
        .map_err(|_| {
            session_trace("runtime.team.profile.file.strip-end", || json!({"index":index,"agentHash":identifier_hash(agent_id),"file":name,"outcome":"Unavailable","reason":"strip-error"}));
            TeamCreationFailure {
                member_index: Some(index),
                file: Some(name),
                ..failure(TeamCreationFailureReason::InvalidTeamRunBlocks)
            }
        })
}

fn failure(reason: TeamCreationFailureReason) -> TeamCreationFailure {
    TeamCreationFailure::new(TeamCreationStage::ReadingProfiles, reason)
}

fn rpc_failure(error: AgentsReadFailure) -> TeamCreationFailure {
    failure(match error {
        AgentsReadFailure::Unavailable => TeamCreationFailureReason::RpcUnavailable,
        AgentsReadFailure::Rejected => TeamCreationFailureReason::RpcRejected,
        AgentsReadFailure::Protocol => TeamCreationFailureReason::RpcProtocol,
        AgentsReadFailure::Deadline => TeamCreationFailureReason::RpcDeadline,
        AgentsReadFailure::Authentication => TeamCreationFailureReason::RpcAuthentication,
    })
}
