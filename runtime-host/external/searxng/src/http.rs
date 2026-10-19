use std::time::Duration;

use serde::Deserialize;

use crate::{Engine, Error, SearchHit, SearchRequest, SearchResult};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(125))
        .build()
        .map_err(|_| Error::RequestFailed)
}

#[derive(Deserialize)]
struct ConfigResponse {
    engines: Vec<ConfigEngine>,
}

#[derive(Deserialize)]
struct ConfigEngine {
    name: String,
    categories: Vec<String>,
    enabled: bool,
    language_support: bool,
    safesearch: bool,
    timeout: f64,
}

pub(crate) async fn catalog(client: reqwest::Client, base_url: &str) -> Result<Vec<Engine>, Error> {
    let request = client
        .get(format!("{base_url}/config"))
        .timeout(Duration::from_secs(5));
    let response: ConfigResponse =
        serde_json::from_slice(&body(request).await?).map_err(|_| Error::InvalidResponse)?;
    if response.engines.is_empty()
        || response.engines.iter().any(|engine| {
            engine.name.trim().is_empty()
                || engine.categories.is_empty()
                || !engine.timeout.is_finite()
                || engine.timeout <= 0.0
        })
    {
        return Err(Error::InvalidResponse);
    }
    Ok(response
        .engines
        .into_iter()
        .map(|engine| Engine {
            name: engine.name,
            categories: engine.categories,
            enabled: engine.enabled,
            language_support: engine.language_support,
            safe_search: engine.safesearch,
            timeout_seconds: engine.timeout,
        })
        .collect())
}

#[derive(Deserialize)]
struct SearchResponse {
    results: Vec<serde_json::Value>,
    unresponsive_engines: serde_json::Value,
}

pub(crate) async fn search(
    client: reqwest::Client,
    base_url: &str,
    timeout_seconds: u32,
    request: &SearchRequest,
) -> Result<SearchResult, Error> {
    if request.query.trim().is_empty()
        || request.query.len() > 16 * 1024
        // Upstream parses these directives before structured engine/language/timeout fields.
        || request.query.split_whitespace().any(|part| part.starts_with(['!', ':', '<']))
        || !(1..=10).contains(&request.count)
        || request.safe_search.is_some_and(|value| value > 2)
        || [&request.categories, &request.engines, &request.language]
            .into_iter()
            .flatten()
            .any(|value| {
                value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control)
            })
    {
        return Err(Error::InvalidRequest);
    }
    let mut fields = vec![("q", request.query.clone()), ("format", "json".to_owned())];
    // Upstream parse_generic unions categories with explicit engines; omit categories for exact engine selection.
    if request.engines.is_none()
        && let Some(categories) = &request.categories
    {
        fields.push(("categories", categories.clone()));
    }
    for (key, value) in [
        ("engines", &request.engines),
        ("language", &request.language),
    ] {
        if let Some(value) = value {
            fields.push((key, value.clone()));
        }
    }
    if let Some(safe_search) = request.safe_search {
        fields.push(("safesearch", safe_search.to_string()));
    }
    let response: SearchResponse = serde_json::from_slice(
        &body(
            client
                .get(format!("{base_url}/search"))
                .query(&fields)
                .timeout(Duration::from_secs(u64::from(timeout_seconds) + 5)),
        )
        .await?,
    )
    .map_err(|_| Error::InvalidResponse)?;
    let results = response
        .results
        .into_iter()
        .filter_map(|hit| {
            let title = hit.get("title")?.as_str()?.trim();
            let url = hit.get("url")?.as_str()?.trim();
            let parsed = reqwest::Url::parse(url).ok()?;
            if title.is_empty()
                || !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return None;
            }
            Some(SearchHit {
                title: title.to_owned(),
                url: url.to_owned(),
                snippet: hit
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .take(request.count)
        .collect();
    Ok(SearchResult {
        results,
        unresponsive_engines: response.unresponsive_engines,
    })
}

async fn body(request: reqwest::RequestBuilder) -> Result<Vec<u8>, Error> {
    let mut response = request.send().await.map_err(request_error)?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(Error::RateLimited);
    }
    if !response.status().is_success() {
        return Err(Error::RequestFailed);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(Error::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(Error::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn request_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::RequestTimeout
    } else {
        Error::RequestFailed
    }
}
