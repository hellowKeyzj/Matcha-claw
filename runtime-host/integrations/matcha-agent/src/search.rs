use std::{fmt, path::PathBuf, sync::Arc, time::Duration};

use foundation::process::supervision::SupervisorPhase;
use foundation::toolchain::{
    FoundationToolchainCommandPort, ToolchainCommandOutcome, ToolchainCommandPort,
    ToolchainCommandRequest,
};
use platform::state_dir::CanonicalStateDir;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{client::Client, driver::MatchaRuntimeDriver};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProjection {
    pub base_url: String,
    pub categories: String,
    pub language: String,
    pub safe_search: u8,
    pub result_count: u8,
    pub revision: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchPhase {
    Disabled,
    NotConfigured,
    PendingRestart,
    Ready,
}

#[derive(Clone, Debug)]
pub struct SearchRequest {
    pub query: String,
    pub categories: Option<String>,
    pub engines: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<u8>,
    pub count: usize,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchError {
    Unavailable,
    Rejected,
    OutcomeUnknown,
    InvalidReadback,
    VerificationUnsupported,
}

impl fmt::Display for SearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Matcha search configuration is unavailable; start the runtime and retry",
            Self::Rejected => "Matcha rejected the search settings; check the native configuration",
            Self::OutcomeUnknown => "Matcha search configuration outcome is unknown; observe before retrying",
            Self::InvalidReadback => "Matcha search configuration readback did not match",
            Self::VerificationUnsupported => "Matcha has no non-model WebSearch invocation API; verify from an authorized native session",
        })
    }
}

impl std::error::Error for SearchError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    phase: SearchPhase,
    configured: Option<SearchProjection>,
}

#[derive(Clone)]
pub(crate) struct OfflineControl {
    executable: PathBuf,
    home: PathBuf,
    commands: Arc<FoundationToolchainCommandPort>,
}

impl OfflineControl {
    pub(crate) fn new(
        executable: PathBuf,
        home: PathBuf,
        working_directory: PathBuf,
        #[cfg(unix)] guardian_executable: PathBuf,
    ) -> Self {
        Self {
            executable,
            home,
            commands: Arc::new(FoundationToolchainCommandPort::new(
                working_directory,
                #[cfg(unix)]
                guardian_executable,
            )),
        }
    }

    async fn configured(&self) -> Result<Option<SearchProjection>, SearchError> {
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let directory = CanonicalStateDir::provision_private(home)
                .map_err(|_| SearchError::Unavailable)?
                .open()
                .map_err(|_| SearchError::Unavailable)?;
            // Same native home lock as the launcher and ConfigStore. NotSent does
            // not prove the server stopped; a live owner makes this read fail.
            let lock = directory
                .lock_regular_file("matcha-agent.lock")
                .map_err(|_| SearchError::Unavailable)?;
            let read = (|| {
                let Some(bytes) = directory
                    .read_regular_file_bounded("matcha-agent.json", usize::MAX)
                    .map_err(|_| SearchError::Unavailable)?
                else {
                    return Ok(None);
                };
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| SearchError::InvalidReadback)?;
                let fields = value.as_object().ok_or(SearchError::InvalidReadback)?;
                fields
                    .get("search")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        serde_json::from_value(value.clone())
                            .map_err(|_| SearchError::InvalidReadback)
                    })
                    .transpose()
            })();
            lock.unlock().map_err(|_| SearchError::OutcomeUnknown)?;
            read
        })
        .await
        .map_err(|_| SearchError::OutcomeUnknown)?
    }

    async fn observe(&self) -> Result<SearchPhase, SearchError> {
        Ok(if self.configured().await?.is_none() {
            SearchPhase::Disabled
        } else {
            SearchPhase::PendingRestart
        })
    }

    async fn disable(&self) -> Result<SearchPhase, SearchError> {
        if self.configured().await?.is_none() {
            return Ok(SearchPhase::Disabled);
        }
        let outcome = self
            .commands
            .execute(ToolchainCommandRequest::new(
                self.executable.clone(),
                [
                    "--home".into(),
                    self.home.clone().into_os_string(),
                    "--search-disable".into(),
                ],
                Some(Duration::from_secs(15)),
            ))
            .await;
        match outcome {
            ToolchainCommandOutcome::Succeeded if self.configured().await?.is_none() => {
                Ok(SearchPhase::Disabled)
            }
            ToolchainCommandOutcome::Succeeded => Err(SearchError::InvalidReadback),
            ToolchainCommandOutcome::Unknown | ToolchainCommandOutcome::TimedOut => {
                Err(SearchError::OutcomeUnknown)
            }
            _ => Err(SearchError::Unavailable),
        }
    }
}

impl MatchaRuntimeDriver {
    pub async fn apply_search(
        &self,
        projection: Option<&SearchProjection>,
    ) -> Result<SearchPhase, SearchError> {
        if projection.is_none() && self.search_offline() {
            return self.search.disable().await;
        }
        match self
            .native_client()
            .call("search.project", json!({ "projection": projection }))
            .await
        {
            Ok(response) => applied(response, projection),
            Err(error)
                if projection.is_none() && error.delivery() == crate::client::Delivery::NotSent =>
            {
                self.search.disable().await
            }
            Err(error) => Err(transport_error(error)),
        }
    }

    pub async fn observe_search(&self) -> Result<SearchPhase, SearchError> {
        if self.search_offline() {
            return self.search.observe().await;
        }
        match self.native_client().call("search.observe", json!({})).await {
            Ok(response) => observation(response).map(|observed| observed.phase),
            Err(error) if error.delivery() == crate::client::Delivery::NotSent => {
                self.search.observe().await
            }
            Err(error) => Err(transport_error(error)),
        }
    }

    fn search_offline(&self) -> bool {
        let snapshot = self.lifecycle_handle().snapshot();
        snapshot.process().is_none()
            && matches!(
                snapshot.phase(),
                SupervisorPhase::Idle
                    | SupervisorPhase::OperationFailed
                    | SupervisorPhase::ShutDown
            )
    }

    pub async fn verify_search(
        &self,
        request: &SearchRequest,
    ) -> Result<SearchVerification, SearchError> {
        verify(&self.native_client(), request).await
    }
}

pub async fn apply(
    client: &Client,
    projection: Option<&SearchProjection>,
) -> Result<SearchPhase, SearchError> {
    let response = client
        .call("search.project", json!({ "projection": projection }))
        .await
        .map_err(transport_error)?;
    applied(response, projection)
}

fn observation(response: Value) -> Result<Observation, SearchError> {
    serde_json::from_value(response).map_err(|_| SearchError::InvalidReadback)
}

fn applied(
    response: Value,
    projection: Option<&SearchProjection>,
) -> Result<SearchPhase, SearchError> {
    let observed = observation(response)?;
    if observed.configured.as_ref() != projection {
        return Err(SearchError::InvalidReadback);
    }
    Ok(observed.phase)
}

pub async fn observe(client: &Client) -> Result<SearchPhase, SearchError> {
    let response = client
        .call("search.observe", json!({}))
        .await
        .map_err(transport_error)?;
    let observed: Observation =
        serde_json::from_value(response).map_err(|_| SearchError::InvalidReadback)?;
    Ok(observed.phase)
}

pub async fn verify(
    _client: &Client,
    _request: &SearchRequest,
) -> Result<SearchVerification, SearchError> {
    // Tool execution still belongs to the native permission/query pipeline, never a paid probe run.
    Err(SearchError::VerificationUnsupported)
}

fn transport_error(error: crate::client::Error) -> SearchError {
    match error.delivery() {
        crate::client::Delivery::Unknown => SearchError::OutcomeUnknown,
        crate::client::Delivery::NotSent => SearchError::Unavailable,
        crate::client::Delivery::ResponseReceived => match error.code() {
            Some(-32602 | -32001 | -32002) => SearchError::Rejected,
            Some(-32006) => SearchError::OutcomeUnknown,
            _ => SearchError::Unavailable,
        },
    }
}
