mod local;

use std::{net::IpAddr, path::PathBuf, time::Duration};

use reqwest::{Client, RequestBuilder, Url};
use serde_json::{Value, json};

use crate::search_config::{EmbeddingConfig, EmbeddingCredentials, EmbeddingSource};

pub(crate) use local::{DIMENSION as LOCAL_DIMENSION, MODEL as LOCAL_MODEL};

pub struct Embedder {
    client: Client,
    local: local::LocalMiniLm,
}

impl Embedder {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            local: local::LocalMiniLm::default(),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|_| "failed to initialize embedding HTTP client".to_owned())?,
        })
    }

    pub(crate) fn with_local_assets(mut self, assets_root: PathBuf) -> Self {
        self.local = self.local.with_assets(assets_root);
        self
    }

    pub async fn embed(
        &self,
        text: &str,
        config: &EmbeddingConfig,
        credentials: &EmbeddingCredentials,
        max_retries: usize,
    ) -> Result<Vec<f32>, String> {
        if !config.is_ready() {
            return Err("wiki embedding is disabled or not configured".to_owned());
        }
        if config.source == EmbeddingSource::LocalMiniLm {
            return self
                .local
                .embed(vec![text.to_owned()])
                .await
                .map(|mut vectors| vectors.remove(0));
        }
        let mut current = text;
        for attempt in 0..=max_retries {
            match self.embed_once(current, config, credentials).await {
                Ok(vector) => return Ok(vector),
                Err(FetchError::Oversize)
                    if attempt < max_retries && current.chars().count() > 64 =>
                {
                    let keep = current.chars().count() / 2;
                    let end = current
                        .char_indices()
                        .nth(keep)
                        .map(|(offset, _)| offset)
                        .unwrap_or(current.len());
                    current = &current[..end];
                }
                Err(FetchError::Oversize) => {
                    return Err(
                        "embedding input exceeds the provider context; lower maxChunkChars"
                            .to_owned(),
                    );
                }
                Err(FetchError::Other(reason)) => return Err(reason),
            }
        }
        unreachable!("each final embedding attempt returns")
    }

    pub async fn embed_batch(
        &self,
        texts: &[String],
        config: &EmbeddingConfig,
        credentials: &EmbeddingCredentials,
    ) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() || texts.len() > 64 {
            return Err("embedding batch must contain between 1 and 64 inputs".to_owned());
        }
        if !config.is_ready() {
            return Err("wiki embedding is disabled or not configured".to_owned());
        }
        if config.source == EmbeddingSource::LocalMiniLm {
            return self.local.embed(texts.to_vec()).await;
        }
        if !supports_batch(config) {
            return Err("embedding provider does not support OpenAI-compatible batches".to_owned());
        }
        let endpoint = provider_endpoint(config)?;
        let response = self
            .request(&endpoint, config, credentials, false)
            .json(&json!({"model": config.model, "input": texts}))
            .send()
            .await
            .map_err(|_| "embedding batch request failed".to_owned())?;
        let value = read_response(response).await.map_err(FetchError::reason)?;
        let entries = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "embedding batch response is missing data".to_owned())?;
        if entries.len() != texts.len() {
            return Err("embedding batch response has an incomplete vector count".to_owned());
        }
        let mut vectors = vec![None; texts.len()];
        for (position, entry) in entries.iter().enumerate() {
            let index = match entry.get("index") {
                Some(index) => index
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                    .ok_or_else(|| "embedding batch response has an invalid index".to_owned())?,
                None => position,
            };
            if index >= vectors.len() || vectors[index].is_some() {
                return Err(
                    "embedding batch response has duplicate or out-of-range indexes".to_owned(),
                );
            }
            vectors[index] = Some(parse_vector(entry.get("embedding"))?);
        }
        let vectors = vectors
            .into_iter()
            .map(|vector| vector.expect("validated complete batch"))
            .collect::<Vec<_>>();
        let dimension = vectors[0].len();
        if vectors.iter().any(|vector| vector.len() != dimension) {
            return Err("embedding batch response has inconsistent dimensions".to_owned());
        }
        Ok(vectors)
    }

    async fn embed_once(
        &self,
        text: &str,
        config: &EmbeddingConfig,
        credentials: &EmbeddingCredentials,
    ) -> Result<Vec<f32>, FetchError> {
        let google = is_google(config);
        let doubao = is_doubao(config);
        let endpoint = provider_endpoint(config).map_err(FetchError::Other)?;
        let body = if google {
            let model = config.model.trim();
            let model = if model.starts_with("models/") {
                model.to_owned()
            } else {
                format!("models/{model}")
            };
            let mut body = json!({"model": model, "content": {"parts": [{"text": text}]}});
            if let Some(dim) = config
                .output_dimensionality
                .filter(|dim| dim.is_finite() && *dim >= 1.0)
            {
                body["output_dimensionality"] = json!(dim.floor() as u32);
            }
            body
        } else if doubao {
            json!({"model": config.model, "encoding_format": "float", "input": [{"type": "text", "text": text}]})
        } else {
            json!({"model": config.model, "input": text})
        };
        let response = self
            .request(&endpoint, config, credentials, google)
            .json(&body)
            .send()
            .await
            .map_err(|_| FetchError::Other("embedding request failed".to_owned()))?;
        let value = read_response(response).await?;
        let vector = if google {
            value.get("embedding").and_then(|value| value.get("values"))
        } else if doubao {
            value.get("data").and_then(|value| value.get("embedding"))
        } else {
            value
                .get("data")
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("embedding"))
        };
        parse_vector(vector).map_err(FetchError::Other)
    }

    fn request(
        &self,
        endpoint: &Url,
        config: &EmbeddingConfig,
        credentials: &EmbeddingCredentials,
        google: bool,
    ) -> RequestBuilder {
        let mut request = self
            .client
            .post(endpoint.clone())
            .header("Content-Type", "application/json");
        if is_local_endpoint(endpoint) {
            request = request.header("Origin", "http://localhost");
        }
        if !credentials.api_key.trim().is_empty() {
            request = if google {
                request.header("x-goog-api-key", credentials.api_key.trim())
            } else {
                request.bearer_auth(credentials.api_key.trim())
            };
        }
        for (name, value) in config
            .extra_headers
            .iter()
            .chain(credentials.extra_headers.iter())
        {
            if !is_reserved_header(name) && !name.trim().is_empty() && !value.trim().is_empty() {
                request = request.header(name.trim(), value.trim());
            }
        }
        request
    }
}

pub(crate) fn supports_batch(config: &EmbeddingConfig) -> bool {
    config.source == EmbeddingSource::LocalMiniLm || (!is_google(config) && !is_doubao(config))
}

fn is_google(config: &EmbeddingConfig) -> bool {
    let endpoint = config.endpoint.to_ascii_lowercase();
    endpoint.contains("generativelanguage.googleapis.com")
        || endpoint.contains(":embedcontent")
        || endpoint.contains(":batchembedcontents")
}

fn is_doubao(config: &EmbeddingConfig) -> bool {
    config
        .model
        .to_ascii_lowercase()
        .contains("doubao-embedding-vision")
}

fn provider_endpoint(config: &EmbeddingConfig) -> Result<Url, String> {
    let mut endpoint = Url::parse(config.endpoint.trim())
        .map_err(|_| "embedding endpoint must be a valid HTTP URL".to_owned())?;
    if !matches!(endpoint.scheme(), "http" | "https") || endpoint.host_str().is_none() {
        return Err("embedding endpoint must be a valid HTTP URL".to_owned());
    }
    let path = endpoint.path().trim_end_matches('/').to_owned();
    let lower_path = path.to_ascii_lowercase();
    if is_google(config) {
        let kept = endpoint
            .query_pairs()
            .filter(|(key, _)| !key.eq_ignore_ascii_case("key"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        endpoint.set_query(None);
        if !kept.is_empty() {
            endpoint.query_pairs_mut().extend_pairs(kept);
        }
        let path = if lower_path.ends_with(":batchembedcontents") {
            format!(
                "{}:embedContent",
                &path[..path.len() - ":batchEmbedContents".len()]
            )
        } else if lower_path.ends_with(":embedcontent") {
            path
        } else if lower_path.contains("/models/") {
            format!("{path}:embedContent")
        } else {
            format!(
                "{path}/models/{}:embedContent",
                config.model.trim().trim_start_matches("models/")
            )
        };
        endpoint.set_path(&path);
        return Ok(endpoint);
    }
    let host = endpoint.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "volces.com" || host.ends_with(".volces.com") || host.contains("volcengine") {
        let path = if is_doubao(config) {
            if lower_path.ends_with("/embeddings/multimodal") {
                path
            } else if lower_path.ends_with("/embeddings") {
                format!("{path}/multimodal")
            } else {
                format!("{path}/embeddings/multimodal")
            }
        } else if lower_path.ends_with("/embeddings/multimodal") {
            path[..path.len() - "/multimodal".len()].to_owned()
        } else if lower_path.ends_with("/embeddings") {
            path
        } else {
            format!("{path}/embeddings")
        };
        endpoint.set_path(&path);
    }
    Ok(endpoint)
}

fn is_local_endpoint(endpoint: &Url) -> bool {
    let host = endpoint
        .host_str()
        .unwrap_or_default()
        .trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| match ip {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            IpAddr::V6(ip) => ip.is_loopback(),
        })
}

fn is_reserved_header(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "authorization" | "content-type" | "host" | "content-length" | "origin" | "x-goog-api-key"
    )
}

enum FetchError {
    Oversize,
    Other(String),
}

impl FetchError {
    fn reason(self) -> String {
        match self {
            Self::Oversize => "embedding batch input exceeds the provider context".to_owned(),
            Self::Other(reason) => reason,
        }
    }
}

async fn read_response(response: reqwest::Response) -> Result<Value, FetchError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| FetchError::Other("embedding response could not be read".to_owned()))?;
    if !status.is_success() {
        let lower = body.to_ascii_lowercase();
        if status.as_u16() == 413
            || [
                "too long",
                "maximum context",
                "max_tokens",
                "max tokens",
                "context length",
                "token limit",
                "exceeds",
                "input length",
            ]
            .iter()
            .any(|phrase| lower.contains(phrase))
        {
            return Err(FetchError::Oversize);
        }
        // Provider bodies and URLs may echo credentials; only the status leaves this boundary.
        return Err(FetchError::Other(format!(
            "embedding provider returned HTTP {}",
            status.as_u16()
        )));
    }
    serde_json::from_str(&body)
        .map_err(|_| FetchError::Other("embedding response is not valid JSON".to_owned()))
}

fn parse_vector(value: Option<&Value>) -> Result<Vec<f32>, String> {
    let values = value
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| "embedding response is missing a nonempty vector".to_owned())?;
    values
        .iter()
        .map(|value| {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| "embedding response contains invalid numeric values".to_owned())?;
            let number = number as f32;
            if !number.is_finite() {
                return Err("embedding response contains out-of-range numeric values".to_owned());
            }
            Ok(number)
        })
        .collect()
}
