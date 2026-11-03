mod ark;
mod catalog;
mod dashscope;
mod download;
mod google;
mod openai;
mod openrouter;
mod pixel_size;
mod task;
mod wire;

pub(crate) use catalog::list;
pub use catalog::{Capabilities, ListOutput, ListRequest, Model};
use task::RemoteVideo;
pub use task::{VideoStatus, VideoTask, VideoTaskKind, VideoTaskOutput, VideoTaskRequest};
pub(crate) use task::{collect_video, query_video, submit_video};

use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountKind, ProviderApiProtocol,
    ProviderMediaApiProtocol, ProviderModel, ProviderModelCapability, ProviderModelCatalog,
    ProviderRouting, ProviderRoutingCapability, Resolver,
    llm_client::LlmCredential,
    owner::models::{
        provider_execution_endpoint, provider_execution_protocol, provider_generation_credential,
    },
};

pub(crate) const MAX_REQUEST_BYTES: usize = 48 * 1024 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_DURATION: Duration = Duration::from_secs(20 * 60);
const MAX_OUTPUT_COUNT: u8 = 10;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Image,
    Video,
    #[serde(rename = "tts")]
    Speech,
    #[serde(rename = "transcribe")]
    Transcription,
    Music,
}

impl Kind {
    fn model_capability(self) -> ProviderModelCapability {
        match self {
            Self::Image => ProviderModelCapability::ImageGenerate,
            Self::Video => ProviderModelCapability::VideoGenerate,
            Self::Speech => ProviderModelCapability::TextToSpeech,
            Self::Transcription => ProviderModelCapability::Transcribe,
            Self::Music => ProviderModelCapability::MusicGenerate,
        }
    }

    fn routing_capability(self) -> Option<ProviderRoutingCapability> {
        match self {
            Self::Image => Some(ProviderRoutingCapability::ImageGenerate),
            Self::Video => Some(ProviderRoutingCapability::VideoGenerate),
            Self::Speech => Some(ProviderRoutingCapability::Tts),
            Self::Transcription => None,
            Self::Music => Some(ProviderRoutingCapability::MusicGenerate),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub kind: Kind,
    pub prompt: String,
    pub selection_id: Option<String>,
    #[serde(default)]
    pub images: Vec<Content>,
    pub mask: Option<Content>,
    pub size: Option<String>,
    pub duration_seconds: Option<u32>,
    pub count: Option<u8>,
    pub audio: Option<Content>,
    pub voice: Option<String>,
    pub language: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Content {
    pub data: String,
    pub mime_type: String,
}

#[derive(Serialize)]
pub struct Output {
    pub outputs: Vec<Content>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    InvalidRequest,
    SelectionUnavailable,
    Unsupported,
    CredentialMissing,
    CredentialUnavailable,
    Authentication,
    PermissionDenied,
    RateLimited,
    Deadline,
    Cancelled,
    ResponseTooLarge,
    InvalidResponse,
    GenerationFailed,
    ProviderUnavailable,
    OwnerUnavailable,
    TaskBindingChanged,
}

impl Failure {
    pub(crate) fn status(self) -> u16 {
        match self {
            Self::InvalidRequest => 400,
            Self::SelectionUnavailable | Self::TaskBindingChanged => 409,
            Self::Unsupported => 422,
            Self::Authentication | Self::PermissionDenied | Self::GenerationFailed => 502,
            Self::RateLimited => 429,
            Self::Deadline => 504,
            Self::Cancelled => 499,
            Self::ResponseTooLarge | Self::InvalidResponse => 502,
            Self::CredentialMissing
            | Self::CredentialUnavailable
            | Self::ProviderUnavailable
            | Self::OwnerUnavailable => 503,
        }
    }

    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "Media request or input content is invalid",
            Self::SelectionUnavailable => {
                "Configure an enabled media model and its generation route or select it explicitly"
            }
            Self::Unsupported => {
                "The selected media protocol, authentication or options are unsupported"
            }
            Self::CredentialMissing => "Add credentials to the selected provider account",
            Self::CredentialUnavailable => "Provider credentials could not be resolved",
            Self::Authentication => "The media provider rejected its credentials",
            Self::PermissionDenied => "The media provider denied this generation request",
            Self::RateLimited => {
                "The media provider rate limit was reached; no submission was retried"
            }
            Self::Deadline => {
                "Media generation exceeded its time limit; an upstream job may still exist"
            }
            Self::Cancelled => "Media generation was cancelled; an upstream job may still exist",
            Self::ResponseTooLarge => "Media response exceeded the output size limit",
            Self::InvalidResponse => "The media provider returned an invalid response",
            Self::GenerationFailed => "The media provider reported generation failure",
            Self::ProviderUnavailable => {
                "The media provider is unavailable; no submission was retried"
            }
            Self::OwnerUnavailable => "The provider owner is unavailable",
            Self::TaskBindingChanged => {
                "The video's original provider account or endpoint changed; restore it before querying again, do not resubmit"
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Protocol {
    OpenAi,
    Google,
    OpenRouter,
    DashScope,
    Ark,
}

impl Protocol {
    fn capabilities(self, model: &ProviderModel, kind: Kind) -> Result<Capabilities, Failure> {
        match self {
            Self::OpenAi => openai::capabilities(model, kind),
            Self::Google => google::capabilities(model, kind),
            Self::OpenRouter => openrouter::capabilities(model, kind),
            Self::DashScope => dashscope::capabilities(model, kind),
            Self::Ark => ark::capabilities(model, kind),
        }
    }

    fn validate(self, model: &ProviderModel, request: &Request) -> Result<(), Failure> {
        match self {
            Self::OpenAi => openai::validate(model, request),
            Self::Google => google::validate(model, request),
            Self::OpenRouter => openrouter::validate(model, request),
            Self::DashScope => dashscope::validate(model, request),
            Self::Ark => ark::validate(model, request),
        }
    }

    async fn generate(
        self,
        client: &Client,
        endpoint: &Url,
        credential: &LlmCredential,
        model: &ProviderModel,
        request: Request,
    ) -> Result<Output, Failure> {
        match self {
            Self::OpenAi => openai::generate(client, endpoint, credential, model, request).await,
            Self::Google => google::generate(client, endpoint, credential, model, request).await,
            Self::OpenRouter => {
                openrouter::generate(client, endpoint, credential, model, request).await
            }
            Self::DashScope => {
                dashscope::generate(client, endpoint, credential, model, request).await
            }
            Self::Ark => ark::generate(client, endpoint, credential, model, request).await,
        }
    }
}

impl Request {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if self.kind != Kind::Transcription && self.prompt.trim().is_empty()
            || self.prompt.len() > 128_000
            || self.prompt.chars().count() > 32_000
            || self.selection_id.as_ref().is_some_and(|id| {
                id.len() != "model-selection:v1:".len() + 64
                    || !id.starts_with("model-selection:v1:")
                    || !id["model-selection:v1:".len()..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
            })
            || self.images.len() > 16
            || self
                .count
                .is_some_and(|count| !(1..=MAX_OUTPUT_COUNT).contains(&count))
            || self.duration_seconds == Some(0)
            || [&self.size, &self.voice, &self.language]
                .into_iter()
                .any(|option| {
                    option.as_ref().is_some_and(|value| {
                        value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
                    })
                })
            || self.mask.is_some() && self.images.is_empty()
            || self.kind == Kind::Transcription && self.audio.is_none()
        {
            return Err(Failure::InvalidRequest);
        }
        if matches!(self.kind, Kind::Image | Kind::Video)
            && (self.audio.is_some() || self.voice.is_some() || self.language.is_some())
        {
            return Err(Failure::Unsupported);
        }
        let mut input_bytes = 0;
        if let Some(mask) = &self.mask {
            let bytes = wire::decode_input(mask)?;
            if mask.mime_type != "image/png" || bytes.len() >= 4 * 1024 * 1024 {
                return Err(Failure::InvalidRequest);
            }
            input_bytes += bytes.len();
        }
        for image in &self.images {
            input_bytes += wire::decode_input(image)?.len();
            if input_bytes > 32 * 1024 * 1024 {
                return Err(Failure::InvalidRequest);
            }
        }
        if let Some(audio) = &self.audio {
            input_bytes += wire::decode_audio_input(audio)?.len();
        }
        if input_bytes > 32 * 1024 * 1024 {
            return Err(Failure::InvalidRequest);
        }
        Ok(())
    }
}

pub(crate) async fn generate(
    client: Option<&Client>,
    resolver: &Resolver,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    request: Request,
    cancellation: CancellationToken,
) -> Result<Output, Failure> {
    if request.kind == Kind::Video {
        return task::generate_video(
            client,
            resolver,
            accounts,
            catalog,
            routing,
            request,
            cancellation,
        )
        .await;
    }
    request.validate()?;
    let (account, model, timeout_ms) = select(
        accounts,
        catalog,
        routing,
        request.kind,
        request.selection_id.as_deref(),
    )?;
    let protocol = protocol(account)?;
    // Validate options before resolving a credential or starting any charged submission.
    protocol.validate(model, &request)?;
    let endpoint = endpoint(account, protocol)?;
    let client = client.ok_or(Failure::ProviderUnavailable)?;
    let execution = async {
        let credential = credential(account, resolver).await?;
        protocol
            .generate(client, &endpoint, &credential, model, request)
            .await
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Failure::Cancelled),
        outcome = tokio::time::timeout(duration(timeout_ms), execution) => outcome.unwrap_or(Err(Failure::Deadline)),
    }
}

fn duration(timeout_ms: Option<u64>) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(MAX_DURATION)
        .min(MAX_DURATION)
}

async fn credential(
    account: &ProviderAccount,
    resolver: &Resolver,
) -> Result<LlmCredential, Failure> {
    provider_generation_credential(account, resolver)
        .await
        .map_err(|reason| match reason {
            crate::ProviderTextGenerationUnavailableReason::CredentialMissing => {
                Failure::CredentialMissing
            }
            _ => Failure::CredentialUnavailable,
        })?
        .ok_or(Failure::Unsupported)
}

fn endpoint(account: &ProviderAccount, protocol: Protocol) -> Result<Url, Failure> {
    let default_endpoint = match protocol {
        Protocol::OpenAi => "https://api.openai.com/v1",
        Protocol::Google => "https://generativelanguage.googleapis.com/v1beta",
        Protocol::OpenRouter => "https://openrouter.ai/api/v1",
        Protocol::DashScope => "https://dashscope.aliyuncs.com/api/v1",
        Protocol::Ark => "https://ark.cn-beijing.volces.com/api/v3",
    };
    let endpoint = match account.configuration().kind() {
        ProviderAccountKind::Chat => provider_execution_endpoint(account)
            .map_err(|_| Failure::Unsupported)?
            .as_str()
            .to_owned(),
        ProviderAccountKind::Media => account
            .configuration()
            .endpoint()
            .map(|endpoint| endpoint.as_str())
            .unwrap_or(default_endpoint)
            .to_owned(),
    };
    wire::endpoint(&endpoint, protocol)
}

fn protocol(account: &ProviderAccount) -> Result<Protocol, Failure> {
    let configuration = account.configuration();
    if !matches!(
        configuration.auth_mode(),
        ProviderAccountAuthMode::ApiKey | ProviderAccountAuthMode::Token
    ) {
        return Err(Failure::Unsupported);
    }
    let protocol = match configuration.kind() {
        ProviderAccountKind::Media => match configuration.media_protocol() {
            Some(ProviderMediaApiProtocol::OpenAi) => Protocol::OpenAi,
            Some(ProviderMediaApiProtocol::Google) => Protocol::Google,
            Some(ProviderMediaApiProtocol::OpenRouter) => Protocol::OpenRouter,
            Some(ProviderMediaApiProtocol::DashScope) => Protocol::DashScope,
            Some(ProviderMediaApiProtocol::Ark) => Protocol::Ark,
            None => return Err(Failure::Unsupported),
        },
        ProviderAccountKind::Chat => match provider_execution_protocol(account) {
            Some(ProviderApiProtocol::OpenAiCompletions | ProviderApiProtocol::OpenAiResponses) => {
                match account.provider().as_str() {
                    "provider:openrouter" => Protocol::OpenRouter,
                    "provider:ark" => Protocol::Ark,
                    _ => Protocol::OpenAi,
                }
            }
            Some(ProviderApiProtocol::GoogleGenerativeAi) => Protocol::Google,
            _ => return Err(Failure::Unsupported),
        },
    };
    if protocol == Protocol::Google && configuration.auth_mode() != ProviderAccountAuthMode::ApiKey
    {
        return Err(Failure::Unsupported);
    }
    Ok(protocol)
}

fn select<'a>(
    accounts: &'a [ProviderAccount],
    catalog: &'a ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    kind: Kind,
    selection_id: Option<&str>,
) -> Result<(&'a ProviderAccount, &'a ProviderModel, Option<u64>), Failure> {
    let route = kind
        .routing_capability()
        .and_then(|capability| routing.and_then(|routing| routing.route(capability)));
    let model = catalog
        .models()
        .iter()
        .find(|model| {
            model.supports(kind.model_capability())
                && match selection_id {
                    Some(selection_id) => model.selection_id() == selection_id,
                    None => route.is_some_and(|route| {
                        model.account_id() == route.primary().account_id()
                            && model.model_id() == route.primary().model_id()
                    }),
                }
        })
        .ok_or(Failure::SelectionUnavailable)?;
    let account = accounts
        .iter()
        .find(|account| account.id() == model.account_id() && account.configuration().enabled())
        .ok_or(Failure::SelectionUnavailable)?;
    // A media submission is not replayable: route fallbacks never resubmit a charged request.
    let timeout_ms = selection_id
        .is_none()
        .then(|| route.and_then(|route| route.timeout_ms()))
        .flatten()
        .or(model.timeout_ms());
    Ok((account, model, timeout_ms))
}
