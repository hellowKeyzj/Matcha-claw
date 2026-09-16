use std::{fmt, net::Ipv6Addr};

use serde_json::{Map, Value};

use crate::gateway::config_patch::{destructive_array_replace_paths, merge_patch};

use crate::lifecycle::state_dir::CanonicalStateDir;

use super::config_store::{
    OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigUpdate,
};

const BROWSER_RELAY_PLUGIN: &str = "browser-relay";
const DEFAULT_SESSION_IDLE_MINUTES: u64 = 10_080;
const MAX_PROXY_ENDPOINT_LENGTH: usize = 2048;
const PROXY_LOOPBACK_MODE: &str = "gateway-only";

/// OpenClaw has no native Settings field for proxy bypass rules.
/// The Settings owner retains that value as desired-only; this projection never writes it.
#[cfg(test)]
const BYPASS_RULES_NATIVE_KEY: Option<&str> = None;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserMode {
    Native,
    Relay,
    Off,
}

/// Projects the OpenClaw-native Settings fields.
///
/// OpenClaw managed proxy has no native `bypassRules` field, so that Settings
/// value intentionally is not represented here and remains a desired-only owner field.
#[derive(Clone, Eq, PartialEq)]
pub struct SettingsProjection {
    browser_mode: BrowserMode,
    proxy: Option<String>,
}

pub fn apply(
    state_dir: CanonicalStateDir,
    browser_mode: BrowserMode,
    proxy: Option<&str>,
) -> Result<bool, SettingsProjectionError> {
    SettingsProjection::try_new(browser_mode, proxy)?
        .apply(&OpenClawConfigStore::new(state_dir))
        .map(|update| update.changed)
}

pub fn apply_prelaunch_desired(
    state_dir: CanonicalStateDir,
    browser_mode: BrowserMode,
    proxy: Option<&str>,
) -> Result<bool, SettingsProjectionError> {
    let projection = SettingsProjection::try_new(browser_mode, proxy)?;
    let store = OpenClawConfigStore::new(state_dir);
    let update = store
        .update(|document| {
            let mut changed = projection.apply_to_document(document);
            changed |= apply_default_session_idle(document);
            if changed {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map_err(|_| SettingsProjectionError::ConfigStore)?;
    let document = store
        .read()
        .map_err(|_| SettingsProjectionError::ConfigStore)?;
    if !projection.matches_document(&document) || !session_idle_projection_is_ready(&document) {
        return Err(SettingsProjectionError::ConfigStore);
    }
    Ok(update.changed)
}

pub fn ensure_default_session_idle(
    state_dir: CanonicalStateDir,
) -> Result<bool, SettingsProjectionError> {
    OpenClawConfigStore::new(state_dir)
        .update_private_document(|document| {
            if apply_default_session_idle(document) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map(|update| update.changed)
        .map_err(|_| SettingsProjectionError::ConfigStore)
}

pub fn readback_matches(
    state_dir: CanonicalStateDir,
    browser_mode: BrowserMode,
    proxy: Option<&str>,
) -> Result<bool, SettingsProjectionError> {
    let projection = SettingsProjection::try_new(browser_mode, proxy)?;
    let document = OpenClawConfigStore::new(state_dir)
        .read()
        .map_err(|_| SettingsProjectionError::ConfigStore)?;
    Ok(projection.matches_document(&document))
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct SettingsConfigPatch {
    pub(crate) patch: Value,
    pub(crate) replace_paths: Vec<String>,
    pub(crate) changed: bool,
}

impl SettingsProjection {
    pub fn try_new(
        browser_mode: BrowserMode,
        proxy: Option<&str>,
    ) -> Result<Self, SettingsProjectionError> {
        let proxy = proxy
            .filter(|value| !value.is_empty())
            .map(normalize_proxy)
            .transpose()?;
        Ok(Self {
            browser_mode,
            proxy,
        })
    }

    pub(crate) fn build_config_patch(
        &self,
        current: &OpenClawConfigDocument,
    ) -> SettingsConfigPatch {
        let current = current.as_value();
        let mut target = OpenClawConfigDocument::from_value(current.clone())
            .expect("cloned OpenClaw config document remains an object");
        let changed = self.apply_to_document(&mut target);
        let target = target.into_value();
        let patch = if changed {
            merge_patch(&current, &target)
        } else {
            Value::Object(Map::new())
        };
        let replace_paths = if changed {
            destructive_array_replace_paths(&current, &target)
        } else {
            Vec::new()
        };
        SettingsConfigPatch {
            patch,
            replace_paths,
            changed,
        }
    }

    pub(crate) fn apply(
        &self,
        store: &OpenClawConfigStore,
    ) -> Result<OpenClawConfigUpdate, SettingsProjectionError> {
        let update = store
            .update(|document| {
                if self.apply_to_document(document) {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map_err(|_| SettingsProjectionError::ConfigStore)?;
        let document = store
            .read()
            .map_err(|_| SettingsProjectionError::ConfigStore)?;
        if !self.matches_document(&document) {
            return Err(SettingsProjectionError::ConfigStore);
        }
        Ok(update)
    }

    fn apply_to_document(&self, document: &mut OpenClawConfigDocument) -> bool {
        let mut changed = false;
        let mut browser = object(document.get("browser"));
        let native = self.browser_mode == BrowserMode::Native;
        changed |= replace(&mut browser, "enabled", Value::Bool(native));
        if native {
            changed |= replace(
                &mut browser,
                "defaultProfile",
                Value::String("openclaw".into()),
            );
        } else {
            changed |= browser.remove("defaultProfile").is_some();
        }
        changed |= replace_document(document, "browser", Value::Object(browser));

        let mut plugins = object(document.get("plugins"));
        let mut allow = strings(plugins.get("allow"));
        let relay = self.browser_mode == BrowserMode::Relay;
        changed |= set_member(&mut allow, BROWSER_RELAY_PLUGIN, relay);
        changed |= replace(
            &mut plugins,
            "allow",
            Value::Array(allow.into_iter().map(Value::String).collect()),
        );
        let mut entries = object(plugins.get("entries"));
        let mut relay_entry = object(entries.get(BROWSER_RELAY_PLUGIN));
        changed |= replace(&mut relay_entry, "enabled", Value::Bool(relay));
        changed |= replace(
            &mut entries,
            BROWSER_RELAY_PLUGIN,
            Value::Object(relay_entry),
        );
        changed |= replace(&mut plugins, "entries", Value::Object(entries));
        changed |= replace_document(document, "plugins", Value::Object(plugins));

        changed |= apply_native_proxy(document, self.proxy.as_deref());
        changed
    }

    fn matches_document(&self, document: &OpenClawConfigDocument) -> bool {
        let browser = object(document.get("browser"));
        let native = self.browser_mode == BrowserMode::Native;
        if browser.get("enabled") != Some(&Value::Bool(native)) {
            return false;
        }
        if native {
            if browser.get("defaultProfile") != Some(&Value::String("openclaw".into())) {
                return false;
            }
        } else if browser.contains_key("defaultProfile") {
            return false;
        }

        let plugins = object(document.get("plugins"));
        let allow = strings(plugins.get("allow"));
        let relay = self.browser_mode == BrowserMode::Relay;
        if allow.contains(&BROWSER_RELAY_PLUGIN.to_owned()) != relay {
            return false;
        }
        let entries = object(plugins.get("entries"));
        let relay_entry = object(entries.get(BROWSER_RELAY_PLUGIN));
        if relay_entry.get("enabled") != Some(&Value::Bool(relay)) {
            return false;
        }

        let proxy = object(document.get("proxy"));
        match &self.proxy {
            Some(proxy_url) => {
                proxy.get("proxyUrl") == Some(&Value::String(proxy_url.clone()))
                    && proxy.get("enabled") == Some(&Value::Bool(true))
                    && proxy.get("loopbackMode") == Some(&Value::String(PROXY_LOOPBACK_MODE.into()))
            }
            None => {
                proxy.get("enabled") != Some(&Value::Bool(true))
                    && !proxy.contains_key("proxyUrl")
                    && !proxy.contains_key("loopbackMode")
            }
        }
    }
}

impl fmt::Debug for SettingsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SettingsProjection([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsProjectionError {
    InvalidProxy,
    ConfigStore,
}

impl fmt::Display for SettingsProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidProxy => "OpenClaw proxy projection is invalid",
            Self::ConfigStore => "OpenClaw Settings projection persistence failed",
        })
    }
}

impl std::error::Error for SettingsProjectionError {}

fn apply_native_proxy(document: &mut OpenClawConfigDocument, proxy: Option<&str>) -> bool {
    match proxy {
        Some(proxy) => apply_native_proxy_value(document, proxy),
        None => disable_native_proxy(document),
    }
}

fn apply_native_proxy_value(document: &mut OpenClawConfigDocument, proxy_url: &str) -> bool {
    let mut proxy = object(document.get("proxy"));
    let mut changed = replace(&mut proxy, "proxyUrl", Value::String(proxy_url.to_owned()));
    changed |= replace(&mut proxy, "enabled", Value::Bool(true));
    changed |= replace(
        &mut proxy,
        "loopbackMode",
        Value::String(PROXY_LOOPBACK_MODE.into()),
    );
    changed |= replace_document(document, "proxy", Value::Object(proxy));
    changed
}

fn disable_native_proxy(document: &mut OpenClawConfigDocument) -> bool {
    if document.get("proxy").is_none() {
        return false;
    }

    let mut proxy = object(document.get("proxy"));
    let mut changed = proxy.remove("proxyUrl").is_some();
    changed |= proxy.remove("loopbackMode").is_some();
    changed |= replace(&mut proxy, "enabled", Value::Bool(false));
    changed |= replace_document(document, "proxy", Value::Object(proxy));
    changed
}

fn apply_default_session_idle(document: &mut OpenClawConfigDocument) -> bool {
    let session = object(document.get("session"));
    if ["idleMinutes", "reset", "resetByType", "resetByChannel"]
        .into_iter()
        .any(|key| session.contains_key(key))
    {
        return false;
    }

    let mut session = session;
    session.insert(
        "idleMinutes".into(),
        Value::Number(DEFAULT_SESSION_IDLE_MINUTES.into()),
    );
    replace_document(document, "session", Value::Object(session))
}

fn session_idle_projection_is_ready(document: &OpenClawConfigDocument) -> bool {
    let session = object(document.get("session"));
    ["idleMinutes", "reset", "resetByType", "resetByChannel"]
        .into_iter()
        .any(|key| session.contains_key(key))
}

fn normalize_proxy(value: &str) -> Result<String, SettingsProjectionError> {
    if value.is_empty() || value.len() > MAX_PROXY_ENDPOINT_LENGTH {
        return Err(SettingsProjectionError::InvalidProxy);
    }
    let value = if has_scheme(value) {
        value.to_owned()
    } else {
        format!("http://{value}")
    };
    if value.len() > MAX_PROXY_ENDPOINT_LENGTH {
        return Err(SettingsProjectionError::InvalidProxy);
    }
    valid_endpoint(&value)
        .then_some(value)
        .ok_or(SettingsProjectionError::InvalidProxy)
}

fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    valid_scheme(scheme)
}

fn valid_endpoint(value: &str) -> bool {
    let Some((scheme, authority)) = value.split_once("://") else {
        return false;
    };
    valid_scheme(scheme)
        && !authority
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && !authority.contains(['/', '@', '?', '#', '\\'])
        && valid_authority(authority)
}

fn valid_authority(authority: &str) -> bool {
    if let Some(value) = authority.strip_prefix('[') {
        let Some((host, suffix)) = value.split_once(']') else {
            return false;
        };
        return host.parse::<Ipv6Addr>().is_ok() && valid_port_suffix(suffix);
    }

    match authority.split_once(':') {
        Some((host, port)) => !port.contains(':') && valid_host(host) && valid_port(port),
        None => valid_host(authority),
    }
}

fn valid_port_suffix(value: &str) -> bool {
    value.is_empty() || value.strip_prefix(':').is_some_and(valid_port)
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            matches!(bytes.first(), Some(value) if value.is_ascii_alphanumeric())
                && matches!(bytes.last(), Some(value) if value.is_ascii_alphanumeric())
                && bytes
                    .iter()
                    .all(|value| value.is_ascii_alphanumeric() || *value == b'-')
        })
}

fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.bytes().all(|value| value.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

fn valid_scheme(scheme: &str) -> bool {
    let mut characters = scheme.bytes();
    matches!(characters.next(), Some(character) if character.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'+' | b'.' | b'-')
        })
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn set_member(values: &mut Vec<String>, member: &str, present: bool) -> bool {
    let before = values.clone();
    values.retain(|value| value != member);
    if present {
        values.push(member.into());
    }
    *values != before
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
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);

            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "openclaw-settings-projection-tests-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn establishes_the_legacy_idle_default_without_overwriting_session_policy() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();

        assert!(ensure_default_session_idle(state_dir.clone()).unwrap());
        let document = OpenClawConfigStore::new(state_dir.clone()).read().unwrap();
        assert_eq!(document.as_value()["session"]["idleMinutes"], 10_080);
        assert!(!ensure_default_session_idle(state_dir).unwrap());

        let protected = root.state_dir();
        OpenClawConfigStore::new(protected.clone())
            .update(|document| {
                document.insert("session".into(), serde_json::json!({ "reset": "daily" }));
                OpenClawConfigMutation::changed()
            })
            .unwrap();
        assert!(!ensure_default_session_idle(protected.clone()).unwrap());
        let document = OpenClawConfigStore::new(protected).read().unwrap();
        assert_eq!(
            document.as_value()["session"],
            serde_json::json!({ "reset": "daily" })
        );
    }

    #[test]
    fn applies_prelaunch_desired_settings_and_session_idle_in_one_config_write() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let store = OpenClawConfigStore::new(state_dir.clone());
        store
            .update(|document| {
                document.insert(
                    "session".into(),
                    serde_json::json!({ "idleMinutes": DEFAULT_SESSION_IDLE_MINUTES }),
                );
                OpenClawConfigMutation::changed()
            })
            .unwrap();

        assert!(
            apply_prelaunch_desired(
                state_dir.clone(),
                BrowserMode::Native,
                Some("proxy.internal:8080")
            )
            .unwrap()
        );
        let document = store.read().unwrap().as_value();
        assert_eq!(document["browser"]["enabled"], true);
        assert_eq!(document["browser"]["defaultProfile"], "openclaw");
        assert_eq!(
            document["session"]["idleMinutes"],
            DEFAULT_SESSION_IDLE_MINUTES
        );
        assert_eq!(document["proxy"]["enabled"], true);
        assert_eq!(document["proxy"]["proxyUrl"], "http://proxy.internal:8080");
        assert_eq!(document["proxy"]["loopbackMode"], PROXY_LOOPBACK_MODE);
        assert!(document["channels"].get("telegram").is_none());
        assert!(!document.to_string().contains("credentialReference"));
        assert!(
            !apply_prelaunch_desired(
                state_dir,
                BrowserMode::Native,
                Some("http://proxy.internal:8080")
            )
            .unwrap()
        );
    }

    #[test]
    fn prelaunch_without_proxy_does_not_create_telegram_account() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();

        assert!(apply_prelaunch_desired(state_dir.clone(), BrowserMode::Native, None).unwrap());
        let document = OpenClawConfigStore::new(state_dir)
            .read()
            .unwrap()
            .as_value();
        assert_eq!(document["browser"]["enabled"], true);
        assert!(document["channels"].get("telegram").is_none());
    }

    #[test]
    fn applies_native_relay_and_off_with_readback() {
        for (mode, expected_browser, expected_relay) in [
            (
                BrowserMode::Native,
                serde_json::json!({ "enabled": true, "defaultProfile": "openclaw" }),
                false,
            ),
            (
                BrowserMode::Relay,
                serde_json::json!({ "enabled": false }),
                true,
            ),
            (
                BrowserMode::Off,
                serde_json::json!({ "enabled": false }),
                false,
            ),
        ] {
            let root = TestRoot::new();
            let state_dir = root.state_dir();
            let store = OpenClawConfigStore::new(state_dir.clone());
            store
                .update(|document| {
                    document.insert(
                        "browser".into(),
                        serde_json::json!({
                            "defaultProfile": "custom",
                            "profiles": { "custom": { "color": "#123456" } },
                        }),
                    );
                    document.insert(
                        "plugins".into(),
                        serde_json::json!({
                            "allow": ["other", BROWSER_RELAY_PLUGIN],
                            "entries": {
                                BROWSER_RELAY_PLUGIN: { "enabled": true, "custom": true },
                                "other": { "enabled": true },
                            },
                        }),
                    );
                    document.insert(
                        "channels".into(),
                        serde_json::json!({
                            "telegram": {
                                "defaultAccount": "work",
                                "accounts": {
                                    "default": { "proxy": "http://default.proxy:80" },
                                    "work": { "label": "preserve" },
                                },
                            },
                        }),
                    );
                    OpenClawConfigMutation::changed()
                })
                .unwrap();

            let changed = apply(state_dir.clone(), mode, Some("proxy.internal:8080")).unwrap();
            assert!(changed);
            let document = store.read().unwrap().as_value();
            assert_eq!(document["browser"]["enabled"], expected_browser["enabled"]);
            assert_eq!(
                document["browser"].get("defaultProfile"),
                expected_browser.get("defaultProfile")
            );
            assert_eq!(
                document["plugins"]["allow"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(BROWSER_RELAY_PLUGIN)),
                expected_relay
            );
            assert_eq!(
                document["plugins"]["entries"][BROWSER_RELAY_PLUGIN]["enabled"],
                expected_relay
            );
            assert_eq!(
                document["plugins"]["entries"][BROWSER_RELAY_PLUGIN]["custom"],
                true
            );
            assert_eq!(
                document["browser"]["profiles"]["custom"]["color"],
                "#123456"
            );
            assert_eq!(document["proxy"]["enabled"], true);
            assert_eq!(document["proxy"]["proxyUrl"], "http://proxy.internal:8080");
            assert_eq!(document["proxy"]["loopbackMode"], PROXY_LOOPBACK_MODE);
            assert_eq!(document["channels"]["telegram"]["defaultAccount"], "work");
            assert_eq!(
                document["channels"]["telegram"]["accounts"]["default"]["proxy"],
                "http://default.proxy:80"
            );
            assert_eq!(
                document["channels"]["telegram"]["accounts"]["work"]["label"],
                "preserve"
            );
            assert!(
                document["channels"]["telegram"]["accounts"]["work"]
                    .get("proxy")
                    .is_none()
            );
        }
    }

    #[test]
    fn unchanged_projection_reports_no_change_after_readback() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        assert!(
            apply(
                state_dir.clone(),
                BrowserMode::Native,
                Some("proxy.internal:8080")
            )
            .unwrap()
        );
        assert!(
            !apply(
                state_dir,
                BrowserMode::Native,
                Some("http://proxy.internal:8080")
            )
            .unwrap()
        );
    }

    #[test]
    fn builds_config_patch_for_native_browser_and_managed_proxy() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "browser": {
                "enabled": false,
                "profiles": { "custom": { "color": "#123456" } }
            },
            "plugins": {
                "allow": ["other", BROWSER_RELAY_PLUGIN],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": true, "custom": true }
                }
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "work",
                    "accounts": {
                        "default": { "proxy": "http://default.proxy:80" },
                        "work": { "label": "preserve" }
                    }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Native, Some("proxy.internal:8080"))
            .unwrap()
            .build_config_patch(&current);

        assert!(patch.changed);
        assert_eq!(patch.replace_paths, vec!["plugins.allow"]);
        assert_eq!(
            patch.patch,
            serde_json::json!({
                "browser": {
                    "enabled": true,
                    "defaultProfile": "openclaw"
                },
                "plugins": {
                    "allow": ["other"],
                    "entries": {
                        BROWSER_RELAY_PLUGIN: { "enabled": false }
                    }
                },
                "proxy": {
                    "enabled": true,
                    "proxyUrl": "http://proxy.internal:8080",
                    "loopbackMode": PROXY_LOOPBACK_MODE
                }
            })
        );
    }

    #[test]
    fn disabling_managed_proxy_preserves_channel_specific_proxy() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "browser": {
                "enabled": true,
                "defaultProfile": "openclaw"
            },
            "plugins": {
                "allow": [],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": false }
                }
            },
            "proxy": {
                "enabled": true,
                "proxyUrl": "http://proxy.internal:8080",
                "loopbackMode": PROXY_LOOPBACK_MODE
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "default",
                    "accounts": {
                        "default": { "proxy": "http://channel.proxy:8080" }
                    }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Native, None)
            .unwrap()
            .build_config_patch(&current);

        assert!(patch.changed);
        assert_eq!(patch.patch["proxy"]["enabled"], false);
        assert_eq!(patch.patch["proxy"]["proxyUrl"], serde_json::json!(null));
        assert_eq!(
            patch.patch["proxy"]["loopbackMode"],
            serde_json::json!(null)
        );
        assert!(patch.patch.get("channels").is_none());
    }

    #[test]
    fn builds_config_patch_for_relay_browser_and_managed_proxy_disable() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "browser": {
                "enabled": true,
                "defaultProfile": "openclaw",
                "profiles": { "openclaw": { "color": "#abcdef" } }
            },
            "plugins": {
                "allow": ["other"],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": false, "custom": true }
                }
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "work",
                    "accounts": {
                        "work": {
                            "proxy": "http://proxy.internal:8080",
                            "label": "preserve"
                        }
                    }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Relay, None)
            .unwrap()
            .build_config_patch(&current);

        assert!(patch.changed);
        assert_eq!(patch.replace_paths, Vec::<String>::new());
        assert_eq!(
            patch.patch,
            serde_json::json!({
                "browser": {
                    "enabled": false,
                    "defaultProfile": null
                },
                "plugins": {
                    "allow": ["other", BROWSER_RELAY_PLUGIN],
                    "entries": {
                        BROWSER_RELAY_PLUGIN: { "enabled": true }
                    }
                }
            })
        );
    }

    #[test]
    fn builds_config_patch_for_proxy_without_browser_or_plugin_changes() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "browser": {
                "enabled": true,
                "defaultProfile": "openclaw"
            },
            "plugins": {
                "allow": ["other"],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": false }
                }
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "default",
                    "accounts": {
                        "default": { "label": "preserve" }
                    }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Native, Some("proxy.internal:8080"))
            .unwrap()
            .build_config_patch(&current);

        assert!(patch.changed);
        assert_eq!(patch.replace_paths, Vec::<String>::new());
        assert_eq!(
            patch.patch,
            serde_json::json!({
                "proxy": {
                    "enabled": true,
                    "proxyUrl": "http://proxy.internal:8080",
                    "loopbackMode": PROXY_LOOPBACK_MODE
                }
            })
        );
    }

    #[test]
    fn unchanged_config_patch_reports_no_change() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "browser": {
                "enabled": false,
                "profiles": { "custom": { "color": "#123456" } }
            },
            "plugins": {
                "allow": ["other", BROWSER_RELAY_PLUGIN],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": true, "custom": true }
                }
            },
            "proxy": {
                "enabled": true,
                "proxyUrl": "http://proxy.internal:8080",
                "loopbackMode": PROXY_LOOPBACK_MODE
            },
            "channels": {
                "telegram": {
                    "defaultAccount": "work",
                    "accounts": {
                        "work": { "proxy": "http://channel.proxy:8080" }
                    }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Relay, Some("proxy.internal:8080"))
            .unwrap()
            .build_config_patch(&current);

        assert!(!patch.changed);
        assert_eq!(patch.patch, serde_json::json!({}));
        assert_eq!(patch.replace_paths, Vec::<String>::new());
    }

    #[test]
    fn config_patch_replace_paths_for_plugins_allow_are_stable_and_deduplicated() {
        let current = OpenClawConfigDocument::from_value(serde_json::json!({
            "plugins": {
                "allow": ["other", BROWSER_RELAY_PLUGIN, BROWSER_RELAY_PLUGIN],
                "entries": {
                    BROWSER_RELAY_PLUGIN: { "enabled": false }
                }
            }
        }))
        .unwrap();

        let patch = SettingsProjection::try_new(BrowserMode::Native, None)
            .unwrap()
            .build_config_patch(&current);

        assert!(patch.changed);
        assert_eq!(patch.replace_paths, vec!["plugins.allow"]);
        assert_eq!(
            patch.patch["plugins"]["allow"],
            serde_json::json!(["other"])
        );
    }

    #[test]
    fn bypass_rules_are_explicitly_desired_only_and_never_projected() {
        assert_eq!(BYPASS_RULES_NATIVE_KEY, None);
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        apply(state_dir.clone(), BrowserMode::Relay, None).unwrap();
        let document = OpenClawConfigStore::new(state_dir)
            .read()
            .unwrap()
            .as_value();
        assert!(document["browser"].get("bypassRules").is_none());
        assert!(document["proxy"].get("bypassRules").is_none());
    }

    #[test]
    fn normalizes_supported_proxy_endpoints_and_rejects_unsafe_forms() {
        for (input, expected) in [
            ("proxy.internal", "http://proxy.internal"),
            ("proxy.internal:8080", "http://proxy.internal:8080"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("0.0.0.0:0", "http://0.0.0.0:0"),
            ("255.255.255.255:65535", "http://255.255.255.255:65535"),
            ("[::1]:1080", "http://[::1]:1080"),
            (
                "[::ffff:192.0.2.1]:65535",
                "http://[::ffff:192.0.2.1]:65535",
            ),
            ("[2001:db8::1]:1080", "http://[2001:db8::1]:1080"),
            (
                "socks5://proxy.internal:1080",
                "socks5://proxy.internal:1080",
            ),
        ] {
            let projection = SettingsProjection::try_new(BrowserMode::Native, Some(input)).unwrap();
            assert_eq!(projection.proxy.as_deref(), Some(expected));
        }

        for input in [
            "http://user@proxy.internal:8080",
            "http://proxy.internal/path",
            "http://proxy.internal?query",
            "http://proxy.internal#fragment",
            "http://proxy\\internal",
            "http://proxy internal",
            "http://proxy.internal\u{0007}",
            "2001:db8::1",
            "http://[2001:db8::1",
            "http://[2001:db8::not-ip]:1080",
            "http://proxy.internal:",
            "http://proxy.internal:port",
            "http://proxy.internal:65536",
        ] {
            assert_eq!(
                SettingsProjection::try_new(BrowserMode::Native, Some(input)).unwrap_err(),
                SettingsProjectionError::InvalidProxy
            );
        }

        let at_limit = format!("http://{}", "a".repeat(MAX_PROXY_ENDPOINT_LENGTH - 7));
        assert!(SettingsProjection::try_new(BrowserMode::Native, Some(&at_limit)).is_ok());
        let over_limit = format!("http://{}", "a".repeat(MAX_PROXY_ENDPOINT_LENGTH - 6));
        assert_eq!(
            SettingsProjection::try_new(BrowserMode::Native, Some(&over_limit)).unwrap_err(),
            SettingsProjectionError::InvalidProxy
        );
        let bare_at_limit = "a".repeat(MAX_PROXY_ENDPOINT_LENGTH - 7);
        assert!(SettingsProjection::try_new(BrowserMode::Native, Some(&bare_at_limit)).is_ok());
        let bare_over_limit = "a".repeat(MAX_PROXY_ENDPOINT_LENGTH - 6);
        assert_eq!(
            SettingsProjection::try_new(BrowserMode::Native, Some(&bare_over_limit)).unwrap_err(),
            SettingsProjectionError::InvalidProxy
        );
    }
}
