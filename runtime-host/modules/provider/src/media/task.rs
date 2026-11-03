use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderAccount, ProviderModel, ProviderModelCatalog, ProviderRouting, Resolver,
    llm_client::LlmCredential,
};

use super::{
    Failure, Kind, MAX_DURATION, Output, Protocol, Request, ark, dashscope, google, openai,
    openrouter,
};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum VideoTaskKind {
    #[serde(rename = "openai-video")]
    OpenAiVideo,
    #[serde(rename = "google-video")]
    GoogleVideo,
    #[serde(rename = "openrouter-video")]
    OpenRouterVideo,
    #[serde(rename = "dashscope-video")]
    DashScopeVideo,
    #[serde(rename = "ark-video")]
    ArkVideo,
}

impl VideoTaskKind {
    fn protocol(self) -> Protocol {
        match self {
            Self::OpenAiVideo => Protocol::OpenAi,
            Self::GoogleVideo => Protocol::Google,
            Self::OpenRouterVideo => Protocol::OpenRouter,
            Self::DashScopeVideo => Protocol::DashScope,
            Self::ArkVideo => Protocol::Ark,
        }
    }
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

pub(super) struct RemoteVideo {
    pub id: String,
    pub status: VideoStatus,
    pub progress: Option<f64>,
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
    fn from_remote(task: VideoTask, remote: RemoteVideo) -> Result<Self, Failure> {
        if remote.id != task.remote_id
            || remote
                .progress
                .is_some_and(|progress| !progress.is_finite() || !(0.0..=100.0).contains(&progress))
        {
            return Err(Failure::InvalidResponse);
        }
        Ok(Self {
            task,
            status: remote.status,
            progress: remote.progress,
        })
    }
}

impl Protocol {
    fn task_kind(self) -> VideoTaskKind {
        match self {
            Self::OpenAi => VideoTaskKind::OpenAiVideo,
            Self::Google => VideoTaskKind::GoogleVideo,
            Self::OpenRouter => VideoTaskKind::OpenRouterVideo,
            Self::DashScope => VideoTaskKind::DashScopeVideo,
            Self::Ark => VideoTaskKind::ArkVideo,
        }
    }

    fn is_remote_id(self, id: &str) -> bool {
        match self {
            Self::OpenAi => openai::is_remote_id(id),
            Self::Google => google::is_remote_id(id),
            Self::OpenRouter => openrouter::is_remote_id(id),
            Self::DashScope => dashscope::is_remote_id(id),
            Self::Ark => ark::is_remote_id(id),
        }
    }

    async fn submit_video(
        self,
        client: &Client,
        endpoint: &Url,
        credential: &LlmCredential,
        model: &ProviderModel,
        request: Request,
    ) -> Result<RemoteVideo, Failure> {
        match self {
            Self::OpenAi => {
                openai::submit_video(client, endpoint, credential, model, request).await
            }
            Self::Google => {
                google::submit_video(client, endpoint, credential, model, request).await
            }
            Self::OpenRouter => {
                openrouter::submit_video(client, endpoint, credential, model, request).await
            }
            Self::DashScope => {
                dashscope::submit_video(client, endpoint, credential, model, request).await
            }
            Self::Ark => ark::submit_video(client, endpoint, credential, model, request).await,
        }
    }

    async fn query_video(
        self,
        client: &Client,
        endpoint: &Url,
        credential: &LlmCredential,
        id: &str,
    ) -> Result<RemoteVideo, Failure> {
        match self {
            Self::OpenAi => openai::query_video(client, endpoint, credential, id).await,
            Self::Google => google::query_video(client, endpoint, credential, id).await,
            Self::OpenRouter => openrouter::query_video(client, endpoint, credential, id).await,
            Self::DashScope => dashscope::query_video(client, endpoint, credential, id).await,
            Self::Ark => ark::query_video(client, endpoint, credential, id).await,
        }
    }

    async fn collect_video(
        self,
        client: &Client,
        endpoint: &Url,
        credential: &LlmCredential,
        id: &str,
    ) -> Result<Output, Failure> {
        match self {
            Self::OpenAi => openai::collect_video(client, endpoint, credential, id).await,
            Self::Google => google::collect_video(client, endpoint, credential, id).await,
            Self::OpenRouter => openrouter::collect_video(client, endpoint, credential, id).await,
            Self::DashScope => dashscope::collect_video(client, endpoint, credential, id).await,
            Self::Ark => ark::collect_video(client, endpoint, credential, id).await,
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
        Kind::Video,
        request.selection_id.as_deref(),
    )?;
    let protocol = super::protocol(account)?;
    protocol.validate(model, &request)?;
    let endpoint = super::endpoint(account, protocol)?;
    let client = client.ok_or(Failure::ProviderUnavailable)?;
    let execution = async {
        let credential = super::credential(account, resolver).await?;
        let remote = protocol
            .submit_video(client, &endpoint, &credential, model, request)
            .await?;
        if !protocol.is_remote_id(&remote.id) {
            return Err(Failure::InvalidResponse);
        }
        let task = VideoTask {
            kind: protocol.task_kind(),
            selection_id: model.selection_id(),
            account_id: account.id().as_str().to_owned(),
            model_id: model.model_id().to_owned(),
            endpoint_id: endpoint_id(&endpoint),
            remote_id: remote.id.clone(),
        };
        // The caller persists this receipt before any poll or download.
        VideoTaskOutput::from_remote(task, remote)
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(super::duration(timeout_ms), execution) => outcome.unwrap_or(Err(Failure::Deadline)),
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
        let remote = request
            .task
            .kind
            .protocol()
            .query_video(client, &endpoint, &credential, &request.task.remote_id)
            .await?;
        VideoTaskOutput::from_remote(request.task, remote)
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
        // A protocol may query the original task for its artifact, but never submit again.
        request
            .task
            .kind
            .protocol()
            .collect_video(client, &endpoint, &credential, &request.task.remote_id)
            .await
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(MAX_DURATION, execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

pub(super) async fn generate_video(
    client: Option<&Client>,
    resolver: &Resolver,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    request: Request,
    cancellation: CancellationToken,
) -> Result<Output, Failure> {
    let (_, _, timeout_ms) = super::select(
        accounts,
        catalog,
        routing,
        Kind::Video,
        request.selection_id.as_deref(),
    )?;
    let execution = async {
        let mut receipt = submit_video(
            client,
            resolver,
            accounts,
            catalog,
            routing,
            request,
            cancellation.clone(),
        )
        .await?;
        loop {
            match receipt.status {
                VideoStatus::Completed => {
                    return collect_video(
                        client,
                        resolver,
                        accounts,
                        catalog,
                        VideoTaskRequest { task: receipt.task },
                        cancellation.clone(),
                    )
                    .await;
                }
                VideoStatus::Failed => return Err(Failure::GenerationFailed),
                VideoStatus::Unknown => return Err(Failure::InvalidResponse),
                VideoStatus::Queued | VideoStatus::InProgress => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    receipt = query_video(
                        client,
                        resolver,
                        accounts,
                        catalog,
                        VideoTaskRequest { task: receipt.task },
                        cancellation.clone(),
                    )
                    .await?;
                }
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(super::duration(timeout_ms), execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

fn restore<'a>(
    accounts: &'a [ProviderAccount],
    catalog: &ProviderModelCatalog,
    task: &VideoTask,
) -> Result<(&'a ProviderAccount, Url), Failure> {
    let protocol = task.kind.protocol();
    if !protocol.is_remote_id(&task.remote_id) {
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
                && model.supports(Kind::Video.model_capability())
        })
        || !super::protocol(account).is_ok_and(|current| current == protocol)
    {
        return Err(Failure::TaskBindingChanged);
    }
    let endpoint = super::endpoint(account, protocol).map_err(|_| Failure::TaskBindingChanged)?;
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
