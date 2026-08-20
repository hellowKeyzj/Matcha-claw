use std::{collections::BTreeSet, fmt};

use serde_json::{Map, Value};

use super::config_store::OpenClawConfigDocument;

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_PROVIDER_KEY_BYTES: usize = 256;
const MOONSHOT_KIMI_CHINA_BASE_URL: &str = "https://api.moonshot.cn/v1";
const MOONSHOT_KIMI_GLOBAL_BASE_URL: &str = "https://api.moonshot.ai/v1";

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct ProviderKey(String);

impl ProviderKey {
    pub(crate) fn try_new(value: String) -> Result<Self, ProviderProjectionError> {
        valid_provider_key(&value)
            .then_some(Self(value))
            .ok_or(ProviderProjectionError::InvalidProviderKey)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProviderKey").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ProviderEndpoint(String);

impl ProviderEndpoint {
    pub(crate) fn try_new(value: String) -> Result<Self, ProviderProjectionError> {
        valid_endpoint(&value)
            .then_some(Self(value))
            .ok_or(ProviderProjectionError::InvalidEndpoint)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderEndpoint")
            .field(&self.0)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderProtocol {
    AnthropicMessages,
    GoogleGenerativeAi,
    OpenAiCodexResponses,
    OpenAiCompletions,
    OpenAiResponses,
}

impl ProviderProtocol {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic-messages",
            Self::GoogleGenerativeAi => "google-generative-ai",
            Self::OpenAiCodexResponses => "openai-codex-responses",
            Self::OpenAiCompletions => "openai-completions",
            Self::OpenAiResponses => "openai-responses",
        }
    }
}

pub(crate) struct ProviderProjection {
    provider: ProviderKey,
    endpoint: ProviderEndpoint,
    protocol: ProviderProtocol,
    auth_header: Option<bool>,
    replace_provider_keys: BTreeSet<ProviderKey>,
}

impl ProviderProjection {
    pub(crate) fn new(
        provider: ProviderKey,
        endpoint: ProviderEndpoint,
        protocol: ProviderProtocol,
        auth_header: Option<bool>,
        replace_provider_keys: impl IntoIterator<Item = ProviderKey>,
    ) -> Self {
        Self {
            provider,
            endpoint,
            protocol,
            auth_header,
            replace_provider_keys: replace_provider_keys.into_iter().collect(),
        }
    }

    pub(crate) fn apply_to_document(&self, document: &mut OpenClawConfigDocument) -> bool {
        let mut models = object(document.get("models"));
        let mut providers = object(models.get("providers"));
        for provider in &self.replace_provider_keys {
            if provider != &self.provider {
                providers.remove(provider.as_str());
            }
        }

        let mut entry = object(providers.get(self.provider.as_str()));
        entry.insert(
            "baseUrl".into(),
            Value::String(self.endpoint.as_str().to_owned()),
        );
        entry.insert("api".into(), Value::String(self.protocol.as_str().into()));
        entry.remove("apiKey");
        entry.remove("headers");
        match self.auth_header {
            Some(value) => {
                entry.insert("authHeader".into(), Value::Bool(value));
            }
            None => {
                entry.remove("authHeader");
            }
        }
        if !entry.get("agentRuntime").is_some_and(Value::is_object)
            && matches!(self.provider.as_str(), "openai" | "openai-codex")
        {
            entry.insert("agentRuntime".into(), serde_json::json!({ "id": "pi" }));
        }

        providers.insert(self.provider.as_str().to_owned(), Value::Object(entry));
        models.insert("providers".into(), Value::Object(providers));

        let models_changed = replace(document, "models", Value::Object(models));
        let search_changed = match self.provider.as_str() {
            "moonshot" => apply_kimi_search_base_url(document, MOONSHOT_KIMI_CHINA_BASE_URL),
            "moonshot-global" => {
                apply_kimi_search_base_url(document, MOONSHOT_KIMI_GLOBAL_BASE_URL)
            }
            _ => false,
        };
        models_changed || search_changed
    }

    /// Removes the managed transport entry and leaves unrelated provider entries untouched.
    pub(crate) fn remove_from_document(
        provider: &ProviderKey,
        document: &mut OpenClawConfigDocument,
    ) -> bool {
        let mut models = object(document.get("models"));
        let mut providers = object(models.get("providers"));
        if providers.remove(provider.as_str()).is_none() {
            return false;
        }
        models.insert("providers".into(), Value::Object(providers));
        replace(document, "models", Value::Object(models))
    }
}

impl fmt::Debug for ProviderProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderProjection([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderProjectionError {
    InvalidEndpoint,
    InvalidProviderKey,
}

impl fmt::Display for ProviderProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "OpenClaw provider endpoint is invalid",
            Self::InvalidProviderKey => "OpenClaw provider identifier is invalid",
        })
    }
}

impl std::error::Error for ProviderProjectionError {}

fn apply_kimi_search_base_url(document: &mut OpenClawConfigDocument, base_url: &str) -> bool {
    let mut tools = object(document.get("tools"));
    let mut web = object(tools.get("web"));
    let mut search = object(web.get("search"));
    let mut kimi = object(search.get("kimi"));
    kimi.remove("apiKey");
    kimi.insert("baseUrl".into(), Value::String(base_url.into()));
    search.insert("kimi".into(), Value::Object(kimi));
    web.insert("search".into(), Value::Object(search));
    tools.insert("web".into(), Value::Object(web));
    replace(document, "tools", Value::Object(tools))
}

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

fn valid_endpoint(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_ENDPOINT_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    let Some(authority) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = authority.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty() && !authority.contains('@')
}

fn valid_provider_key(value: &str) -> bool {
    !value.contains('/') && !value.contains('\\') && valid_identifier(value, MAX_PROVIDER_KEY_BYTES)
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}
