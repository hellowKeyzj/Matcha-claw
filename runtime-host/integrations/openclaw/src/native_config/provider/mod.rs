use std::{collections::BTreeSet, fmt};

use serde_json::{Map, Value};

use super::config_store::OpenClawConfigDocument;

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_PROVIDER_KEY_BYTES: usize = 256;
const LEGACY_OPENAI_CODEX_PROVIDER_KEY: &str = "openai-codex";
const LEGACY_OPENAI_CODEX_RESPONSES_PROTOCOL: &str = "openai-codex-responses";
const OPENAI_CHATGPT_RESPONSES_PROTOCOL: &str = "openai-chatgpt-responses";
pub(crate) const OPENAI_CODEX_OAUTH_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const OPENAI_PROVIDER_KEY: &str = "openai";
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
    OpenAiChatGptResponses,
    OpenAiCompletions,
    OpenAiResponses,
}

impl ProviderProtocol {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic-messages",
            Self::GoogleGenerativeAi => "google-generative-ai",
            Self::OpenAiChatGptResponses => OPENAI_CHATGPT_RESPONSES_PROTOCOL,
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
            Value::String(resolve_endpoint(self.endpoint.as_str(), self.protocol).to_owned()),
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
        pin_openai_agent_runtime(self.provider.as_str(), &mut entry);

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

pub(crate) fn migrate_legacy_openai_codex_runtime(document: &mut OpenClawConfigDocument) -> bool {
    let models_changed = migrate_legacy_openai_codex_provider(document);
    let agents_changed = migrate_legacy_openai_codex_agent_models(document);
    models_changed || agents_changed
}

fn migrate_legacy_openai_codex_provider(document: &mut OpenClawConfigDocument) -> bool {
    let mut models = object(document.get("models"));
    let mut providers = object(models.get("providers"));
    let mut changed = false;
    for entry in providers.values_mut().filter_map(Value::as_object_mut) {
        if entry.get("api").and_then(Value::as_str) == Some(LEGACY_OPENAI_CODEX_RESPONSES_PROTOCOL)
        {
            entry.insert(
                "api".into(),
                Value::String(OPENAI_CHATGPT_RESPONSES_PROTOCOL.into()),
            );
            changed = true;
        }
        if entry.get("api").and_then(Value::as_str) == Some(OPENAI_CHATGPT_RESPONSES_PROTOCOL)
            && is_openai_platform_base_url(entry.get("baseUrl"))
        {
            entry.insert(
                "baseUrl".into(),
                Value::String(OPENAI_CODEX_OAUTH_BASE_URL.into()),
            );
            changed = true;
        }
    }
    if providers
        .get(LEGACY_OPENAI_CODEX_PROVIDER_KEY)
        .and_then(Value::as_object)
        .is_some_and(|entry| {
            entry.get("api").and_then(Value::as_str) == Some(OPENAI_CHATGPT_RESPONSES_PROTOCOL)
        })
    {
        let codex = providers
            .remove(LEGACY_OPENAI_CODEX_PROVIDER_KEY)
            .and_then(|entry| entry.as_object().cloned())
            .expect("legacy provider was present");
        let mut openai = object(providers.get(OPENAI_PROVIDER_KEY));
        let openai_agent_runtime = openai
            .get("agentRuntime")
            .and_then(Value::as_object)
            .cloned();
        openai.extend(codex);
        openai.insert(
            "baseUrl".into(),
            Value::String(OPENAI_CODEX_OAUTH_BASE_URL.into()),
        );
        openai.insert(
            "api".into(),
            Value::String(OPENAI_CHATGPT_RESPONSES_PROTOCOL.into()),
        );
        if let Some(runtime) = openai_agent_runtime {
            openai.insert("agentRuntime".into(), Value::Object(runtime));
        } else {
            openai.insert(
                "agentRuntime".into(),
                Value::Object(Map::from_iter([("id".into(), Value::String("pi".into()))])),
            );
        }
        pin_openai_agent_runtime(OPENAI_PROVIDER_KEY, &mut openai);
        providers.insert(OPENAI_PROVIDER_KEY.into(), Value::Object(openai));
        changed = true;
    }
    if !changed {
        return false;
    }
    models.insert("providers".into(), Value::Object(providers));
    replace(document, "models", Value::Object(models))
}

fn migrate_legacy_openai_codex_agent_models(document: &mut OpenClawConfigDocument) -> bool {
    let mut agents = object(document.get("agents"));
    let mut changed = false;
    if let Some(defaults) = agents.get_mut("defaults").and_then(Value::as_object_mut) {
        changed |= migrate_agent_model_fields(defaults);
    }
    if let Some(list) = agents.get_mut("list").and_then(Value::as_array_mut) {
        for agent in list.iter_mut().filter_map(Value::as_object_mut) {
            changed |= migrate_agent_model_fields(agent);
        }
    }
    if changed {
        replace(document, "agents", Value::Object(agents))
    } else {
        false
    }
}

fn migrate_agent_model_fields(agent: &mut Map<String, Value>) -> bool {
    let mut changed = rewrite_model_reference_field(agent, "model");
    if let Some(models) = agent.get_mut("models").and_then(Value::as_object_mut) {
        changed |= rewrite_model_reference_map_keys(models);
    }
    changed
}

fn rewrite_model_reference_field(agent: &mut Map<String, Value>, field: &str) -> bool {
    let Some(value) = agent.get_mut(field) else {
        return false;
    };
    rewrite_model_reference_value(value)
}

fn rewrite_model_reference_value(value: &mut Value) -> bool {
    match value {
        Value::String(reference) => rewrite_model_reference_string(reference),
        Value::Object(route) => {
            let mut changed = rewrite_model_reference_field(route, "primary");
            if let Some(fallbacks) = route.get_mut("fallbacks").and_then(Value::as_array_mut) {
                for fallback in fallbacks {
                    changed |= rewrite_model_reference_value(fallback);
                }
            }
            changed
        }
        _ => false,
    }
}

fn rewrite_model_reference_map_keys(models: &mut Map<String, Value>) -> bool {
    let keys = models.keys().cloned().collect::<Vec<_>>();
    let mut changed = false;
    for key in keys {
        let Some(next) = rewrite_legacy_openai_codex_model_reference(&key) else {
            continue;
        };
        if !models.contains_key(&next)
            && let Some(value) = models.remove(&key)
        {
            models.insert(next, value);
        } else {
            models.remove(&key);
        }
        changed = true;
    }
    changed
}

fn rewrite_model_reference_string(reference: &mut String) -> bool {
    let Some(next) = rewrite_legacy_openai_codex_model_reference(reference) else {
        return false;
    };
    *reference = next;
    true
}

fn rewrite_legacy_openai_codex_model_reference(reference: &str) -> Option<String> {
    reference
        .strip_prefix("openai-codex/")
        .map(|model| format!("openai/{model}"))
}

fn resolve_endpoint(endpoint: &str, protocol: ProviderProtocol) -> &str {
    if protocol == ProviderProtocol::OpenAiChatGptResponses
        && is_openai_platform_base_url_str(endpoint)
    {
        OPENAI_CODEX_OAUTH_BASE_URL
    } else {
        endpoint
    }
}

fn is_openai_platform_base_url(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(is_openai_platform_base_url_str)
}

fn is_openai_platform_base_url_str(value: &str) -> bool {
    let value = value.trim().trim_end_matches('/');
    value.eq_ignore_ascii_case("https://api.openai.com")
        || value.eq_ignore_ascii_case("https://api.openai.com/v1")
        || value.eq_ignore_ascii_case("http://api.openai.com")
        || value.eq_ignore_ascii_case("http://api.openai.com/v1")
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn pin_openai_agent_runtime(provider: &str, entry: &mut Map<String, Value>) {
    if !matches!(provider, "openai" | "openai-codex") || has_agent_runtime_id(entry) {
        return;
    }
    let mut runtime = entry
        .get("agentRuntime")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    runtime.insert("id".into(), Value::String("pi".into()));
    entry.insert("agentRuntime".into(), Value::Object(runtime));
}

fn has_agent_runtime_id(entry: &Map<String, Value>) -> bool {
    entry
        .get("agentRuntime")
        .and_then(Value::as_object)
        .and_then(|runtime| runtime.get("id"))
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
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

#[cfg(test)]
mod tests;
