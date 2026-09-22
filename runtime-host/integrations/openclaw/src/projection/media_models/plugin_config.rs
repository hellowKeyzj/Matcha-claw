use std::collections::BTreeSet;

use serde_json::{Map, Value};

use super::{MediaProviderCatalog, ProviderModels};
use crate::projection::config_store::OpenClawConfigDocument;

const PLUGIN_ID: &str = "matchaclaw-media";

/// Projects non-secret custom-media desired facts into OpenClaw's private config.
/// A successful write is an effect receipt only; it does not prove runtime acceptance or health.
pub(super) fn apply(catalog: &MediaProviderCatalog, document: &mut OpenClawConfigDocument) -> bool {
    let mut changed = if catalog.providers().is_empty() {
        false
    } else {
        ensure_plugin_enabled(document)
    };
    let mut plugins = object(document.get("plugins"));
    let mut entries = object(plugins.get("entries"));
    let mut entry = object(entries.get(PLUGIN_ID));
    let mut config = object(entry.get("config"));
    let providers = catalog
        .providers()
        .iter()
        .map(|provider| {
            (
                provider.provider.as_str().to_owned(),
                provider_json(provider),
            )
        })
        .collect::<Map<_, _>>();
    if config.get("providers") != Some(&Value::Object(providers.clone())) {
        config.insert("providers".into(), Value::Object(providers));
        changed = true;
    }
    entry.insert("config".into(), Value::Object(config));
    if !catalog.providers().is_empty() {
        entry.insert("enabled".into(), Value::Bool(true));
    }
    entries.insert(PLUGIN_ID.into(), Value::Object(entry));
    plugins.insert("entries".into(), Value::Object(entries));
    let plugin_changed = replace(document, "plugins", Value::Object(plugins));
    changed || plugin_changed
}

fn provider_json(provider: &ProviderModels) -> Value {
    let models = provider
        .models
        .iter()
        .map(|model| {
            let mut value = Map::new();
            value.insert("id".into(), Value::String(model.id().as_str().to_owned()));
            value.insert(
                "capabilities".into(),
                Value::Array(
                    model
                        .capabilities()
                        .iter()
                        .map(|capability| Value::String(capability_name(*capability).into()))
                        .collect(),
                ),
            );
            if let Some(timeout_ms) = model.timeout_ms() {
                value.insert("timeoutMs".into(), Value::Number(timeout_ms.into()));
            }
            insert_option(&mut value, "aspectRatio", model.aspect_ratio());
            insert_option(&mut value, "resolution", model.resolution());
            insert_option(&mut value, "quality", model.quality());
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "label": provider.label,
        "baseUrl": provider.endpoint.as_str(),
        "apiProtocol": provider.protocol.as_str(),
        "models": models,
    })
}

fn capability_name(capability: ::provider::ProviderModelCapability) -> &'static str {
    match capability {
        ::provider::ProviderModelCapability::Chat => "chat",
        ::provider::ProviderModelCapability::ImageUnderstand => "imageUnderstand",
        ::provider::ProviderModelCapability::ImageGenerate => "imageGenerate",
        ::provider::ProviderModelCapability::VideoGenerate => "videoGenerate",
        ::provider::ProviderModelCapability::MusicGenerate => "musicGenerate",
        ::provider::ProviderModelCapability::TextToSpeech => "tts",
        ::provider::ProviderModelCapability::Transcribe => "transcribe",
    }
}

fn ensure_plugin_enabled(document: &mut OpenClawConfigDocument) -> bool {
    let mut plugins = object(document.get("plugins"));
    let allow = plugins
        .get("allow")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let mut next = allow;
    next.insert(PLUGIN_ID.into());
    let next = Value::Array(next.into_iter().map(Value::String).collect());
    if plugins.get("allow") == Some(&next) {
        return false;
    }
    plugins.insert("allow".into(), next);
    replace(document, "plugins", Value::Object(plugins))
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

fn insert_option(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        object.insert(key.into(), Value::String(value.to_owned()));
    }
}
