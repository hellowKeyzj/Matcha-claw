use std::{collections::HashMap, sync::LazyLock};

use environment::ProviderModelCapability;
use serde::Deserialize;

static CATALOG: LazyLock<ModelReferenceCatalog> = LazyLock::new(|| {
    ModelReferenceCatalog::from_json(include_str!("model_reference_catalog.json"))
        .expect("bundled model reference catalog must be valid")
});

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModelReference {
    capabilities: Vec<ProviderModelCapability>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
}

impl ModelReference {
    pub(crate) fn capabilities(&self) -> Vec<ProviderModelCapability> {
        self.capabilities.clone()
    }

    pub(crate) const fn context_window(&self) -> Option<u64> {
        self.context_window
    }

    pub(crate) const fn max_tokens(&self) -> Option<u64> {
        self.max_tokens
    }
}

pub(crate) fn find(model_id: &str) -> Option<&'static ModelReference> {
    CATALOG.find(model_id)
}

#[derive(Clone, Debug, Default)]
struct ModelReferenceCatalog {
    records: HashMap<String, ModelReference>,
}

impl ModelReferenceCatalog {
    fn from_json(content: &str) -> Result<Self, ModelReferenceCatalogError> {
        let document: ModelReferenceCatalogDocument =
            serde_json::from_str(content).map_err(|_| ModelReferenceCatalogError::Decode)?;
        if document.version != 1 {
            return Err(ModelReferenceCatalogError::Version);
        }
        let mut records = HashMap::new();
        for record in document.models {
            let model_id =
                normalized_text(record.model_id).ok_or(ModelReferenceCatalogError::ModelId)?;
            if normalized_text(record.source).is_none()
                || !is_checked_at_date(&record.checked_at)
                || (record.context_window.is_none() && record.max_tokens.is_none())
                || record.context_window == Some(0)
                || record.max_tokens == Some(0)
            {
                return Err(ModelReferenceCatalogError::Record);
            }
            if let (Some(context_window), Some(max_tokens)) =
                (record.context_window, record.max_tokens)
                && max_tokens > context_window
            {
                return Err(ModelReferenceCatalogError::Record);
            }
            let capabilities = record
                .capabilities
                .into_iter()
                .map(parse_capability)
                .collect::<Result<Vec<_>, _>>()?;
            if capabilities.is_empty() {
                return Err(ModelReferenceCatalogError::Capability);
            }
            let mut capabilities = capabilities;
            capabilities.sort_unstable();
            capabilities.dedup();
            let previous = records.insert(
                model_id,
                ModelReference {
                    capabilities,
                    context_window: record.context_window,
                    max_tokens: record.max_tokens,
                },
            );
            if previous.is_some() {
                return Err(ModelReferenceCatalogError::Duplicate);
            }
        }
        Ok(Self { records })
    }

    fn find(&self, model_id: &str) -> Option<&ModelReference> {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            return None;
        }
        self.records.get(model_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelReferenceCatalogDocument {
    version: u16,
    models: Vec<ModelReferenceRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelReferenceRecord {
    model_id: String,
    capabilities: Vec<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    source: String,
    checked_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModelReferenceCatalogError {
    Capability,
    Decode,
    Duplicate,
    ModelId,
    Record,
    Version,
}

fn normalized_text(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

fn parse_capability(value: String) -> Result<ProviderModelCapability, ModelReferenceCatalogError> {
    match value.trim() {
        "chat" => Ok(ProviderModelCapability::Chat),
        "imageUnderstand" => Ok(ProviderModelCapability::ImageUnderstand),
        "imageGenerate" => Ok(ProviderModelCapability::ImageGenerate),
        "videoGenerate" => Ok(ProviderModelCapability::VideoGenerate),
        "musicGenerate" => Ok(ProviderModelCapability::MusicGenerate),
        "tts" => Ok(ProviderModelCapability::TextToSpeech),
        "transcribe" => Ok(ProviderModelCapability::Transcribe),
        _ => Err(ModelReferenceCatalogError::Capability),
    }
}

fn is_checked_at_date(value: &str) -> bool {
    let value = value.trim();
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_valid() {
        let catalog =
            ModelReferenceCatalog::from_json(include_str!("model_reference_catalog.json"))
                .expect("bundled model reference catalog must be valid");

        assert!(catalog.find("deepseek-v4-flash").is_some());
    }

    #[test]
    fn lookup_uses_model_id_only() {
        let catalog = ModelReferenceCatalog::from_json(
            r#"{
              "version": 1,
              "models": [{
                "modelId": "same-model",
                "capabilities": ["chat", "imageUnderstand"],
                "contextWindow": 128000,
                "maxTokens": 16384,
                "source": "https://example.com/model",
                "checkedAt": "2026-09-06"
              }]
            }"#,
        )
        .expect("catalog");

        let reference = catalog.find("same-model").expect("reference");
        assert_eq!(reference.context_window(), Some(128_000));
        assert_eq!(reference.max_tokens(), Some(16_384));
        assert_eq!(reference.capabilities().len(), 2);
    }

    #[test]
    fn duplicate_model_ids_are_rejected() {
        let catalog = ModelReferenceCatalog::from_json(
            r#"{
              "version": 1,
              "models": [
                {
                  "modelId": "same-model",
                  "capabilities": ["chat"],
                  "contextWindow": 64000,
                  "maxTokens": 8192,
                  "source": "https://example.com/a",
                  "checkedAt": "2026-09-06"
                },
                {
                  "modelId": "same-model",
                  "capabilities": ["chat"],
                  "contextWindow": 64000,
                  "maxTokens": 8192,
                  "source": "https://example.com/b",
                  "checkedAt": "2026-09-06"
                }
              ]
            }"#,
        );

        assert_eq!(catalog.unwrap_err(), ModelReferenceCatalogError::Duplicate);
    }

    #[test]
    fn record_accepts_single_verified_token_limit() {
        let catalog = ModelReferenceCatalog::from_json(
            r#"{
              "version": 1,
              "models": [{
                "modelId": "known-context-only",
                "capabilities": ["chat"],
                "contextWindow": 4096,
                "source": "https://example.com/a",
                "checkedAt": "2026-09-06"
              }]
            }"#,
        )
        .expect("catalog");

        let reference = catalog.find("known-context-only").expect("reference");
        assert_eq!(reference.context_window(), Some(4096));
        assert_eq!(reference.max_tokens(), None);
    }

    #[test]
    fn invalid_records_are_rejected() {
        let catalog = ModelReferenceCatalog::from_json(
            r#"{
              "version": 1,
              "models": [{
                "modelId": "bad-model",
                "capabilities": ["chat"],
                "contextWindow": 4096,
                "maxTokens": 8192,
                "source": "https://example.com/a",
                "checkedAt": "2026-09-06"
              }]
            }"#,
        );

        assert_eq!(catalog.unwrap_err(), ModelReferenceCatalogError::Record);
    }
}
