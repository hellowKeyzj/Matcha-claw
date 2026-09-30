use reqwest::{Client, Url};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::WikiFailure;
use crate::search_config::{SearchConfig, SearchCredentials, SearchProvider, SearchProviderConfig};

use super::{ResearchSource, request_json};

pub(super) async fn search(
    client: &Client,
    query: &str,
    config: &SearchConfig,
    credentials: &SearchCredentials,
    requested: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<ResearchSource>, WikiFailure> {
    let query = query.trim();
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let provider = config.provider;
    if provider == SearchProvider::None {
        return Err(WikiFailure::invalid_input(
            "provider",
            "select a web search provider in Wiki settings",
        ));
    }
    let max_results = requested.clamp(
        1,
        if provider == SearchProvider::Bocha {
            50
        } else {
            20
        },
    );
    let default = SearchProviderConfig::default();
    let active = config.provider_configs.get(&provider).unwrap_or(&default);
    let key = credentials.api_key(provider).trim();
    if !matches!(
        provider,
        SearchProvider::Searxng | SearchProvider::Firecrawl
    ) && key.is_empty()
    {
        return Err(WikiFailure::invalid_input(
            "apiKey",
            "add an API key for the selected search provider in Wiki settings",
        ));
    }
    let operation = match provider {
        SearchProvider::Tavily => "Tavily search",
        SearchProvider::Serpapi => "SerpApi search",
        SearchProvider::Searxng => "SearXNG search",
        SearchProvider::Ollama => "Ollama web search",
        SearchProvider::Brave => "Brave search",
        SearchProvider::Bocha => "Bocha search",
        SearchProvider::Firecrawl => "Firecrawl search",
        SearchProvider::None => unreachable!(),
    };
    let request = match provider {
        SearchProvider::Tavily => client.post("https://api.tavily.com/search").json(&json!({
            "api_key": key, "query": query, "max_results": max_results,
            "search_depth": "advanced", "include_answer": false,
        })),
        SearchProvider::Serpapi => client.get("https://serpapi.com/search").query(&[
            (
                "engine",
                active.serp_api_engine.as_deref().unwrap_or("google"),
            ),
            ("q", query),
            ("api_key", key),
            ("num", &max_results.to_string()),
        ]),
        SearchProvider::Searxng => {
            let raw = active
                .sear_xng_url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    WikiFailure::invalid_input(
                        "searXngUrl",
                        "add a SearXNG instance URL in Wiki settings",
                    )
                })?;
            let url = endpoint(raw, "search", "https")?;
            let categories = active
                .sear_xng_categories
                .as_ref()
                .map(|values| values.join(","))
                .unwrap_or_else(|| "general".into());
            client.get(url).query(&[
                ("q", query),
                ("format", "json"),
                ("categories", &categories),
            ])
        }
        SearchProvider::Ollama => {
            let base = active
                .ollama_url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("https://ollama.com");
            client
                .post(endpoint(base, "api/web_search", "https")?)
                .bearer_auth(key)
                .json(&json!({ "query": query, "max_results": max_results }))
        }
        SearchProvider::Brave => client
            .get("https://api.search.brave.com/res/v1/web/search")
            .header("X-Subscription-Token", key)
            .query(&[("q", query), ("count", &max_results.to_string())]),
        SearchProvider::Bocha => client
            .post("https://api.bocha.cn/v1/web-search")
            .bearer_auth(key)
            .json(&json!({
                "query": query, "freshness": "noLimit", "summary": true, "count": max_results,
            })),
        SearchProvider::Firecrawl => {
            let base = active
                .base_url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("https://api.firecrawl.dev");
            let mut request = client.post(endpoint(base, "v2/search", "https")?);
            if !key.is_empty() {
                request = request.bearer_auth(key);
            }
            request.json(&json!({ "query": query, "limit": max_results }))
        }
        SearchProvider::None => unreachable!(),
    };
    let parsed = request_json(
        request.header("Accept", "application/json"),
        operation,
        cancellation,
    )
    .await?;
    if parsed.get("error").is_some_and(|value| !value.is_null())
        || parsed.get("success").and_then(Value::as_bool) == Some(false)
    {
        if provider == SearchProvider::Firecrawl
            && parsed
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    value
                        .to_ascii_lowercase()
                        .contains("ip address looks suspicious")
                })
        {
            return Err(WikiFailure::state(
                "Firecrawl rejected key-free access from this IP; add a Firecrawl API key or choose another provider",
            ));
        }
        return Err(WikiFailure::state(format!(
            "{operation} was rejected; check provider configuration"
        )));
    }
    if provider == SearchProvider::Bocha && parsed.get("code").and_then(Value::as_i64) != Some(200)
    {
        return Err(WikiFailure::state(
            "Bocha search returned an unsuccessful API status; check the key and account quota",
        ));
    }
    if provider == SearchProvider::Brave
        && parsed.get("web").is_none()
        && parsed.get("message").is_some()
    {
        return Err(WikiFailure::state(
            "Brave search was rejected; check the key and account quota",
        ));
    }
    let items = match provider {
        SearchProvider::Firecrawl => firecrawl_items(&parsed),
        SearchProvider::Brave => parsed.pointer("/web/results").and_then(Value::as_array),
        SearchProvider::Bocha => parsed
            .pointer("/data/webPages/value")
            .and_then(Value::as_array),
        SearchProvider::Serpapi => [
            "organic_results",
            "news_results",
            "images_results",
            "video_results",
            "videos_results",
            "shopping_results",
        ]
        .iter()
        .find_map(|name| parsed.get(*name).and_then(Value::as_array)),
        _ => parsed.get("results").and_then(Value::as_array),
    };
    Ok(items
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|item| normalize(item, provider == SearchProvider::Bocha))
        .filter(|item| !item.url.trim().is_empty())
        .collect())
}

fn endpoint(raw: &str, suffix: &str, default_scheme: &str) -> Result<Url, WikiFailure> {
    let raw = raw.trim().trim_end_matches('/');
    let normalized = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("{default_scheme}://{raw}")
    };
    let mut url = Url::parse(&normalized)
        .map_err(|_| WikiFailure::invalid_input("endpoint", "expected an HTTP(S) endpoint"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(WikiFailure::invalid_input(
            "endpoint",
            "expected an HTTP(S) endpoint without URL credentials",
        ));
    }
    let path = url.path().trim_end_matches('/');
    if !path.ends_with(&format!("/{suffix}")) {
        url.set_path(&format!("{path}/{suffix}"));
    }
    Ok(url)
}

fn firecrawl_items(value: &Value) -> Option<&Vec<Value>> {
    for name in ["data", "results"] {
        let Some(candidate) = value.get(name) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            return Some(items);
        }
        for nested in ["web", "results", "items"] {
            if let Some(items) = candidate.get(nested).and_then(Value::as_array) {
                return Some(items);
            }
        }
    }
    None
}

fn normalize(value: &Value, bocha: bool) -> ResearchSource {
    let metadata = value.get("metadata");
    let title = if bocha {
        value.get("name")
    } else {
        value
            .get("title")
            .or_else(|| metadata.and_then(|value| value.get("title")))
    }
    .and_then(Value::as_str)
    .unwrap_or("Untitled")
    .to_owned();
    let url = value
        .get("url")
        .or_else(|| value.get("link"))
        .or_else(|| metadata.and_then(|value| value.get("sourceURL")))
        .or_else(|| metadata.and_then(|value| value.get("url")))
        .or_else(|| value.get("original"))
        .or_else(|| value.get("thumbnail"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let snippet = if bocha {
        value.get("summary").or_else(|| value.get("snippet"))
    } else {
        value
            .get("snippet")
            .or_else(|| value.get("content"))
            .or_else(|| value.get("description"))
            .or_else(|| metadata.and_then(|value| value.get("description")))
            .or_else(|| value.get("summary"))
            .or_else(|| value.get("markdown"))
    }
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();
    let host = Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "web".into());
    let source = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    ResearchSource {
        title,
        url,
        snippet,
        source,
    }
}
