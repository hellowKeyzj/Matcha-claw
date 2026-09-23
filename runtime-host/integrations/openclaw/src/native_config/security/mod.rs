use std::fmt;

use serde_json::{Map, Value};

use platform::state_dir::CanonicalStateDir;

use super::config_store::{OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore};

const SECURITY_CORE_PLUGIN_ID: &str = "security-core";
const PRIVATE_AUTH_KEYS: &[&str] = &[
    "access",
    "access_token",
    "access-token",
    "apikey",
    "api_key",
    "api-key",
    "auth",
    "authorization",
    "client_secret",
    "client-secret",
    "clientsecret",
    "credential",
    "headers",
    "key",
    "password",
    "proxy-authorization",
    "refresh",
    "refresh_token",
    "refresh-token",
    "secret",
    "token",
    "x-api-key",
];

pub mod rule_catalog;

#[derive(Clone, Eq, PartialEq)]
pub struct SavedPolicyRuntimeProjection {
    runtime: Map<String, Value>,
}

impl SavedPolicyRuntimeProjection {
    pub fn from_normalized_runtime(runtime: Map<String, Value>) -> Self {
        Self { runtime }
    }

    pub fn apply(&self, state_dir: CanonicalStateDir) -> Result<bool, SecurityProjectionError> {
        apply_normalized(state_dir, &self.runtime)
    }
}

impl fmt::Debug for SavedPolicyRuntimeProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SavedPolicyRuntimeProjection([REDACTED])")
    }
}

/// The Host passes only its already normalized durable policy here. This private projection
/// never serializes the policy through a public transport or debug surface.
pub fn apply_normalized(
    state_dir: CanonicalStateDir,
    runtime: &Map<String, Value>,
) -> Result<bool, SecurityProjectionError> {
    if contains_private_auth(runtime) {
        return Err(SecurityProjectionError::ConfigStore);
    }
    OpenClawConfigStore::new(state_dir)
        .update(|document| {
            let mut plugins = object(document.get("plugins"));
            let mut entries = object(plugins.get("entries"));
            let mut security_core = object(entries.get(SECURITY_CORE_PLUGIN_ID));
            let mut config = object(security_core.get("config"));
            config.extend(runtime.clone());
            security_core.insert("config".into(), Value::Object(config));
            entries.insert(SECURITY_CORE_PLUGIN_ID.into(), Value::Object(security_core));
            plugins.insert("entries".into(), Value::Object(entries));
            if replace(document, "plugins", Value::Object(plugins)) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map(|update| update.changed)
        .map_err(|_| SecurityProjectionError::ConfigStore)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityProjectionError {
    ConfigStore,
}

impl fmt::Display for SecurityProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw security policy persistence failed")
    }
}

impl std::error::Error for SecurityProjectionError {}

#[cfg(test)]
mod tests;

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn contains_private_auth(runtime: &Map<String, Value>) -> bool {
    runtime.iter().any(|(key, value)| {
        PRIVATE_AUTH_KEYS.contains(&key.to_ascii_lowercase().as_str())
            || match value {
                Value::Object(object) => contains_private_auth(object),
                Value::Array(values) => values
                    .iter()
                    .any(|value| value.as_object().is_some_and(contains_private_auth)),
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
            }
    })
}

fn replace(document: &mut OpenClawConfigDocument, key: &str, value: Value) -> bool {
    if document.get(key) == Some(&value) {
        return false;
    }
    document.insert(key.into(), value);
    true
}
