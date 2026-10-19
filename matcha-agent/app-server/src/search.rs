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
    let _guard = sessions.search_guard().await;
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
            if config.checked_snapshot().await?.search != projection {
                config
                    .update(|config| {
                        config.search = projection.clone();
                        Ok(())
                    })
                    .await?;
            }
            observation(projection.as_ref(), sessions, true).await
        }
        "search.observe" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Params {}
            let _: Params = rpc::params(params)?;
            let projection = config.checked_snapshot().await?.search;
            observation(projection.as_ref(), sessions, false).await
        }
        _ => Err(rpc::Error::method(method)),
    }
}

async fn observation(
    projection: Option<&Projection>,
    sessions: &Sessions,
    apply: bool,
) -> rpc::Result {
    let (instances, transitioning) = sessions.search_instances().await;
    let count = instances.len();
    let mut pending = transitioning || (projection.is_some() && count == 0);
    let mut checks = tokio::task::JoinSet::new();
    for instance in instances {
        let projection = projection.cloned();
        checks.spawn(async move {
            if apply {
                instance.apply_search(projection.as_ref()).await
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
