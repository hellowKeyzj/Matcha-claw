use std::collections::BTreeSet;

use serde_json::{Map, Value};

use super::{MediaProviderCatalog, ProviderModels};
use crate::native_config::config_store::OpenClawConfigDocument;

const RETIRED_PLUGIN_ID: &str = "matchaclaw-media";

/// Projects non-secret custom-media desired facts into OpenClaw's private config.
/// A successful write is an effect receipt only; it does not prove runtime acceptance or health.
pub(super) fn apply(
    catalog: &MediaProviderCatalog,
    document: &mut OpenClawConfigDocument,
    owned_provider_keys: &BTreeSet<String>,
    preserved_provider_keys: &BTreeSet<String>,
) -> bool {
    let models_changed = apply_provider_config(
        catalog,
        document,
        owned_provider_keys,
        preserved_provider_keys,
    );
    let plugins_changed = remove_retired_plugin(document);
    models_changed || plugins_changed
}

fn apply_provider_config(
    catalog: &MediaProviderCatalog,
    document: &mut OpenClawConfigDocument,
    owned_provider_keys: &BTreeSet<String>,
    preserved_provider_keys: &BTreeSet<String>,
) -> bool {
    if catalog.providers().is_empty()
        && document
            .get("models")
            .and_then(|models| models.get("providers"))
            .and_then(Value::as_object)
            .is_none()
    {
        return false;
    }
    let mut models = document
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut providers = match models.remove("providers") {
        Some(Value::Object(providers)) => providers,
        _ => Map::new(),
    };
    for key in owned_provider_keys.difference(preserved_provider_keys) {
        if let Some(provider) = providers.get_mut(key).and_then(Value::as_object_mut) {
            provider.remove("media");
        }
    }
    for provider in catalog.providers() {
        let key = provider.provider.as_str();
        let mut entry = match providers.remove(key) {
            Some(Value::Object(entry)) => entry,
            _ => Map::new(),
        };
        entry.insert(
            "baseUrl".into(),
            Value::String(provider.endpoint.as_str().to_owned()),
        );
        entry
            .entry("models")
            .or_insert_with(|| Value::Array(Vec::new()));
        entry.insert("media".into(), media_json(provider));
        providers.insert(key.to_owned(), Value::Object(entry));
    }
    models.insert("providers".into(), Value::Object(providers));
    replace(document, "models", Value::Object(models))
}

fn media_json(provider: &ProviderModels) -> Value {
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
        "api": provider.protocol.as_str(),
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

fn remove_retired_plugin(document: &mut OpenClawConfigDocument) -> bool {
    let Some(Value::Object(mut plugins)) = document.get("plugins").cloned() else {
        return false;
    };
    if let Some(entries) = plugins.get_mut("entries").and_then(Value::as_object_mut) {
        entries.remove(RETIRED_PLUGIN_ID);
    }
    if let Some(allow) = plugins.get_mut("allow").and_then(Value::as_array_mut) {
        allow.retain(|entry| entry.as_str() != Some(RETIRED_PLUGIN_ID));
    }
    if let Some(paths) = plugins
        .get_mut("load")
        .and_then(|load| load.get_mut("paths"))
        .and_then(Value::as_array_mut)
    {
        paths.retain(|path| !path.as_str().is_some_and(is_retired_plugin_path));
    }
    replace(document, "plugins", Value::Object(plugins))
}

fn is_retired_plugin_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let directory = normalized
        .strip_suffix("/dist/index.js")
        .unwrap_or(normalized);
    matches!(
        directory.rsplit('/').next(),
        Some("matchaclaw-media" | "openclaw-matchaclaw-media-plugin")
    )
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
