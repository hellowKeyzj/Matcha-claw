mod anytxt;
mod web;

use std::time::Duration;

use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::WikiFailure;
use crate::search_config::{
    AnyTxtConfig, SearchConfig, SearchConfigUpdate, SearchCredentials, apply_search_test_input,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSource {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProviderTest {
    pub config: SearchConfigUpdate,
    #[serde(default = "default_test_query")]
    pub query: String,
    #[serde(default = "default_test_limit")]
    pub max_results: usize,
}

fn default_test_query() -> String {
    "wikipedia".into()
}
fn default_test_limit() -> usize {
    1
}

#[derive(Clone)]
pub struct ExternalSearch {
    client: Client,
}

impl ExternalSearch {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn test_provider(
        &self,
        input: SearchProviderTest,
        config: &SearchConfig,
        credentials: &SearchCredentials,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ResearchSource>, WikiFailure> {
        let (config, credentials) = apply_search_test_input(config, credentials, input.config)?;
        let query = if input.query.trim().is_empty() {
            "wikipedia"
        } else {
            &input.query
        };
        self.web_search(
            query,
            &config,
            &credentials,
            input.max_results,
            cancellation,
        )
        .await
    }

    pub async fn web_search(
        &self,
        query: &str,
        config: &SearchConfig,
        credentials: &SearchCredentials,
        max_results: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ResearchSource>, WikiFailure> {
        web::search(
            &self.client,
            query,
            config,
            credentials,
            max_results,
            cancellation,
        )
        .await
    }

    pub async fn anytxt_search(
        &self,
        query: &str,
        config: &AnyTxtConfig,
        max_results: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ResearchSource>, WikiFailure> {
        anytxt::search(&self.client, query, config, max_results, cancellation).await
    }
}

async fn request_json(
    request: RequestBuilder,
    operation: &str,
    cancellation: &CancellationToken,
) -> Result<Value, WikiFailure> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WikiFailure::cancelled()),
        result = async {
            let mut response = request.timeout(Duration::from_secs(30)).send().await.map_err(|error| network_failure(operation, &error))?;
            let status = response.status();
            if !status.is_success() {
                let action = match status.as_u16() {
                    401 | 403 => "check the provider API key or instance access",
                    429 => "provider rate limit reached; retry later",
                    _ => "check provider availability and configuration",
                };
                return Err(WikiFailure::state(format!("{operation} HTTP {}: {action}", status.as_u16())));
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| network_failure(operation, &error))? {
                if body.len().saturating_add(chunk.len()) > 4 * 1024 * 1024 {
                    return Err(WikiFailure::state(format!("{operation} response exceeds 4 MiB")));
                }
                body.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&body).map_err(|_| WikiFailure::state(format!("{operation} returned invalid JSON")))
        } => result,
    }
}

fn network_failure(operation: &str, error: &reqwest::Error) -> WikiFailure {
    let reason = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "could not connect; check the service and proxy settings"
    } else {
        "request failed; check the endpoint and network settings"
    };
    WikiFailure::state(format!("{operation} {reason}"))
}

fn trim_text(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{text}...")
    } else {
        text
    }
}
