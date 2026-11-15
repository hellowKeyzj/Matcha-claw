use super::{Cli, Instance};
use crate::{config::ConfigStore, rpc, search::Projection};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Default)]
pub(super) struct State {
    // Instance-scoped flag values, not a second durable settings store.
    original: Option<Value>,
    unresolved: Option<rpc::Error>,
}

impl Cli {
    pub(crate) async fn apply_search(&self, projection: Option<&Projection>) -> rpc::Result<bool> {
        self.initialized().await?;
        self.0.instance.apply_search(projection).await
    }

    pub(crate) async fn reconcile_search(&self, config: &ConfigStore) -> rpc::Result<bool> {
        let cli = self.clone();
        let config = config.clone();
        tokio::spawn(async move {
            cli.initialized().await?;
            let instance = &cli.0.instance;
            let mut state = instance.search.lock().await;
            // Snapshot after instance serialization: an old project may not overwrite a newer one.
            let projection = config.checked_snapshot().await?.search;
            instance
                .apply_search_locked(&mut state, projection.as_ref())
                .await
        })
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32006,
                "search_reload_unknown",
                "Native search reload could not be confirmed",
            )
            .with_source(error)
        })?
    }

    pub(crate) async fn observe_search(
        &self,
        projection: Option<&Projection>,
    ) -> rpc::Result<bool> {
        self.initialized().await?;
        let state = self.0.instance.search.lock().await;
        if let Some(error) = &state.unresolved {
            return Err(error.clone());
        }
        if projection.is_none() {
            return Ok(state.original.is_none());
        }
        let observed = self.0.instance.search_settings().await?;
        Ok(matches_projection(
            &observed,
            projection.expect("search projection"),
        ))
    }
}

impl Instance {
    pub(super) async fn apply_search(&self, projection: Option<&Projection>) -> rpc::Result<bool> {
        let mut state = self.search.lock().await;
        self.apply_search_locked(&mut state, projection).await
    }

    async fn apply_search_locked(
        &self,
        state: &mut State,
        projection: Option<&Projection>,
    ) -> rpc::Result<bool> {
        if let Some(error) = &state.unresolved {
            return Err(error.clone());
        }
        if projection.is_none() && state.original.is_none() {
            return Ok(true);
        }
        let observed = self.search_settings().await?;
        if let Some(projection) = projection {
            if state.original.is_none() {
                state.original = Some(flag_settings(&observed)?);
            }
            if matches_projection(&observed, projection) {
                return Ok(true);
            }
        }
        let settings = match projection {
            Some(projection) => projection.settings(),
            None => state
                .original
                .clone()
                .expect("original search flag settings"),
        };
        if let Err(error) = self
            .search_request(json!({ "subtype": "apply_flag_settings", "settings": settings }))
            .await
        {
            if error.code == -32006 {
                // Pending native writes keep their lease after timeout; never race a new projection with them.
                state.unresolved = Some(error.clone());
            }
            return Err(error);
        }
        let observed = self.search_settings().await?;
        match projection {
            Some(projection) => Ok(matches_projection(&observed, projection)),
            None => {
                let restored = flag_settings(&observed)?
                    == state
                        .original
                        .clone()
                        .expect("original search flag settings");
                if restored {
                    state.original = None;
                }
                Ok(restored)
            }
        }
    }

    async fn search_settings(&self) -> rpc::Result<Value> {
        let observed = self
            .search_request(json!({ "subtype": "get_settings" }))
            .await?;
        if !observed.get("effective").is_some_and(Value::is_object)
            || !observed.get("sources").is_some_and(Value::is_array)
            || !observed
                .pointer("/applied/webSearchAdapter")
                .is_some_and(Value::is_string)
        {
            return Err(rpc::Error::new(
                -32004,
                "search_native_readback",
                "The native search settings response is invalid",
            ));
        }
        Ok(observed)
    }

    async fn search_request(&self, request: Value) -> rpc::Result<Value> {
        tokio::time::timeout(Duration::from_secs(5), self.request(request))
            .await
            .map_err(|_| {
                rpc::Error::new(
                    -32006,
                    "search_reload_timeout",
                    "Native search reload was not confirmed; close and resume this session",
                )
            })?
    }
}

fn matches_projection(observed: &Value, projection: &Projection) -> bool {
    observed
        .pointer("/applied/webSearchAdapter")
        .and_then(Value::as_str)
        == Some("searxng")
        && observed
            .pointer("/effective/webSearchAdapter")
            .and_then(Value::as_str)
            == Some("searxng")
        && observed.pointer("/effective/searxng") == Some(&json!(projection))
}

fn flag_settings(observed: &Value) -> rpc::Result<Value> {
    let sources = observed["sources"]
        .as_array()
        .ok_or_else(|| rpc::Error::internal("search_native_sources"))?;
    let flag = sources
        .iter()
        .find(|source| source["source"] == "flagSettings");
    if flag.is_some_and(|source| !source["settings"].is_object()) {
        return Err(rpc::Error::new(
            -32004,
            "search_native_sources",
            "The native flag settings response is invalid",
        ));
    }
    Ok(json!({
        "webSearchAdapter": flag.and_then(|source| source["settings"].get("webSearchAdapter")),
        "searxng": flag.and_then(|source| source["settings"].get("searxng")),
    }))
}
