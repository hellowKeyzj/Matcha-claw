mod config;
mod http;
mod preparation;
mod process;

use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsString,
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

use foundation::process::supervision::{Supervisor, SupervisorHandle, SupervisorPhase};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct ServiceConfig {
    pub language: String,
    pub safe_search: u8,
    pub request_timeout_seconds: u32,
    pub proxy_url: Option<String>,
    pub engines: Vec<EngineConfig>,
}

impl fmt::Debug for ServiceConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceConfig")
            .field("language", &self.language)
            .field("safe_search", &self.safe_search)
            .field("request_timeout_seconds", &self.request_timeout_seconds)
            .field("proxy_configured", &self.proxy_url.is_some())
            .field("engine_count", &self.engines.len())
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub name: String,
    pub enabled: bool,
    pub timeout_seconds: Option<u32>,
    pub weight: Option<f64>,
    pub options: BTreeMap<String, serde_json::Value>,
}

impl fmt::Debug for EngineConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EngineConfig")
            .field("name", &self.name)
            .field("enabled", &self.enabled)
            .field("timeout_seconds", &self.timeout_seconds)
            .field("weight", &self.weight)
            .field("options", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Engine {
    pub name: String,
    pub categories: Vec<String>,
    pub enabled: bool,
    pub language_support: bool,
    pub safe_search: bool,
    pub timeout_seconds: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub categories: Option<String>,
    pub engines: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<u8>,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub results: Vec<SearchHit>,
    pub unresponsive_engines: serde_json::Value,
}

pub trait PythonEnvironment: Send + Sync {
    fn prepare(&self) -> Pin<Box<dyn Future<Output = Result<PythonExecution, Error>> + Send + '_>>;
}

pub struct PythonExecution {
    pub uv: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}

impl fmt::Debug for PythonExecution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PythonExecution([REDACTED])")
    }
}

#[derive(Clone)]
pub struct ServiceInput {
    pub resources_dir: PathBuf,
    pub state_dir: PathBuf,
    pub python_environment: Arc<dyn PythonEnvironment>,
    pub guardian_executable: Option<PathBuf>,
}

impl fmt::Debug for ServiceInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServiceInput([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidConfig,
    InvalidRequest,
    ResourcesUnavailable,
    StateUnavailable,
    ToolchainUnavailable,
    PreparationFailed,
    NotRunning,
    StartFailed,
    StopFailed,
    RequestFailed,
    RequestTimeout,
    ResponseTooLarge,
    InvalidResponse,
    RateLimited,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidConfig => "Search configuration is invalid; check the selected engines and options.",
            Self::InvalidRequest => "Search request is invalid; check the query and search options.",
            Self::ResourcesUnavailable => "Search resources are missing or invalid; reinstall the search component.",
            Self::StateUnavailable => "Search state is not writable; check application storage permissions.",
            Self::ToolchainUnavailable => "Python 3.12 is unavailable; prepare the application toolchain.",
            Self::PreparationFailed => "Search dependency preparation failed; prepare the search component again.",
            Self::NotRunning => "Search service is not running; start the search component.",
            Self::StartFailed => "Search service could not start; check the search configuration and prepare it again.",
            Self::StopFailed => "Search process cleanup could not be confirmed; restart the application before retrying.",
            Self::RequestFailed => "Search service request failed; check that the search component is running.",
            Self::RequestTimeout => "Search request timed out; check the engine connection or request timeout.",
            Self::ResponseTooLarge => "Search service response exceeded the size limit.",
            Self::InvalidResponse => "Search service returned an invalid response.",
            Self::RateLimited => "Search service is rate limited; wait before retrying.",
        })
    }
}

impl std::error::Error for Error {}

struct Lifecycle {
    supervisor: Option<Supervisor>,
}

#[derive(Clone)]
struct Endpoint {
    base_url: String,
    timeout_seconds: u32,
    engines: Arc<[Engine]>,
    supervisor: SupervisorHandle,
}

pub struct Service {
    input: ServiceInput,
    lifecycle: tokio::sync::Mutex<Lifecycle>,
    endpoint: Mutex<Option<Endpoint>>,
    client: std::sync::OnceLock<reqwest::Client>,
    logs: Mutex<VecDeque<String>>,
}

impl Service {
    pub fn new(input: ServiceInput) -> Self {
        Self {
            input,
            lifecycle: tokio::sync::Mutex::new(Lifecycle { supervisor: None }),
            endpoint: Mutex::new(None),
            client: std::sync::OnceLock::new(),
            logs: Mutex::new(VecDeque::new()),
        }
    }

    /// Returns upstream default-enabled engines available without Tor after validating config.
    pub fn validate_config(&self, config: &ServiceConfig) -> Result<Vec<String>, Error> {
        config::validate(&self.input.resources_dir, config)?
            .into_iter()
            .filter(|definition| {
                let onions = match definition.get("categories") {
                    Some(serde_json::Value::String(category)) => category == "onions",
                    Some(serde_json::Value::Array(categories)) => categories
                        .iter()
                        .any(|category| category.as_str() == Some("onions")),
                    _ => false,
                };
                definition
                    .get("disabled")
                    .and_then(serde_json::Value::as_bool)
                    != Some(true)
                    && definition
                        .get("inactive")
                        .and_then(serde_json::Value::as_bool)
                        != Some(true)
                    && !onions
            })
            .map(|definition| {
                definition
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .ok_or(Error::ResourcesUnavailable)
            })
            .collect()
    }

    pub async fn prepare(&self) -> Result<(), Error> {
        let _lifecycle = self.lifecycle.lock().await;
        self.record("[search] preparing dependencies");
        let result = preparation::prepare(&self.input).await;
        self.record(if result.is_ok() {
            "[search] dependencies ready"
        } else {
            "[search] dependency preparation failed"
        });
        result.map(|_| ())
    }

    pub async fn start(&self, config: &ServiceConfig) -> Result<String, Error> {
        let mut lifecycle = self.lifecycle.lock().await;
        let settings = config::settings(&self.input.resources_dir, config)?;
        self.stop_locked(&mut lifecycle).await?;
        let execution = preparation::prepare(&self.input).await?;
        preparation::write_settings(&self.input.state_dir, &settings)?;
        self.record("[search] starting local service");
        let client = self.client()?;
        let (supervisor, endpoint) = process::launch(&self.input, execution, client)?;
        lifecycle.supervisor = Some(supervisor);
        let handle = lifecycle
            .supervisor
            .as_ref()
            .expect("supervisor stored")
            .handle();
        if process::start(&handle).await.is_err() {
            self.record("[search] local service startup failed");
            self.stop_locked(&mut lifecycle).await?;
            return Err(Error::StartFailed);
        }
        let Some(ready) = endpoint.borrow().clone() else {
            self.stop_locked(&mut lifecycle).await?;
            return Err(Error::StartFailed);
        };
        *self
            .endpoint
            .lock()
            .expect("search endpoint mutex poisoned") = Some(Endpoint {
            base_url: ready.base_url.clone(),
            timeout_seconds: config.request_timeout_seconds,
            engines: ready.engines.into(),
            supervisor: handle,
        });
        self.record("[search] local service ready");
        Ok(ready.base_url)
    }

    pub async fn stop(&self) -> Result<(), Error> {
        let mut lifecycle = self.lifecycle.lock().await;
        self.stop_locked(&mut lifecycle).await
    }

    async fn stop_locked(&self, lifecycle: &mut Lifecycle) -> Result<(), Error> {
        *self
            .endpoint
            .lock()
            .expect("search endpoint mutex poisoned") = None;
        if let Some(supervisor) = lifecycle.supervisor.as_mut() {
            process::shutdown(supervisor).await?;
            lifecycle.supervisor = None;
            self.record("[search] local service stopped");
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.running_endpoint().is_ok()
    }

    pub fn base_url(&self) -> Option<String> {
        self.running_endpoint()
            .ok()
            .map(|endpoint| endpoint.base_url)
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs
            .lock()
            .expect("search logs mutex poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub async fn catalog(&self) -> Result<Vec<Engine>, Error> {
        let endpoint = self.running_endpoint()?;
        http::catalog(self.client()?, &endpoint.base_url).await
    }

    pub async fn search(&self, request: &SearchRequest) -> Result<SearchResult, Error> {
        let endpoint = self.running_endpoint()?;
        if request.engines.as_ref().is_some_and(|selected| {
            selected.split(',').any(|name| {
                !endpoint
                    .engines
                    .iter()
                    .any(|engine| engine.name == name.trim())
            })
        }) || request.categories.as_ref().is_some_and(|selected| {
            selected.split(',').any(|category| {
                !endpoint
                    .engines
                    .iter()
                    .any(|engine| engine.categories.iter().any(|name| name == category.trim()))
            })
        }) {
            return Err(Error::InvalidRequest);
        }
        let effective;
        let request =
            if let (Some(engines), Some(categories)) = (&request.engines, &request.categories) {
                let selected: Vec<_> = engines
                    .split(',')
                    .map(str::trim)
                    .filter(|name| {
                        endpoint.engines.iter().any(|engine| {
                            engine.name == *name
                                && categories.split(',').any(|category| {
                                    engine.categories.iter().any(|name| name == category.trim())
                                })
                        })
                    })
                    .collect();
                if selected.is_empty() {
                    return Err(Error::InvalidRequest);
                }
                effective = SearchRequest {
                    engines: Some(selected.join(",")),
                    ..request.clone()
                };
                &effective
            } else {
                request
            };
        http::search(
            self.client()?,
            &endpoint.base_url,
            endpoint.timeout_seconds,
            request,
        )
        .await
    }

    fn running_endpoint(&self) -> Result<Endpoint, Error> {
        let endpoint = self
            .endpoint
            .lock()
            .expect("search endpoint mutex poisoned");
        let endpoint = endpoint.as_ref().ok_or(Error::NotRunning)?;
        if endpoint.supervisor.snapshot().phase() != SupervisorPhase::Running
            || endpoint
                .supervisor
                .lease()
                .is_none_or(|lease| lease.is_cancelled())
        {
            return Err(Error::NotRunning);
        }
        Ok(endpoint.clone())
    }

    fn client(&self) -> Result<reqwest::Client, Error> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = http::client()?;
        let _ = self.client.set(client.clone());
        Ok(self.client.get().cloned().unwrap_or(client))
    }

    fn record(&self, message: &'static str) {
        let mut logs = self.logs.lock().expect("search logs mutex poisoned");
        if logs.len() == 100 {
            logs.pop_front();
        }
        logs.push_back(message.to_owned());
    }
}

impl fmt::Debug for Service {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Service")
            .field("running", &self.is_running())
            .finish_non_exhaustive()
    }
}
