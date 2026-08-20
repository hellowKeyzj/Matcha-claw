use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "settings-desired.v1.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

impl Outcome {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Desired {
    browser_mode: BrowserMode,
    proxy: Proxy,
    launch_at_startup: bool,
    gateway_auto_start: bool,
}

impl Desired {
    pub(crate) fn try_from_wire(value: &serde_json::Value) -> Result<Self, ()> {
        let input = value
            .get("input")
            .and_then(serde_json::Value::as_object)
            .ok_or(())?;
        let browser_mode = match input
            .get("browserMode")
            .and_then(serde_json::Value::as_str)
            .ok_or(())?
        {
            "native" => BrowserMode::Native,
            "relay" => BrowserMode::Relay,
            "off" => BrowserMode::Off,
            _ => return Err(()),
        };
        let launch_at_startup = input
            .get("launchAtStartup")
            .and_then(serde_json::Value::as_bool)
            .ok_or(())?;
        let gateway_auto_start = input
            .get("gatewayAutoStart")
            .and_then(serde_json::Value::as_bool)
            .ok_or(())?;
        let proxy = input
            .get("proxy")
            .and_then(serde_json::Value::as_object)
            .ok_or(())?;
        let enabled = proxy
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .ok_or(())?;
        let server = proxy
            .get("server")
            .and_then(serde_json::Value::as_str)
            .filter(|value| valid_text(value, 2048))
            .ok_or(())?
            .to_owned();
        let bypass_rules = proxy
            .get("bypassRules")
            .and_then(serde_json::Value::as_str)
            .filter(|value| valid_text(value, 4096))
            .ok_or(())?
            .to_owned();
        if proxy.get("credentialReference") != Some(&serde_json::Value::Null) {
            return Err(());
        }
        if enabled && server.is_empty() {
            return Err(());
        }
        if server.contains('@') {
            return Err(());
        }
        Ok(Self {
            browser_mode,
            proxy: Proxy {
                enabled,
                server,
                bypass_rules,
            },
            launch_at_startup,
            gateway_auto_start,
        })
    }
}

fn valid_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.contains('\0') && !value.contains(['\r', '\n'])
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BrowserMode {
    Native,
    Relay,
    Off,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Proxy {
    enabled: bool,
    server: String,
    bypass_rules: String,
}

impl Desired {
    pub(crate) fn browser_mode(&self) -> openclaw::projection::settings::BrowserMode {
        match self.browser_mode {
            BrowserMode::Native => openclaw::projection::settings::BrowserMode::Native,
            BrowserMode::Relay => openclaw::projection::settings::BrowserMode::Relay,
            BrowserMode::Off => openclaw::projection::settings::BrowserMode::Off,
        }
    }

    pub(crate) fn proxy_endpoint(&self) -> Option<&str> {
        self.proxy.enabled.then_some(self.proxy.server.as_str())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesired {
    revision: u64,
    browser_mode: BrowserMode,
    proxy: Proxy,
    #[serde(default)]
    launch_at_startup: bool,
    #[serde(default = "default_gateway_auto_start")]
    gateway_auto_start: bool,
    effect: PersistedEffect,
    correlations: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedEffect {
    Pending,
    Confirmed,
    Rejected,
    Unknown,
}

fn default_gateway_auto_start() -> bool {
    true
}

impl Default for PersistedDesired {
    fn default() -> Self {
        Self {
            revision: 0,
            browser_mode: BrowserMode::Relay,
            proxy: Proxy {
                enabled: false,
                server: String::new(),
                bypass_rules: "<local>;localhost;127.0.0.1;::1".into(),
            },
            launch_at_startup: false,
            gateway_auto_start: true,
            effect: PersistedEffect::Pending,
            correlations: Vec::new(),
        }
    }
}

impl PersistedDesired {
    fn desired(&self) -> Desired {
        Desired {
            browser_mode: self.browser_mode,
            proxy: self.proxy.clone(),
            launch_at_startup: self.launch_at_startup,
            gateway_auto_start: self.gateway_auto_start,
        }
    }
}

pub(crate) struct Owner {
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    state: Mutex<PersistedDesired>,
    effect: tokio::sync::Mutex<()>,
}

pub(crate) fn bootstrap_gateway_auto_start(state_dir: &Path) -> Result<bool, ()> {
    let state_dir =
        openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir).map_err(|_| ())?;
    Ok(load(&state_dir)?.gateway_auto_start)
}

pub(crate) fn apply_prelaunch_projection(state_dir: &Path) -> Result<bool, ()> {
    let state_dir =
        openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir).map_err(|_| ())?;
    let desired = load(&state_dir)?.desired();
    openclaw::projection::settings::apply_prelaunch_desired(
        state_dir,
        desired.browser_mode(),
        desired.proxy_endpoint(),
    )
    .map_err(|_| ())
}

impl Owner {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, ()> {
        let state_dir = openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir)
            .map_err(|_| ())?;
        let state = load(&state_dir)?;
        Ok(Self {
            state_dir,
            state: Mutex::new(state),
            effect: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn replace(
        &self,
        correlation: &str,
        desired: Desired,
    ) -> Result<(u64, Option<Outcome>), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.correlations.iter().any(|known| known == correlation) {
            return Ok((state.revision, Some(effect_outcome(state.effect))));
        }
        state.revision = state.revision.checked_add(1).ok_or(())?;
        state.browser_mode = desired.browser_mode;
        state.proxy = desired.proxy;
        state.launch_at_startup = desired.launch_at_startup;
        state.gateway_auto_start = desired.gateway_auto_start;
        state.effect = PersistedEffect::Pending;
        remember(&mut state.correlations, correlation);
        persist(&self.state_dir, &state)?;
        Ok((state.revision, None))
    }

    pub(crate) fn settle(&self, revision: u64, outcome: Outcome) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.revision != revision {
            return Ok(());
        }
        state.effect = match outcome {
            Outcome::Confirmed => PersistedEffect::Confirmed,
            Outcome::Rejected => PersistedEffect::Rejected,
            Outcome::Unknown => PersistedEffect::Unknown,
        };
        persist(&self.state_dir, &state)
    }

    pub(crate) fn pending(&self) -> Result<Option<(u64, Desired)>, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        if !matches!(
            state.effect,
            PersistedEffect::Pending | PersistedEffect::Unknown
        ) || state.revision == 0
        {
            return Ok(None);
        }
        Ok(Some((state.revision, state.desired())))
    }

    pub(crate) fn desired_snapshot(&self) -> Result<serde_json::Value, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        Ok(serde_json::json!({
            "browserMode": state.browser_mode,
            "launchAtStartup": state.launch_at_startup,
            "gatewayAutoStart": state.gateway_auto_start,
            "proxyEnabled": state.proxy.enabled,
            "proxyServer": state.proxy.server,
            "proxyBypassRules": state.proxy.bypass_rules,
        }))
    }

    pub(crate) async fn serialize_effect<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
    ) -> T {
        let _effect = self.effect.lock().await;
        operation.await
    }
}

fn effect_outcome(effect: PersistedEffect) -> Outcome {
    match effect {
        PersistedEffect::Confirmed => Outcome::Confirmed,
        PersistedEffect::Pending | PersistedEffect::Rejected | PersistedEffect::Unknown => {
            Outcome::Unknown
        }
    }
}

fn remember(correlations: &mut Vec<String>, correlation: &str) {
    correlations.push(correlation.to_owned());
    if correlations.len() > 128 {
        correlations.drain(..correlations.len() - 128);
    }
}

fn load(
    state_dir: &openclaw::lifecycle::state_dir::CanonicalStateDir,
) -> Result<PersistedDesired, ()> {
    let Some(bytes) = state_dir
        .read_regular_file_bounded(STATE_FILE, MAX_STATE_BYTES as usize)
        .map_err(|_| ())?
    else {
        return Ok(PersistedDesired::default());
    };
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn persist(
    state_dir: &openclaw::lifecycle::state_dir::CanonicalStateDir,
    state: &PersistedDesired,
) -> Result<(), ()> {
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(());
    }
    state_dir
        .replace_regular_file_bounded(STATE_FILE, &bytes, MAX_STATE_BYTES as usize)
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_revision_and_replays_a_known_correlation() {
        let root = std::env::temp_dir().join(format!(
            "settings-delivery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Owner::open(&root).unwrap();
        let desired = Desired::try_from_wire(&serde_json::json!({
            "input": {
                "browserMode": "off",
                "launchAtStartup": false,
                "gatewayAutoStart": true,
                "proxy": { "enabled": false, "server": "", "bypassRules": "", "credentialReference": null }
            }
        })).unwrap();
        assert_eq!(owner.replace("first", desired.clone()).unwrap(), (1, None));
        assert_eq!(
            owner.replace("first", desired).unwrap(),
            (1, Some(Outcome::Unknown))
        );
        drop(owner);
        assert_eq!(
            Owner::open(&root).unwrap().state.lock().unwrap().revision,
            1
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_effect_remains_recoverable_for_reconciliation() {
        let root = std::env::temp_dir().join(format!(
            "settings-delivery-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Owner::open(&root).unwrap();
        let desired = Desired::try_from_wire(&serde_json::json!({
            "input": {
                "browserMode": "relay",
                "launchAtStartup": false,
                "gatewayAutoStart": true,
                "proxy": { "enabled": false, "server": "", "bypassRules": "", "credentialReference": null }
            }
        })).unwrap();
        let (revision, _) = owner.replace("pending", desired).unwrap();
        assert_eq!(
            owner
                .pending()
                .unwrap()
                .map(|(pending_revision, _)| pending_revision),
            Some(revision)
        );
        owner.settle(revision, Outcome::Unknown).unwrap();
        drop(owner);
        let owner = Owner::open(&root).unwrap();
        assert_eq!(
            owner
                .pending()
                .unwrap()
                .map(|(pending_revision, _)| pending_revision),
            Some(revision)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn effect_guard_serializes_settings_projection_and_restart() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };

        let root = std::env::temp_dir().join(format!(
            "settings-delivery-effect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Arc::new(Owner::open(&root).unwrap());
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let first_owner = Arc::clone(&owner);
        let first = tokio::spawn(async move {
            first_owner
                .serialize_effect(async move {
                    started_sender.send(()).unwrap();
                    release_receiver.await.unwrap();
                })
                .await;
        });
        started_receiver.await.unwrap();

        let second_ran = Arc::new(AtomicBool::new(false));
        let second_owner = Arc::clone(&owner);
        let second_ran_flag = Arc::clone(&second_ran);
        let second = tokio::spawn(async move {
            second_owner
                .serialize_effect(async move {
                    second_ran_flag.store(true, Ordering::SeqCst);
                })
                .await;
        });
        tokio::task::yield_now().await;
        assert!(!second_ran.load(Ordering::SeqCst));

        release_sender.send(()).unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert!(second_ran.load(Ordering::SeqCst));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn prelaunch_projection_applies_last_known_desired_settings() {
        let root = std::env::temp_dir().join(format!(
            "settings-delivery-prelaunch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Owner::open(&root).unwrap();
        owner
            .replace(
                "desired",
                Desired::try_from_wire(&serde_json::json!({
                    "input": {
                        "browserMode": "native",
                        "launchAtStartup": false,
                        "gatewayAutoStart": true,
                        "proxy": {
                            "enabled": true,
                            "server": "proxy.internal:8080",
                            "bypassRules": "localhost",
                            "credentialReference": null
                        }
                    }
                }))
                .unwrap(),
            )
            .unwrap();
        drop(owner);

        assert!(apply_prelaunch_projection(&root).unwrap());
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("openclaw.json")).unwrap()).unwrap();
        assert_eq!(document["browser"]["enabled"], true);
        assert_eq!(document["browser"]["defaultProfile"], "openclaw");
        assert_eq!(document["session"]["idleMinutes"], 10_080);
        assert_eq!(
            document["channels"]["telegram"]["accounts"]["default"]["proxy"],
            "http://proxy.internal:8080"
        );
        assert!(!document.to_string().contains("credentialReference"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_any_non_null_credential_reference() {
        let value = serde_json::json!({
            "input": {
                "browserMode": "relay",
                "launchAtStartup": false,
                "gatewayAutoStart": true,
                "proxy": {
                    "enabled": true,
                    "server": "http://proxy.example.test:8080",
                    "bypassRules": "",
                    "credentialReference": "proxy-credential:v1:opaque-reference"
                }
            }
        });
        assert_eq!(Desired::try_from_wire(&value), Err(()));
    }

    #[test]
    fn desired_snapshot_exposes_only_non_secret_owner_facts() {
        let root = std::env::temp_dir().join(format!(
            "settings-delivery-public-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Owner::open(&root).unwrap();
        owner
            .replace(
                "public",
                Desired::try_from_wire(&serde_json::json!({
                    "input": {
                        "browserMode": "native",
                        "launchAtStartup": true,
                        "gatewayAutoStart": false,
                        "proxy": {
                            "enabled": true,
                            "server": "http://proxy.example.test:8080",
                            "bypassRules": "localhost",
                            "credentialReference": null
                        }
                    }
                }))
                .unwrap(),
            )
            .unwrap();

        let settings = owner.desired_snapshot().unwrap();
        assert_eq!(
            settings,
            serde_json::json!({
                "browserMode": "native",
                "launchAtStartup": true,
                "gatewayAutoStart": false,
                "proxyEnabled": true,
                "proxyServer": "http://proxy.example.test:8080",
                "proxyBypassRules": "localhost",
            })
        );
        assert!(!settings.to_string().contains("credentialReference"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_effect_cannot_settle_a_newer_mutation() {
        let root = std::env::temp_dir().join(format!(
            "settings-delivery-stale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let owner = Owner::open(&root).unwrap();
        let first = Desired::try_from_wire(&serde_json::json!({
            "input": {
                "browserMode": "native",
                "launchAtStartup": false,
                "gatewayAutoStart": true,
                "proxy": { "enabled": false, "server": "", "bypassRules": "", "credentialReference": null }
            }
        })).unwrap();
        let second = Desired::try_from_wire(&serde_json::json!({
            "input": {
                "browserMode": "off",
                "launchAtStartup": false,
                "gatewayAutoStart": true,
                "proxy": { "enabled": false, "server": "", "bypassRules": "", "credentialReference": null }
            }
        })).unwrap();
        let (first_revision, _) = owner.replace("first", first).unwrap();
        let (second_revision, _) = owner.replace("second", second).unwrap();
        owner.settle(first_revision, Outcome::Confirmed).unwrap();
        assert_eq!(
            owner.pending().unwrap().map(|(revision, _)| revision),
            Some(second_revision)
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
