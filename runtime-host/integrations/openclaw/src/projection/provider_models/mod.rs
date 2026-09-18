use std::collections::{BTreeMap, BTreeSet};

use environment::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountKind, ProviderMediaApiProtocol,
    ProviderModel, ProviderModelCapability, ProviderModelCatalog,
};
use serde_json::{Map, Value};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::{
        agent_models, auth,
        config_store::{OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore},
        media_models,
        provider::{
            OPENAI_CODEX_OAUTH_BASE_URL, ProviderEndpoint, ProviderKey, ProviderProjection,
            ProviderProtocol,
        },
    },
};

const MEDIA_PLUGIN_ID: &str = "matchaclaw-media";

/// The private OpenClaw configuration effect of the desired provider-model catalog.
///
/// This is not runtime acceptance, health, Applied evidence, or an observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderModelProjectionEffect {
    ConfigurationWritten { changed: bool },
}

/// A redacted failure while materializing provider-model desired facts into OpenClaw config.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderModelProjectionError {
    AccountConfiguration,
    CredentialUnavailable,
    DuplicateProviderKey,
    InvalidModelCapability,
    InvalidModelIdentifier,
    InvalidTokenLimit,
    Persistence,
}

impl ProviderModelProjectionError {
    pub const fn diagnostic_reason(self) -> &'static str {
        match self {
            Self::AccountConfiguration => "provider-account-configuration-invalid",
            Self::CredentialUnavailable => "provider-credential-unavailable",
            Self::DuplicateProviderKey => "provider-key-duplicate",
            Self::InvalidModelCapability => "provider-model-capability-invalid",
            Self::InvalidModelIdentifier => "provider-model-identifier-invalid",
            Self::InvalidTokenLimit => "provider-model-token-limit-invalid",
            Self::Persistence => "provider-model-persistence-failed",
        }
    }
}

impl std::fmt::Display for ProviderModelProjectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AccountConfiguration => "OpenClaw provider account configuration is unavailable",
            Self::CredentialUnavailable => "OpenClaw provider credential is unavailable",
            Self::DuplicateProviderKey => "OpenClaw provider configuration is ambiguous",
            Self::InvalidModelCapability => "OpenClaw provider model capability is invalid",
            Self::InvalidModelIdentifier => "OpenClaw provider model identifier is invalid",
            Self::InvalidTokenLimit => "OpenClaw provider model token limit is invalid",
            Self::Persistence => "OpenClaw provider-model configuration persistence failed",
        })
    }
}

impl std::error::Error for ProviderModelProjectionError {}

/// A purpose-specific private projection. Public callers receive neither this plan nor account
/// endpoint/auth material; they only consume the Host's narrow catalog DTOs.
pub struct ProviderModelProjection;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderModelRuntimeIdentity {
    provider_key: String,
}

impl ProviderModelRuntimeIdentity {
    pub fn provider_key(&self) -> &str {
        &self.provider_key
    }

    pub fn runtime_model_ref(&self, kind: ProviderAccountKind, model_id: &str) -> String {
        match kind {
            ProviderAccountKind::Chat => format!("{}/{}", self.provider_key, model_id),
            ProviderAccountKind::Media => {
                format!("{MEDIA_PLUGIN_ID}/{}/{}", self.provider_key, model_id)
            }
        }
    }
}

pub fn public_provider_model_identities(
    accounts: &[ProviderAccount],
) -> Result<BTreeMap<String, ProviderModelRuntimeIdentity>, ProviderModelProjectionError> {
    let enabled = accounts
        .iter()
        .filter(|account| account.configuration().enabled())
        .map(|account| (account.id().as_str().to_owned(), account))
        .collect::<BTreeMap<_, _>>();
    projection_keys(&enabled, true)?
        .into_iter()
        .map(|(account_id, provider_key)| {
            Ok((account_id, ProviderModelRuntimeIdentity { provider_key }))
        })
        .collect()
}

pub fn public_provider_model_identity(
    account: &ProviderAccount,
) -> Result<ProviderModelRuntimeIdentity, ProviderModelProjectionError> {
    let account_id = account.id().as_str().to_owned();
    let accounts = BTreeMap::from([(account_id.clone(), account)]);
    let provider_key = projection_keys(&accounts, true)?
        .remove(&account_id)
        .ok_or(ProviderModelProjectionError::AccountConfiguration)?;
    Ok(ProviderModelRuntimeIdentity { provider_key })
}

pub(crate) fn canonical_provider_keys(
    accounts: &[ProviderAccount],
    retired: &[ProviderAccount],
) -> Result<BTreeSet<String>, ProviderModelProjectionError> {
    let mut active = BTreeMap::new();
    let mut owned = BTreeMap::new();
    for account in accounts {
        owned.insert(account.id().as_str().to_owned(), account);
        if account.configuration().enabled() {
            active.insert(account.id().as_str().to_owned(), account);
        }
    }
    for account in retired {
        owned.insert(account.id().as_str().to_owned(), account);
    }
    let mut keys = projection_keys(&active, true)?
        .into_values()
        .collect::<BTreeSet<_>>();
    keys.extend(projection_keys(&owned, false)?.into_values());
    Ok(keys)
}

impl ProviderModelProjection {
    pub fn apply(
        state_dir: CanonicalStateDir,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> Result<ProviderModelProjectionEffect, ProviderModelProjectionError> {
        let plan = Self::build_plan(
            &state_dir,
            accounts,
            catalog,
            retired,
            required_auth_accounts,
            now_millis,
        )?;
        let store = OpenClawConfigStore::new(state_dir);
        let update = store
            .update(|document| {
                if plan.apply_to_document(document) {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map_err(|_| ProviderModelProjectionError::Persistence)?;

        Ok(ProviderModelProjectionEffect::ConfigurationWritten {
            changed: update.changed,
        })
    }

    pub(crate) fn apply_to_document(
        state_dir: &CanonicalStateDir,
        document: &mut OpenClawConfigDocument,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> Result<bool, ProviderModelProjectionError> {
        let plan = Self::build_plan(
            state_dir,
            accounts,
            catalog,
            retired,
            required_auth_accounts,
            now_millis,
        )?;
        Ok(plan.apply_to_document(document))
    }

    fn build_plan<'a>(
        state_dir: &CanonicalStateDir,
        accounts: &'a [ProviderAccount],
        catalog: &'a ProviderModelCatalog,
        retired: &'a [ProviderAccount],
        required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> Result<ProjectionPlan<'a>, ProviderModelProjectionError> {
        let plan = ProjectionPlan::build(accounts, catalog, retired)?;
        for (account_id, account) in &plan.accounts {
            if !required_auth_accounts.contains(account.id()) {
                continue;
            }
            let Some(credential) = account.configuration().credential() else {
                continue;
            };
            let key = plan
                .keys
                .get(account_id)
                .expect("every projected account receives a provider key");
            if !auth::credential_is_available(state_dir, key.as_str(), credential, now_millis)
                .map_err(|_| ProviderModelProjectionError::CredentialUnavailable)?
            {
                return Err(ProviderModelProjectionError::CredentialUnavailable);
            }
        }
        Ok(plan)
    }
}

struct ProjectionPlan<'a> {
    accounts: BTreeMap<String, &'a ProviderAccount>,
    keys: BTreeMap<String, ProviderKey>,
    removed_transport: Vec<ProviderKey>,
    provider_plugins: BTreeMap<&'static str, bool>,
    text: Vec<agent_models::ProviderModels>,
    empty_text: Vec<agent_models::ProviderId>,
    empty_transport: Vec<ProviderKey>,
    media: media_models::MediaProviderCatalog,
    owned_model_providers: BTreeSet<String>,
    valid_model_references: BTreeSet<String>,
    has_custom_chat_models: bool,
}

impl<'a> ProjectionPlan<'a> {
    fn build(
        accounts: &'a [ProviderAccount],
        catalog: &ProviderModelCatalog,
        retired: &'a [ProviderAccount],
    ) -> Result<Self, ProviderModelProjectionError> {
        let mut all_accounts = BTreeMap::new();
        for account in accounts
            .iter()
            .filter(|account| account.configuration().enabled())
        {
            all_accounts.insert(account.id().as_str().to_owned(), account);
        }
        let keys = projection_keys(&all_accounts, true)?;
        let projected_accounts = all_accounts.clone();
        let keys = keys
            .into_iter()
            .map(|(account_id, key)| {
                ProviderKey::try_new(key)
                    .map(|key| (account_id, key))
                    .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let removed_transport = retired_transport(&all_accounts, retired)?;
        let mut provider_plugins = retired
            .iter()
            .filter_map(|account| native_provider_plugin(account.provider().as_str()))
            .map(|plugin| (plugin, false))
            .collect::<BTreeMap<_, _>>();
        for account in all_accounts.values() {
            if let Some(plugin) = native_provider_plugin(account.provider().as_str()) {
                provider_plugins.insert(plugin, true);
            }
        }

        let mut text = Vec::new();
        let mut empty_text = Vec::new();
        let mut empty_transport = Vec::new();
        let mut media = Vec::new();
        let owned_model_providers = canonical_provider_keys(accounts, retired)?;
        let mut valid_model_references = BTreeSet::new();
        let mut has_custom_chat_models = false;
        for (account_id, account) in &all_accounts {
            let key = keys
                .get(account_id)
                .expect("every projected account receives a provider key");
            let models = catalog
                .models()
                .iter()
                .filter(|model| model.account_id() == account.id())
                .collect::<Vec<_>>();
            if models.is_empty() {
                match account.configuration().kind() {
                    ProviderAccountKind::Chat => {
                        empty_text.push(
                            agent_models::ProviderId::try_new(key.as_str().to_owned())
                                .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
                        );
                        if account.provider().as_str() == "provider:custom" {
                            empty_transport.push(key.clone());
                        }
                    }
                    ProviderAccountKind::Media => {}
                }
                continue;
            }
            match account.configuration().kind() {
                ProviderAccountKind::Chat => {
                    let custom_provider = account.provider().as_str() == "provider:custom";
                    let context = TextModelProjectionContext { custom_provider };
                    let (provider, projected_models) = text_models(key.as_str(), &models, context)?;
                    has_custom_chat_models |= custom_provider;
                    for model in &models {
                        valid_model_references.insert(format!(
                            "{}/{}",
                            key.as_str(),
                            model.model_id()
                        ));
                    }
                    if matches!(
                        account.provider().as_str(),
                        "provider:opencode" | "provider:opencode-go"
                    ) {
                        empty_text.push(provider);
                    } else {
                        text.push(
                            agent_models::ProviderModels::try_new(provider, projected_models)
                                .map_err(provider_model_error_from_agent_model)?,
                        );
                    }
                }
                ProviderAccountKind::Media => {
                    let provider = media_models(account, key.as_str(), &models)?;
                    for model in &models {
                        valid_model_references.insert(format!(
                            "{MEDIA_PLUGIN_ID}/{}/{}",
                            key.as_str(),
                            model.model_id()
                        ));
                    }
                    media.push(provider);
                }
            }
        }

        Ok(Self {
            accounts: projected_accounts,
            keys,
            removed_transport,
            provider_plugins,
            text,
            empty_text,
            empty_transport,
            media: media_models::MediaProviderCatalog::try_new(media)
                .map_err(provider_model_error_from_media_catalog)?,
            owned_model_providers,
            valid_model_references,
            has_custom_chat_models,
        })
    }

    fn apply_to_document(&self, document: &mut OpenClawConfigDocument) -> bool {
        let mut changed = super::provider::migrate_legacy_openai_codex_runtime(document);
        for (account_id, account) in &self.accounts {
            let key = self
                .keys
                .get(account_id)
                .expect("every projected account receives a provider key");
            changed |= apply_transport(account, key, document);
            changed |= apply_native_runtime(account, key, document);
            changed |= apply_keyless_auth_profile(account, key, document);
        }
        for (&plugin, &enabled) in &self.provider_plugins {
            changed |= set_provider_plugin_enabled(plugin, enabled, document);
        }
        for provider in &self.removed_transport {
            changed |= ProviderProjection::remove_from_document(provider, document);
            changed |= remove_keyless_auth_profile(provider, document);
        }
        for models in &self.text {
            changed |= models.apply_to_document(document);
        }
        for provider in &self.empty_text {
            changed |= agent_models::ProviderModels::remove_from_document(provider, document);
        }
        for provider in &self.empty_transport {
            changed |= ProviderProjection::remove_from_document(provider, document);
            changed |= remove_keyless_auth_profile(provider, document);
        }
        changed |= self.media.apply_to_document(document);
        changed |= apply_model_allowlist(
            document,
            &self.owned_model_providers,
            &self.valid_model_references,
        );
        if self.has_custom_chat_models {
            changed |= apply_compaction_safeguard_default(document);
        }
        changed | prune_unknown_model_references(document, &self.valid_model_references)
    }
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn apply_keyless_auth_profile(
    account: &ProviderAccount,
    key: &ProviderKey,
    document: &mut OpenClawConfigDocument,
) -> bool {
    let Some(mode) = keyless_auth_mode(account) else {
        return remove_keyless_auth_profile(key, document);
    };
    let profile_id = keyless_auth_profile_id(key);
    let mut auth = object(document.get("auth"));
    let before = auth.clone();
    let mut profiles = object(auth.get("profiles"));
    profiles.insert(
        profile_id.clone(),
        Value::Object(Map::from_iter([
            ("provider".into(), Value::String(key.as_str().to_owned())),
            ("mode".into(), Value::String(mode.into())),
        ])),
    );
    auth.insert("profiles".into(), Value::Object(profiles));
    let mut order = object(auth.get("order"));
    let existing_order = order
        .get(key.as_str())
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_order = Vec::with_capacity(existing_order.len() + 1);
    next_order.push(Value::String(profile_id.clone()));
    next_order.extend(
        existing_order
            .into_iter()
            .filter(|profile| profile.as_str() != Some(profile_id.as_str())),
    );
    order.insert(key.as_str().to_owned(), Value::Array(next_order));
    auth.insert("order".into(), Value::Object(order));
    if auth == before {
        return false;
    }
    document.insert("auth".into(), Value::Object(auth));
    true
}

fn keyless_auth_mode(account: &ProviderAccount) -> Option<&'static str> {
    match account.configuration().auth_mode() {
        ProviderAccountAuthMode::ApiKey => Some("api_key"),
        ProviderAccountAuthMode::Token => Some("token"),
        ProviderAccountAuthMode::OAuthBrowser | ProviderAccountAuthMode::OAuthDevice => {
            Some("oauth")
        }
        ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse => None,
    }
}

fn keyless_auth_profile_id(key: &ProviderKey) -> String {
    format!("{}:default", key.as_str())
}

fn remove_keyless_auth_profile(key: &ProviderKey, document: &mut OpenClawConfigDocument) -> bool {
    let Some(Value::Object(mut auth)) = document.get("auth").cloned() else {
        return false;
    };
    let before = auth.clone();
    let profile_id = keyless_auth_profile_id(key);
    if let Some(Value::Object(profiles)) = auth.get_mut("profiles") {
        profiles.remove(&profile_id);
    }
    if let Some(Value::Object(order)) = auth.get_mut("order") {
        if let Some(Value::Array(profiles)) = order.get_mut(key.as_str()) {
            profiles.retain(|profile| profile.as_str() != Some(profile_id.as_str()));
            if profiles.is_empty() {
                order.remove(key.as_str());
            }
        }
    }
    remove_empty_object(&mut auth, "profiles");
    remove_empty_object(&mut auth, "order");
    if auth == before {
        return false;
    }
    if auth.is_empty() {
        remove_document_key(document, "auth");
    } else {
        document.insert("auth".into(), Value::Object(auth));
    }
    true
}

fn remove_empty_object(object: &mut Map<String, Value>, key: &str) {
    if object
        .get(key)
        .and_then(Value::as_object)
        .is_some_and(Map::is_empty)
    {
        object.remove(key);
    }
}

fn remove_document_key(document: &mut OpenClawConfigDocument, key: &str) {
    let mut root = object(Some(&document.as_value()));
    root.remove(key);
    *document = OpenClawConfigDocument::from_value(Value::Object(root))
        .expect("object root remains a valid OpenClaw config document");
}

fn apply_model_allowlist(
    document: &mut OpenClawConfigDocument,
    provider_keys: &BTreeSet<String>,
    model_references: &BTreeSet<String>,
) -> bool {
    let mut agents = object(document.get("agents"));
    let before = agents.clone();
    let mut defaults = object(agents.get("defaults"));
    let mut models = object(defaults.get("models"));
    models.retain(|reference, _| {
        !provider_keys
            .iter()
            .any(|provider| provider_owns_model_reference(provider, reference))
            || model_references.contains(reference)
    });
    for reference in model_references {
        models
            .entry(reference.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if models.is_empty() {
        defaults.remove("models");
    } else {
        defaults.insert("models".into(), Value::Object(models));
    }
    if defaults.is_empty() {
        agents.remove("defaults");
    } else {
        agents.insert("defaults".into(), Value::Object(defaults));
    }
    if agents == before {
        return false;
    }
    if agents.is_empty() {
        remove_document_key(document, "agents");
    } else {
        document.insert("agents".into(), Value::Object(agents));
    }
    true
}

fn provider_owns_model_reference(provider: &str, reference: &str) -> bool {
    reference
        .strip_prefix(provider)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn apply_transport(
    account: &ProviderAccount,
    key: &ProviderKey,
    document: &mut OpenClawConfigDocument,
) -> bool {
    let configuration = account.configuration();
    if !matches!(configuration.kind(), ProviderAccountKind::Chat) {
        return false;
    }
    if matches!(
        account.provider().as_str(),
        "provider:opencode" | "provider:opencode-go"
    ) {
        return ProviderProjection::remove_from_document(key, document);
    }
    let Some(protocol) = provider_protocol(account) else {
        return false;
    };
    let Some(endpoint) = provider_endpoint(account) else {
        return false;
    };
    ProviderProjection::new(
        key.clone(),
        endpoint,
        protocol,
        auth_header(account),
        legacy_transport_keys(account),
    )
    .apply_to_document(document)
}

fn apply_native_runtime(
    account: &ProviderAccount,
    key: &ProviderKey,
    document: &mut OpenClawConfigDocument,
) -> bool {
    if account.provider().as_str() != "provider:anthropic" {
        return false;
    }
    let mut models = object(document.get("models"));
    let mut providers = object(models.get("providers"));
    let mut entry = object(providers.get(key.as_str()));
    let before = entry.clone();
    if account.configuration().auth_mode() == ProviderAccountAuthMode::CliReuse {
        entry.insert(
            "agentRuntime".into(),
            serde_json::json!({ "id": "claude-cli" }),
        );
    } else if entry
        .get("agentRuntime")
        .and_then(|runtime| runtime.get("id"))
        .and_then(Value::as_str)
        == Some("claude-cli")
    {
        entry.remove("agentRuntime");
    }
    if entry == before {
        return false;
    }
    providers.insert(key.as_str().into(), Value::Object(entry));
    models.insert("providers".into(), Value::Object(providers));
    document.insert("models".into(), Value::Object(models));
    true
}

pub fn native_provider_plugin(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "provider:anthropic" => "anthropic",
        "provider:qianfan" => "qianfan",
        "provider:stepfun" => "stepfun",
        "provider:tencent-tokenhub" | "provider:tencent-tokenplan" => "tencent",
        "provider:xiaomi" | "provider:xiaomi-token-plan" => "xiaomi",
        "provider:qwen" | "provider:qwen-token-plan" => "qwen",
        "provider:kimi" => "kimi",
        "provider:volcengine-plan" => "volcengine",
        "provider:opencode" => "opencode",
        "provider:opencode-go" => "opencode-go",
        "provider:github-copilot" => "github-copilot",
        _ => return None,
    })
}

fn set_provider_plugin_enabled(
    plugin: &str,
    enabled: bool,
    document: &mut OpenClawConfigDocument,
) -> bool {
    let mut plugins = object(document.get("plugins"));
    let before = plugins.clone();
    if enabled
        && plugins
            .get("deny")
            .and_then(Value::as_array)
            .is_some_and(|deny| deny.iter().any(|id| id.as_str() == Some(plugin)))
    {
        return false;
    }
    let mut entries = object(plugins.get("entries"));
    let mut entry = object(entries.get(plugin));
    entry.insert("enabled".into(), Value::Bool(enabled));
    entries.insert(plugin.into(), Value::Object(entry));
    plugins.insert("entries".into(), Value::Object(entries));
    if let Some(Value::Array(allow)) = plugins.get_mut("allow") {
        if enabled {
            if !allow.iter().any(|value| value.as_str() == Some(plugin)) {
                allow.push(Value::String(plugin.into()));
            }
        } else {
            allow.retain(|value| value.as_str() != Some(plugin));
        }
    }
    if plugins == before {
        return false;
    }
    document.insert("plugins".into(), Value::Object(plugins));
    true
}

fn provider_protocol(account: &ProviderAccount) -> Option<ProviderProtocol> {
    if matches!(
        account.configuration().auth_mode(),
        ProviderAccountAuthMode::OAuthBrowser | ProviderAccountAuthMode::OAuthDevice
    ) && account.provider().as_str() == "provider:openai"
    {
        return Some(ProviderProtocol::OpenAiChatGptResponses);
    }
    match account
        .configuration()
        .protocol()
        .or_else(|| default_provider_protocol(account.provider().as_str()))?
    {
        environment::ProviderApiProtocol::AnthropicMessages => {
            Some(ProviderProtocol::AnthropicMessages)
        }
        environment::ProviderApiProtocol::GoogleGenerativeAi => {
            Some(ProviderProtocol::GoogleGenerativeAi)
        }
        environment::ProviderApiProtocol::OpenAiCompletions => {
            Some(ProviderProtocol::OpenAiCompletions)
        }
        environment::ProviderApiProtocol::OpenAiResponses => {
            Some(ProviderProtocol::OpenAiResponses)
        }
    }
}

pub fn default_provider_protocol(provider: &str) -> Option<environment::ProviderApiProtocol> {
    match provider {
        "provider:anthropic" | "provider:kimi" => {
            Some(environment::ProviderApiProtocol::AnthropicMessages)
        }
        "provider:google" => Some(environment::ProviderApiProtocol::GoogleGenerativeAi),
        "provider:openai" | "provider:github-copilot" => {
            Some(environment::ProviderApiProtocol::OpenAiResponses)
        }
        "provider:qianfan"
        | "provider:stepfun"
        | "provider:tencent-tokenhub"
        | "provider:tencent-tokenplan"
        | "provider:xiaomi"
        | "provider:xiaomi-token-plan"
        | "provider:qwen"
        | "provider:qwen-token-plan"
        | "provider:volcengine-plan"
        | "provider:opencode"
        | "provider:opencode-go"
        | "provider:ark"
        | "provider:zai"
        | "provider:zai-global"
        | "provider:moonshot"
        | "provider:moonshot-global"
        | "provider:siliconflow"
        | "provider:deepseek"
        | "provider:openrouter"
        | "provider:ollama" => Some(environment::ProviderApiProtocol::OpenAiCompletions),
        _ => None,
    }
}

fn provider_endpoint(account: &ProviderAccount) -> Option<ProviderEndpoint> {
    if account.provider().as_str() == "provider:openai"
        && matches!(
            account.configuration().auth_mode(),
            ProviderAccountAuthMode::OAuthBrowser | ProviderAccountAuthMode::OAuthDevice
        )
    {
        return Some(
            ProviderEndpoint::try_new(OPENAI_CODEX_OAUTH_BASE_URL.to_owned())
                .expect("OpenAI Codex OAuth endpoint is valid"),
        );
    }
    account
        .configuration()
        .endpoint()
        .map(|endpoint| endpoint.as_str())
        .or_else(|| default_provider_endpoint(account.provider().as_str()))
        .map(|endpoint| {
            ProviderEndpoint::try_new(endpoint.to_owned())
                .expect("environment endpoint is valid OpenClaw endpoint")
        })
}

pub fn default_provider_endpoint(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "provider:anthropic" => "https://api.anthropic.com",
        "provider:qianfan" => "https://qianfan.baidubce.com/v2",
        "provider:stepfun" => "https://api.stepfun.ai/v1",
        "provider:tencent-tokenhub" => "https://tokenhub.tencentmaas.com/v1",
        "provider:tencent-tokenplan" => "https://api.lkeap.cloud.tencent.com/plan/v3",
        "provider:xiaomi" => "https://api.xiaomimimo.com/v1",
        "provider:xiaomi-token-plan" => "https://token-plan-sgp.xiaomimimo.com/v1",
        "provider:qwen" => "https://coding-intl.dashscope.aliyuncs.com/v1",
        "provider:qwen-token-plan" => {
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
        }
        "provider:kimi" => "https://api.kimi.com/coding/",
        "provider:volcengine-plan" => "https://ark.cn-beijing.volces.com/api/coding/v3",
        "provider:opencode" => "https://opencode.ai/zen/v1",
        "provider:opencode-go" => "https://opencode.ai/zen/go/v1",
        "provider:github-copilot" => "https://api.individual.githubcopilot.com",
        _ => return None,
    })
}

fn auth_header(account: &ProviderAccount) -> Option<bool> {
    matches!(
        (
            account.provider().as_str(),
            account.configuration().auth_mode()
        ),
        (
            "provider:minimax-portal" | "provider:minimax-portal-cn",
            ProviderAccountAuthMode::OAuthDevice
        )
    )
    .then_some(true)
}

fn legacy_transport_keys(account: &ProviderAccount) -> Vec<ProviderKey> {
    if account.provider().as_str() == "provider:openai"
        && matches!(
            account.configuration().auth_mode(),
            ProviderAccountAuthMode::OAuthBrowser | ProviderAccountAuthMode::OAuthDevice
        )
    {
        vec![ProviderKey::try_new("openai-codex".into()).expect("legacy provider key is valid")]
    } else {
        Vec::new()
    }
}

#[derive(Clone, Copy)]
struct TextModelProjectionContext {
    custom_provider: bool,
}

fn text_models(
    key: &str,
    models: &[&ProviderModel],
    context: TextModelProjectionContext,
) -> Result<(agent_models::ProviderId, Vec<agent_models::Model>), ProviderModelProjectionError> {
    let provider = agent_models::ProviderId::try_new(key.to_owned())
        .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?;
    let projected = models
        .iter()
        .map(|model| {
            let model_id = model.model_id();
            agent_models::Model::try_new(
                agent_models::ModelId::try_new(model_id.to_owned())
                    .map_err(|_| ProviderModelProjectionError::InvalidModelIdentifier)?,
                model.context_window(),
                model.max_tokens(),
                text_input(model, context),
            )
            .map_err(provider_model_error_from_agent_model)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((provider, projected))
}

fn media_models(
    account: &ProviderAccount,
    key: &str,
    models: &[&ProviderModel],
) -> Result<media_models::ProviderModels, ProviderModelProjectionError> {
    let configuration = account.configuration();
    let endpoint = configuration
        .endpoint()
        .ok_or(ProviderModelProjectionError::AccountConfiguration)?;
    let protocol = configuration
        .media_protocol()
        .ok_or(ProviderModelProjectionError::AccountConfiguration)?;
    let projected = models
        .iter()
        .map(|model| {
            media_models::Model::try_new(
                media_models::ModelId::try_new(model.model_id().to_owned())
                    .map_err(|_| ProviderModelProjectionError::InvalidModelIdentifier)?,
                model.capabilities().to_vec(),
                model.timeout_ms(),
                model.aspect_ratio().map(str::to_owned),
                model.resolution().map(str::to_owned),
                model.quality().map(str::to_owned),
            )
            .map_err(provider_model_error_from_media_catalog)
        })
        .collect::<Result<Vec<_>, _>>()?;
    media_models::ProviderModels::try_new(
        media_models::ProviderKey::try_new(key.to_owned())
            .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
        configuration.label().to_owned(),
        media_models::Endpoint::try_new(endpoint.as_str().to_owned())
            .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
        media_protocol(protocol),
        projected,
    )
    .map_err(provider_model_error_from_media_catalog)
}

fn provider_model_error_from_agent_model(
    error: agent_models::ModelProjectionError,
) -> ProviderModelProjectionError {
    match error {
        agent_models::ModelProjectionError::InvalidModelId => {
            ProviderModelProjectionError::InvalidModelIdentifier
        }
        agent_models::ModelProjectionError::InvalidTokenLimit => {
            ProviderModelProjectionError::InvalidTokenLimit
        }
        agent_models::ModelProjectionError::DuplicateModelId
        | agent_models::ModelProjectionError::EmptyModelCatalog
        | agent_models::ModelProjectionError::InvalidProviderId => {
            ProviderModelProjectionError::AccountConfiguration
        }
    }
}

fn provider_model_error_from_media_catalog(
    error: media_models::MediaCatalogError,
) -> ProviderModelProjectionError {
    match error {
        media_models::MediaCatalogError::DuplicateProviderKey => {
            ProviderModelProjectionError::DuplicateProviderKey
        }
        media_models::MediaCatalogError::InvalidCapabilities => {
            ProviderModelProjectionError::InvalidModelCapability
        }
        media_models::MediaCatalogError::DuplicateModelId
        | media_models::MediaCatalogError::InvalidModelId => {
            ProviderModelProjectionError::InvalidModelIdentifier
        }
        media_models::MediaCatalogError::ConfigPersist => ProviderModelProjectionError::Persistence,
        media_models::MediaCatalogError::EmptyModelCatalog
        | media_models::MediaCatalogError::InvalidAspectRatio
        | media_models::MediaCatalogError::InvalidEndpoint
        | media_models::MediaCatalogError::InvalidLabel
        | media_models::MediaCatalogError::InvalidProviderKey
        | media_models::MediaCatalogError::InvalidQuality
        | media_models::MediaCatalogError::InvalidResolution
        | media_models::MediaCatalogError::InvalidTimeout => {
            ProviderModelProjectionError::AccountConfiguration
        }
    }
}

fn retired_transport(
    accounts: &BTreeMap<String, &ProviderAccount>,
    retired: &[ProviderAccount],
) -> Result<Vec<ProviderKey>, ProviderModelProjectionError> {
    let retained = projection_keys(accounts, true)?
        .into_values()
        .collect::<BTreeSet<_>>();
    let mut before = accounts.clone();
    for account in retired {
        before.insert(account.id().as_str().to_owned(), account);
    }
    projection_keys(&before, false)?
        .into_values()
        .filter(|key| !retained.contains(key))
        .map(|key| {
            ProviderKey::try_new(key)
                .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
        })
        .collect()
}

fn projection_keys(
    accounts: &BTreeMap<String, &ProviderAccount>,
    reject_zai_alias_collision: bool,
) -> Result<BTreeMap<String, String>, ProviderModelProjectionError> {
    let mut grouped = BTreeMap::<String, Vec<&ProviderAccount>>::new();
    for account in accounts.values() {
        grouped
            .entry(base_provider_key(account)?)
            .or_default()
            .push(*account);
    }
    let mut keys = BTreeMap::new();
    for (base, mut accounts) in grouped {
        accounts.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        if accounts.len() == 1 {
            keys.insert(accounts[0].id().as_str().to_owned(), base);
            continue;
        }
        if reject_zai_alias_collision && super::provider_key::is_single_slot_provider_key(&base) {
            return Err(ProviderModelProjectionError::DuplicateProviderKey);
        }
        for account in accounts {
            keys.insert(
                account.id().as_str().to_owned(),
                format!("{base}-{}", account.id().as_str()),
            );
        }
    }
    if keys.values().collect::<BTreeSet<_>>().len() != keys.len() {
        return Err(ProviderModelProjectionError::DuplicateProviderKey);
    }
    Ok(keys)
}

fn base_provider_key(account: &ProviderAccount) -> Result<String, ProviderModelProjectionError> {
    let key = super::provider_key::base_provider_key(account)
        .ok_or(ProviderModelProjectionError::AccountConfiguration)?;
    valid_provider_key(&key)
        .then_some(key)
        .ok_or(ProviderModelProjectionError::AccountConfiguration)
}

fn media_protocol(protocol: ProviderMediaApiProtocol) -> media_models::Protocol {
    match protocol {
        ProviderMediaApiProtocol::Google => media_models::Protocol::Google,
        ProviderMediaApiProtocol::OpenAi => media_models::Protocol::OpenAi,
        ProviderMediaApiProtocol::OpenRouter => media_models::Protocol::OpenRouter,
    }
}

fn text_input(
    model: &ProviderModel,
    context: TextModelProjectionContext,
) -> Vec<agent_models::InputModality> {
    let mut input = vec![agent_models::InputModality::Text];
    if model.supports(ProviderModelCapability::ImageUnderstand)
        || (context.custom_provider && infer_model_supports_image_input(model.model_id()))
    {
        input.push(agent_models::InputModality::Image);
    }
    input
}

fn infer_model_supports_image_input(model_id: &str) -> bool {
    let normalized = NormalizedModelId::new(model_id);
    normalized.matches(has_gpt_4x_or_o_series)
        || normalized.matches(|value| has_model_family(value, "gpt-5"))
        || normalized.matches(|value| {
            value.contains("claude-3")
                || value.contains("claude-4")
                || value.contains("claude-fable")
                || value.contains("claude-sonnet")
                || value.contains("claude-opus")
                || value.contains("claude-haiku")
        })
        || normalized.matches(|value| has_model_token(value, "gemini"))
        || normalized.matches(|value| {
            value.contains("qwen-vl") || (value.contains("qwen") && value.contains("vl"))
        })
        || normalized.matches(|value| {
            [
                "vision",
                "llava",
                "pixtral",
                "internvl",
                "mllama",
                "minicpm-v",
                "glm-4v",
            ]
            .iter()
            .any(|pattern| value.contains(pattern))
        })
        || normalized.matches(has_vl_token)
}

struct NormalizedModelId {
    bare: String,
    full: String,
}

impl NormalizedModelId {
    fn new(model_id: &str) -> Self {
        let full = model_id.trim().to_ascii_lowercase();
        let without_vendor = full.rsplit('/').next().unwrap_or(&full);
        let bare = without_vendor.split(':').next().unwrap_or(without_vendor);
        Self {
            bare: if bare.is_empty() {
                full.clone()
            } else {
                bare.to_owned()
            },
            full,
        }
    }

    fn matches(&self, predicate: fn(&str) -> bool) -> bool {
        predicate(&self.bare) || predicate(&self.full)
    }
}

fn has_gpt_4x_or_o_series(value: &str) -> bool {
    has_model_family(value, "gpt-4.1")
        || has_model_family(value, "gpt-4o")
        || has_model_token(value, "o1")
        || has_model_token(value, "o3")
        || has_model_token(value, "o4")
}

fn has_vl_token(value: &str) -> bool {
    has_model_token(value, "vl")
}

fn has_model_family(value: &str, family: &str) -> bool {
    let mut offset = 0;
    while let Some(relative) = value[offset..].find(family) {
        let index = offset + relative;
        let end = index + family.len();
        let before = index
            .checked_sub(1)
            .and_then(|previous| value.as_bytes().get(previous));
        let after = value.as_bytes().get(end);
        let before_ok = before.is_none() || before.is_some_and(|byte| !is_model_word_byte(*byte));
        let after_ok = after.is_none_or(|byte| !is_model_word_byte(*byte));
        if before_ok && after_ok {
            return true;
        }
        offset = end;
    }
    false
}

fn is_model_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn has_model_token(value: &str, token: &str) -> bool {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| part == token)
}

fn apply_compaction_safeguard_default(document: &mut OpenClawConfigDocument) -> bool {
    let mut agents = object(document.get("agents"));
    let mut defaults = object(agents.get("defaults"));
    match defaults.get_mut("compaction") {
        Some(Value::Object(compaction)) if !compaction.contains_key("mode") => {
            compaction.insert("mode".into(), Value::String("safeguard".into()));
        }
        Some(_) => return false,
        None => {
            defaults.insert(
                "compaction".into(),
                Value::Object(Map::from_iter([(
                    "mode".into(),
                    Value::String("safeguard".into()),
                )])),
            );
        }
    }
    agents.insert("defaults".into(), Value::Object(defaults));
    document.insert("agents".into(), Value::Object(agents));
    true
}

fn prune_unknown_model_references(
    document: &mut OpenClawConfigDocument,
    valid: &BTreeSet<String>,
) -> bool {
    let mut root = document.as_value();
    let Some(root_object) = root.as_object_mut() else {
        return false;
    };
    let Some(agents) = root_object.get_mut("agents").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    if let Some(defaults) = agents.get_mut("defaults").and_then(Value::as_object_mut) {
        changed |= prune_model_field(defaults, "model", valid);
    }
    if let Some(list) = agents.get_mut("list").and_then(Value::as_array_mut) {
        for agent in list.iter_mut().filter_map(Value::as_object_mut) {
            changed |= prune_model_field(agent, "model", valid);
        }
    }
    if changed {
        document.insert("agents".into(), root_object["agents"].clone());
    }
    changed
}

fn prune_model_field(
    object: &mut Map<String, Value>,
    field: &str,
    valid: &BTreeSet<String>,
) -> bool {
    let Some(current) = object.get(field).cloned() else {
        return false;
    };
    let next = match &current {
        Value::String(reference) => valid
            .contains(reference)
            .then_some(Value::String(reference.clone())),
        Value::Object(route) => {
            let mut route = route.clone();
            let primary = route
                .remove("primary")
                .and_then(|value| value.as_str().map(str::to_owned));
            let mut fallbacks = route
                .remove("fallbacks")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .filter(|reference| valid.contains(reference))
                .collect::<Vec<_>>();
            fallbacks.dedup();
            let primary = primary
                .filter(|reference| valid.contains(reference))
                .or_else(|| (!fallbacks.is_empty()).then(|| fallbacks.remove(0)));
            primary.map(|primary| {
                fallbacks.retain(|fallback| fallback != &primary);
                route.insert("primary".into(), Value::String(primary));
                route.insert(
                    "fallbacks".into(),
                    Value::Array(fallbacks.into_iter().map(Value::String).collect()),
                );
                Value::Object(route)
            })
        }
        value => Some(value.clone()),
    };
    if next.as_ref() == Some(&current) {
        return false;
    }
    match next {
        Some(next) => {
            object.insert(field.into(), next);
        }
        None => {
            object.remove(field);
        }
    }
    true
}

fn valid_provider_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.contains(['/', '\\'])
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use environment::{
        CredentialReference, ProviderAccountConfiguration, ProviderAccountConfigurationInput,
        ProviderAccountId, ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint,
        ProviderModelCapability, ProviderReference,
    };
    use serde_json::json;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        path: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "openclaw-provider-model-projection-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test root");
            let state_dir =
                CanonicalStateDir::provision(path.join("state")).expect("provision state");
            Self { path, state_dir }
        }

        fn config_path(&self) -> PathBuf {
            self.state_dir.as_path().join("openclaw.json")
        }
    }

    fn write_state_db_auth_profiles(root: &TestRoot, profiles: Value) {
        let database_path = root
            .state_dir
            .as_path()
            .join("state")
            .join("openclaw.sqlite");
        fs::create_dir_all(database_path.parent().expect("state-db parent"))
            .expect("create state-db parent");
        let connection = rusqlite::Connection::open(database_path).expect("open state-db");
        connection
            .execute(
                "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
                [],
            )
            .expect("create config machine state table");
        for (state_key, value) in [
            ("auth.sharedStore", json!({ "location": "state-db" })),
            (
                "authProfiles.store",
                json!({ "version": 1, "profiles": profiles }),
            ),
            ("authProfiles.state", json!({ "version": 1 })),
        ] {
            connection
                .execute(
                    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) \
                     VALUES (?1, ?2, ?3) \
                     ON CONFLICT(state_key) DO UPDATE SET \
                       value_json = excluded.value_json, \
                       updated_at_ms = excluded.updated_at_ms",
                    (
                        state_key,
                        serde_json::to_string(&value).expect("serialize auth state value"),
                        1_800_000_000_000_i64,
                    ),
                )
                .expect("write auth state value");
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn account(
        id: &str,
        provider: &str,
        auth_mode: ProviderAccountAuthMode,
        enabled: bool,
    ) -> ProviderAccount {
        account_with_protocol(
            id,
            provider,
            auth_mode,
            enabled,
            Some(ProviderApiProtocol::OpenAiResponses),
        )
    }

    fn account_with_protocol(
        id: &str,
        provider: &str,
        auth_mode: ProviderAccountAuthMode,
        enabled: bool,
        protocol: Option<ProviderApiProtocol>,
    ) -> ProviderAccount {
        ProviderAccount::new(
            ProviderAccountId::try_new(id).expect("account identifier"),
            ProviderReference::try_new(format!("provider:{provider}")).expect("provider reference"),
            ProviderAccountRevision::try_new(1).expect("account revision"),
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: "Provider".to_owned(),
                enabled,
                kind: ProviderAccountKind::Chat,
                endpoint: Some(
                    ProviderEndpoint::try_new("https://api.example.com/v1").expect("endpoint"),
                ),
                protocol,
                media_protocol: None,
                auth_mode,
                credential: (!matches!(auth_mode, ProviderAccountAuthMode::Local))
                    .then(|| CredentialReference::try_new(format!("credential:v1:{id}")))
                    .transpose()
                    .expect("credential"),
                created_at: "2026-07-31T10:00:00Z".to_owned(),
                updated_at: "2026-07-31T10:00:00Z".to_owned(),
            })
            .expect("account configuration"),
        )
    }

    fn model(account: &ProviderAccount, id: &str) -> ProviderModel {
        ProviderModel::try_new(
            account.id().clone(),
            id,
            vec![ProviderModelCapability::Chat],
            Some(128_000),
            Some(16_000),
            None,
            None,
            None,
            None,
        )
        .expect("model")
    }

    fn model_without_context(account: &ProviderAccount, id: &str) -> ProviderModel {
        ProviderModel::try_new(
            account.id().clone(),
            id,
            vec![ProviderModelCapability::Chat],
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("model")
    }

    fn auth_accounts(accounts: &[ProviderAccount]) -> BTreeSet<ProviderAccountId> {
        accounts
            .iter()
            .map(|account| account.id().clone())
            .collect()
    }

    #[test]
    fn local_account_projects_models_without_a_private_auth_profile() {
        let root = TestRoot::new();
        let account = account(
            "local-ollama",
            "ollama",
            ProviderAccountAuthMode::Local,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "llama-3.3")]).expect("catalog");
        let accounts = [account];

        let effect = ProviderModelProjection::apply(
            root.state_dir.clone(),
            &accounts,
            &catalog,
            &[],
            &auth_accounts(&accounts),
            1_800_000_000_000,
        )
        .expect("local projection must not require private auth");

        assert!(matches!(
            effect,
            ProviderModelProjectionEffect::ConfigurationWritten { changed: true }
        ));
        let document: Value =
            serde_json::from_slice(&fs::read(root.config_path()).expect("read projected config"))
                .expect("decode projected config");
        assert_eq!(
            document.pointer("/models/providers/ollama-local-ollama/models/0/id"),
            Some(&json!("llama-3.3"))
        );
        assert_eq!(
            document.pointer("/auth/profiles/ollama-local-ollama:default"),
            None
        );
        assert_eq!(document.pointer("/auth/order/ollama-local-ollama"), None);
    }

    #[test]
    fn non_local_account_requires_a_private_auth_profile() {
        let root = TestRoot::new();
        let account = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];

        assert_eq!(
            ProviderModelProjection::apply(
                root.state_dir.clone(),
                &accounts,
                &catalog,
                &[],
                &auth_accounts(&accounts),
                1_800_000_000_000,
            ),
            Err(ProviderModelProjectionError::CredentialUnavailable)
        );
    }

    #[test]
    fn credential_availability_uses_projected_provider_key() {
        let root = TestRoot::new();
        let account = account(
            "openai-oauth",
            "openai",
            ProviderAccountAuthMode::OAuthBrowser,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];
        write_state_db_auth_profiles(
            &root,
            json!({
                "openai-oauth": {
                    "type": "oauth",
                    "provider": "openai-codex",
                    "access": "access-token",
                    "refresh": "refresh-token",
                    "expires": 1_900_000_000_000_i64
                }
            }),
        );

        assert_eq!(
            ProviderModelProjection::apply(
                root.state_dir.clone(),
                &accounts,
                &catalog,
                &[],
                &auth_accounts(&accounts),
                1_800_000_000_000,
            ),
            Err(ProviderModelProjectionError::CredentialUnavailable)
        );

        write_state_db_auth_profiles(
            &root,
            json!({
                "openai-oauth": {
                    "type": "oauth",
                    "provider": "openai",
                    "access": "access-token",
                    "refresh": "refresh-token",
                    "expires": 1_900_000_000_000_i64
                }
            }),
        );

        let effect = ProviderModelProjection::apply(
            root.state_dir.clone(),
            &accounts,
            &catalog,
            &[],
            &auth_accounts(&accounts),
            1_800_000_000_000,
        )
        .expect("project with canonical provider profile");

        assert!(matches!(
            effect,
            ProviderModelProjectionEffect::ConfigurationWritten { changed: true }
        ));
        let document: Value =
            serde_json::from_slice(&fs::read(root.config_path()).expect("read projected config"))
                .expect("decode projected config");
        assert_eq!(
            document.pointer("/models/providers/openai/models/0/id"),
            Some(&json!("gpt-5.6"))
        );
        assert_eq!(
            document.pointer("/auth/profiles/openai:default"),
            Some(&json!({ "provider": "openai", "mode": "oauth" }))
        );
        assert_eq!(
            document.pointer("/auth/order/openai"),
            Some(&json!(["openai:default"]))
        );
    }

    #[test]
    fn scoped_auth_check_does_not_block_complete_public_projection() {
        let root = TestRoot::new();
        let changed = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let stale = account(
            "anthropic-stale",
            "anthropic",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            model(&changed, "gpt-5.6"),
            model(&stale, "claude-fable-5"),
        ])
        .expect("catalog");
        write_state_db_auth_profiles(
            &root,
            json!({
                "openai:default": {
                    "type": "api_key",
                    "provider": "openai",
                    "key": "openai-key"
                }
            }),
        );
        let accounts = [changed, stale];
        let required = BTreeSet::from([accounts[0].id().clone()]);
        let mut document = OpenClawConfigDocument::empty();

        assert!(
            ProviderModelProjection::apply_to_document(
                &root.state_dir,
                &mut document,
                &accounts,
                &catalog,
                &[],
                &required,
                1_800_000_000_000,
            )
            .expect("unrelated missing auth must not block projection")
        );
        let projected = document.as_value();
        assert_eq!(
            projected.pointer("/models/providers/openai/models/0/id"),
            Some(&json!("gpt-5.6"))
        );
        assert_eq!(
            projected.pointer("/models/providers/anthropic/models/0/id"),
            Some(&json!("claude-fable-5"))
        );
    }

    #[test]
    fn projects_chat_transport_and_models_in_one_document_mutation() {
        let account = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "mode": "merge",
                "providers": {
                    "openai": { "apiKey": "secret-canary", "unmanaged": true }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("agents"),
            Some(&json!({
                "defaults": {
                    "models": {
                        "openai/gpt-5.6": {}
                    }                }
            }))
        );
        assert_eq!(
            document.get("auth"),
            Some(&json!({
                "profiles": {
                    "openai:default": { "provider": "openai", "mode": "api_key" }
                },
                "order": {
                    "openai": ["openai:default"]
                }
            }))
        );
        assert_eq!(
            document
                .as_value()
                .pointer("/models/providers/openai/apiKey"),
            None
        );
        assert!(!plan.apply_to_document(&mut document));
    }

    #[test]
    fn custom_provider_projects_explicit_context_window_and_compaction_safeguard() {
        let account = account(
            "custom-12345678",
            "custom",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            ProviderModel::try_new(
                account.id().clone(),
                "explicit-context-window",
                vec![ProviderModelCapability::Chat],
                Some(64_000),
                Some(8_000),
                None,
                None,
                None,
                None,
            )
            .expect("model"),
            ProviderModel::try_new(
                account.id().clone(),
                "gpt-5.5",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("model"),
            ProviderModel::try_new(
                account.id().clone(),
                "private-context-tokens",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("model"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "providers": {
                    "custom-12345678": {
                        "models": [{
                            "id": "private-context-tokens",
                            "name": "private-context-tokens",
                            "contextTokens": 32_000
                        }]
                    }
                }
            }),
        );
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "temperature": 0.2
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/custom-12345678/models/0/contextWindow"),
            Some(&json!(64_000))
        );
        assert_eq!(
            value.pointer("/models/providers/custom-12345678/models/0/maxTokens"),
            Some(&json!(8_000))
        );
        assert_eq!(
            value.pointer("/models/providers/custom-12345678/models/1/contextWindow"),
            None
        );
        assert_eq!(
            value.pointer("/models/providers/custom-12345678/models/2/contextTokens"),
            Some(&json!(32_000))
        );
        assert_eq!(
            value.pointer("/models/providers/custom-12345678/models/2/contextWindow"),
            None
        );
        assert_eq!(
            value.pointer("/agents/defaults/compaction"),
            Some(&json!({ "mode": "safeguard" }))
        );
        assert_eq!(
            value.pointer("/agents/defaults/compaction/reserveTokensFloor"),
            None
        );
    }

    #[test]
    fn custom_provider_infers_image_input_without_context_window_backfill() {
        let account = account(
            "custom-12345678",
            "custom",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            model_without_context(&account, "unknown-private-model"),
            model_without_context(&account, "openai/gpt-5.6-sol"),
            model_without_context(&account, "gpt-5.5"),
            model_without_context(&account, "gpt-5.6-mini"),
            model_without_context(&account, "gpt-5"),
            model_without_context(&account, "gpt-5.56"),
            model_without_context(&account, "qwen3:latest"),
            model_without_context(&account, "moonshotai/kimi-k2.6"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        let models = value
            .pointer("/models/providers/custom-12345678/models")
            .and_then(Value::as_array)
            .expect("projected models");
        let model = |id: &str| {
            models
                .iter()
                .find(|model| model.get("id").and_then(Value::as_str) == Some(id))
                .expect("projected model")
        };
        for model in models {
            assert_eq!(model.get("contextWindow"), None);
        }
        assert_eq!(model("unknown-private-model")["input"], json!(["text"]));
        assert_eq!(
            model("openai/gpt-5.6-sol")["input"],
            json!(["text", "image"])
        );
        assert_eq!(model("gpt-5.5")["input"], json!(["text", "image"]));
        assert_eq!(model("gpt-5.6-mini")["input"], json!(["text", "image"]));
        assert_eq!(model("gpt-5")["input"], json!(["text", "image"]));
        assert_eq!(model("gpt-5.56")["input"], json!(["text", "image"]));
        assert_eq!(model("qwen3:latest")["input"], json!(["text"]));
        assert_eq!(model("moonshotai/kimi-k2.6")["input"], json!(["text"]));
    }

    #[test]
    fn chatgpt_oauth_transport_keeps_api_without_context_window_backfill() {
        let account = account(
            "openai-oauth",
            "openai",
            ProviderAccountAuthMode::OAuthBrowser,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            model_without_context(&account, "gpt-5.6-sol"),
            model_without_context(&account, "gpt-4o"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/openai/api"),
            Some(&json!("openai-chatgpt-responses"))
        );
        let models = value
            .pointer("/models/providers/openai/models")
            .and_then(Value::as_array)
            .expect("projected models");
        for model in models {
            assert_eq!(model.get("contextWindow"), None);
        }
    }

    #[test]
    fn ollama_keeps_model_tag_without_context_window_backfill() {
        let account = account(
            "ollama-local",
            "ollama",
            ProviderAccountAuthMode::Local,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            model_without_context(&account, "deepseek-v4-flash"),
            model_without_context(&account, "qwen3:latest"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/ollama-local/models/0/id"),
            Some(&json!("deepseek-v4-flash"))
        );
        assert_eq!(
            value.pointer("/models/providers/ollama-local/models/1/id"),
            Some(&json!("qwen3:latest"))
        );
        assert_eq!(
            value.pointer("/models/providers/ollama-local/models/0/contextWindow"),
            None
        );
        assert_eq!(
            value.pointer("/models/providers/ollama-local/models/1/contextWindow"),
            None
        );
    }

    #[test]
    fn explicit_image_capability_remains_highest_priority_for_custom_provider() {
        let account = account(
            "custom-12345678",
            "custom",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            ProviderModel::try_new(
                account.id().clone(),
                "unknown-private-model",
                vec![
                    ProviderModelCapability::Chat,
                    ProviderModelCapability::ImageUnderstand,
                ],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("model"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document
                .as_value()
                .pointer("/models/providers/custom-12345678/models/0/input"),
            Some(&json!(["text", "image"]))
        );
    }

    #[test]
    fn custom_provider_preserves_explicit_compaction_mode() {
        let account = account(
            "custom-12345678",
            "custom",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            ProviderModel::try_new(
                account.id().clone(),
                "private-model",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("model"),
        ])
        .expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "compaction": {
                        "mode": "default",
                        "keepRecentTokens": 123
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.as_value().pointer("/agents/defaults/compaction"),
            Some(&json!({ "mode": "default", "keepRecentTokens": 123 }))
        );
    }

    #[test]
    fn model_projection_migrates_legacy_openai_codex_refs() {
        let account = account(
            "openai-oauth",
            "openai",
            ProviderAccountAuthMode::OAuthBrowser,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "providers": {
                    "openai-codex": {
                        "baseUrl": "https://api.openai.com/v1",
                        "api": "openai-codex-responses",
                        "models": [{ "id": "gpt-5.6", "name": "Legacy" }]
                    }
                }
            }),
        );
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "model": {
                        "primary": "openai-codex/gpt-5.6",
                        "fallbacks": []
                    },
                    "models": {
                        "openai-codex/gpt-5.6": { "alias": "legacy" }
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/openai/baseUrl"),
            Some(&json!(OPENAI_CODEX_OAUTH_BASE_URL))
        );
        assert_eq!(
            value.pointer("/models/providers/openai/models/0/id"),
            Some(&json!("gpt-5.6"))
        );
        assert_eq!(value.pointer("/models/providers/openai-codex"), None);
        assert_eq!(
            value.pointer("/agents/defaults/model/primary"),
            Some(&json!("openai/gpt-5.6"))
        );
        assert_eq!(
            value.pointer("/agents/defaults/models/openai~1gpt-5.6/alias"),
            Some(&json!("legacy"))
        );
    }

    #[test]
    fn model_projection_updates_owned_allowlist_entries_without_clobbering_siblings() {
        let account = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "models": {
                        "anthropic/claude-fable-5": { "alias": "fable" },
                        "openai/old": { "alias": "old" }
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("agents"),
            Some(&json!({
                "defaults": {
                    "models": {
                        "anthropic/claude-fable-5": { "alias": "fable" },
                        "openai/gpt-5.6": {}
                    }
                }
            }))
        );
    }

    #[test]
    fn removed_model_drops_owned_default_allowlist_entry_and_keeps_valid_sibling() {
        let account = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "models": {
                        "openai/gpt-5.6": { "alias": "valid" },
                        "openai/deleted": { "alias": "deleted" },
                        "unmanaged/model": { "alias": "unmanaged" }
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/agents/defaults/models/openai~1gpt-5.6/alias"),
            Some(&json!("valid"))
        );
        assert_eq!(
            value.pointer("/agents/defaults/models/openai~1deleted"),
            None
        );
        assert_eq!(
            value.pointer("/agents/defaults/models/unmanaged~1model/alias"),
            Some(&json!("unmanaged"))
        );
    }

    #[test]
    fn maps_oauth_transport_without_materializing_credentials() {
        let openai = account(
            "openai-oauth",
            "openai",
            ProviderAccountAuthMode::OAuthBrowser,
            true,
        );
        let minimax = account(
            "minimax-oauth",
            "minimax-portal-cn",
            ProviderAccountAuthMode::OAuthDevice,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![]).expect("catalog");
        let accounts = [openai, minimax];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("models"),
            Some(&json!({
                "providers": {
                    "minimax-portal": {
                        "baseUrl": "https://api.example.com/v1",
                        "api": "openai-responses",
                        "authHeader": true
                    },
                    "openai": {
                        "baseUrl": OPENAI_CODEX_OAUTH_BASE_URL,
                        "api": "openai-chatgpt-responses",
                        "agentRuntime": { "id": "pi" }
                    }
                }
            }))
        );
        assert_eq!(
            document.get("auth"),
            Some(&json!({
                "profiles": {
                    "minimax-portal:default": { "provider": "minimax-portal", "mode": "oauth" },
                    "openai:default": { "provider": "openai", "mode": "oauth" }
                },
                "order": {
                    "minimax-portal": ["minimax-portal:default"],
                    "openai": ["openai:default"]
                }
            }))
        );
        assert_eq!(
            document
                .as_value()
                .pointer("/auth/profiles/openai:default/key"),
            None
        );
        assert_eq!(
            document
                .as_value()
                .pointer("/auth/profiles/openai:default/token"),
            None
        );
        assert_eq!(
            document
                .as_value()
                .pointer("/auth/profiles/openai:default/credentialReference"),
            None
        );
    }

    #[test]
    fn custom_provider_without_models_removes_transport_and_allowlist_entries() {
        let account = account(
            "custom-12345678",
            "custom",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "providers": {
                    "custom-12345678": { "baseUrl": "https://api.example.com/v1", "api": "openai-responses" }
                }
            }),
        );
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "models": {
                        "anthropic/claude-fable-5": {},
                        "custom-12345678/old": {}
                    }
                }
            }),
        );
        document.insert(
            "auth".into(),
            json!({
                "profiles": {
                    "custom-12345678:default": { "provider": "custom-12345678", "mode": "api_key" },
                    "custom-12345678:manual": { "provider": "custom-12345678", "mode": "api_key" }
                },
                "order": {
                    "custom-12345678": ["custom-12345678:default", "custom-12345678:manual"]
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(document.get("models"), Some(&json!({ "providers": {} })));
        assert_eq!(
            document.get("agents"),
            Some(&json!({
                "defaults": {
                    "models": {
                        "anthropic/claude-fable-5": {}
                    }
                }
            }))
        );
        assert_eq!(
            document.get("auth"),
            Some(&json!({
                "profiles": {
                    "custom-12345678:manual": { "provider": "custom-12345678", "mode": "api_key" }
                },
                "order": {
                    "custom-12345678": ["custom-12345678:manual"]
                }
            }))
        );
    }

    #[test]
    fn disabled_provider_removes_owned_model_allowlist_container_when_empty() {
        let disabled = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            false,
        );
        let catalog = ProviderModelCatalog::try_new(vec![]).expect("catalog");
        let accounts = [disabled];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "models": {
                        "openai/old": { "alias": "old" }
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(value.pointer("/agents/defaults/models"), None);
        assert_eq!(value.pointer("/agents/defaults"), None);
        assert_eq!(value.pointer("/agents"), None);
    }

    #[test]
    fn retired_provider_removes_owned_private_projection() {
        let retired = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![]).expect("catalog");
        let retired = [retired];
        let plan = ProjectionPlan::build(&[], &catalog, &retired).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "providers": {
                    "openai": { "baseUrl": "https://api.example.com/v1" },
                    "unmanaged": { "baseUrl": "https://unmanaged.example.com/v1" }
                }
            }),
        );
        document.insert(
            "auth".into(),
            json!({
                "profiles": {
                    "openai:default": { "provider": "openai", "mode": "api_key" }
                },
                "order": {
                    "openai": ["openai:default"]
                }
            }),
        );
        document.insert(
            "agents".into(),
            json!({
                "defaults": {
                    "models": {
                        "openai/old": { "alias": "old" },
                        "unmanaged/model": { "alias": "unmanaged" }
                    }
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(value.pointer("/models/providers/openai"), None);
        assert_eq!(
            value.pointer("/models/providers/unmanaged/baseUrl"),
            Some(&json!("https://unmanaged.example.com/v1"))
        );
        assert_eq!(value.pointer("/auth"), None);
        assert_eq!(value.pointer("/agents/defaults/models/openai~1old"), None);
        assert_eq!(
            value.pointer("/agents/defaults/models/unmanaged~1model/alias"),
            Some(&json!("unmanaged"))
        );
    }

    #[test]
    fn removes_only_retired_transport_when_the_key_is_no_longer_owned() {
        let retired = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![]).expect("catalog");
        let retired = [retired];
        let plan = ProjectionPlan::build(&[], &catalog, &retired).expect("plan");
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "models".into(),
            json!({
                "providers": {
                    "openai": { "baseUrl": "https://api.example.com/v1" },
                    "unmanaged": { "baseUrl": "https://unmanaged.example.com/v1" }
                }
            }),
        );
        document.insert(
            "auth".into(),
            json!({
                "profiles": {
                    "openai:default": { "provider": "openai", "mode": "api_key" },
                    "openai:custom": { "provider": "openai", "mode": "api_key" },
                    "unmanaged:default": { "provider": "unmanaged", "mode": "api_key" }
                },
                "order": {
                    "openai": ["openai:default", "openai:custom"],
                    "unmanaged": ["unmanaged:default"]
                }
            }),
        );

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("models"),
            Some(&json!({
                "providers": {
                    "unmanaged": { "baseUrl": "https://unmanaged.example.com/v1" }
                }
            }))
        );
        assert_eq!(
            document.get("auth"),
            Some(&json!({
                "profiles": {
                    "openai:custom": { "provider": "openai", "mode": "api_key" },
                    "unmanaged:default": { "provider": "unmanaged", "mode": "api_key" }
                },
                "order": {
                    "openai": ["openai:custom"],
                    "unmanaged": ["unmanaged:default"]
                }
            }))
        );
    }

    #[test]
    fn zai_global_uses_zai_runtime_key_and_default_protocol() {
        let account = account_with_protocol(
            "zai-global-main",
            "zai-global",
            ProviderAccountAuthMode::ApiKey,
            true,
            None,
        );
        let catalog = ProviderModelCatalog::try_new(vec![
            ProviderModel::try_new(
                account.id().clone(),
                "glm-5.2",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("glm 5 model"),
            ProviderModel::try_new(
                account.id().clone(),
                "glm-4.6",
                vec![ProviderModelCapability::Chat],
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("glm 4 model"),
        ])
        .expect("catalog");
        let accounts = [account];
        let identities = public_provider_model_identities(&accounts).expect("public identities");
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert_eq!(identities["zai-global-main"].provider_key(), "zai");
        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/zai/models/0/id"),
            Some(&json!("glm-4.6"))
        );
        assert_eq!(
            value.pointer("/models/providers/zai/models/0/contextWindow"),
            None
        );
        assert_eq!(
            value.pointer("/models/providers/zai/models/1/id"),
            Some(&json!("glm-5.2"))
        );
        assert_eq!(
            value.pointer("/models/providers/zai/models/1/contextWindow"),
            None
        );
        assert_eq!(
            value.pointer("/models/providers/zai/api"),
            Some(&json!("openai-completions"))
        );
        assert_eq!(
            value.pointer("/agents/defaults/models/zai~1glm-5.2"),
            Some(&json!({}))
        );
    }

    #[test]
    fn builtin_provider_transport_uses_runtime_default_protocol_when_account_has_none() {
        let account = account_with_protocol(
            "zai-main",
            "zai",
            ProviderAccountAuthMode::ApiKey,
            true,
            None,
        );
        let catalog =
            ProviderModelCatalog::try_new(vec![model(&account, "glm-5")]).expect("catalog");
        let accounts = [account];
        let plan = ProjectionPlan::build(&accounts, &catalog, &[]).expect("plan");
        let mut document = OpenClawConfigDocument::empty();

        assert!(plan.apply_to_document(&mut document));
        let value = document.as_value();
        assert_eq!(
            value.pointer("/models/providers/zai/api"),
            Some(&json!("openai-completions"))
        );
        assert_eq!(
            value.pointer("/models/providers/zai/baseUrl"),
            Some(&json!("https://api.example.com/v1"))
        );
    }

    #[test]
    fn repeated_single_slot_provider_key_is_ambiguous_instead_of_suffixing() {
        let first = account("zai-main", "zai", ProviderAccountAuthMode::ApiKey, true);
        let second = account("zai-alt", "zai", ProviderAccountAuthMode::ApiKey, true);

        assert_eq!(
            public_provider_model_identities(&[first, second]),
            Err(ProviderModelProjectionError::DuplicateProviderKey)
        );
    }

    #[test]
    fn zai_and_zai_global_are_ambiguous_instead_of_suffixing() {
        let zai = account("zai-main", "zai", ProviderAccountAuthMode::ApiKey, true);
        let global = account(
            "zai-global-main",
            "zai-global",
            ProviderAccountAuthMode::ApiKey,
            true,
        );

        assert_eq!(
            public_provider_model_identities(&[zai, global]),
            Err(ProviderModelProjectionError::DuplicateProviderKey)
        );
    }

    #[test]
    fn public_identities_reuse_canonical_keys_and_skip_disabled_accounts() {
        let openai = account(
            "openai-oauth",
            "openai",
            ProviderAccountAuthMode::OAuthBrowser,
            true,
        );
        let minimax = account(
            "minimax-oauth",
            "minimax-portal-cn",
            ProviderAccountAuthMode::OAuthDevice,
            true,
        );
        let disabled = account(
            "openai-disabled",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            false,
        );

        let identities = public_provider_model_identities(&[openai, minimax, disabled])
            .expect("public identities");

        assert_eq!(identities["openai-oauth"].provider_key(), "openai");
        assert_eq!(identities["minimax-oauth"].provider_key(), "minimax-portal");
        assert!(!identities.contains_key("openai-disabled"));
        assert_eq!(
            identities["openai-oauth"].runtime_model_ref(ProviderAccountKind::Chat, "gpt-5.6"),
            "openai/gpt-5.6"
        );
        assert_eq!(
            identities["openai-oauth"].runtime_model_ref(ProviderAccountKind::Media, "image-1"),
            "matchaclaw-media/openai/image-1"
        );
    }

    #[test]
    fn public_identities_suffix_colliding_enabled_accounts_deterministically() {
        let first = account("openai-a", "openai", ProviderAccountAuthMode::ApiKey, true);
        let second = account("openai-b", "openai", ProviderAccountAuthMode::ApiKey, true);

        let identities =
            public_provider_model_identities(&[second, first]).expect("public identities");

        assert_eq!(identities["openai-a"].provider_key(), "openai-openai-a");
        assert_eq!(identities["openai-b"].provider_key(), "openai-openai-b");
    }
}
