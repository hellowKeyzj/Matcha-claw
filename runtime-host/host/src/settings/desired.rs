use std::path::Path;

use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "settings-desired.v1.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub revision: u64,
    pub outcome: Outcome,
}

impl Settlement {
    pub(crate) const fn unknown(revision: u64) -> Self {
        Self {
            revision,
            outcome: Outcome::Unknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Desired {
    browser_mode: BrowserMode,
    proxy: Proxy,
    launch_at_startup: bool,
    gateway_auto_start: bool,
}

impl Desired {
    pub fn try_from_wire(value: &serde_json::Value) -> Result<Self, ()> {
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

    pub(super) fn browser_mode(&self) -> openclaw::projection::settings::BrowserMode {
        match self.browser_mode {
            BrowserMode::Native => openclaw::projection::settings::BrowserMode::Native,
            BrowserMode::Relay => openclaw::projection::settings::BrowserMode::Relay,
            BrowserMode::Off => openclaw::projection::settings::BrowserMode::Off,
        }
    }

    pub(super) fn proxy_endpoint(&self) -> Option<&str> {
        self.proxy.enabled.then_some(self.proxy.server.as_str())
    }

    pub(super) fn projection(
        &self,
    ) -> (openclaw::projection::settings::BrowserMode, Option<String>) {
        (
            self.browser_mode(),
            self.proxy_endpoint().map(ToOwned::to_owned),
        )
    }
}

fn valid_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.contains('\0') && !value.contains(['\r', '\n'])
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum BrowserMode {
    #[default]
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

#[derive(Clone, Copy, Debug)]
pub(crate) enum StateFileError {
    CannotRead,
    CannotWrite,
}

pub(crate) struct DesiredState {
    state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    persisted: PersistedDesired,
}

impl DesiredState {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, StateFileError> {
        let state_dir = openclaw::lifecycle::state_dir::CanonicalStateDir::provision(state_dir)
            .map_err(|_| StateFileError::CannotRead)?;
        let persisted = load(&state_dir)?;
        Ok(Self {
            state_dir,
            persisted,
        })
    }

    pub(crate) fn replace(
        &mut self,
        correlation: String,
        desired: Desired,
    ) -> (u64, Option<Outcome>) {
        if self
            .persisted
            .correlations
            .iter()
            .any(|known| known == &correlation)
        {
            return (
                self.persisted.revision,
                Some(effect_outcome(self.persisted.effect)),
            );
        }

        self.persisted.revision = self.persisted.revision.saturating_add(1);
        self.persisted.browser_mode = desired.browser_mode;
        self.persisted.proxy = desired.proxy;
        self.persisted.launch_at_startup = desired.launch_at_startup;
        self.persisted.gateway_auto_start = desired.gateway_auto_start;
        self.persisted.effect = PersistedEffect::Pending;
        remember(&mut self.persisted.correlations, &correlation);

        if persist(&self.state_dir, &self.persisted).is_err() {
            return (self.persisted.revision, Some(Outcome::Unknown));
        }

        (self.persisted.revision, None)
    }

    pub(crate) fn settle(&mut self, revision: u64, outcome: Outcome) {
        if self.persisted.revision != revision {
            return;
        }

        self.persisted.effect = match outcome {
            Outcome::Confirmed => PersistedEffect::Confirmed,
            Outcome::Rejected => PersistedEffect::Rejected,
            Outcome::Unknown => PersistedEffect::Unknown,
        };

        let _ = persist(&self.state_dir, &self.persisted);
    }

    pub(crate) fn pending(&self) -> Option<PendingDesired> {
        if !matches!(
            self.persisted.effect,
            PersistedEffect::Pending | PersistedEffect::Unknown
        ) || self.persisted.revision == 0
        {
            return None;
        }

        Some(PendingDesired {
            revision: self.persisted.revision,
            desired: self.persisted.desired(),
        })
    }

    pub(crate) fn desired(&self) -> Desired {
        self.persisted.desired()
    }

    pub(crate) fn desired_snapshot(&self) -> PublicDesiredSnapshot {
        PublicDesiredSnapshot {
            browser_mode: self.persisted.browser_mode,
            launch_at_startup: self.persisted.launch_at_startup,
            gateway_auto_start: self.persisted.gateway_auto_start,
            proxy_enabled: self.persisted.proxy.enabled,
            proxy_server: self.persisted.proxy.server.clone(),
            proxy_bypass_rules: self.persisted.proxy.bypass_rules.clone(),
        }
    }

    pub(crate) fn snapshot(&self) -> SettingsSnapshot {
        SettingsSnapshot {
            desired: self.desired_snapshot(),
            pending: self.pending(),
        }
    }

    pub(crate) fn gateway_auto_start(&self) -> bool {
        self.persisted.gateway_auto_start
    }
}

#[derive(Clone, Debug)]
pub struct PendingDesired {
    pub revision: u64,
    pub desired: Desired,
}

#[derive(Clone, Debug, Default)]
pub struct PublicDesiredSnapshot {
    pub browser_mode: BrowserMode,
    pub launch_at_startup: bool,
    pub gateway_auto_start: bool,
    pub proxy_enabled: bool,
    pub proxy_server: String,
    pub proxy_bypass_rules: String,
}

impl PublicDesiredSnapshot {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "browserMode": self.browser_mode,
            "launchAtStartup": self.launch_at_startup,
            "gatewayAutoStart": self.gateway_auto_start,
            "proxyEnabled": self.proxy_enabled,
            "proxyServer": self.proxy_server,
            "proxyBypassRules": self.proxy_bypass_rules,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SettingsSnapshot {
    pub(crate) desired: PublicDesiredSnapshot,
    pub(crate) pending: Option<PendingDesired>,
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
) -> Result<PersistedDesired, StateFileError> {
    let Some(bytes) = state_dir
        .read_regular_file_bounded(STATE_FILE, MAX_STATE_BYTES as usize)
        .map_err(|_| StateFileError::CannotRead)?
    else {
        return Ok(PersistedDesired::default());
    };
    serde_json::from_slice(&bytes).map_err(|_| StateFileError::CannotRead)
}

fn persist(
    state_dir: &openclaw::lifecycle::state_dir::CanonicalStateDir,
    state: &PersistedDesired,
) -> Result<(), StateFileError> {
    let bytes = serde_json::to_vec(state).map_err(|_| StateFileError::CannotWrite)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(StateFileError::CannotWrite);
    }
    state_dir
        .replace_regular_file_bounded(STATE_FILE, &bytes, MAX_STATE_BYTES as usize)
        .map_err(|_| StateFileError::CannotWrite)
}
