use std::fmt::{self, Write};

use sha2::{Digest, Sha256};

use crate::ProviderAccountId;

const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_MEDIA_OPTION_BYTES: usize = 128;
const MODEL_SELECTION_ID_PREFIX: &str = "model-selection:v1:";
const MODEL_SELECTION_ID_DIGEST_BYTES: usize = 64;

/// A non-secret capability declared for a provider model.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ProviderModelCapability {
    Chat,
    ImageUnderstand,
    ImageGenerate,
    VideoGenerate,
    MusicGenerate,
    TextToSpeech,
    Transcribe,
}

/// A declared ProviderModel fact owned by a public provider account identity.
///
/// This is desired catalog data. It is neither a runtime configuration projection
/// nor evidence that the model is reachable, accepted, or observed at runtime.
#[derive(Clone, Eq, PartialEq)]
pub struct ProviderModel {
    account_id: ProviderAccountId,
    model_id: String,
    capabilities: Vec<ProviderModelCapability>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    timeout_ms: Option<u64>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    quality: Option<String>,
}

impl ProviderModel {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        account_id: ProviderAccountId,
        model_id: impl Into<String>,
        capabilities: Vec<ProviderModelCapability>,
        context_window: Option<u64>,
        max_tokens: Option<u64>,
        timeout_ms: Option<u64>,
        aspect_ratio: Option<String>,
        resolution: Option<String>,
        quality: Option<String>,
    ) -> Result<Self, InvalidProviderModel> {
        let model_id = normalized_model_id(model_id.into()).ok_or(InvalidProviderModel::ModelId)?;
        if capabilities.is_empty() {
            return Err(InvalidProviderModel::Capabilities);
        }
        let mut capabilities = capabilities;
        capabilities.sort_unstable();
        capabilities.dedup();
        if context_window == Some(0) || max_tokens == Some(0) || timeout_ms == Some(0) {
            return Err(InvalidProviderModel::PositiveLimit);
        }
        Ok(Self {
            account_id,
            model_id,
            capabilities,
            context_window,
            max_tokens,
            timeout_ms,
            aspect_ratio: normalized_media_option(aspect_ratio)
                .map_err(|()| InvalidProviderModel::AspectRatio)?,
            resolution: normalized_media_option(resolution)
                .map_err(|()| InvalidProviderModel::Resolution)?,
            quality: normalized_media_option(quality)
                .map_err(|()| InvalidProviderModel::Quality)?,
        })
    }

    pub fn account_id(&self) -> &ProviderAccountId {
        &self.account_id
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn capabilities(&self) -> &[ProviderModelCapability] {
        &self.capabilities
    }

    pub const fn context_window(&self) -> Option<u64> {
        self.context_window
    }

    pub const fn max_tokens(&self) -> Option<u64> {
        self.max_tokens
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

    pub fn supports(&self, capability: ProviderModelCapability) -> bool {
        self.capabilities.binary_search(&capability).is_ok()
    }

    pub fn selection_id(&self) -> String {
        provider_model_selection_id(&self.account_id, &self.model_id)
    }
}

pub fn provider_model_selection_id(account_id: &ProviderAccountId, model_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(model_id.as_bytes());
    let digest = hasher.finalize();
    let mut id =
        String::with_capacity(MODEL_SELECTION_ID_PREFIX.len() + MODEL_SELECTION_ID_DIGEST_BYTES);
    id.push_str(MODEL_SELECTION_ID_PREFIX);
    for byte in digest {
        let _ = write!(&mut id, "{byte:02x}");
    }
    id
}

impl fmt::Debug for ProviderModel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderModel")
            .field("account_id", &self.account_id)
            .field("model_id", &self.model_id)
            .field("capabilities", &self.capabilities)
            .field("context_window", &self.context_window)
            .field("max_tokens", &self.max_tokens)
            .field("timeout_ms", &self.timeout_ms)
            .field("aspect_ratio", &self.aspect_ratio)
            .field("resolution", &self.resolution)
            .field("quality", &self.quality)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidProviderModel {
    AspectRatio,
    Capabilities,
    ModelId,
    PositiveLimit,
    Quality,
    Resolution,
}

impl fmt::Display for InvalidProviderModel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AspectRatio => "provider model aspect ratio is invalid",
            Self::Capabilities => "provider model must declare at least one capability",
            Self::ModelId => "provider model identifier is invalid",
            Self::PositiveLimit => "provider model limits must be positive",
            Self::Quality => "provider model quality is invalid",
            Self::Resolution => "provider model resolution is invalid",
        })
    }
}

impl std::error::Error for InvalidProviderModel {}

/// Desired provider-model catalog. Routing consumes this catalog but does not own it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderModelCatalog {
    models: Vec<ProviderModel>,
}

impl ProviderModelCatalog {
    pub fn try_new(models: Vec<ProviderModel>) -> Result<Self, ProviderModelCatalogFault> {
        let mut catalog = Self { models };
        catalog.canonicalize()?;
        Ok(catalog)
    }

    pub fn models(&self) -> &[ProviderModel] {
        &self.models
    }

    /// Replaces every desired model owned by `account_id`; an empty list clears it.
    pub fn replace(
        &mut self,
        account_id: &ProviderAccountId,
        models: Vec<ProviderModel>,
    ) -> Result<(), ProviderModelCatalogFault> {
        if models.iter().any(|model| model.account_id() != account_id) {
            return Err(ProviderModelCatalogFault::AccountMismatch);
        }
        let mut next = self
            .models
            .iter()
            .filter(|model| model.account_id() != account_id)
            .cloned()
            .collect::<Vec<_>>();
        next.extend(models);
        let mut catalog = Self { models: next };
        catalog.canonicalize()?;
        *self = catalog;
        Ok(())
    }

    /// Returns the stable, non-secret model candidates for a routing capability.
    pub fn selectable_for(&self, capability: ProviderModelCapability) -> Vec<&ProviderModel> {
        self.models
            .iter()
            .filter(|model| model.supports(capability))
            .collect()
    }

    fn canonicalize(&mut self) -> Result<(), ProviderModelCatalogFault> {
        self.models.sort_by(|left, right| {
            (left.account_id().as_str(), left.model_id())
                .cmp(&(right.account_id().as_str(), right.model_id()))
        });
        if self.models.windows(2).any(|models| {
            models[0].account_id() == models[1].account_id()
                && models[0].model_id() == models[1].model_id()
        }) {
            return Err(ProviderModelCatalogFault::DuplicateModel);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderModelCatalogFault {
    AccountMismatch,
    DuplicateModel,
}

impl fmt::Display for ProviderModelCatalogFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AccountMismatch => "provider model account does not match the replacement target",
            Self::DuplicateModel => "provider model identifiers must be distinct per account",
        })
    }
}

impl std::error::Error for ProviderModelCatalogFault {}

fn normalized_model_id(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= MAX_MODEL_ID_BYTES && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn normalized_media_option(value: Option<String>) -> Result<Option<String>, ()> {
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
    .ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_id(value: &str) -> ProviderAccountId {
        ProviderAccountId::try_new(value).unwrap()
    }

    fn model(
        account_id: ProviderAccountId,
        model_id: &str,
        capabilities: Vec<ProviderModelCapability>,
    ) -> ProviderModel {
        ProviderModel::try_new(
            account_id,
            model_id,
            capabilities,
            Some(200_000),
            Some(8_000),
            Some(30_000),
            Some("16:9".to_owned()),
            Some("1080p".to_owned()),
            Some("high".to_owned()),
        )
        .unwrap()
    }

    #[test]
    fn model_keeps_only_complete_non_secret_desired_facts() {
        let model = model(
            account_id("openai-main"),
            " gpt-4.1 ",
            vec![
                ProviderModelCapability::ImageUnderstand,
                ProviderModelCapability::Chat,
                ProviderModelCapability::Chat,
            ],
        );

        assert_eq!(model.model_id(), "gpt-4.1");
        assert_eq!(
            model.capabilities(),
            [
                ProviderModelCapability::Chat,
                ProviderModelCapability::ImageUnderstand,
            ]
        );
        assert_eq!(model.context_window(), Some(200_000));
        assert_eq!(model.max_tokens(), Some(8_000));
        assert_eq!(model.timeout_ms(), Some(30_000));
        assert_eq!(model.aspect_ratio(), Some("16:9"));
        assert_eq!(model.resolution(), Some("1080p"));
        assert_eq!(model.quality(), Some("high"));
        let rendered = format!("{model:?}");
        assert!(rendered.contains("openai-main"));
        for forbidden in [
            "baseUrl",
            "header",
            "apiKey",
            "secret-value-must-not-appear",
        ] {
            assert!(!rendered.contains(forbidden));
        }
    }

    #[test]
    fn model_rejects_invalid_required_facts_and_non_positive_limits() {
        let account = account_id("primary");
        assert_eq!(
            ProviderModel::try_new(
                account.clone(),
                "   ",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            Err(InvalidProviderModel::ModelId)
        );
        assert_eq!(
            ProviderModel::try_new(
                account.clone(),
                "model",
                Vec::new(),
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            Err(InvalidProviderModel::Capabilities)
        );
        assert_eq!(
            ProviderModel::try_new(
                account.clone(),
                "model",
                vec![ProviderModelCapability::Chat],
                Some(0),
                None,
                None,
                None,
                None,
                None,
            ),
            Err(InvalidProviderModel::PositiveLimit)
        );
        assert_eq!(
            ProviderModel::try_new(
                account,
                "model",
                vec![ProviderModelCapability::ImageGenerate],
                None,
                None,
                None,
                Some("16/9".to_owned()),
                Some("1K".to_owned()),
                Some("high".to_owned()),
            ),
            Err(InvalidProviderModel::AspectRatio)
        );
    }

    #[test]
    fn replace_is_atomic_per_account_and_selectable_is_capability_scoped() {
        let first_account = account_id("first");
        let second_account = account_id("second");
        let mut catalog = ProviderModelCatalog::try_new(vec![
            model(
                first_account.clone(),
                "chat-old",
                vec![ProviderModelCapability::Chat],
            ),
            model(
                second_account.clone(),
                "image",
                vec![ProviderModelCapability::ImageGenerate],
            ),
        ])
        .unwrap();

        catalog
            .replace(
                &first_account,
                vec![model(
                    first_account.clone(),
                    "chat-new",
                    vec![
                        ProviderModelCapability::Chat,
                        ProviderModelCapability::ImageUnderstand,
                    ],
                )],
            )
            .unwrap();

        assert_eq!(
            catalog
                .models()
                .iter()
                .map(ProviderModel::model_id)
                .collect::<Vec<_>>(),
            ["chat-new", "image"]
        );
        assert_eq!(
            catalog
                .selectable_for(ProviderModelCapability::Chat)
                .iter()
                .map(|model| model.model_id())
                .collect::<Vec<_>>(),
            ["chat-new"]
        );
        assert_eq!(
            catalog
                .selectable_for(ProviderModelCapability::ImageGenerate)
                .iter()
                .map(|model| model.model_id())
                .collect::<Vec<_>>(),
            ["image"]
        );

        let before = catalog.clone();
        assert_eq!(
            catalog.replace(
                &first_account,
                vec![model(
                    second_account,
                    "wrong-account",
                    vec![ProviderModelCapability::Chat],
                )],
            ),
            Err(ProviderModelCatalogFault::AccountMismatch)
        );
        assert_eq!(catalog, before);
    }

    #[test]
    fn model_selection_id_is_stable_and_non_secret() {
        let model = model(
            account_id("custom-c16654ab-1739-46b0-b0b4-8e4e03448aab"),
            "ark-code-latest",
            vec![ProviderModelCapability::Chat],
        );

        let selection_id = model.selection_id();
        assert!(selection_id.starts_with(MODEL_SELECTION_ID_PREFIX));
        assert_eq!(
            selection_id.len(),
            MODEL_SELECTION_ID_PREFIX.len() + MODEL_SELECTION_ID_DIGEST_BYTES
        );
        assert_eq!(selection_id, model.selection_id());
        assert!(!selection_id.contains("custom-c16654ab"));
        assert!(!selection_id.contains("ark-code-latest"));
        assert!(!selection_id.contains('/'));
    }

    #[test]
    fn catalog_rejects_duplicate_model_ids_within_one_account_id() {
        let account = account_id("primary");
        assert_eq!(
            ProviderModelCatalog::try_new(vec![
                model(account.clone(), "same", vec![ProviderModelCapability::Chat],),
                model(
                    account,
                    "same",
                    vec![ProviderModelCapability::ImageUnderstand],
                ),
            ]),
            Err(ProviderModelCatalogFault::DuplicateModel)
        );
    }
}
