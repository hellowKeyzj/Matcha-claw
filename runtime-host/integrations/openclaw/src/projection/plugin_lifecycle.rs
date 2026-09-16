use std::collections::BTreeSet;

use serde_json::{Map, Value};

use super::config_store::{
    OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError,
    OpenClawConfigUpdate,
};

pub(crate) const MEMORY_PLUGIN_ID: &str = "memory-lancedb-pro";
const LOCAL_MINILM_PROVIDER: &str = "local-minilm";
const LOCAL_MINILM_MODEL: &str = "all-MiniLM-L6-v2";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PluginLifecycleTransitionState {
    pub(crate) previous_enabled_plugin_ids: Vec<String>,
    pub(crate) next_enabled_plugin_ids: Vec<String>,
    pub(crate) newly_enabled_plugin_ids: Vec<String>,
    pub(crate) newly_disabled_plugin_ids: Vec<String>,
}

impl PluginLifecycleTransitionState {
    pub(crate) fn new<P, N>(previous: P, next: N) -> Self
    where
        P: IntoIterator,
        P::Item: Into<String>,
        N: IntoIterator,
        N::Item: Into<String>,
    {
        let previous_enabled_plugin_ids = unique_ids(previous);
        let next_enabled_plugin_ids = unique_ids(next);
        let previous_set = previous_enabled_plugin_ids.iter().collect::<BTreeSet<_>>();
        let next_set = next_enabled_plugin_ids.iter().collect::<BTreeSet<_>>();
        let newly_enabled_plugin_ids = next_enabled_plugin_ids
            .iter()
            .filter(|id| !previous_set.contains(id))
            .cloned()
            .collect();
        let newly_disabled_plugin_ids = previous_enabled_plugin_ids
            .iter()
            .filter(|id| !next_set.contains(id))
            .cloned()
            .collect();

        Self {
            previous_enabled_plugin_ids,
            next_enabled_plugin_ids,
            newly_enabled_plugin_ids,
            newly_disabled_plugin_ids,
        }
    }
}

pub(crate) fn apply_transition_config<F>(
    store: &OpenClawConfigStore,
    transition: &PluginLifecycleTransitionState,
    mut set_plugin_enabled: F,
) -> Result<OpenClawConfigUpdate, OpenClawConfigStoreError>
where
    F: FnMut(&mut OpenClawConfigDocument, &str, bool) -> bool,
{
    store.update_private_document(|document| {
        let mut changed = false;
        for plugin_id in &transition.next_enabled_plugin_ids {
            changed |= set_plugin_enabled(document, plugin_id, true);
            changed |= apply_enable_config(document, plugin_id);
        }
        for plugin_id in &transition.newly_disabled_plugin_ids {
            changed |= set_plugin_enabled(document, plugin_id, false);
            changed |= apply_disable_config(document, plugin_id);
        }
        if changed {
            OpenClawConfigMutation::changed()
        } else {
            OpenClawConfigMutation::unchanged()
        }
    })
}

pub(crate) fn apply_startup_config<I>(
    store: &OpenClawConfigStore,
    enabled_plugin_ids: I,
) -> Result<OpenClawConfigUpdate, OpenClawConfigStoreError>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    store.update_private_document(|document| {
        let changed = enabled_plugin_ids.into_iter().fold(false, |changed, id| {
            changed | apply_enable_config(document, id.as_ref())
        });
        if changed {
            OpenClawConfigMutation::changed()
        } else {
            OpenClawConfigMutation::unchanged()
        }
    })
}

pub(crate) fn apply_enable_config(document: &mut OpenClawConfigDocument, plugin_id: &str) -> bool {
    if plugin_id == MEMORY_PLUGIN_ID {
        ensure_memory_plugin_configured(document)
    } else {
        false
    }
}

pub(crate) fn apply_disable_config(document: &mut OpenClawConfigDocument, plugin_id: &str) -> bool {
    if plugin_id == MEMORY_PLUGIN_ID {
        release_memory_slot(document)
    } else {
        false
    }
}

fn ensure_memory_plugin_configured(document: &mut OpenClawConfigDocument) -> bool {
    let mut plugins = object(document.get("plugins"));
    let mut slots = object(plugins.get("slots"));
    let mut entries = object(plugins.get("entries"));
    let mut entry = object(entries.get(MEMORY_PLUGIN_ID));
    let mut config = object(entry.get("config"));
    let mut embedding = object(config.get("embedding"));
    let mut changed = false;

    changed |= replace(&mut slots, "memory", Value::String(MEMORY_PLUGIN_ID.into()));
    changed |= default_value(
        &mut config,
        "autoCapture",
        Value::Bool(true),
        Value::is_boolean,
    );
    changed |= default_value(
        &mut config,
        "autoRecall",
        Value::Bool(true),
        Value::is_boolean,
    );
    changed |= default_value(
        &mut config,
        "autoRecallMinLength",
        Value::from(5),
        Value::is_number,
    );
    changed |= default_value(
        &mut config,
        "smartExtraction",
        Value::Bool(true),
        Value::is_boolean,
    );
    changed |= default_value(
        &mut config,
        "extractMinMessages",
        Value::from(5),
        Value::is_number,
    );
    changed |= default_value(
        &mut config,
        "extractMaxChars",
        Value::from(8000),
        Value::is_number,
    );

    let mut session_memory = object(config.get("sessionMemory"));
    changed |= default_value(
        &mut session_memory,
        "enabled",
        Value::Bool(false),
        Value::is_boolean,
    );
    changed |= replace(&mut config, "sessionMemory", Value::Object(session_memory));

    let provider = text(embedding.get("provider"));
    let model = text(embedding.get("model"));
    if provider.is_none() {
        changed |= replace(
            &mut embedding,
            "provider",
            Value::String(LOCAL_MINILM_PROVIDER.into()),
        );
    }
    if provider
        .as_deref()
        .is_none_or(|value| value == LOCAL_MINILM_PROVIDER)
        && model.is_none()
    {
        changed |= replace(
            &mut embedding,
            "model",
            Value::String(LOCAL_MINILM_MODEL.into()),
        );
    }
    changed |= replace(&mut config, "embedding", Value::Object(embedding));
    changed |= replace(&mut entry, "config", Value::Object(config));
    changed |= replace(&mut entries, MEMORY_PLUGIN_ID, Value::Object(entry));
    changed |= replace(&mut plugins, "slots", Value::Object(slots));
    changed |= replace(&mut plugins, "entries", Value::Object(entries));
    changed |= replace_document(document, "plugins", Value::Object(plugins));
    changed
}

fn release_memory_slot(document: &mut OpenClawConfigDocument) -> bool {
    let Some(plugins) = document.get("plugins").and_then(Value::as_object) else {
        return false;
    };
    let Some(slots) = plugins.get("slots").and_then(Value::as_object) else {
        return false;
    };
    if slots.get("memory").and_then(Value::as_str) != Some(MEMORY_PLUGIN_ID) {
        return false;
    }

    let mut plugins = plugins.clone();
    let mut slots = slots.clone();
    slots.remove("memory");
    if slots.is_empty() {
        plugins.remove("slots");
    } else {
        plugins.insert("slots".into(), Value::Object(slots));
    }
    replace_document(document, "plugins", Value::Object(plugins))
}

fn unique_ids<I>(ids: I) -> Vec<String>
where
    I: IntoIterator,
    I::Item: Into<String>,
{
    let mut seen = BTreeSet::new();
    ids.into_iter()
        .map(Into::into)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn default_value(
    target: &mut Map<String, Value>,
    key: &str,
    value: Value,
    expected: fn(&Value) -> bool,
) -> bool {
    if target.get(key).is_some_and(expected) {
        return false;
    }
    replace(target, key, value)
}

fn replace(target: &mut Map<String, Value>, key: &str, value: Value) -> bool {
    if target.get(key) == Some(&value) {
        return false;
    }
    target.insert(key.into(), value);
    true
}

fn replace_document(document: &mut OpenClawConfigDocument, key: &str, value: Value) -> bool {
    if document.get(key) == Some(&value) {
        return false;
    }
    document.insert(key.into(), value);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_sets_legacy_defaults_inside_plugin_config() {
        let mut document = OpenClawConfigDocument::empty();
        assert!(apply_enable_config(&mut document, MEMORY_PLUGIN_ID));
        let value = document.as_value();
        let config = &value["plugins"]["entries"][MEMORY_PLUGIN_ID]["config"];
        assert_eq!(value["plugins"]["slots"]["memory"], MEMORY_PLUGIN_ID);
        assert_eq!(config["autoCapture"], true);
        assert_eq!(config["autoRecall"], true);
        assert_eq!(config["autoRecallMinLength"], 5);
        assert_eq!(config["smartExtraction"], true);
        assert_eq!(config["extractMinMessages"], 5);
        assert_eq!(config["extractMaxChars"], 8000);
        assert_eq!(config["sessionMemory"]["enabled"], false);
        assert_eq!(config["embedding"]["provider"], LOCAL_MINILM_PROVIDER);
        assert_eq!(config["embedding"]["model"], LOCAL_MINILM_MODEL);
    }

    #[test]
    fn enable_preserves_existing_values_and_disable_preserves_config() {
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "plugins".into(),
            serde_json::json!({
                "slots": {"memory": MEMORY_PLUGIN_ID, "other": "other-plugin"},
                "entries": {MEMORY_PLUGIN_ID: {"config": {
                    "autoCapture": false,
                    "embedding": {"provider": "custom", "model": "custom-model"}
                }}},
                "allow": [MEMORY_PLUGIN_ID]
            }),
        );
        assert!(apply_enable_config(&mut document, MEMORY_PLUGIN_ID));
        assert!(apply_disable_config(&mut document, MEMORY_PLUGIN_ID));
        let value = document.as_value();
        assert_eq!(
            value["plugins"]["slots"],
            serde_json::json!({"other": "other-plugin"})
        );
        assert_eq!(
            value["plugins"]["entries"][MEMORY_PLUGIN_ID]["config"]["autoCapture"],
            false
        );
        assert_eq!(
            value["plugins"]["allow"],
            serde_json::json!([MEMORY_PLUGIN_ID])
        );
    }

    #[test]
    fn transition_reports_enable_and_disable_sets() {
        let transition = PluginLifecycleTransitionState::new(
            ["memory-lancedb-pro", "old"],
            ["memory-lancedb-pro", "new"],
        );
        assert_eq!(transition.newly_enabled_plugin_ids, vec!["new"]);
        assert_eq!(transition.newly_disabled_plugin_ids, vec!["old"]);
    }
}
