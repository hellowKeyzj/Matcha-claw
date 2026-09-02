use std::{collections::BTreeMap, fmt};

use serde_json::{Map, Value};

use super::config_store::OpenClawConfigDocument;

const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_PROVIDER_ID_BYTES: usize = 256;

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn try_new(value: String) -> Result<Self, ModelProjectionError> {
        valid_identifier(&value, MAX_PROVIDER_ID_BYTES)
            .then_some(Self(value))
            .ok_or(ModelProjectionError::InvalidProviderId)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProviderId").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ModelId(String);

impl ModelId {
    pub fn try_new(value: String) -> Result<Self, ModelProjectionError> {
        valid_identifier(&value, MAX_MODEL_ID_BYTES)
            .then_some(Self(value))
            .ok_or(ModelProjectionError::InvalidModelId)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputModality {
    Text,
    Image,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Model {
    id: ModelId,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    input: Vec<InputModality>,
}

impl Model {
    pub fn try_new(
        id: ModelId,
        context_window: Option<u64>,
        max_tokens: Option<u64>,
        input: Vec<InputModality>,
    ) -> Result<Self, ModelProjectionError> {
        if context_window == Some(0) || max_tokens == Some(0) {
            return Err(ModelProjectionError::InvalidTokenLimit);
        }
        if let (Some(context_window), Some(max_tokens)) = (context_window, max_tokens)
            && max_tokens > context_window
        {
            return Err(ModelProjectionError::InvalidTokenLimit);
        }
        Ok(Self {
            id,
            context_window,
            max_tokens,
            input,
        })
    }

    pub fn id(&self) -> &ModelId {
        &self.id
    }

    pub fn context_window(&self) -> Option<u64> {
        self.context_window
    }

    pub fn max_tokens(&self) -> Option<u64> {
        self.max_tokens
    }

    pub fn input(&self) -> &[InputModality] {
        &self.input
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModels {
    provider: ProviderId,
    models: Vec<Model>,
}

impl ProviderModels {
    pub fn try_new(provider: ProviderId, models: Vec<Model>) -> Result<Self, ModelProjectionError> {
        if models.is_empty() {
            return Err(ModelProjectionError::EmptyModelCatalog);
        }
        if duplicate_ids(&models) {
            return Err(ModelProjectionError::DuplicateModelId);
        }
        let mut models = models;
        models.sort_by(|left, right| left.id.as_str().cmp(right.id.as_str()));
        Ok(Self { provider, models })
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn models(&self) -> &[Model] {
        &self.models
    }

    pub(crate) fn apply_to_document(&self, document: &mut OpenClawConfigDocument) -> bool {
        let mut models = object(document.get("models"));
        let mut providers = object(models.get("providers"));
        let mut provider = object(providers.get(self.provider.as_str()));
        provider.insert("models".into(), Value::Array(self.models_json(&provider)));
        providers.insert(self.provider.as_str().into(), Value::Object(provider));
        models.insert("providers".into(), Value::Object(providers));
        replace(document, "models", Value::Object(models))
    }

    /// Removes only this provider's desired model catalog while preserving its private transport.
    pub(crate) fn remove_from_document(
        provider: &ProviderId,
        document: &mut OpenClawConfigDocument,
    ) -> bool {
        let mut models = object(document.get("models"));
        let mut providers = object(models.get("providers"));
        let Some(existing) = providers.get(provider.as_str()) else {
            return false;
        };
        let mut entry = object(Some(existing));
        if entry.remove("models").is_none() {
            return false;
        }
        providers.insert(provider.as_str().to_owned(), Value::Object(entry));
        models.insert("providers".into(), Value::Object(providers));
        replace(document, "models", Value::Object(models))
    }

    fn models_json(&self, provider: &Map<String, Value>) -> Vec<Value> {
        let existing = existing_models_by_id(provider);
        self.models
            .iter()
            .map(|model| {
                let mut value = existing.get(model.id.as_str()).cloned().unwrap_or_default();
                value.insert("id".into(), Value::String(model.id.as_str().to_owned()));
                value.insert("name".into(), Value::String(model.id.as_str().to_owned()));
                if !model.input.is_empty() {
                    value.insert(
                        "input".into(),
                        Value::Array(
                            model
                                .input
                                .iter()
                                .map(|input| Value::String(input.as_str().into()))
                                .collect(),
                        ),
                    );
                }
                if let Some(context_window) = model.context_window {
                    value.insert("contextWindow".into(), Value::Number(context_window.into()));
                }
                if let Some(max_tokens) = model.max_tokens {
                    value.insert("maxTokens".into(), Value::Number(max_tokens.into()));
                }
                Value::Object(value)
            })
            .collect()
    }
}

impl InputModality {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

fn existing_models_by_id(provider: &Map<String, Value>) -> BTreeMap<String, Map<String, Value>> {
    provider
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|model| {
            model
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), model.clone()))
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelProjectionError {
    DuplicateModelId,
    EmptyModelCatalog,
    InvalidModelId,
    InvalidProviderId,
    InvalidTokenLimit,
}

impl fmt::Display for ModelProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateModelId => {
                formatter.write_str("OpenClaw model catalog contains duplicate model identifiers")
            }
            Self::EmptyModelCatalog => formatter.write_str("OpenClaw model catalog is empty"),
            Self::InvalidModelId => formatter.write_str("OpenClaw model identifier is invalid"),
            Self::InvalidProviderId => {
                formatter.write_str("OpenClaw model provider identifier is invalid")
            }
            Self::InvalidTokenLimit => {
                formatter.write_str("OpenClaw model token limits are invalid")
            }
        }
    }
}

impl std::error::Error for ModelProjectionError {}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn replace(document: &mut OpenClawConfigDocument, key: &str, value: Value) -> bool {
    if document.get(key) == Some(&value) {
        return false;
    }
    document.insert(key.into(), value);
    true
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

fn duplicate_ids(models: &[Model]) -> bool {
    models.iter().enumerate().any(|(index, model)| {
        models[..index]
            .iter()
            .any(|previous| previous.id == model.id)
    })
}

#[cfg(test)]
mod tests;
