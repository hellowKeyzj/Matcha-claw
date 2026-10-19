use std::{
    fmt,
    time::{Duration, Instant},
};

use foundation::process::supervision::SupervisorPhase;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    gateway::{
        client::GatewayControlReadiness,
        delivery::MutationDelivery,
        operation::next_request_id,
        wire::{self, GatewayResponse},
    },
    native_config::{
        config_store::{OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore},
        search as projection,
    },
};

use super::OpenClawDriver;

#[derive(Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub base_url: String,
    pub categories: String,
    pub language: String,
    pub engines: Option<String>,
    pub safe_search: u8,
    pub result_count: u8,
    pub revision: String,
}

impl fmt::Debug for SearchConfig {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("SearchConfig([REDACTED])")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub count: Option<u8>,
    pub categories: Option<String>,
    pub engines: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchPhase {
    Disabled,
    NotConfigured,
    PendingRestart,
    Ready,
}

#[derive(Clone, Debug)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Clone, Debug)]
pub struct SearchVerification {
    pub results: Vec<SearchHit>,
    pub unresponsive_engines: Value,
    pub elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchError {
    InvalidInput,
    Config,
    PolicyDenied,
    Unavailable,
    Unsupported,
    InvocationFailed,
    Protocol,
}

impl fmt::Display for SearchError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::InvalidInput => "OpenClaw search input is invalid",
            Self::Config => "OpenClaw search configuration could not be applied",
            Self::PolicyDenied => "OpenClaw native policy blocks search",
            Self::Unavailable => "OpenClaw gateway is unavailable",
            Self::Unsupported => "OpenClaw native search operation is unsupported",
            Self::InvocationFailed => "OpenClaw native search invocation failed",
            Self::Protocol => "OpenClaw native search response is invalid",
        })
    }
}
impl std::error::Error for SearchError {}

impl OpenClawDriver {
    pub async fn apply_search(
        &self,
        config: Option<&SearchConfig>,
        authorize: bool,
    ) -> Result<SearchPhase, SearchError> {
        if let Some(config) = config {
            projection::validate(config)?;
        }
        let client = self.gateway.client();
        let _transaction = client.config_transaction().await;
        if config.is_some() {
            let reconciled = self
                .plugins()
                .reconcile_enabled_managed_plugins(&["searxng".into()])
                .map_err(|_| SearchError::Config)?;
            if !reconciled
                .installed_ids
                .iter()
                .chain(&reconciled.updated_ids)
                .chain(&reconciled.unchanged_ids)
                .any(|id| id == "searxng")
            {
                return Err(SearchError::Config);
            }
            projection::link_plugin(&self.state_dir, &self.openclaw_dir)?;
            self.plugins()
                .reconcile_installed_records()
                .map_err(|_| SearchError::Config)?;
        }
        if client.control_readiness_snapshot().await != GatewayControlReadiness::Ready {
            let store = OpenClawConfigStore::new(self.state_dir.clone());
            let mut failure = None;
            store
                .update_private_document(|document| {
                    match projection::apply(&self.state_dir, document, config, authorize) {
                        Ok(true) => OpenClawConfigMutation::changed(),
                        Ok(false) => OpenClawConfigMutation::unchanged(),
                        Err(error) => {
                            failure = Some(error);
                            OpenClawConfigMutation::unchanged()
                        }
                    }
                })
                .map_err(|_| SearchError::Config)?;
            if let Some(error) = failure {
                return Err(error);
            }
            return Ok(
                if config.is_some()
                    || matches!(
                        self.supervisor_handle().snapshot().phase(),
                        SupervisorPhase::Starting
                            | SupervisorPhase::Running
                            | SupervisorPhase::Stopping
                    )
                {
                    SearchPhase::PendingRestart
                } else {
                    SearchPhase::Disabled
                },
            );
        }
        let get = wire::team::config_get_request(next_request_id("search-config-get"))
            .map_err(|_| SearchError::Protocol)?;
        let snapshot = wire::team::decode_config_get(
            client
                .rpc_query(get)
                .await
                .map_err(|_| SearchError::Unavailable)?,
        )
        .map_err(|_| SearchError::Protocol)?;
        let (source, hash) = snapshot.into_source_config_parts();
        let mut document =
            OpenClawConfigDocument::from_value(source.clone()).map_err(|_| SearchError::Config)?;
        let changed = projection::apply(&self.state_dir, &mut document, config, authorize)?;
        if changed {
            let target = document.as_value();
            let patch = crate::gateway::config_patch::merge_patch(&source, &target);
            let replace_paths =
                crate::gateway::config_patch::destructive_array_replace_paths(&source, &target);
            let raw = wire::team::ConfigDocument::new(
                serde_json::to_string(&patch).map_err(|_| SearchError::Config)?,
            )
            .map_err(|_| SearchError::Config)?;
            let request = wire::team::config_patch_request(
                next_request_id("search-config-patch"),
                raw,
                hash,
                replace_paths,
            )
            .map_err(|_| SearchError::Config)?;
            match client
                .rpc_encoded_mutation(
                    request.request_id().to_owned(),
                    request.encode().map_err(|_| SearchError::Config)?,
                )
                .await
            {
                MutationDelivery::Response(GatewayResponse::Failure { error, .. })
                    if wire::channel::is_config_restart_required(&error) =>
                {
                    return Ok(SearchPhase::PendingRestart);
                }
                MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                    return Err(SearchError::Config);
                }
                MutationDelivery::Response(response) => {
                    match wire::channel::decode_channel_config_patch(response) {
                        Ok(wire::channel::ChannelConfigPatchOutcome::RestartRequired) => {
                            return Ok(SearchPhase::PendingRestart);
                        }
                        Ok(_) => {}
                        Err(_) => return Err(SearchError::Protocol),
                    }
                }
                MutationDelivery::NotWritten(_) => {
                    return Err(SearchError::Config);
                }
                MutationDelivery::MayHaveReached(_) => return Ok(SearchPhase::PendingRestart),
            }
        }
        self.observe_search().await
    }

    pub async fn observe_search(&self) -> Result<SearchPhase, SearchError> {
        let document = OpenClawConfigStore::new(self.state_dir.clone())
            .read_private()
            .map_err(|_| SearchError::Config)?;
        let local = document.as_value();
        let selected = local
            .pointer("/tools/web/search/provider")
            .and_then(Value::as_str)
            == Some("searxng");
        if selected {
            projection::check_policy(&local)?;
        }
        let revision = local
            .pointer("/plugins/entries/searxng/config/webSearch/revision")
            .and_then(Value::as_str);
        if selected && revision.is_none() {
            return Ok(SearchPhase::NotConfigured);
        }
        let client = self.gateway.client();
        if client.control_readiness_snapshot().await != GatewayControlReadiness::Ready {
            return Ok(
                if selected
                    || matches!(
                        self.supervisor_handle().snapshot().phase(),
                        SupervisorPhase::Starting
                            | SupervisorPhase::Running
                            | SupervisorPhase::Stopping
                    )
                {
                    SearchPhase::PendingRestart
                } else {
                    SearchPhase::Disabled
                },
            );
        }
        let response = client
            .rpc_query(wire::search::status_request(next_request_id(
                "search-status",
            ))?)
            .await
            .map_err(|_| SearchError::Unavailable)?;
        let payload = wire::search::payload(response)?;
        if !selected {
            return Ok(
                if payload
                    .get("selectedProvider")
                    .and_then(Value::as_str)
                    .is_some_and(|provider| provider != "searxng")
                    && payload.get("loaded").and_then(Value::as_bool) == Some(false)
                {
                    SearchPhase::Disabled
                } else {
                    SearchPhase::PendingRestart
                },
            );
        }
        if payload.get("policyBlocked").and_then(Value::as_bool) == Some(true) {
            return Err(SearchError::PolicyDenied);
        }
        Ok(
            if payload.get("selectedProvider").and_then(Value::as_str) == Some("searxng")
                && payload.get("revision").and_then(Value::as_str) == revision
                && payload.get("loaded").and_then(Value::as_bool) == Some(true)
                && payload.get("configured").and_then(Value::as_bool) == Some(true)
            {
                SearchPhase::Ready
            } else {
                SearchPhase::PendingRestart
            },
        )
    }

    pub async fn verify_search(
        &self,
        request: &SearchRequest,
    ) -> Result<SearchVerification, SearchError> {
        if request.query.trim().is_empty()
            || request.query.len() > 4096
            || request
                .query
                .split_whitespace()
                .any(|token| token.starts_with(['!', ':', '<']))
            || request.count.is_some_and(|n| !(1..=10).contains(&n))
            || request.safe_search.is_some_and(|n| n > 2)
            || [&request.categories, &request.engines]
                .into_iter()
                .flatten()
                .any(|value| {
                    value.len() > 4096 || value.split(',').any(|name| name.trim().is_empty())
                })
            || request
                .language
                .as_ref()
                .is_some_and(|value| value.len() > 128 || value.trim().is_empty())
        {
            return Err(SearchError::InvalidInput);
        }
        if self.observe_search().await? != SearchPhase::Ready {
            return Err(SearchError::Unavailable);
        }
        let mut args = json!({"query": request.query});
        for (key, value) in [
            ("categories", &request.categories),
            ("engines", &request.engines),
            ("language", &request.language),
        ] {
            if let Some(value) = value {
                args[key] = Value::String(value.clone());
            }
        }
        if let Some(value) = request.count {
            args["count"] = json!(value);
        }
        if let Some(value) = request.safe_search {
            args["safesearch"] = json!(value);
        }
        let client = self.gateway.client();
        let started = Instant::now();
        let response = client
            .rpc_query_with_deadline(
                wire::search::invoke_request(next_request_id("search-verify"), args)?,
                Duration::from_secs(150),
            )
            .await
            .map_err(|_| SearchError::Unavailable)?;
        let payload = wire::search::payload(response)?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(
                match payload.pointer("/error/code").and_then(Value::as_str) {
                    Some("forbidden" | "requires_approval" | "not_found") => {
                        SearchError::PolicyDenied
                    }
                    Some("validation_error") => SearchError::InvalidInput,
                    _ => SearchError::InvocationFailed,
                },
            );
        }
        let output = payload.get("output").ok_or(SearchError::Protocol)?;
        let data = output
            .get("details")
            .cloned()
            .or_else(|| {
                output.get("content")?.as_array()?.iter().find_map(|part| {
                    serde_json::from_str::<Value>(part.get("text")?.as_str()?).ok()
                })
            })
            .ok_or(SearchError::Protocol)?;
        if data.get("provider").and_then(Value::as_str) != Some("searxng")
            || data.get("kind").and_then(Value::as_str) != Some("results")
        {
            return Err(SearchError::InvocationFailed);
        }
        let results = data
            .get("results")
            .and_then(Value::as_array)
            .ok_or(SearchError::Protocol)?
            .iter()
            .map(|hit| {
                Ok(SearchHit {
                    title: hit
                        .get("title")
                        .and_then(Value::as_str)
                        .ok_or(SearchError::Protocol)?
                        .into(),
                    url: hit
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or(SearchError::Protocol)?
                        .into(),
                    snippet: hit
                        .get("snippet")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                })
            })
            .collect::<Result<_, SearchError>>()?;
        Ok(SearchVerification {
            results,
            unresponsive_engines: data
                .get("unresponsiveEngines")
                .cloned()
                .unwrap_or(Value::Null),
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        })
    }
}
