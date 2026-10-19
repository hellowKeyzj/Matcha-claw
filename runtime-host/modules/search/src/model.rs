use std::{collections::HashSet, fmt};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchConfig {
    pub enabled: bool,
    pub auto_start: bool,
    pub categories: Vec<String>,
    pub language: String,
    pub safe_search: u8,
    pub result_count: u8,
    pub request_timeout_seconds: u32,
    pub proxy_url: Option<String>,
    pub engines: Vec<SearchEngineConfig>,
    pub runtimes: Vec<SearchRuntimeConfig>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_start: false,
            categories: vec!["general".into()],
            language: "all".into(),
            safe_search: 0,
            result_count: 5,
            request_timeout_seconds: 30,
            proxy_url: None,
            engines: ["bing", "sogou", "360search", "quark"]
                .into_iter()
                .map(|name| SearchEngineConfig {
                    name: name.into(),
                    enabled: true,
                    timeout_seconds: None,
                    weight: None,
                })
                .collect(),
            runtimes: Vec::new(),
        }
    }
}

impl SearchConfig {
    pub(crate) fn validate(&self) -> Result<(), SearchError> {
        if self.safe_search > 2
            || !(1..=10).contains(&self.result_count)
            || !(1..=120).contains(&self.request_timeout_seconds)
            || self.categories.is_empty()
            || self.categories.len() > 32
            || self.engines.len() > 1024
            || self.runtimes.len() > 16
            || !valid_language(&self.language)
            || !unique_names(self.categories.iter().map(String::as_str))
            || !unique_names(self.engines.iter().map(|engine| engine.name.as_str()))
        {
            return Err(SearchError::invalid());
        }
        if let Some(proxy) = &self.proxy_url {
            let url = reqwest::Url::parse(proxy).map_err(|_| SearchError::invalid())?;
            if proxy.len() > 2048
                || proxy
                    .bytes()
                    .any(|value| value.is_ascii_control() || value.is_ascii_whitespace())
                || !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || proxy
                    .split_once("://")
                    .is_some_and(|(_, authority)| authority.contains('@'))
                || !matches!(url.path(), "" | "/")
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(SearchError::invalid());
            }
        }
        for engine in &self.engines {
            if engine
                .timeout_seconds
                .is_some_and(|timeout| !(1..=120).contains(&timeout))
                || engine
                    .weight
                    .is_some_and(|weight| !weight.is_finite() || weight <= 0.0 || weight > 100.0)
            {
                return Err(SearchError::invalid());
            }
        }
        let mut endpoints = HashSet::new();
        if self
            .runtimes
            .iter()
            .any(|runtime| !endpoints.insert(&runtime.endpoint))
        {
            return Err(SearchError::invalid());
        }
        Ok(())
    }

    pub(crate) fn service_config(&self) -> searxng::ServiceConfig {
        searxng::ServiceConfig {
            language: self.language.clone(),
            safe_search: self.safe_search,
            request_timeout_seconds: self.request_timeout_seconds,
            proxy_url: self.proxy_url.clone(),
            engines: self
                .engines
                .iter()
                .map(|engine| searxng::EngineConfig {
                    name: engine.name.clone(),
                    enabled: engine.enabled,
                    timeout_seconds: engine.timeout_seconds,
                    weight: engine.weight,
                    options: Default::default(),
                })
                .collect(),
        }
    }
}

fn valid_language(value: &str) -> bool {
    if matches!(value, "all" | "auto") {
        return true;
    }
    let parts: Vec<_> = value.split(['-', '_']).collect();
    (1..=3).contains(&parts.len())
        && (2..=3).contains(&parts[0].len())
        && parts.iter().all(|part| {
            (2..=4).contains(&part.len()) && part.bytes().all(|value| value.is_ascii_alphabetic())
        })
}

fn unique_names<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut names = HashSet::new();
    values.into_iter().all(|value| {
        !value.is_empty()
            && value.len() <= 256
            && !value.chars().any(char::is_control)
            && !value.contains(',')
            && names.insert(value)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchEngineConfig {
    pub name: String,
    pub enabled: bool,
    pub timeout_seconds: Option<u32>,
    pub weight: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRuntimeConfig {
    #[serde(deserialize_with = "deserialize_endpoint")]
    pub endpoint: RuntimeEndpoint,
    pub enabled: bool,
}

pub(crate) fn deserialize_endpoint<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<RuntimeEndpoint, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Endpoint {
        kind: String,
        runtime_adapter_id: String,
        runtime_instance_id: String,
    }
    let endpoint = Endpoint::deserialize(deserializer)?;
    if endpoint.kind != "native-runtime" {
        return Err(serde::de::Error::custom("invalid runtime endpoint"));
    }
    RuntimeEndpoint::try_new(endpoint.runtime_adapter_id, endpoint.runtime_instance_id)
        .map_err(|_| serde::de::Error::custom("invalid runtime endpoint"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSnapshot {
    pub revision: u64,
    pub applied_revision: Option<u64>,
    pub config: SearchConfig,
    pub service: SearchServiceState,
    pub engines: Vec<SearchEngine>,
    pub runtimes: Vec<SearchRuntimeState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchServiceState {
    pub phase: SearchServicePhase,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchServicePhase {
    Stopped,
    Preparing,
    Starting,
    Running,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEngine {
    pub name: String,
    pub categories: Vec<String>,
    pub enabled: bool,
    pub language_support: bool,
    pub safe_search: bool,
    pub timeout_seconds: f64,
}

impl From<searxng::Engine> for SearchEngine {
    fn from(engine: searxng::Engine) -> Self {
        Self {
            name: engine.name,
            categories: engine.categories,
            enabled: engine.enabled,
            language_support: engine.language_support,
            safe_search: engine.safe_search,
            timeout_seconds: engine.timeout_seconds,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSearchPhase {
    Disabled,
    NotConfigured,
    PendingRestart,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRuntimeState {
    pub endpoint: RuntimeEndpoint,
    pub enabled: bool,
    pub phase: RuntimeSearchPhase,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchVerifyRequest {
    pub query: String,
    pub engines: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_endpoint")]
    pub endpoint: Option<RuntimeEndpoint>,
}

fn deserialize_optional_endpoint<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeEndpoint>, D::Error> {
    deserialize_endpoint(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchVerification {
    pub results: Vec<SearchHit>,
    pub unresponsive_engines: serde_json::Value,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchError {
    status: u16,
    message: &'static str,
}

impl SearchError {
    pub const fn invalid() -> Self {
        Self {
            status: 400,
            message: "Network search request is invalid",
        }
    }
    pub const fn unsupported() -> Self {
        Self {
            status: 400,
            message: "Native runtime search verification is not supported; use an existing runtime tool session",
        }
    }
    pub const fn unavailable() -> Self {
        Self {
            status: 503,
            message: "Network search is unavailable; prepare or restart the service",
        }
    }
    pub const fn native_policy_denied() -> Self {
        Self {
            status: 503,
            message: "Native runtime policy denied network search; check runtime tool permissions",
        }
    }
    pub const fn native_failed() -> Self {
        Self {
            status: 503,
            message: "Native runtime search failed; check the runtime session and retry",
        }
    }
    pub(crate) const fn conflict() -> Self {
        Self {
            status: 409,
            message: "Network search configuration changed; reload before saving",
        }
    }
    pub(crate) const fn storage() -> Self {
        Self {
            status: 503,
            message: "Network search configuration could not be saved; check storage and retry",
        }
    }
    pub(crate) const fn catalog_required() -> Self {
        Self {
            status: 400,
            message: "Prepare and enable network search before selecting categories",
        }
    }
    pub const fn status(self) -> u16 {
        self.status
    }
    pub const fn message(self) -> &'static str {
        self.message
    }
}

impl From<searxng::Error> for SearchError {
    fn from(error: searxng::Error) -> Self {
        use searxng::Error;
        let message = match error {
            Error::InvalidConfig => {
                "Network search configuration is invalid; check the selected engines and options"
            }
            Error::InvalidRequest => "Network search request is invalid",
            Error::ResourcesUnavailable => {
                "Network search resources are missing; reinstall the search component"
            }
            Error::StateUnavailable => {
                "Network search storage is unavailable; check application storage permissions"
            }
            Error::ToolchainUnavailable => {
                "Python 3.12 is unavailable; prepare the application toolchain"
            }
            Error::PreparationFailed => {
                "Network search dependency preparation failed; prepare the component again"
            }
            Error::NotRunning => {
                "Network search service is stopped; enable or restart it before verifying"
            }
            Error::StartFailed => {
                "Network search could not start; check configuration and prepare it again"
            }
            Error::StopFailed => {
                "Network search cleanup could not be confirmed; restart the application before retrying"
            }
            Error::RequestFailed => "Network search request failed; check the component is running",
            Error::RequestTimeout => {
                "Network search timed out; check engine connectivity or request timeout"
            }
            Error::ResponseTooLarge => "Network search response exceeded the size limit",
            Error::InvalidResponse => {
                "Network search returned an invalid response; restart the component"
            }
            Error::RateLimited => "Network search is rate limited; wait before retrying",
        };
        Self {
            status: if matches!(error, Error::InvalidConfig | Error::InvalidRequest) {
                400
            } else {
                503
            },
            message,
        }
    }
}

impl fmt::Display for SearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for SearchError {}
