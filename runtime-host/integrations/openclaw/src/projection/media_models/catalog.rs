use std::fmt;

use environment::ProviderModelCapability;

const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_PROVIDER_KEY_BYTES: usize = 256;
const MAX_LABEL_BYTES: usize = 256;
const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_MEDIA_OPTION_BYTES: usize = 128;

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProviderKey(String);

impl ProviderKey {
    pub fn try_new(value: String) -> Result<Self, MediaCatalogError> {
        valid_identifier(&value, MAX_PROVIDER_KEY_BYTES)
            .then_some(Self(value))
            .ok_or(MediaCatalogError::InvalidProviderKey)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProviderKey").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ModelId(String);

impl ModelId {
    pub fn try_new(value: String) -> Result<Self, MediaCatalogError> {
        valid_identifier(&value, MAX_MODEL_ID_BYTES)
            .then_some(Self(value))
            .ok_or(MediaCatalogError::InvalidModelId)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ModelId").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct Endpoint(String);

impl Endpoint {
    pub fn try_new(value: String) -> Result<Self, MediaCatalogError> {
        valid_endpoint(&value)
            .then_some(Self(value))
            .ok_or(MediaCatalogError::InvalidEndpoint)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Endpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Endpoint([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Protocol {
    Google,
    OpenAi,
    OpenRouter,
}

impl Protocol {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::OpenAi => "openai",
            Self::OpenRouter => "openrouter",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Model {
    id: ModelId,
    capabilities: Vec<ProviderModelCapability>,
    timeout_ms: Option<u64>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    quality: Option<String>,
}

impl Model {
    pub fn try_new(
        id: ModelId,
        capabilities: Vec<ProviderModelCapability>,
        timeout_ms: Option<u64>,
        aspect_ratio: Option<String>,
        resolution: Option<String>,
        quality: Option<String>,
    ) -> Result<Self, MediaCatalogError> {
        if capabilities.is_empty() || capabilities.iter().any(|capability| !is_media(*capability)) {
            return Err(MediaCatalogError::InvalidCapabilities);
        }
        if timeout_ms == Some(0) {
            return Err(MediaCatalogError::InvalidTimeout);
        }
        let mut capabilities = capabilities;
        capabilities.sort_unstable();
        capabilities.dedup();
        Ok(Self {
            id,
            capabilities,
            timeout_ms,
            aspect_ratio: option(aspect_ratio, MediaCatalogError::InvalidAspectRatio)?,
            resolution: option(resolution, MediaCatalogError::InvalidResolution)?,
            quality: option(quality, MediaCatalogError::InvalidQuality)?,
        })
    }

    pub fn id(&self) -> &ModelId {
        &self.id
    }

    pub fn capabilities(&self) -> &[ProviderModelCapability] {
        &self.capabilities
    }

    pub const fn timeout_ms(&self) -> Option<u64> {
        self.timeout_ms
    }

    pub fn aspect_ratio(&self) -> Option<&str> {
        self.aspect_ratio.as_deref()
    }

    pub fn resolution(&self) -> Option<&str> {
        self.resolution.as_deref()
    }

    pub fn quality(&self) -> Option<&str> {
        self.quality.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModels {
    pub(super) provider: ProviderKey,
    pub(super) label: String,
    pub(super) endpoint: Endpoint,
    pub(super) protocol: Protocol,
    pub(super) models: Vec<Model>,
}

impl ProviderModels {
    pub fn try_new(
        provider: ProviderKey,
        label: String,
        endpoint: Endpoint,
        protocol: Protocol,
        models: Vec<Model>,
    ) -> Result<Self, MediaCatalogError> {
        if !valid_label(&label) {
            return Err(MediaCatalogError::InvalidLabel);
        }
        if models.is_empty() {
            return Err(MediaCatalogError::EmptyModelCatalog);
        }
        let mut models = models;
        models.sort_by(|left, right| left.id.as_str().cmp(right.id.as_str()));
        if models.windows(2).any(|models| models[0].id == models[1].id) {
            return Err(MediaCatalogError::DuplicateModelId);
        }
        Ok(Self {
            provider,
            label,
            endpoint,
            protocol,
            models,
        })
    }

    pub fn provider(&self) -> &ProviderKey {
        &self.provider
    }

    pub fn models(&self) -> &[Model] {
        &self.models
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaProviderCatalog {
    providers: Vec<ProviderModels>,
}

impl MediaProviderCatalog {
    pub fn try_new(mut providers: Vec<ProviderModels>) -> Result<Self, MediaCatalogError> {
        providers.sort_by(|left, right| left.provider.as_str().cmp(right.provider.as_str()));
        if providers
            .windows(2)
            .any(|providers| providers[0].provider == providers[1].provider)
        {
            return Err(MediaCatalogError::DuplicateProviderKey);
        }
        Ok(Self { providers })
    }

    pub fn providers(&self) -> &[ProviderModels] {
        &self.providers
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaCatalogError {
    ConfigPersist,
    DuplicateModelId,
    DuplicateProviderKey,
    EmptyModelCatalog,
    InvalidAspectRatio,
    InvalidCapabilities,
    InvalidEndpoint,
    InvalidLabel,
    InvalidModelId,
    InvalidProviderKey,
    InvalidQuality,
    InvalidResolution,
    InvalidTimeout,
}

impl fmt::Display for MediaCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ConfigPersist => "OpenClaw custom media configuration persistence failed",
            Self::DuplicateModelId => {
                "OpenClaw custom media catalog contains duplicate model identifiers"
            }
            Self::DuplicateProviderKey => {
                "OpenClaw custom media catalog contains duplicate provider identifiers"
            }
            Self::EmptyModelCatalog => "OpenClaw custom media catalog is empty",
            Self::InvalidAspectRatio => "OpenClaw custom media aspect ratio is invalid",
            Self::InvalidCapabilities => "OpenClaw custom media capabilities are invalid",
            Self::InvalidEndpoint => "OpenClaw custom media endpoint is invalid",
            Self::InvalidLabel => "OpenClaw custom media label is invalid",
            Self::InvalidModelId => "OpenClaw custom media model identifier is invalid",
            Self::InvalidProviderKey => "OpenClaw custom media provider identifier is invalid",
            Self::InvalidQuality => "OpenClaw custom media quality is invalid",
            Self::InvalidResolution => "OpenClaw custom media resolution is invalid",
            Self::InvalidTimeout => "OpenClaw custom media timeout is invalid",
        })
    }
}

impl std::error::Error for MediaCatalogError {}

fn is_media(capability: ProviderModelCapability) -> bool {
    matches!(
        capability,
        ProviderModelCapability::ImageGenerate
            | ProviderModelCapability::VideoGenerate
            | ProviderModelCapability::MusicGenerate
            | ProviderModelCapability::TextToSpeech
            | ProviderModelCapability::Transcribe
    )
}

fn option(
    value: Option<String>,
    error: MediaCatalogError,
) -> Result<Option<String>, MediaCatalogError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= MAX_MEDIA_OPTION_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')))
    .then(|| Some(value.to_owned()))
    .ok_or(error)
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_LABEL_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_endpoint(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_ENDPOINT_BYTES || value.chars().any(char::is_control) {
        return false;
    }
    let Some(remainder) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = remainder.split('/').next().unwrap_or_default();
    !authority.is_empty() && !authority.contains('@') && !authority.chars().any(char::is_whitespace)
}
