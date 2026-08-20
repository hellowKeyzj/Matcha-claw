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
        provider::{ProviderEndpoint, ProviderKey, ProviderProjection, ProviderProtocol},
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
    Persistence,
}

impl std::fmt::Display for ProviderModelProjectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AccountConfiguration => "OpenClaw provider account configuration is unavailable",
            Self::CredentialUnavailable => "OpenClaw provider credential is unavailable",
            Self::DuplicateProviderKey => "OpenClaw provider configuration is ambiguous",
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
    projection_keys(&enabled)?
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
    let provider_key = projection_keys(&accounts)?
        .remove(&account_id)
        .ok_or(ProviderModelProjectionError::AccountConfiguration)?;
    Ok(ProviderModelRuntimeIdentity { provider_key })
}

pub(crate) fn canonical_provider_keys(
    accounts: &[ProviderAccount],
    retired: &[ProviderAccount],
) -> Result<BTreeSet<String>, ProviderModelProjectionError> {
    let mut active = BTreeMap::new();
    for account in accounts
        .iter()
        .filter(|account| account.configuration().enabled())
    {
        active.insert(account.id().as_str().to_owned(), account);
    }
    let mut all = active.clone();
    for account in retired {
        all.insert(account.id().as_str().to_owned(), account);
    }
    let mut keys = projection_keys(&active)?
        .into_values()
        .collect::<BTreeSet<_>>();
    keys.extend(projection_keys(&all)?.into_values());
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
    text: Vec<agent_models::ProviderModels>,
    empty_text: Vec<agent_models::ProviderId>,
    empty_transport: Vec<ProviderKey>,
    media: media_models::MediaProviderCatalog,
    model_allowlist_providers: BTreeSet<String>,
    valid_model_references: BTreeSet<String>,
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
        let keys = projection_keys(&all_accounts)?;
        let accounts = all_accounts.clone();
        let keys = keys
            .into_iter()
            .map(|(account_id, key)| {
                ProviderKey::try_new(key)
                    .map(|key| (account_id, key))
                    .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let removed_transport = retired_transport(&all_accounts, retired)?;

        let mut text = Vec::new();
        let mut empty_text = Vec::new();
        let mut empty_transport = Vec::new();
        let mut media = Vec::new();
        let mut model_allowlist_providers = BTreeSet::new();
        let mut valid_model_references = BTreeSet::new();
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
                            model_allowlist_providers.insert(key.as_str().to_owned());
                            empty_transport.push(key.clone());
                        }
                    }
                    ProviderAccountKind::Media => {}
                }
                continue;
            }
            match account.configuration().kind() {
                ProviderAccountKind::Chat => {
                    let (provider, projected_models) = text_models(key.as_str(), &models)?;
                    model_allowlist_providers.insert(key.as_str().to_owned());
                    for model in &models {
                        valid_model_references.insert(format!(
                            "{}/{}",
                            key.as_str(),
                            model.model_id()
                        ));
                    }
                    text.push(
                        agent_models::ProviderModels::try_new(provider, projected_models)
                            .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
                    );
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
            accounts,
            keys,
            removed_transport,
            text,
            empty_text,
            empty_transport,
            media: media_models::MediaProviderCatalog::try_new(media)
                .map_err(|_| ProviderModelProjectionError::DuplicateProviderKey)?,
            model_allowlist_providers,
            valid_model_references,
        })
    }

    fn apply_to_document(&self, document: &mut OpenClawConfigDocument) -> bool {
        let mut changed = false;
        for (account_id, account) in &self.accounts {
            let key = self
                .keys
                .get(account_id)
                .expect("every projected account receives a provider key");
            changed |= apply_transport(account, key, document);
        }
        for provider in &self.removed_transport {
            changed |= ProviderProjection::remove_from_document(provider, document);
        }
        for models in &self.text {
            changed |= models.apply_to_document(document);
        }
        for provider in &self.empty_text {
            changed |= agent_models::ProviderModels::remove_from_document(provider, document);
        }
        for provider in &self.empty_transport {
            changed |= ProviderProjection::remove_from_document(provider, document);
        }
        changed |= self.media.apply_to_document(document);
        changed |= apply_model_allowlist(
            document,
            &self.model_allowlist_providers,
            &self.valid_model_references,
        );
        changed | prune_unknown_model_references(document, &self.valid_model_references)
    }
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn apply_model_allowlist(
    document: &mut OpenClawConfigDocument,
    provider_keys: &BTreeSet<String>,
    model_references: &BTreeSet<String>,
) -> bool {
    let mut agents = object(document.get("agents"));
    let mut defaults = object(agents.get("defaults"));
    let mut models = object(defaults.get("models"));
    let before = models.clone();
    models.retain(|reference, _| {
        !provider_keys
            .iter()
            .any(|provider| provider_owns_model_reference(provider, reference))
            || model_references.contains(reference)
    });
    for reference in model_references {
        models.entry(reference.clone()).or_insert_with(|| Value::Object(Map::new()));
    }
    if models == before {
        return false;
    }
    if models.is_empty() {
        defaults.remove("models");
    } else {
        defaults.insert("models".into(), Value::Object(models));
    }
    agents.insert("defaults".into(), Value::Object(defaults));
    document.insert("agents".into(), Value::Object(agents));
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
    let Some(endpoint) = configuration.endpoint() else {
        return false;
    };
    let Some(protocol) = provider_protocol(account) else {
        return false;
    };
    ProviderProjection::new(
        key.clone(),
        ProviderEndpoint::try_new(endpoint.as_str().to_owned())
            .expect("environment endpoint is valid OpenClaw endpoint"),
        protocol,
        auth_header(account),
        [],
    )
    .apply_to_document(document)
}

fn provider_protocol(account: &ProviderAccount) -> Option<ProviderProtocol> {
    if matches!(
        account.configuration().auth_mode(),
        ProviderAccountAuthMode::OAuthBrowser
    ) && account.provider().as_str() == "provider:openai"
    {
        return Some(ProviderProtocol::OpenAiCodexResponses);
    }
    match account.configuration().protocol()? {
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

fn text_models(
    key: &str,
    models: &[&ProviderModel],
) -> Result<(agent_models::ProviderId, Vec<agent_models::Model>), ProviderModelProjectionError> {
    let provider = agent_models::ProviderId::try_new(key.to_owned())
        .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?;
    let projected = models
        .iter()
        .map(|model| {
            agent_models::Model::try_new(
                agent_models::ModelId::try_new(model.model_id().to_owned())
                    .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
                model.context_window(),
                model.max_tokens(),
                text_input(model),
            )
            .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
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
                    .map_err(|_| ProviderModelProjectionError::AccountConfiguration)?,
                model.capabilities().to_vec(),
                model.timeout_ms(),
                model.aspect_ratio().map(str::to_owned),
                model.resolution().map(str::to_owned),
                model.quality().map(str::to_owned),
            )
            .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
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
    .map_err(|_| ProviderModelProjectionError::AccountConfiguration)
}

fn retired_transport(
    accounts: &BTreeMap<String, &ProviderAccount>,
    retired: &[ProviderAccount],
) -> Result<Vec<ProviderKey>, ProviderModelProjectionError> {
    let retained = projection_keys(accounts)?
        .into_values()
        .collect::<BTreeSet<_>>();
    let mut before = accounts.clone();
    for account in retired {
        before.insert(account.id().as_str().to_owned(), account);
    }
    projection_keys(&before)?
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

fn text_input(model: &ProviderModel) -> Vec<agent_models::InputModality> {
    let mut input = vec![agent_models::InputModality::Text];
    if model.supports(ProviderModelCapability::ImageUnderstand) {
        input.push(agent_models::InputModality::Image);
    }
    input
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
    use crate::lifecycle::state_dir::{AgentId, PrivateAuthProfiles};

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
                protocol: Some(ProviderApiProtocol::OpenAiResponses),
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

    fn auth_accounts(accounts: &[ProviderAccount]) -> BTreeSet<ProviderAccountId> {
        accounts.iter().map(|account| account.id().clone()).collect()
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
        let agent = AgentId::try_new("main".into()).expect("agent");
        root.state_dir
            .replace_auth_profiles(
                &agent,
                &PrivateAuthProfiles::try_new(
                    br#"{"version":1,"profiles":{"openai-oauth":{"type":"oauth","provider":"openai","access":"access-token","refresh":"refresh-token","expires":1900000000000}}}"#.to_vec(),
                )
                .expect("raw provider profile"),
            )
            .expect("store raw provider profile");

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

        root.state_dir
            .replace_auth_profiles(
                &agent,
                &PrivateAuthProfiles::try_new(
                    br#"{"version":1,"profiles":{"openai-oauth":{"type":"oauth","provider":"openai-codex","access":"access-token","refresh":"refresh-token","expires":1900000000000}}}"#.to_vec(),
                )
                .expect("projected provider profile"),
            )
            .expect("store projected provider profile");

        let effect = ProviderModelProjection::apply(
            root.state_dir.clone(),
            &accounts,
            &catalog,
            &[],
            &auth_accounts(&accounts),
            1_800_000_000_000,
        )
        .expect("project with projected provider profile");

        assert!(matches!(
            effect,
            ProviderModelProjectionEffect::ConfigurationWritten { changed: true }
        ));
        let document: Value =
            serde_json::from_slice(&fs::read(root.config_path()).expect("read projected config"))
                .expect("decode projected config");
        assert_eq!(
            document.pointer("/models/providers/openai-codex/models/0/id"),
            Some(&json!("gpt-5.6"))
        );
    }

    #[test]
    fn scoped_auth_check_does_not_block_complete_public_projection() {
        let root = TestRoot::new();
        let changed = account("openai-main", "openai", ProviderAccountAuthMode::ApiKey, true);
        let stale = account("anthropic-stale", "anthropic", ProviderAccountAuthMode::ApiKey, true);
        let catalog = ProviderModelCatalog::try_new(vec![
            model(&changed, "gpt-5.6"),
            model(&stale, "claude-fable-5"),
        ])
        .expect("catalog");
        let agent = AgentId::try_new("main".into()).expect("agent");
        root.state_dir
            .replace_auth_profiles(
                &agent,
                &PrivateAuthProfiles::try_new(
                    br#"{"version":1,"profiles":{"openai-main":{"type":"api_key","provider":"openai","key":"openai-key"}}}"#.to_vec(),
                )
                .expect("auth profiles"),
            )
            .expect("store auth profiles");
        let accounts = [changed, stale];
        let required = BTreeSet::from([accounts[0].id().clone()]);
        let mut document = OpenClawConfigDocument::empty();

        assert!(ProviderModelProjection::apply_to_document(
            &root.state_dir,
            &mut document,
            &accounts,
            &catalog,
            &[],
            &required,
            1_800_000_000_000,
        )
        .expect("unrelated missing auth must not block projection"));
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
                    }
                }
            }))
        );
        assert!(!plan.apply_to_document(&mut document));
    }

    #[test]
    fn model_projection_updates_owned_allowlist_entries_without_clobbering_siblings() {
        let account = account(
            "openai-main",
            "openai",
            ProviderAccountAuthMode::ApiKey,
            true,
        );
        let catalog = ProviderModelCatalog::try_new(vec![model(&account, "gpt-5.6")]).expect("catalog");
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
                    "openai-codex": {
                        "baseUrl": "https://api.example.com/v1",
                        "api": "openai-codex-responses",
                        "agentRuntime": { "id": "pi" }
                    }
                }
            }))
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

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("models"),
            Some(&json!({ "providers": {} }))
        );
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

        assert!(plan.apply_to_document(&mut document));
        assert_eq!(
            document.get("models"),
            Some(&json!({
                "providers": {
                    "unmanaged": { "baseUrl": "https://unmanaged.example.com/v1" }
                }
            }))
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

        assert_eq!(identities["openai-oauth"].provider_key(), "openai-codex");
        assert_eq!(identities["minimax-oauth"].provider_key(), "minimax-portal");
        assert!(!identities.contains_key("openai-disabled"));
        assert_eq!(
            identities["openai-oauth"].runtime_model_ref(ProviderAccountKind::Chat, "gpt-5.6"),
            "openai-codex/gpt-5.6"
        );
        assert_eq!(
            identities["openai-oauth"].runtime_model_ref(ProviderAccountKind::Media, "image-1"),
            "matchaclaw-media/openai-codex/image-1"
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
