use std::{collections::BTreeSet, time::Duration};

use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::models::{
    ProviderModelOwner, default_discovery_endpoint, default_discovery_protocol, provider_api_key,
};
use crate::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountDraft, ProviderAccountKind,
    ProviderApiProtocol, ProviderCascade, ProviderMediaApiProtocol, ProviderModelCapability,
    ProviderModelDiscoverOutcome, ProviderModelDiscoveryView, ProviderModelDraft,
    ProviderTextGenerationUnavailableReason,
    application::model_reference,
    ports::{ProviderModelDiscoveryPortOutcome, ProviderRuntimeDirectory},
};

const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_MODELS: usize = 4096;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Failure {
    InvalidRequest,
    Unsupported,
    CredentialMissing,
    CredentialUnavailable,
    Authentication,
    PermissionDenied,
    RateLimited,
    Deadline,
    InvalidResponse,
    Unavailable,
}

// Private request material has no Debug/Serialize and never enters a call record.
pub(crate) struct DraftRequest {
    pub(crate) account: ProviderAccountDraft,
    pub(crate) api_key: Option<String>,
    pub(crate) token: Option<String>,
}

impl ProviderModelOwner {
    pub(crate) async fn discover(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        cascade: &mut ProviderCascade,
        account_id: &crate::ProviderAccountId,
        diagnostic: &mut Option<ProviderTextGenerationUnavailableReason>,
    ) -> ProviderModelDiscoverOutcome {
        if cascade.reload().is_err() {
            return ProviderModelDiscoverOutcome::Unavailable;
        }
        let Some(account) = cascade.account(account_id) else {
            return ProviderModelDiscoverOutcome::Rejected;
        };
        match tokio::time::timeout(
            Duration::from_secs(3),
            self.discover_account(runtime, account, None),
        )
        .await
        .unwrap_or(Err(Failure::Deadline))
        {
            Ok(models) => ProviderModelDiscoverOutcome::Discovered(models),
            Err(reason) => {
                *diagnostic = Some(match reason {
                    Failure::CredentialMissing => {
                        ProviderTextGenerationUnavailableReason::CredentialMissing
                    }
                    Failure::CredentialUnavailable => {
                        ProviderTextGenerationUnavailableReason::CredentialUnavailable
                    }
                    Failure::Authentication => {
                        ProviderTextGenerationUnavailableReason::Authentication
                    }
                    Failure::PermissionDenied => {
                        ProviderTextGenerationUnavailableReason::PermissionDenied
                    }
                    Failure::RateLimited => ProviderTextGenerationUnavailableReason::RateLimited,
                    Failure::Deadline => ProviderTextGenerationUnavailableReason::Deadline,
                    Failure::InvalidResponse => {
                        ProviderTextGenerationUnavailableReason::InvalidResponse
                    }
                    _ => ProviderTextGenerationUnavailableReason::ProviderUnavailable,
                });
                if matches!(reason, Failure::InvalidRequest | Failure::Unsupported) {
                    ProviderModelDiscoverOutcome::Rejected
                } else {
                    ProviderModelDiscoverOutcome::Unavailable
                }
            }
        }
    }

    pub(crate) async fn discover_draft(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        accounts: &[ProviderAccount],
        request: DraftRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<ProviderModelDiscoveryView>, Failure> {
        request
            .account
            .validate()
            .map_err(|_| Failure::InvalidRequest)?;
        let valid_secret = |secret: &str| {
            !secret.trim().is_empty() && secret.len() <= 16 * 1024 && !secret.contains('\0')
        };
        if request
            .api_key
            .as_deref()
            .is_some_and(|secret| request.account.auth_mode() != "apiKey" || !valid_secret(secret))
            || request.token.as_deref().is_some_and(|secret| {
                request.account.auth_mode() != "token" || !valid_secret(secret)
            })
        {
            return Err(Failure::InvalidRequest);
        }
        if request.account.kind() == "media"
            && matches!(request.account.media_protocol(), Some("dashScope" | "ark"))
        {
            return Err(Failure::Unsupported);
        }
        let existing = request
            .account
            .existing_account(accounts)
            .map_err(|_| Failure::InvalidRequest)?;
        let account = request
            .account
            .materialize(None, "1970-01-01T00:00:00Z")
            .map_err(|_| Failure::InvalidRequest)?;
        let supplied = request.api_key.or(request.token);
        let account = if supplied.is_none()
            && !matches!(
                account.configuration().auth_mode(),
                ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse
            ) {
            let existing = existing.ok_or(Failure::CredentialMissing)?;
            let current = existing.configuration();
            let draft = account.configuration();
            // A stored key is authority for this exact authentication target, not merely an ID.
            if existing.provider() != account.provider()
                || current.kind() != draft.kind()
                || current.auth_mode() != draft.auth_mode()
                || current.protocol() != draft.protocol()
                || current.media_protocol() != draft.media_protocol()
                || endpoint(existing) != endpoint(&account)
            {
                return Err(Failure::InvalidRequest);
            }
            request
                .account
                .materialize(Some(existing), "1970-01-01T00:00:00Z")
                .map_err(|_| Failure::InvalidRequest)?
        } else {
            account
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Failure::Unavailable),
            result = tokio::time::timeout(Duration::from_secs(3), self.discover_account(runtime, &account, supplied)) => result.unwrap_or(Err(Failure::Deadline)),
        }
    }

    async fn discover_account(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        account: &ProviderAccount,
        supplied: Option<String>,
    ) -> Result<Vec<ProviderModelDiscoveryView>, Failure> {
        let media = account.configuration().kind() == ProviderAccountKind::Media;
        if media {
            if matches!(
                account.configuration().media_protocol(),
                Some(ProviderMediaApiProtocol::DashScope | ProviderMediaApiProtocol::Ark)
            ) || account.configuration().auth_mode() != ProviderAccountAuthMode::ApiKey
            {
                return Err(Failure::Unsupported);
            }
        } else if runtime_discovery_provider(account) && supplied.is_none() {
            return discover_runtime(runtime, account).await;
        }
        let base = endpoint(account).ok_or(Failure::Unsupported)?;
        let api_key = match supplied {
            Some(secret) => Some(secret),
            None => match account.configuration().auth_mode() {
                ProviderAccountAuthMode::Local => None,
                ProviderAccountAuthMode::ApiKey | ProviderAccountAuthMode::Token => Some(
                    provider_api_key(account, &self.private_resolver)
                        .await
                        .map_err(|reason| match reason {
                            ProviderTextGenerationUnavailableReason::CredentialMissing => {
                                Failure::CredentialMissing
                            }
                            _ => Failure::CredentialUnavailable,
                        })?,
                ),
                _ => return Err(Failure::Unsupported),
            },
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| Failure::Unavailable)?;
        let protocol = if media {
            match account
                .configuration()
                .media_protocol()
                .ok_or(Failure::Unsupported)?
            {
                ProviderMediaApiProtocol::Google => ProviderApiProtocol::GoogleGenerativeAi,
                ProviderMediaApiProtocol::OpenAi | ProviderMediaApiProtocol::OpenRouter => {
                    ProviderApiProtocol::OpenAiCompletions
                }
                ProviderMediaApiProtocol::DashScope | ProviderMediaApiProtocol::Ark => {
                    return Err(Failure::Unsupported);
                }
            }
        } else {
            account
                .configuration()
                .protocol()
                .or_else(|| default_discovery_protocol(account.provider().as_str()))
                .ok_or(Failure::Unsupported)?
        };
        let mut remaining = MAX_RESPONSE_BYTES;
        let drafts = if account.provider().as_str() == "provider:ollama" && !media {
            let base = normalized_base(base)?;
            let base = base.strip_suffix("/v1").unwrap_or(&base);
            let value =
                discovery_json(client.get(format!("{base}/api/tags")), &mut remaining).await?;
            let models = value
                .get("models")
                .and_then(Value::as_array)
                .ok_or(Failure::InvalidResponse)?;
            collect(models, false, |model| {
                model
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|id| (id, vec![ProviderModelCapability::Chat]))
            })?
        } else {
            match protocol {
                ProviderApiProtocol::GoogleGenerativeAi => {
                    discover_google(&client, base, api_key, media, &mut remaining).await?
                }
                ProviderApiProtocol::AnthropicMessages => {
                    let mut base = normalized_base(base)?;
                    if !base.ends_with("/v1") {
                        base.push_str("/v1");
                    }
                    let secret = api_key.ok_or(Failure::CredentialMissing)?;
                    let request = client
                        .get(format!("{base}/models"))
                        .header("anthropic-version", "2023-06-01");
                    let request =
                        if account.configuration().auth_mode() == ProviderAccountAuthMode::Token {
                            request
                                .bearer_auth(secret)
                                .header("anthropic-beta", "oauth-2025-04-20")
                        } else {
                            request.header("x-api-key", secret)
                        };
                    let value = discovery_json(request, &mut remaining).await?;
                    let models = value
                        .get("data")
                        .and_then(Value::as_array)
                        .ok_or(Failure::InvalidResponse)?;
                    collect(models, false, |model| {
                        model
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| (id, vec![ProviderModelCapability::Chat]))
                    })?
                }
                ProviderApiProtocol::OpenAiCompletions | ProviderApiProtocol::OpenAiResponses => {
                    let mut base = normalized_base(base)?;
                    for suffix in ["/chat/completions", "/responses", "/response"] {
                        if let Some(prefix) = base.strip_suffix(suffix) {
                            base = prefix.to_owned();
                        }
                    }
                    let openrouter = if media {
                        account.configuration().media_protocol()
                            == Some(ProviderMediaApiProtocol::OpenRouter)
                    } else {
                        account.provider().as_str() == "provider:openrouter"
                    };
                    if media && openrouter {
                        return discover_openrouter(&client, &base, api_key, &mut remaining).await;
                    }
                    let mut request = client.get(format!("{base}/models"));
                    if let Some(secret) = api_key {
                        request = request.bearer_auth(secret);
                    }
                    let value = discovery_json(request, &mut remaining).await?;
                    let models = value
                        .get("data")
                        .and_then(Value::as_array)
                        .ok_or(Failure::InvalidResponse)?;
                    collect(models, media, |model| {
                        model.get("id").and_then(Value::as_str).map(|id| {
                            let capabilities = if openrouter {
                                modalities(model.get("architecture"))
                            } else {
                                known_capabilities(id)
                            };
                            (id, capabilities)
                        })
                    })?
                }
            }
        };
        Ok(drafts
            .into_iter()
            .map(ProviderModelDiscoveryView::from_draft)
            .collect())
    }
}

async fn discover_runtime(
    runtime: &dyn ProviderRuntimeDirectory,
    account: &ProviderAccount,
) -> Result<Vec<ProviderModelDiscoveryView>, Failure> {
    let identity_ops = runtime
        .provider_runtime_identity_ops(
            &crate::ProviderSessionEndpoint::OpenClawLocal.runtime_endpoint(),
        )
        .ok_or(Failure::Unavailable)?;
    let identity = identity_ops
        .runtime_identity(account)
        .map_err(|_| Failure::Unsupported)?;
    let discovery = runtime
        .provider_model_discovery_ops()
        .ok_or(Failure::Unavailable)?;
    let models = match discovery.discover_provider_models(account, &identity).await {
        ProviderModelDiscoveryPortOutcome::Discovered(models) => models,
        ProviderModelDiscoveryPortOutcome::Rejected => return Err(Failure::Unsupported),
        ProviderModelDiscoveryPortOutcome::Unavailable => return Err(Failure::Unavailable),
    };
    if models.len() > MAX_MODELS {
        return Err(Failure::InvalidResponse);
    }
    let mut drafts = Vec::new();
    let mut seen = BTreeSet::new();
    for model in models {
        let mut capabilities = known_capabilities(&model.id);
        if !capabilities.contains(&ProviderModelCapability::Chat) {
            capabilities.push(ProviderModelCapability::Chat);
        }
        if model.input.iter().any(|input| input == "image") {
            capabilities.push(ProviderModelCapability::ImageUnderstand);
        }
        if let Some(mut draft) = draft(&model.id, capabilities, &mut seen) {
            draft.context_window = model
                .context_window
                .filter(|value| *value > 0)
                .or(draft.context_window);
            drafts.push(ProviderModelDiscoveryView::from_draft(draft));
        }
    }
    Ok(drafts)
}

async fn discover_google(
    client: &reqwest::Client,
    base: &str,
    secret: Option<String>,
    media: bool,
    remaining: &mut usize,
) -> Result<Vec<ProviderModelDraft>, Failure> {
    let secret = secret.ok_or(Failure::CredentialMissing)?;
    let url = format!("{}/models", normalized_base(base)?);
    let mut page_token = String::new();
    let mut seen_tokens = BTreeSet::new();
    let mut drafts = Vec::new();
    for _ in 0..16 {
        let mut request = client
            .get(&url)
            .header("x-goog-api-key", &secret)
            .query(&[("pageSize", "1000")]);
        if !page_token.is_empty() {
            request = request.query(&[("pageToken", &page_token)]);
        }
        let value = discovery_json(request, remaining).await?;
        let models = value
            .get("models")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        drafts.extend(collect(models, media, |model| {
            let id = model.get("name").and_then(Value::as_str)?;
            // Google Models does not publish a verified modalities field; unknown stays explicit.
            Some((
                id,
                known_capabilities(id.strip_prefix("models/").unwrap_or(id)),
            ))
        })?);
        if drafts.len() > MAX_MODELS {
            return Err(Failure::InvalidResponse);
        }
        let Some(next) = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Ok(deduplicate(drafts));
        };
        if !seen_tokens.insert(next.to_owned()) {
            return Err(Failure::InvalidResponse);
        }
        page_token = next.to_owned();
    }
    Err(Failure::InvalidResponse)
}

async fn discover_openrouter(
    client: &reqwest::Client,
    base: &str,
    secret: Option<String>,
    remaining: &mut usize,
) -> Result<Vec<ProviderModelDiscoveryView>, Failure> {
    let mut drafts = Vec::new();
    for (path, capability) in [
        (
            "images/models",
            Some(ProviderModelCapability::ImageGenerate),
        ),
        (
            "videos/models",
            Some(ProviderModelCapability::VideoGenerate),
        ),
        ("models", None),
    ] {
        let mut request = client.get(format!("{base}/{path}"));
        if let Some(secret) = &secret {
            request = request.bearer_auth(secret);
        }
        let value = discovery_json(request, remaining).await?;
        let models = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        drafts.extend(collect(models, true, |model| {
            let id = model.get("id").and_then(Value::as_str)?;
            let capabilities = capability
                .map(|capability| vec![capability])
                .unwrap_or_else(|| {
                    modalities(model.get("architecture"))
                        .into_iter()
                        .filter(|capability| {
                            matches!(
                                capability,
                                ProviderModelCapability::TextToSpeech
                                    | ProviderModelCapability::MusicGenerate
                                    | ProviderModelCapability::Transcribe
                            )
                        })
                        .collect()
                });
            // The general catalog only contributes positively identified audio models.
            if capability.is_none() && capabilities.is_empty() {
                return None;
            }
            Some((id, capabilities))
        })?);
        if drafts.len() > MAX_MODELS {
            return Err(Failure::InvalidResponse);
        }
    }
    Ok(deduplicate(drafts)
        .into_iter()
        .map(ProviderModelDiscoveryView::from_draft)
        .collect())
}

fn collect<'a>(
    models: &'a [Value],
    media: bool,
    decode: impl Fn(&'a Value) -> Option<(&'a str, Vec<ProviderModelCapability>)>,
) -> Result<Vec<ProviderModelDraft>, Failure> {
    if models.len() > MAX_MODELS {
        return Err(Failure::InvalidResponse);
    }
    let mut seen = BTreeSet::new();
    let mut drafts = Vec::new();
    for model in models {
        let Some((id, mut capabilities)) = decode(model) else {
            continue;
        };
        let known = !capabilities.is_empty();
        if media {
            capabilities.retain(|capability| {
                !matches!(
                    capability,
                    ProviderModelCapability::Chat | ProviderModelCapability::ImageUnderstand
                )
            });
            if known && capabilities.is_empty() {
                continue;
            }
        }
        if let Some(draft) = draft(id, capabilities, &mut seen) {
            drafts.push(draft);
        }
    }
    Ok(drafts)
}

fn draft(
    id: &str,
    mut capabilities: Vec<ProviderModelCapability>,
    seen: &mut BTreeSet<String>,
) -> Option<ProviderModelDraft> {
    let id = id.trim().strip_prefix("models/").unwrap_or(id.trim());
    if id.is_empty()
        || id.len() > 512
        || id.chars().any(char::is_control)
        || !seen.insert(id.to_owned())
    {
        return None;
    }
    capabilities.sort_unstable();
    capabilities.dedup();
    let reference = model_reference::find(id);
    Some(ProviderModelDraft {
        model_id: id.to_owned(),
        capabilities,
        context_window: reference.and_then(model_reference::ModelReference::context_window),
        max_tokens: reference.and_then(model_reference::ModelReference::max_tokens),
        timeout_ms: None,
        aspect_ratio: None,
        resolution: None,
        quality: None,
    })
}

fn deduplicate(drafts: Vec<ProviderModelDraft>) -> Vec<ProviderModelDraft> {
    let mut seen = BTreeSet::new();
    drafts
        .into_iter()
        .filter(|draft| seen.insert(draft.model_id.clone()))
        .collect()
}

fn known_capabilities(id: &str) -> Vec<ProviderModelCapability> {
    use ProviderModelCapability::*;
    if let Some(reference) = model_reference::find(id) {
        return reference.capabilities();
    }
    match id {
        "gpt-image-1"
        | "gpt-image-1-mini"
        | "gpt-image-1.5"
        | "chatgpt-image-latest"
        | "gpt-image-2"
        | "gpt-image-2-2026-04-21"
        | "gpt-image-2.5-sunburst"
        | "gpt-image-2.5-sunburst-2026-09-08"
        | "gpt-image-2.5-flare"
        | "gpt-image-2.5-flare-2026-09-08"
        | "gemini-2.5-flash-image"
        | "gemini-2.5-flash-image-preview"
        | "gemini-3-pro-image-preview"
        | "gemini-3-pro-image"
        | "gemini-3.1-flash-image"
        | "gemini-3.1-flash-image-preview" => vec![ImageGenerate],
        "gemini-nano-banana-2.1" | "gemini-3.1-flash-lite-image" => vec![ImageGenerate],
        "gemini-omni-1.1-flash" => vec![VideoGenerate],
        "gemini-3.8-flash-tts" | "gemini-3.8-flash-lite-tts" => vec![TextToSpeech],
        "lyria-3.5" => vec![MusicGenerate],
        "sora-2"
        | "sora-2-pro"
        | "sora-2-2025-10-06"
        | "sora-2-pro-2025-10-06"
        | "sora-2-2025-12-08" => vec![VideoGenerate],
        _ => Vec::new(),
    }
}

fn modalities(model: Option<&Value>) -> Vec<ProviderModelCapability> {
    use ProviderModelCapability::*;
    let Some(model) = model else {
        return Vec::new();
    };
    let read = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| model.get(*name).and_then(Value::as_array))
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let input = read(&["input_modalities", "inputModalities"]);
    let output = read(&["output_modalities", "outputModalities"]);
    let mut capabilities = Vec::new();
    if output.iter().any(|value| value == "text") {
        capabilities.push(Chat);
    }
    if input.iter().any(|value| value == "image") && capabilities.contains(&Chat) {
        capabilities.push(ImageUnderstand);
    }
    if output.iter().any(|value| value == "image") {
        capabilities.push(ImageGenerate);
    }
    if output.iter().any(|value| value == "video") {
        capabilities.push(VideoGenerate);
    }
    if output.iter().any(|value| value == "audio") {
        capabilities.push(TextToSpeech);
    }
    capabilities
}

fn endpoint(account: &ProviderAccount) -> Option<&str> {
    account
        .configuration()
        .endpoint()
        .map(|endpoint| endpoint.as_str())
        .or_else(|| {
            if account.configuration().kind() == ProviderAccountKind::Media {
                match account.configuration().media_protocol()? {
                    ProviderMediaApiProtocol::Google => {
                        Some("https://generativelanguage.googleapis.com/v1beta")
                    }
                    ProviderMediaApiProtocol::OpenAi => Some("https://api.openai.com/v1"),
                    ProviderMediaApiProtocol::OpenRouter => Some("https://openrouter.ai/api/v1"),
                    ProviderMediaApiProtocol::DashScope | ProviderMediaApiProtocol::Ark => None,
                }
            } else {
                default_discovery_endpoint(account.provider().as_str())
            }
        })
}

fn normalized_base(base: &str) -> Result<String, Failure> {
    let base = base.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(base).map_err(|_| Failure::InvalidRequest)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Failure::InvalidRequest);
    }
    Ok(base.to_owned())
}

async fn discovery_json(
    request: reqwest::RequestBuilder,
    remaining: &mut usize,
) -> Result<Value, Failure> {
    let classify = |error: reqwest::Error| {
        if error.is_timeout() {
            Failure::Deadline
        } else {
            Failure::Unavailable
        }
    };
    let mut response = request.send().await.map_err(classify)?;
    match response.status().as_u16() {
        401 => return Err(Failure::Authentication),
        403 => return Err(Failure::PermissionDenied),
        429 => return Err(Failure::RateLimited),
        status if !(200..300).contains(&status) => return Err(Failure::Unavailable),
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|length| length > *remaining as u64)
    {
        return Err(Failure::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify)? {
        if bytes.len() + chunk.len() > *remaining {
            return Err(Failure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    *remaining -= bytes.len();
    serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)
}

fn runtime_discovery_provider(account: &ProviderAccount) -> bool {
    matches!(
        account.configuration().auth_mode(),
        ProviderAccountAuthMode::CliReuse
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice
    ) || matches!(
        account.provider().as_str(),
        "provider:qianfan"
            | "provider:stepfun"
            | "provider:tencent-tokenhub"
            | "provider:tencent-tokenplan"
            | "provider:xiaomi"
            | "provider:xiaomi-token-plan"
            | "provider:qwen"
            | "provider:qwen-token-plan"
            | "provider:kimi"
            | "provider:volcengine-plan"
            | "provider:opencode"
            | "provider:opencode-go"
            | "provider:github-copilot"
    )
}
