use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use foundation::storage::{PrivateMode, provision_private_directory, set_private_mode};
use serde::{Deserialize, Serialize};

use crate::WikiFailure;

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    #[default]
    None,
    Tavily,
    Serpapi,
    Searxng,
    Ollama,
    Brave,
    Bocha,
    Firecrawl,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeepResearchSource {
    #[default]
    Web,
    Anytxt,
    Both,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProviderConfig {
    pub base_url: Option<String>,
    #[serde(rename = "serpApiEngine")]
    pub serp_api_engine: Option<String>,
    #[serde(rename = "searXngUrl")]
    pub sear_xng_url: Option<String>,
    #[serde(rename = "searXngCategories")]
    pub sear_xng_categories: Option<Vec<String>>,
    pub ollama_url: Option<String>,
    pub api_key_configured: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AnyTxtConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub filter_dir: String,
    pub filter_ext: String,
    pub limit: usize,
}

impl Default for AnyTxtConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: "http://127.0.0.1:9920".into(),
            filter_dir: String::new(),
            filter_ext: "*".into(),
            limit: 20,
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    pub output_dimensionality: Option<f64>,
    #[serde(serialize_with = "serialize_public_headers")]
    pub extra_headers: BTreeMap<String, String>,
    pub max_chunk_chars: usize,
    pub overlap_chunk_chars: usize,
    pub batch_size: usize,
    pub concurrency: usize,
    pub api_key_configured: bool,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: String::new(),
            model: String::new(),
            output_dimensionality: None,
            extra_headers: BTreeMap::new(),
            max_chunk_chars: 1000,
            overlap_chunk_chars: 200,
            batch_size: 1,
            concurrency: 1,
            api_key_configured: false,
        }
    }
}

impl fmt::Debug for EmbeddingConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmbeddingConfig")
            .field("enabled", &self.enabled)
            .field("model", &self.model)
            .field("api_key_configured", &self.api_key_configured)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchConfig {
    pub provider: SearchProvider,
    pub provider_configs: BTreeMap<SearchProvider, SearchProviderConfig>,
    pub deep_research_source: DeepResearchSource,
    pub any_txt: AnyTxtConfig,
    pub embedding: EmbeddingConfig,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProviderConfigUpdate {
    pub base_url: Option<String>,
    #[serde(rename = "serpApiEngine")]
    pub serp_api_engine: Option<String>,
    #[serde(rename = "searXngUrl")]
    pub sear_xng_url: Option<String>,
    #[serde(rename = "searXngCategories")]
    pub sear_xng_categories: Option<Vec<String>>,
    pub ollama_url: Option<String>,
    pub api_key: Option<String>,
    pub api_key_configured: Option<bool>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingConfigUpdate {
    pub enabled: Option<bool>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_dimensionality_patch")]
    pub output_dimensionality: Option<Option<f64>>,
    pub extra_headers: Option<BTreeMap<String, String>>,
    pub max_chunk_chars: Option<usize>,
    pub overlap_chunk_chars: Option<usize>,
    pub batch_size: Option<usize>,
    pub concurrency: Option<usize>,
    pub api_key: Option<String>,
    pub api_key_configured: Option<bool>,
}

fn deserialize_dimensionality_patch<'de, D>(
    deserializer: D,
) -> Result<Option<Option<f64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchConfigUpdate {
    pub provider: Option<SearchProvider>,
    pub provider_configs: Option<BTreeMap<SearchProvider, SearchProviderConfigUpdate>>,
    pub deep_research_source: Option<DeepResearchSource>,
    pub any_txt: Option<AnyTxtConfig>,
    pub embedding: Option<EmbeddingConfigUpdate>,
}

macro_rules! redacted_debug {
    ($($name:ty),+) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!(stringify!($name), " { [redacted] }"))
            }
        }
    )+};
}
redacted_debug!(
    SearchProviderConfigUpdate,
    EmbeddingConfigUpdate,
    SearchConfigUpdate
);

#[derive(Clone, Default)]
pub struct EmbeddingCredentials {
    pub(crate) api_key: String,
    pub(crate) extra_headers: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
pub struct SearchCredentials {
    provider_keys: BTreeMap<SearchProvider, String>,
}

impl SearchCredentials {
    pub fn api_key(&self, provider: SearchProvider) -> &str {
        self.provider_keys
            .get(&provider)
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct PrivateConfig {
    provider_keys: BTreeMap<SearchProvider, String>,
    embedding_api_key: String,
    embedding_headers: BTreeMap<String, String>,
}

pub fn read_config(
    root: &Path,
    state_root: &Path,
    project_id: &str,
) -> Result<SearchConfig, WikiFailure> {
    let (config, _) = read_owned_config(root, state_root, project_id)?;
    Ok(config)
}

pub fn update_config(
    root: &Path,
    state_root: &Path,
    project_id: &str,
    input: SearchConfigUpdate,
) -> Result<SearchConfig, WikiFailure> {
    let (mut config, mut private) = read_owned_config(root, state_root, project_id)?;
    apply_update(&mut config, &mut private, input)?;
    write_private_config(&private_path(state_root, project_id)?, &private)?;
    write_config(&root.join(".llm-wiki/search-config.json"), &config)?;
    Ok(config)
}

pub fn execution_snapshot(
    root: &Path,
    state_root: &Path,
    project_id: &str,
) -> Result<(SearchConfig, SearchCredentials), WikiFailure> {
    let (config, private) = read_owned_config(root, state_root, project_id)?;
    Ok((
        config,
        SearchCredentials {
            provider_keys: private.provider_keys,
        },
    ))
}

pub fn embedding_execution_config(
    root: &Path,
    state_root: &Path,
    project_id: &str,
) -> Result<(EmbeddingConfig, EmbeddingCredentials), WikiFailure> {
    let (config, private) = read_owned_config(root, state_root, project_id)?;
    Ok((
        config.embedding,
        EmbeddingCredentials {
            api_key: private.embedding_api_key,
            extra_headers: private.embedding_headers,
        },
    ))
}

pub(crate) fn apply_search_test_input(
    config: &SearchConfig,
    credentials: &SearchCredentials,
    input: SearchConfigUpdate,
) -> Result<(SearchConfig, SearchCredentials), WikiFailure> {
    let mut config = config.clone();
    let mut private = PrivateConfig {
        provider_keys: credentials.provider_keys.clone(),
        ..PrivateConfig::default()
    };
    apply_update(&mut config, &mut private, input)?;
    Ok((
        config,
        SearchCredentials {
            provider_keys: private.provider_keys,
        },
    ))
}

pub fn has_configured_web(config: &SearchConfig) -> bool {
    let provider = config.provider;
    let active = config.provider_configs.get(&provider);
    match provider {
        SearchProvider::None => false,
        SearchProvider::Searxng => active
            .and_then(|value| value.sear_xng_url.as_deref())
            .is_some_and(|value| !value.trim().is_empty()),
        SearchProvider::Firecrawl => true,
        _ => active.is_some_and(|value| value.api_key_configured),
    }
}

pub fn has_configured_sources(config: &SearchConfig) -> bool {
    let web = has_configured_web(config);
    let anytxt = config.any_txt.enabled && !config.any_txt.endpoint.trim().is_empty();
    match config.deep_research_source {
        DeepResearchSource::Web => web,
        DeepResearchSource::Anytxt => anytxt,
        DeepResearchSource::Both => web || anytxt,
    }
}

fn read_owned_config(
    root: &Path,
    state_root: &Path,
    project_id: &str,
) -> Result<(SearchConfig, PrivateConfig), WikiFailure> {
    let mut config: SearchConfig = read_json(&root.join(".llm-wiki/search-config.json"))?;
    let private: PrivateConfig = read_json(&private_path(state_root, project_id)?)?;
    validate_config(&config)?;
    config
        .embedding
        .extra_headers
        .retain(|name, _| !is_sensitive_header(name));
    project_flags(&mut config, &private);
    Ok((config, private))
}

fn apply_update(
    config: &mut SearchConfig,
    private: &mut PrivateConfig,
    input: SearchConfigUpdate,
) -> Result<(), WikiFailure> {
    if let Some(provider) = input.provider {
        config.provider = provider;
    }
    if let Some(source) = input.deep_research_source {
        config.deep_research_source = source;
    }
    if let Some(anytxt) = input.any_txt {
        config.any_txt = anytxt;
    }
    if let Some(providers) = input.provider_configs {
        for (provider, input) in providers {
            if provider == SearchProvider::None {
                return Err(WikiFailure::invalid_input(
                    "providerConfigs",
                    "none has no provider configuration",
                ));
            }
            let target = config.provider_configs.entry(provider).or_default();
            if input.base_url.is_some() {
                target.base_url = input.base_url;
            }
            if input.serp_api_engine.is_some() {
                target.serp_api_engine = input.serp_api_engine;
            }
            if input.sear_xng_url.is_some() {
                target.sear_xng_url = input.sear_xng_url;
            }
            if input.sear_xng_categories.is_some() {
                target.sear_xng_categories = input.sear_xng_categories;
            }
            if input.ollama_url.is_some() {
                target.ollama_url = input.ollama_url;
            }
            if let Some(key) = input.api_key {
                let key = key.trim();
                if key.is_empty() {
                    private.provider_keys.remove(&provider);
                } else {
                    private.provider_keys.insert(provider, key.to_owned());
                }
            }
        }
    }
    if let Some(input) = input.embedding {
        let target = &mut config.embedding;
        if let Some(value) = input.enabled {
            target.enabled = value;
        }
        if let Some(value) = input.endpoint {
            target.endpoint = value;
        }
        if let Some(value) = input.model {
            target.model = value;
        }
        if let Some(value) = input.output_dimensionality {
            target.output_dimensionality = value;
        }
        if let Some(value) = input.max_chunk_chars {
            target.max_chunk_chars = value;
        }
        if let Some(value) = input.overlap_chunk_chars {
            target.overlap_chunk_chars = value;
        }
        if let Some(value) = input.batch_size {
            target.batch_size = value;
        }
        if let Some(value) = input.concurrency {
            target.concurrency = value;
        }
        if let Some(key) = input.api_key {
            private.embedding_api_key = key.trim().to_owned();
        }
        if let Some(headers) = input.extra_headers {
            target.extra_headers.clear();
            for (name, value) in headers {
                let name = name.trim().to_owned();
                let value = value.trim().to_owned();
                validate_header(&name, &value)?;
                if is_sensitive_header(&name) {
                    private
                        .embedding_headers
                        .retain(|existing, _| !existing.eq_ignore_ascii_case(&name));
                    if !value.is_empty() {
                        private.embedding_headers.insert(name, value);
                    }
                } else if !value.is_empty() {
                    target.extra_headers.insert(name, value);
                }
            }
        }
    }
    config.any_txt.limit = config.any_txt.limit.clamp(1, 100);
    if config.any_txt.endpoint.trim().is_empty() {
        config.any_txt.endpoint = AnyTxtConfig::default().endpoint;
    }
    if !config.any_txt.endpoint.starts_with("http://")
        && !config.any_txt.endpoint.starts_with("https://")
    {
        config.any_txt.endpoint = format!("http://{}", config.any_txt.endpoint.trim());
    }
    if config.any_txt.filter_ext.trim().is_empty() {
        config.any_txt.filter_ext = "*".into();
    }
    validate_config(config)?;
    project_flags(config, private);
    Ok(())
}

fn project_flags(config: &mut SearchConfig, private: &PrivateConfig) {
    for (provider, value) in &mut config.provider_configs {
        value.api_key_configured = private
            .provider_keys
            .get(provider)
            .is_some_and(|key| !key.trim().is_empty());
    }
    config.embedding.api_key_configured = !private.embedding_api_key.trim().is_empty();
}

fn validate_config(config: &SearchConfig) -> Result<(), WikiFailure> {
    for provider in config.provider_configs.values() {
        for (field, url) in [
            ("baseUrl", &provider.base_url),
            ("searXngUrl", &provider.sear_xng_url),
            ("ollamaUrl", &provider.ollama_url),
        ] {
            if let Some(url) = url.as_deref().filter(|value| !value.trim().is_empty()) {
                validate_public_url(field, url, field == "searXngUrl")?;
            }
        }
    }
    validate_public_url("anyTxt.endpoint", &config.any_txt.endpoint, true)?;
    if !config.embedding.endpoint.trim().is_empty() {
        validate_public_url("embedding.endpoint", &config.embedding.endpoint, false)?;
    }
    let cfg = &config.embedding;
    if cfg.max_chunk_chars == 0
        || cfg.batch_size == 0
        || cfg.batch_size > 64
        || cfg.concurrency == 0
        || cfg.concurrency > 32
    {
        return Err(WikiFailure::invalid_input(
            "embedding",
            "maxChunkChars must be positive, batchSize 1-64 and concurrency 1-32",
        ));
    }
    if cfg.overlap_chunk_chars >= cfg.max_chunk_chars {
        return Err(WikiFailure::invalid_input(
            "embedding.overlapChunkChars",
            "overlap must be smaller than maxChunkChars",
        ));
    }
    if cfg
        .output_dimensionality
        .is_some_and(|value| !value.is_finite() || value < 1.0)
    {
        return Err(WikiFailure::invalid_input(
            "embedding.outputDimensionality",
            "output dimensionality must be positive and finite",
        ));
    }
    for (name, value) in &cfg.extra_headers {
        validate_header(name, value)?;
    }
    Ok(())
}

fn validate_public_url(field: &str, raw: &str, allow_bare: bool) -> Result<(), WikiFailure> {
    let normalized = if allow_bare && !raw.contains("://") {
        format!("https://{raw}")
    } else {
        raw.to_owned()
    };
    let url = reqwest::Url::parse(&normalized)
        .map_err(|_| WikiFailure::invalid_input(field, "expected an HTTP(S) URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url
            .query_pairs()
            .any(|(name, _)| is_sensitive_header(&name) || name.eq_ignore_ascii_case("key"))
    {
        return Err(WikiFailure::invalid_input(
            field,
            "HTTP(S) URL must not contain credentials; use the private key input",
        ));
    }
    Ok(())
}

fn validate_header(name: &str, value: &str) -> Result<(), WikiFailure> {
    if reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
        || reqwest::header::HeaderValue::from_str(value).is_err()
    {
        return Err(WikiFailure::invalid_input(
            "embedding.extraHeaders",
            "invalid HTTP header name or value",
        ));
    }
    Ok(())
}

fn is_sensitive_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "authorization",
        "apikey",
        "token",
        "secret",
        "password",
        "credential",
        "cookie",
        "signature",
    ]
    .iter()
    .any(|part| name.contains(part))
}

fn serialize_public_headers<S: serde::Serializer>(
    headers: &BTreeMap<String, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    headers
        .iter()
        .filter(|(name, _)| !is_sensitive_header(name))
        .collect::<BTreeMap<_, _>>()
        .serialize(serializer)
}

fn private_path(state_root: &Path, project_id: &str) -> Result<PathBuf, WikiFailure> {
    let mut components = Path::new(project_id).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || project_id.contains(['/', '\\'])
    {
        return Err(WikiFailure::invalid_input(
            "projectId",
            "invalid project identifier",
        ));
    }
    Ok(state_root
        .join("projects")
        .join(project_id)
        .join("search-private-config.json"))
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, WikiFailure> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| WikiFailure::state("invalid Wiki search configuration JSON")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(_) => Err(WikiFailure::state(
            "Wiki search configuration could not be read",
        )),
    }
}

fn write_config(path: &Path, value: &impl Serialize) -> Result<(), WikiFailure> {
    let parent = path
        .parent()
        .ok_or_else(|| WikiFailure::state("configuration directory is unavailable"))?;
    fs::create_dir_all(parent).map_err(|_| {
        WikiFailure::state("Wiki search configuration directory could not be created")
    })?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| WikiFailure::state("Wiki search configuration could not be encoded"))?;
    fs::write(path, bytes)
        .map_err(|_| WikiFailure::state("Wiki search configuration could not be written"))
}

fn write_private_config(path: &Path, config: &PrivateConfig) -> Result<(), WikiFailure> {
    let parent = path
        .parent()
        .ok_or_else(|| WikiFailure::state("private configuration directory is unavailable"))?;
    provision_private_directory(parent)
        .map_err(|_| WikiFailure::state("Wiki private search storage permission setup failed"))?;
    if path.exists() {
        set_private_mode(path, PrivateMode::File).map_err(|_| {
            WikiFailure::state("Wiki private search storage permission setup failed")
        })?;
    }
    write_config(path, config)?;
    set_private_mode(path, PrivateMode::File)
        .map_err(|_| WikiFailure::state("Wiki private search storage permission setup failed"))
}
