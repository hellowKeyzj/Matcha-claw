use super::ProviderConfig;
use crate::{
    config::{Config, ConfigStore, validate_id},
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Private control-plane values. Config serialization deliberately skips this field.
#[derive(Clone, Default)]
pub struct PrivateProjection(BTreeMap<String, String>);

impl PrivateProjection {
    pub fn from_sources(sources: BTreeMap<String, String>) -> rpc::Result<Self> {
        let mut values = BTreeMap::new();
        for (name, value) in sources {
            if !super::config::environment_name(&name)
                || value.trim().is_empty()
                || value.contains('\0')
            {
                return Err(rpc::Error::invalid(
                    "Private sources require environment names and nonempty native values",
                ));
            }
            if values.insert(environment_name(&name), value).is_some() {
                return Err(rpc::Error::invalid(
                    "Private sources contain case-equivalent names",
                ));
            }
        }
        Ok(Self(values))
    }

    pub fn source(&self, name: &str) -> Option<&str> {
        self.0.get(&environment_name(name)).map(String::as_str)
    }

    pub fn source_names(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }
}

pub(crate) fn environment_name(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_owned()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    providers: BTreeMap<String, Value>,
    private_sources: BTreeMap<String, String>,
    #[serde(default)]
    retired_provider_ids: BTreeSet<String>,
}

pub(super) async fn project(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    let input: Project = rpc::params(params)?;
    let providers = input
        .providers
        .into_iter()
        .map(|(id, value)| {
            validate_id(&id)?;
            if !id.starts_with("host-account-") && !id.starts_with("host-session-") {
                return Err(rpc::Error::invalid(
                    "Private provider projection requires a Host-owned provider ID",
                ));
            }
            Ok((id, ProviderConfig::parse(&value)?))
        })
        .collect::<rpc::Result<BTreeMap<_, _>>>()?;
    for id in &input.retired_provider_ids {
        validate_id(id)?;
        if !id.starts_with("host-account-") || providers.contains_key(id) {
            return Err(rpc::Error::invalid(
                "Retirement must name a distinct Host account provider",
            ));
        }
    }
    let private_sources = PrivateProjection::from_sources(input.private_sources)?.0;
    let referenced = providers
        .values()
        .flat_map(|provider| provider.env.values())
        .map(|source| environment_name(source))
        .collect::<BTreeSet<_>>();
    if referenced != private_sources.keys().cloned().collect() {
        return Err(rpc::Error::invalid(
            "Private projection must supply exactly its configured source references",
        ));
    }
    let provider_ids = providers.keys().cloned().collect::<BTreeSet<_>>();
    let guarded_agents = config
        .snapshot()
        .await
        .agents
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    // Infrequent control-plane writes share Agent admission with binding changes and CLI startup.
    let mut guards = Vec::new();
    for id in &guarded_agents {
        guards.push(sessions.agent_guard(id).await);
    }
    let (session_affected, session_active) = sessions.provider_agents(&provider_ids).await?;
    let mut live_session_providers = BTreeSet::new();
    for id in provider_ids
        .iter()
        .filter(|id| id.starts_with("host-session-"))
    {
        let active = sessions
            .provider_agents(&BTreeSet::from([id.clone()]))
            .await?
            .1;
        if !active.is_empty() {
            live_session_providers.insert(id.clone());
        }
    }
    let mut session_blocked = BTreeSet::new();
    for id in &input.retired_provider_ids {
        if !sessions
            .provider_agents(&BTreeSet::from([id.clone()]))
            .await?
            .0
            .is_empty()
        {
            session_blocked.insert(id.clone());
        }
    }
    let expected_sources = private_sources.clone();
    let readback_ids = provider_ids
        .union(&input.retired_provider_ids)
        .cloned()
        .collect::<BTreeSet<_>>();
    let (changed, mut affected, cleanup_removed, cleanup_blocked) = config
        .update(move |config| {
            if config.agents.keys().any(|id| !guarded_agents.contains(id)) {
                return Err(rpc::Error::conflict(
                    "provider_agent_set_changed",
                    "Agent definitions changed during provider projection",
                ));
            }
            let token = config.auth_token_env.as_deref().map(environment_name);
            if private_sources
                .keys()
                .any(|source| Some(source) == token.as_ref())
            {
                return Err(rpc::Error::invalid(
                    "The server authentication source cannot be used by providers",
                ));
            }
            let affected = config
                .agents
                .iter()
                .filter(|(_, agent)| {
                    agent.provider.as_ref().is_some_and(|id| {
                        providers.contains_key(id) || input.retired_provider_ids.contains(id)
                    })
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut cleanup_blocked = session_blocked;
            cleanup_blocked.extend(
                config
                    .agents
                    .values()
                    .filter_map(|agent| agent.provider.as_ref())
                    .filter(|id| input.retired_provider_ids.contains(*id))
                    .cloned(),
            );
            let mut cleanup_removed = Vec::new();
            let mut changed = false;
            for id in &live_session_providers {
                let provider = &providers[id];
                let stored = rpc::value(provider)?;
                if config.providers.get(id) != Some(&stored)
                    || provider.env.values().any(|source| {
                        config.private_provider_env.source(source)
                            != private_sources
                                .get(&environment_name(source))
                                .map(String::as_str)
                    })
                {
                    return Err(rpc::Error::conflict(
                        "session_provider_requires_restart",
                        "Close the CLI instance before changing this session Provider projection",
                    )
                    .with_data(json!({"requiresRestart": true, "nativeRequestSent": false})));
                }
            }
            // A source may only update the providers in this transaction, never another Agent's alias.
            for (id, value) in &config.providers {
                if providers.contains_key(id)
                    || (input.retired_provider_ids.contains(id) && !cleanup_blocked.contains(id))
                {
                    continue;
                }
                let provider = ProviderConfig::parse(value)?;
                if provider.env.values().any(|source| {
                    private_sources
                        .get(&environment_name(source))
                        .is_some_and(|value| {
                            config.private_provider_env.source(source) != Some(value.as_str())
                        })
                }) {
                    return Err(rpc::Error::conflict(
                        "provider_source_in_use",
                        "A private source belongs to another provider",
                    ));
                }
            }
            for id in &input.retired_provider_ids {
                if cleanup_blocked.contains(id) {
                    continue;
                }
                changed |= config.providers.remove(id).is_some();
                cleanup_removed.push(id.clone());
            }
            for (id, provider) in &providers {
                let value = rpc::value(provider)?;
                changed |= config.providers.get(id) != Some(&value);
                config.providers.insert(id.clone(), value);
            }
            for (source, value) in private_sources {
                changed |= config.private_provider_env.0.get(&source) != Some(&value);
                config.private_provider_env.0.insert(source, value);
            }
            let referenced = config
                .providers
                .values()
                .map(ProviderConfig::parse)
                .collect::<rpc::Result<Vec<_>>>()?
                .iter()
                .flat_map(|provider| provider.env.values().map(|source| environment_name(source)))
                .collect::<BTreeSet<_>>();
            let before = config.private_provider_env.0.len();
            config
                .private_provider_env
                .0
                .retain(|name, _| referenced.contains(name));
            changed |= before != config.private_provider_env.0.len();
            Ok((
                changed,
                affected,
                cleanup_removed,
                cleanup_blocked.into_iter().collect::<Vec<_>>(),
            ))
        })
        .await?;
    let snapshot = config.snapshot().await;
    affected.extend(session_affected);
    affected.sort();
    affected.dedup();
    let mut active = session_active;
    active.sort();
    active.dedup();
    let readback = snapshot
        .providers
        .iter()
        .filter(|(id, _)| readback_ids.contains(*id))
        .map(|(id, value)| (id.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let private_sources_ready = expected_sources.iter().all(|(source, value)| {
        snapshot.private_provider_env.source(source) == Some(value.as_str())
    });
    Ok(json!({
        "providers": readback, "changed": changed, "application": "futureCliInstances",
        "requiresRestart": !active.is_empty(), "affectedAgentIds": affected, "activeAgentIds": active,
        "privateSourcesReady": private_sources_ready, "credentialValidation": "notPerformed",
        "cleanup": {"removedProviderIds": cleanup_removed, "blockedProviderIds": cleanup_blocked},
    }))
}

pub(crate) fn configured_sources(config: &Config) -> rpc::Result<BTreeSet<String>> {
    let mut sources = config
        .cli
        .env
        .values()
        .map(|source| environment_name(source))
        .collect::<BTreeSet<_>>();
    for value in config.providers.values() {
        sources.extend(
            ProviderConfig::parse(value)?
                .env
                .values()
                .map(|source| environment_name(source)),
        );
    }
    if let Some(token) = &config.auth_token_env {
        sources.insert(environment_name(token));
    }
    Ok(sources)
}
