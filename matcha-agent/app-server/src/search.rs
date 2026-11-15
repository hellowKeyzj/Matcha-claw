use crate::{config::ConfigStore, rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projection {
    pub base_url: String,
    pub categories: String,
    pub language: String,
    pub safe_search: u8,
    pub result_count: u8,
    pub revision: String,
}

impl Projection {
    pub fn validate(&self) -> rpc::Result<()> {
        let url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| rpc::Error::invalid("Search baseUrl must be an HTTP(S) base URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self
                .categories
                .split(',')
                .any(|category| category.trim().is_empty())
            || self.language.trim().is_empty()
            || self.safe_search > 2
            || !(1..=10).contains(&self.result_count)
            || self.revision.trim().is_empty()
        {
            return Err(rpc::Error::invalid(
                "Search projection contains invalid settings",
            ));
        }
        Ok(())
    }

    pub(crate) fn settings(&self) -> Value {
        json!({ "webSearchAdapter": "searxng", "searxng": self })
    }
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    match method {
        "search.project" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Params {
                projection: Option<Projection>,
            }
            if params.get("projection").is_none() {
                return Err(rpc::Error::invalid(
                    "search.project requires projection or null",
                ));
            }
            let Params { projection } = rpc::params(params)?;
            if let Some(projection) = &projection {
                projection.validate()?;
            }
            let guard = sessions.search_guard().await;
            if config.checked_snapshot().await?.search != projection {
                config
                    .update(|config| {
                        config.search = projection.clone();
                        Ok(())
                    })
                    .await?;
            }
            let instances = sessions.search_instances().await;
            drop(guard);
            observation(projection.as_ref(), config, sessions, instances, true).await
        }
        "search.observe" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Params {}
            let _: Params = rpc::params(params)?;
            let guard = sessions.search_guard().await;
            let projection = config.checked_snapshot().await?.search;
            let instances = sessions.search_instances().await;
            drop(guard);
            observation(projection.as_ref(), config, sessions, instances, false).await
        }
        _ => Err(rpc::Error::method(method)),
    }
}

async fn observation(
    projection: Option<&Projection>,
    config: &ConfigStore,
    sessions: &Sessions,
    (instances, transitioning): (Vec<crate::cli::Cli>, bool),
    apply: bool,
) -> rpc::Result {
    let count = instances.len();
    let identities: std::collections::BTreeSet<_> = instances
        .iter()
        .map(|instance| instance.instance_id().to_owned())
        .collect();
    let mut pending = transitioning || (projection.is_some() && count == 0);
    let mut checks = tokio::task::JoinSet::new();
    for instance in instances {
        let projection = projection.cloned();
        let config = config.clone();
        checks.spawn(async move {
            if apply {
                instance.reconcile_search(&config).await
            } else {
                instance.observe_search(projection.as_ref()).await
            }
        });
    }
    while let Some(result) = checks.join_next().await {
        if !matches!(result, Ok(Ok(true))) {
            pending = true;
        }
    }
    let _guard = sessions.search_guard().await;
    let (current, current_transitioning) = sessions.search_instances().await;
    pending |= config.checked_snapshot().await?.search.as_ref() != projection
        || current_transitioning
        || current.iter().map(|instance| instance.instance_id().to_owned())
            .collect::<std::collections::BTreeSet<_>>() != identities;
    Ok(json!({
        "phase": if pending { "pendingRestart" }
            else if projection.is_some() { "ready" } else { "disabled" },
        "configured": projection,
        "liveInstances": count,
        "action": if pending {
            Some("Start or resume a native session; if a live session still differs, close and resume it, then observe search again")
        } else { None },
    }))
}

/// Called only by the native offline command, under the same ConfigStore home lock.
pub async fn disable_offline(config: &ConfigStore) -> rpc::Result {
    if config.checked_snapshot().await?.search.is_some() {
        config
            .update(|config| {
                config.search = None;
                Ok(())
            })
            .await?;
    }
    Ok(json!({ "phase": "disabled", "configured": null }))
}
