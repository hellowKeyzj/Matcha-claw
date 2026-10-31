use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderAccount, ProviderModelCatalog, ProviderRouting, ProviderRoutingCapability, Resolver,
};

use super::{Failure, Kind, MAX_DURATION, Output, Protocol, Request, video};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum VideoTaskKind {
    #[serde(rename = "openai-video")]
    OpenAiVideo,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoTask {
    pub kind: VideoTaskKind,
    pub selection_id: String,
    pub account_id: String,
    pub model_id: String,
    pub endpoint_id: String,
    pub remote_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoTaskRequest {
    pub task: VideoTask,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoStatus {
    Queued,
    InProgress,
    Completed,
    Failed,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTaskOutput {
    pub task: VideoTask,
    pub status: VideoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

impl VideoTaskOutput {
    fn from_response(task: VideoTask, value: &Value) -> Self {
        let status = if value.get("error").is_some_and(|error| !error.is_null()) {
            VideoStatus::Failed
        } else {
            match value.get("status").and_then(Value::as_str) {
                Some("queued") => VideoStatus::Queued,
                Some("in_progress") => VideoStatus::InProgress,
                Some("completed") => VideoStatus::Completed,
                Some("failed") => VideoStatus::Failed,
                _ => VideoStatus::Unknown,
            }
        };
        let progress = value
            .get("progress")
            .and_then(Value::as_f64)
            .filter(|progress| progress.is_finite() && (0.0..=100.0).contains(progress));
        Self {
            task,
            status,
            progress,
        }
    }
}

pub(crate) async fn submit_video(
    client: Option<&Client>,
    resolver: &Resolver,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    request: Request,
    cancellation: CancellationToken,
) -> Result<VideoTaskOutput, Failure> {
    request.validate()?;
    if request.kind != Kind::Video {
        return Err(Failure::InvalidRequest);
    }
    let (account, model, timeout_ms) = super::select(
        accounts,
        catalog,
        routing,
        ProviderRoutingCapability::VideoGenerate,
        request.selection_id.as_deref(),
    )?;
    if !matches!(super::protocol(account)?, Protocol::OpenAi) {
        return Err(Failure::Unsupported);
    }
    video::validate_openai(model, &request)?;
    let capabilities = super::catalog::capabilities(account, model, Kind::Video)?;
    if request
        .size
        .as_deref()
        .or(model.resolution())
        .is_some_and(|size| {
            !capabilities
                .sizes
                .as_ref()
                .is_some_and(|sizes| sizes.contains(&size))
        })
    {
        return Err(Failure::Unsupported);
    }
    let endpoint = super::endpoint(account, Protocol::OpenAi)?;
    let client = client.ok_or(Failure::ProviderUnavailable)?;
    let duration = timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(MAX_DURATION)
        .min(MAX_DURATION);
    let execution = async {
        let credential = super::credential(account, resolver).await?;
        let value = video::submit(client, &endpoint, &credential, model, request).await?;
        let remote_id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| video::is_remote_id(id))
            .ok_or(Failure::InvalidResponse)?;
        let task = VideoTask {
            kind: VideoTaskKind::OpenAiVideo,
            selection_id: model.selection_id(),
            account_id: account.id().as_str().to_owned(),
            model_id: model.model_id().to_owned(),
            endpoint_id: endpoint_id(&endpoint),
            remote_id: remote_id.to_owned(),
        };
        // Return the remote identity before any poll/download; Design persists this receipt.
        Ok(VideoTaskOutput::from_response(task, &value))
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(duration, execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

pub(crate) async fn query_video(
    client: Option<&Client>,
    resolver: &Resolver,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    request: VideoTaskRequest,
    cancellation: CancellationToken,
) -> Result<VideoTaskOutput, Failure> {
    let (account, endpoint) = restore(accounts, catalog, &request.task)?;
    let client = client.ok_or(Failure::ProviderUnavailable)?;
    let execution = async {
        let credential = super::credential(account, resolver).await?;
        let value = video::query(client, &endpoint, &credential, &request.task.remote_id).await?;
        if value.get("id").and_then(Value::as_str) != Some(request.task.remote_id.as_str()) {
            return Err(Failure::InvalidResponse);
        }
        Ok(VideoTaskOutput::from_response(request.task, &value))
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(Duration::from_secs(60), execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

pub(crate) async fn collect_video(
    client: Option<&Client>,
    resolver: &Resolver,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    request: VideoTaskRequest,
    cancellation: CancellationToken,
) -> Result<Output, Failure> {
    let (account, endpoint) = restore(accounts, catalog, &request.task)?;
    let client = client.ok_or(Failure::ProviderUnavailable)?;
    let execution = async {
        let credential = super::credential(account, resolver).await?;
        // Collection never queries or submits: the caller already observed completion.
        video::collect(client, &endpoint, &credential, &request.task.remote_id).await
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(MAX_DURATION, execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

fn restore<'a>(
    accounts: &'a [ProviderAccount],
    catalog: &ProviderModelCatalog,
    task: &VideoTask,
) -> Result<(&'a ProviderAccount, Url), Failure> {
    if !video::is_remote_id(&task.remote_id) {
        return Err(Failure::InvalidRequest);
    }
    let account = accounts
        .iter()
        .find(|account| {
            account.id().as_str() == task.account_id && account.configuration().enabled()
        })
        .ok_or(Failure::TaskBindingChanged)?;
    if crate::provider_model_selection_id(account.id(), &task.model_id) != task.selection_id
        || !catalog.models().iter().any(|model| {
            model.account_id() == account.id()
                && model.model_id() == task.model_id
                && model.supports(crate::ProviderModelCapability::VideoGenerate)
        })
        || !matches!(super::protocol(account), Ok(Protocol::OpenAi))
    {
        return Err(Failure::TaskBindingChanged);
    }
    let endpoint =
        super::endpoint(account, Protocol::OpenAi).map_err(|_| Failure::TaskBindingChanged)?;
    if endpoint_id(&endpoint) != task.endpoint_id {
        return Err(Failure::TaskBindingChanged);
    }
    Ok((account, endpoint))
}

fn endpoint_id(endpoint: &Url) -> String {
    format!(
        "media-endpoint:v1:{:x}",
        Sha256::digest(endpoint.as_str().as_bytes())
    )
}
