use std::{collections::BTreeMap, fmt};

use ::provider::{
    ProviderAccount, ProviderAccountKind, ProviderModelCatalog,
    ProviderRouting as DesiredProviderRouting, ProviderRoutingCapability,
};
use serde_json::{Map, Value};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::{auth, provider_key},
};

use super::config_store::{
    OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError,
    OpenClawConfigUpdate,
};

const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_PROVIDER_KEY_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PositiveTimeoutMs(u64);

impl PositiveTimeoutMs {
    pub(crate) fn try_new(value: u64) -> Result<Self, RoutingProjectionError> {
        (value > 0)
            .then_some(Self(value))
            .ok_or(RoutingProjectionError::InvalidTimeoutMs)
    }

    fn as_u64(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ProviderKey(String);

impl ProviderKey {
    pub(crate) fn try_new(value: String) -> Result<Self, RoutingProjectionError> {
        valid_provider_key(&value)
            .then_some(Self(value))
            .ok_or(RoutingProjectionError::InvalidProviderKey)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProviderKey").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ModelId(String);

impl ModelId {
    pub(crate) fn try_new(value: String) -> Result<Self, RoutingProjectionError> {
        valid_identifier(&value, MAX_MODEL_ID_BYTES)
            .then_some(Self(value))
            .ok_or(RoutingProjectionError::InvalidModelId)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ModelId").field(&self.0).finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModelRoute {
    primary: ModelReference,
    fallbacks: Vec<ModelReference>,
    timeout_ms: Option<PositiveTimeoutMs>,
}

impl ModelRoute {
    pub(crate) fn new(
        primary: ModelReference,
        fallbacks: Vec<ModelReference>,
        timeout_ms: Option<PositiveTimeoutMs>,
    ) -> Self {
        Self {
            primary,
            fallbacks,
            timeout_ms,
        }
    }

    fn as_json(&self, allows_timeout: bool) -> Result<Value, RoutingProjectionError> {
        if self.timeout_ms.is_some() && !allows_timeout {
            return Err(RoutingProjectionError::UnsupportedTimeout);
        }
        let mut route = Map::from_iter([
            ("primary".into(), Value::String(self.primary.as_string())),
            (
                "fallbacks".into(),
                Value::Array(
                    self.fallbacks
                        .iter()
                        .map(ModelReference::as_string)
                        .map(Value::String)
                        .collect(),
                ),
            ),
        ]);
        if let Some(timeout_ms) = self.timeout_ms {
            route.insert("timeoutMs".into(), Value::from(timeout_ms.as_u64()));
        }
        Ok(Value::Object(route))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModelReference {
    provider: ProviderKey,
    model: ModelId,
}

impl ModelReference {
    pub(crate) fn new(provider: ProviderKey, model: ModelId) -> Self {
        Self { provider, model }
    }

    fn as_string(&self) -> String {
        format!("{}/{}", self.provider.as_str(), self.model.as_str())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CapabilityRouting {
    pub(crate) chat: Option<ModelRoute>,
    pub(crate) image_understand: Option<ModelRoute>,
    pub(crate) image_generate: Option<ModelRoute>,
    pub(crate) video_generate: Option<ModelRoute>,
    pub(crate) music_generate: Option<ModelRoute>,
    pub(crate) tts_provider: Option<ProviderKey>,
}

impl CapabilityRouting {
    pub(crate) fn apply(
        &self,
        store: &OpenClawConfigStore,
    ) -> Result<OpenClawConfigUpdate, RoutingProjectionError> {
        let mut projection_error = None;
        let update = store
            .update(|document| match self.apply_to_document(document) {
                Ok(true) => OpenClawConfigMutation::changed(),
                Ok(false) => OpenClawConfigMutation::unchanged(),
                Err(error) => {
                    projection_error = Some(error);
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map_err(RoutingProjectionError::ConfigStore)?;
        match projection_error {
            Some(error) => Err(error),
            None => Ok(update),
        }
    }

    fn apply_to_document(
        &self,
        document: &mut OpenClawConfigDocument,
    ) -> Result<bool, RoutingProjectionError> {
        let agents_changed = self.apply_agents_defaults(document)?;
        let tts_changed = self.apply_tts_provider(document);
        Ok(agents_changed || tts_changed)
    }

    fn apply_agents_defaults(
        &self,
        document: &mut OpenClawConfigDocument,
    ) -> Result<bool, RoutingProjectionError> {
        let mut agents = object(document.get("agents"));
        let mut defaults = object(agents.get("defaults"));
        set_route(&mut defaults, "model", self.chat.as_ref(), false)?;
        set_route(
            &mut defaults,
            "imageModel",
            self.image_understand.as_ref(),
            true,
        )?;
        set_route(
            &mut defaults,
            "imageGenerationModel",
            self.image_generate.as_ref(),
            true,
        )?;
        set_route(
            &mut defaults,
            "videoGenerationModel",
            self.video_generate.as_ref(),
            true,
        )?;
        set_route(
            &mut defaults,
            "musicGenerationModel",
            self.music_generate.as_ref(),
            true,
        )?;
        if self.has_media_route() {
            defaults.insert(
                "mediaGenerationAutoProviderFallback".into(),
                Value::Bool(false),
            );
        } else {
            defaults.remove("mediaGenerationAutoProviderFallback");
        }
        agents.insert("defaults".into(), Value::Object(defaults));
        Ok(replace(document, "agents", Value::Object(agents)))
    }

    fn apply_tts_provider(&self, document: &mut OpenClawConfigDocument) -> bool {
        let Some(provider) = &self.tts_provider else {
            let Some(messages) = document.get("messages").and_then(Value::as_object) else {
                return false;
            };
            let Some(tts) = messages.get("tts").and_then(Value::as_object) else {
                return false;
            };
            if !tts.contains_key("provider") {
                return false;
            }
            let mut messages = messages.clone();
            let mut tts = tts.clone();
            tts.remove("provider");
            if tts.is_empty() {
                messages.remove("tts");
            } else {
                messages.insert("tts".into(), Value::Object(tts));
            }
            return replace(document, "messages", Value::Object(messages));
        };

        let mut messages = object(document.get("messages"));
        let mut tts = object(messages.get("tts"));
        tts.insert(
            "provider".into(),
            Value::String(provider.as_str().to_owned()),
        );
        messages.insert("tts".into(), Value::Object(tts));
        replace(document, "messages", Value::Object(messages))
    }

    fn has_media_route(&self) -> bool {
        self.image_generate.is_some()
            || self.video_generate.is_some()
            || self.music_generate.is_some()
    }
}

/// The private OpenClaw configuration effect of durable desired provider routing.
///
/// This facade is intentionally final-purpose: it accepts non-secret Environment routing facts,
/// resolves their sealed credential bindings only to validate the projection, and writes no public
/// provider-key material.
pub struct ProviderRoutingProjection;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderRoutingProjectionEffect {
    ConfigurationWritten { changed: bool },
}

impl ProviderRoutingProjection {
    pub fn apply(
        state_dir: CanonicalStateDir,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        routing: &DesiredProviderRouting,
        now_millis: u64,
    ) -> Result<ProviderRoutingProjectionEffect, ProviderRoutingProjectionError> {
        let routes =
            ProjectionRoutes::build(state_dir.clone(), accounts, models, routing, now_millis)?;
        let update = routes
            .routing
            .apply(&OpenClawConfigStore::new(state_dir))
            .map_err(|_| ProviderRoutingProjectionError::Persistence)?;
        Ok(ProviderRoutingProjectionEffect::ConfigurationWritten {
            changed: update.changed,
        })
    }

    pub(crate) fn apply_to_document(
        state_dir: &CanonicalStateDir,
        document: &mut OpenClawConfigDocument,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        routing: &DesiredProviderRouting,
        now_millis: u64,
    ) -> Result<bool, ProviderRoutingProjectionError> {
        let routes =
            ProjectionRoutes::build(state_dir.clone(), accounts, models, routing, now_millis)?;
        routes
            .routing
            .apply_to_document(document)
            .map_err(|_| ProviderRoutingProjectionError::InvalidRoute)
    }
}

struct ProjectionRoutes {
    routing: CapabilityRouting,
}

impl ProjectionRoutes {
    fn build(
        state_dir: CanonicalStateDir,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        desired: &DesiredProviderRouting,
        now_millis: u64,
    ) -> Result<Self, ProviderRoutingProjectionError> {
        let accounts = accounts_by_id(accounts)?;
        let keys = projection_keys(&accounts)?;
        let mut routing = CapabilityRouting::default();
        for (capability, route) in desired.routes() {
            let route = route_for(
                state_dir.clone(),
                &accounts,
                &keys,
                models,
                *capability,
                route,
                now_millis,
            )?;
            match capability {
                ProviderRoutingCapability::Chat => routing.chat = Some(route),
                ProviderRoutingCapability::ImageUnderstand => {
                    routing.image_understand = Some(route)
                }
                ProviderRoutingCapability::ImageGenerate => routing.image_generate = Some(route),
                ProviderRoutingCapability::VideoGenerate => routing.video_generate = Some(route),
                ProviderRoutingCapability::MusicGenerate => routing.music_generate = Some(route),
                ProviderRoutingCapability::Tts => {
                    if !route.fallbacks.is_empty() || route.timeout_ms.is_some() {
                        return Err(ProviderRoutingProjectionError::InvalidRoute);
                    }
                    routing.tts_provider = Some(route.primary.provider);
                }
            }
        }
        Ok(Self { routing })
    }
}

fn route_for(
    state_dir: CanonicalStateDir,
    accounts: &BTreeMap<String, &ProviderAccount>,
    keys: &BTreeMap<String, String>,
    models: &ProviderModelCatalog,
    capability: ProviderRoutingCapability,
    route: &::provider::ProviderRoute,
    now_millis: u64,
) -> Result<ModelRoute, ProviderRoutingProjectionError> {
    let primary = reference_for(
        state_dir.clone(),
        accounts,
        keys,
        models,
        capability,
        route.primary(),
        now_millis,
    )?;
    let fallbacks = route
        .fallbacks()
        .iter()
        .map(|reference| {
            reference_for(
                state_dir.clone(),
                accounts,
                keys,
                models,
                capability,
                reference,
                now_millis,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let timeout_ms = route
        .timeout_ms()
        .map(PositiveTimeoutMs::try_new)
        .transpose()
        .map_err(|_| ProviderRoutingProjectionError::InvalidRoute)?;
    Ok(ModelRoute::new(primary, fallbacks, timeout_ms))
}

fn reference_for(
    state_dir: CanonicalStateDir,
    accounts: &BTreeMap<String, &ProviderAccount>,
    keys: &BTreeMap<String, String>,
    models: &ProviderModelCatalog,
    capability: ProviderRoutingCapability,
    reference: &::provider::ProviderModelReference,
    now_millis: u64,
) -> Result<ModelReference, ProviderRoutingProjectionError> {
    let account = accounts
        .get(reference.account_id().as_str())
        .copied()
        .ok_or(ProviderRoutingProjectionError::AccountUnavailable)?;
    let Some(model) = models.models().iter().find(|model| {
        model.account_id() == reference.account_id() && model.model_id() == reference.model_id()
    }) else {
        return Err(ProviderRoutingProjectionError::ModelUnavailable);
    };
    if !model.supports(model_capability(capability)) {
        return Err(ProviderRoutingProjectionError::ModelCapabilityUnavailable);
    }
    let key = keys
        .get(account.id().as_str())
        .ok_or(ProviderRoutingProjectionError::AccountUnavailable)?;
    if let Some(credential) = account.configuration().credential()
        && !auth::credential_is_available(&state_dir, key, credential, now_millis)
            .map_err(|_| ProviderRoutingProjectionError::CredentialUnavailable)?
    {
        return Err(ProviderRoutingProjectionError::CredentialUnavailable);
    }
    let model = match account.configuration().kind() {
        ProviderAccountKind::Chat => reference.model_id().to_owned(),
        ProviderAccountKind::Media => format!("{key}/{}", reference.model_id()),
    };
    let provider = match account.configuration().kind() {
        ProviderAccountKind::Chat => key.clone(),
        ProviderAccountKind::Media => "matchaclaw-media".to_owned(),
    };
    Ok(ModelReference::new(
        ProviderKey::try_new(provider).map_err(|_| ProviderRoutingProjectionError::InvalidRoute)?,
        ModelId::try_new(model).map_err(|_| ProviderRoutingProjectionError::InvalidRoute)?,
    ))
}

fn accounts_by_id(
    accounts: &[ProviderAccount],
) -> Result<BTreeMap<String, &ProviderAccount>, ProviderRoutingProjectionError> {
    let mut result = BTreeMap::new();
    for account in accounts
        .iter()
        .filter(|account| account.configuration().enabled())
    {
        if result
            .insert(account.id().as_str().to_owned(), account)
            .is_some()
        {
            return Err(ProviderRoutingProjectionError::AccountUnavailable);
        }
    }
    Ok(result)
}

fn projection_keys(
    accounts: &BTreeMap<String, &ProviderAccount>,
) -> Result<BTreeMap<String, String>, ProviderRoutingProjectionError> {
    let mut grouped = BTreeMap::<String, Vec<&ProviderAccount>>::new();
    for account in accounts.values() {
        let key = provider_key::base_provider_key(account)
            .ok_or(ProviderRoutingProjectionError::AccountUnavailable)?;
        grouped.entry(key).or_default().push(*account);
    }
    let mut keys = BTreeMap::new();
    for (base, mut group) in grouped {
        group.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        if group.len() > 1 && provider_key::is_single_slot_provider_key(&base) {
            return Err(ProviderRoutingProjectionError::AccountUnavailable);
        }
        let unique = group.len() == 1;
        for account in group {
            let key = if unique {
                base.clone()
            } else {
                format!("{base}-{}", account.id().as_str())
            };
            if !valid_provider_key(&key)
                || keys.insert(account.id().as_str().to_owned(), key).is_some()
            {
                return Err(ProviderRoutingProjectionError::AccountUnavailable);
            }
        }
    }
    Ok(keys)
}

const fn model_capability(
    capability: ProviderRoutingCapability,
) -> ::provider::ProviderModelCapability {
    match capability {
        ProviderRoutingCapability::Chat => ::provider::ProviderModelCapability::Chat,
        ProviderRoutingCapability::ImageUnderstand => {
            ::provider::ProviderModelCapability::ImageUnderstand
        }
        ProviderRoutingCapability::ImageGenerate => {
            ::provider::ProviderModelCapability::ImageGenerate
        }
        ProviderRoutingCapability::VideoGenerate => {
            ::provider::ProviderModelCapability::VideoGenerate
        }
        ProviderRoutingCapability::MusicGenerate => {
            ::provider::ProviderModelCapability::MusicGenerate
        }
        ProviderRoutingCapability::Tts => ::provider::ProviderModelCapability::TextToSpeech,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderRoutingProjectionError {
    AccountUnavailable,
    CredentialUnavailable,
    InvalidRoute,
    ModelCapabilityUnavailable,
    ModelUnavailable,
    Persistence,
}

impl ProviderRoutingProjectionError {
    pub const fn diagnostic_reason(self) -> &'static str {
        match self {
            Self::AccountUnavailable => "provider-routing-account-unavailable",
            Self::CredentialUnavailable => "provider-routing-credential-unavailable",
            Self::InvalidRoute => "provider-routing-invalid",
            Self::ModelCapabilityUnavailable => "provider-routing-model-capability-unavailable",
            Self::ModelUnavailable => "provider-routing-model-unavailable",
            Self::Persistence => "provider-routing-persistence-failed",
        }
    }
}

impl fmt::Display for ProviderRoutingProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AccountUnavailable => "OpenClaw routing account is unavailable",
            Self::CredentialUnavailable => "OpenClaw routing credential is unavailable",
            Self::InvalidRoute => "OpenClaw routing route is invalid",
            Self::ModelCapabilityUnavailable => "OpenClaw routing model capability is unavailable",
            Self::ModelUnavailable => "OpenClaw routing model is unavailable",
            Self::Persistence => "OpenClaw routing configuration persistence failed",
        })
    }
}

impl std::error::Error for ProviderRoutingProjectionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RoutingProjectionError {
    ConfigStore(OpenClawConfigStoreError),
    InvalidModelId,
    InvalidProviderKey,
    InvalidTimeoutMs,
    UnsupportedTimeout,
}

impl fmt::Display for RoutingProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ConfigStore(_) => "OpenClaw capability routing persistence failed",
            Self::InvalidModelId => "OpenClaw routing model identifier is invalid",
            Self::InvalidProviderKey => "OpenClaw routing provider identifier is invalid",
            Self::InvalidTimeoutMs => "OpenClaw routing timeout is invalid",
            Self::UnsupportedTimeout => {
                "OpenClaw routing timeout is unsupported for this capability"
            }
        })
    }
}

impl std::error::Error for RoutingProjectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ConfigStore(error) => Some(error),
            Self::InvalidModelId
            | Self::InvalidProviderKey
            | Self::InvalidTimeoutMs
            | Self::UnsupportedTimeout => None,
        }
    }
}

fn set_route(
    defaults: &mut Map<String, Value>,
    key: &str,
    route: Option<&ModelRoute>,
    allows_timeout: bool,
) -> Result<(), RoutingProjectionError> {
    match route {
        Some(route) => {
            defaults.insert(key.into(), route.as_json(allows_timeout)?);
        }
        None => {
            defaults.remove(key);
        }
    }
    Ok(())
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
