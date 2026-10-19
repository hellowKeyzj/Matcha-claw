use std::{ffi::OsStr, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use runtime_directory::RuntimeDriverIdentity;
use search::{
    RuntimeSearchFuture, RuntimeSearchPhase, RuntimeSearchPort, RuntimeSearchProjection,
    SearchError, SearchHit, SearchVerification,
};

use matcha_agent::{driver::MatchaRuntimeDriver, search as matcha};
use openclaw::driver::{OpenClawDriver, search as open_claw};

pub(in crate::composition::host) struct SearchPython {
    toolchain: Arc<toolchain::NativeToolchain>,
}

impl SearchPython {
    pub(in crate::composition::host) fn new(toolchain: Arc<toolchain::NativeToolchain>) -> Self {
        Self { toolchain }
    }
}

impl searxng::PythonEnvironment for SearchPython {
    fn prepare(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<searxng::PythonExecution, searxng::Error>> + Send + '_>>
    {
        Box::pin(async move {
            if !matches!(
                self.toolchain.prepare().await,
                toolchain::PrepareOutcome::Ready | toolchain::PrepareOutcome::Installed
            ) {
                return Err(searxng::Error::ToolchainUnavailable);
            }
            let projection = self.toolchain.private_env_projection().await;
            if projection.status() != toolchain::ToolchainEnvProjectionStatus::Ready {
                return Err(searxng::Error::ToolchainUnavailable);
            }
            let uv = projection
                .patch()
                .iter()
                .find(|variable| variable.key() == OsStr::new("MATCHACLAW_UV_BIN"))
                .map(|variable| PathBuf::from(variable.value()))
                .ok_or(searxng::Error::ToolchainUnavailable)?;
            let environment = projection
                .patch()
                .iter()
                .map(|variable| (variable.key().to_owned(), variable.value().to_owned()))
                .collect();
            Ok(searxng::PythonExecution { uv, environment })
        })
    }
}

pub(in crate::composition::host) struct NativeSearch {
    open_claw: Arc<OpenClawDriver>,
    matcha: Arc<MatchaRuntimeDriver>,
}

impl NativeSearch {
    pub(in crate::composition::host) fn new(
        open_claw: Arc<OpenClawDriver>,
        matcha: Arc<MatchaRuntimeDriver>,
    ) -> Self {
        Self { open_claw, matcha }
    }
}

impl RuntimeSearchPort for NativeSearch {
    fn apply<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
        projection: Option<&'a RuntimeSearchProjection>,
        authorize: bool,
    ) -> RuntimeSearchFuture<'a, RuntimeSearchPhase> {
        Box::pin(async move {
            if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
                let config = projection.map(|value| open_claw::SearchConfig {
                    base_url: value.base_url.clone(),
                    categories: value.categories.clone(),
                    language: value.language.clone(),
                    engines: None,
                    safe_search: value.safe_search,
                    result_count: value.result_count,
                    revision: value.revision.clone(),
                });
                self.open_claw
                    .apply_search(config.as_ref(), authorize)
                    .await
                    .map(openclaw_phase)
                    .map_err(openclaw_error)
            } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
                let config = projection.map(|value| matcha::SearchProjection {
                    base_url: value.base_url.clone(),
                    categories: value.categories.clone(),
                    language: value.language.clone(),
                    safe_search: value.safe_search,
                    result_count: value.result_count,
                    revision: value.revision.clone(),
                });
                self.matcha
                    .apply_search(config.as_ref())
                    .await
                    .map(matcha_phase)
                    .map_err(matcha_error)
            } else {
                Err(SearchError::unsupported())
            }
        })
    }

    fn observe<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
    ) -> RuntimeSearchFuture<'a, RuntimeSearchPhase> {
        Box::pin(async move {
            if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
                self.open_claw
                    .observe_search()
                    .await
                    .map(openclaw_phase)
                    .map_err(openclaw_error)
            } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
                self.matcha
                    .observe_search()
                    .await
                    .map(matcha_phase)
                    .map_err(matcha_error)
            } else {
                Err(SearchError::unsupported())
            }
        })
    }

    fn verify<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
        request: &'a searxng::SearchRequest,
    ) -> RuntimeSearchFuture<'a, SearchVerification> {
        Box::pin(async move {
            if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
                let result = self
                    .open_claw
                    .verify_search(&open_claw::SearchRequest {
                        query: request.query.clone(),
                        count: Some(
                            request
                                .count
                                .try_into()
                                .map_err(|_| SearchError::invalid())?,
                        ),
                        categories: request.categories.clone(),
                        engines: request.engines.clone(),
                        language: request.language.clone(),
                        safe_search: request.safe_search,
                    })
                    .await
                    .map_err(openclaw_error)?;
                Ok(SearchVerification {
                    results: result
                        .results
                        .into_iter()
                        .map(|hit| SearchHit {
                            title: hit.title,
                            url: hit.url,
                            snippet: hit.snippet,
                        })
                        .collect(),
                    unresponsive_engines: result.unresponsive_engines,
                    elapsed_ms: result.elapsed_ms,
                })
            } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
                let result = self
                    .matcha
                    .verify_search(&matcha::SearchRequest {
                        query: request.query.clone(),
                        count: request.count,
                        categories: request.categories.clone(),
                        engines: request.engines.clone(),
                        language: request.language.clone(),
                        safe_search: request.safe_search,
                    })
                    .await
                    .map_err(matcha_error)?;
                Ok(SearchVerification {
                    results: result
                        .results
                        .into_iter()
                        .map(|hit| SearchHit {
                            title: hit.title,
                            url: hit.url,
                            snippet: hit.snippet,
                        })
                        .collect(),
                    unresponsive_engines: result.unresponsive_engines,
                    elapsed_ms: result.elapsed_ms,
                })
            } else {
                Err(SearchError::unsupported())
            }
        })
    }
}

fn openclaw_phase(phase: open_claw::SearchPhase) -> RuntimeSearchPhase {
    match phase {
        open_claw::SearchPhase::Disabled => RuntimeSearchPhase::Disabled,
        open_claw::SearchPhase::NotConfigured => RuntimeSearchPhase::NotConfigured,
        open_claw::SearchPhase::PendingRestart => RuntimeSearchPhase::PendingRestart,
        open_claw::SearchPhase::Ready => RuntimeSearchPhase::Ready,
    }
}

fn matcha_phase(phase: matcha::SearchPhase) -> RuntimeSearchPhase {
    match phase {
        matcha::SearchPhase::Disabled => RuntimeSearchPhase::Disabled,
        matcha::SearchPhase::NotConfigured => RuntimeSearchPhase::NotConfigured,
        matcha::SearchPhase::PendingRestart => RuntimeSearchPhase::PendingRestart,
        matcha::SearchPhase::Ready => RuntimeSearchPhase::Ready,
    }
}

fn openclaw_error(error: open_claw::SearchError) -> SearchError {
    match error {
        open_claw::SearchError::InvalidInput => SearchError::invalid(),
        open_claw::SearchError::Unsupported => SearchError::unsupported(),
        open_claw::SearchError::PolicyDenied => SearchError::native_policy_denied(),
        open_claw::SearchError::Unavailable => SearchError::unavailable(),
        _ => SearchError::native_failed(),
    }
}

fn matcha_error(error: matcha::SearchError) -> SearchError {
    match error {
        matcha::SearchError::VerificationUnsupported => SearchError::unsupported(),
        matcha::SearchError::Unavailable => SearchError::unavailable(),
        _ => SearchError::native_failed(),
    }
}
