use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{BrowserMode, Desired, DesiredSnapshot, Outcome, PendingDesired, SettingsSnapshot};

const STATE_FILE: &str = "settings-desired.v1.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesired {
    revision: u64,
    browser_mode: PersistedBrowserMode,
    proxy: PersistedProxy,
    #[serde(default)]
    launch_at_startup: bool,
    #[serde(default = "default_gateway_auto_start")]
    gateway_auto_start: bool,
    effect: PersistedEffect,
    correlations: Vec<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PersistedBrowserMode {
    Native,
    Relay,
    Off,
}

impl PersistedBrowserMode {
    const fn into_domain(self) -> BrowserMode {
        match self {
            Self::Native => BrowserMode::Native,
            Self::Relay => BrowserMode::Relay,
            Self::Off => BrowserMode::Off,
        }
    }

    const fn from_domain(value: BrowserMode) -> Self {
        match value {
            BrowserMode::Native => Self::Native,
            BrowserMode::Relay => Self::Relay,
            BrowserMode::Off => Self::Off,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProxy {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    server: String,
    #[serde(default)]
    bypass_rules: String,
}

impl PersistedProxy {
    fn into_domain(self) -> super::desired::Proxy {
        super::desired::Proxy {
            enabled: self.enabled,
            server: self.server,
            bypass_rules: self.bypass_rules,
        }
    }

    fn from_domain(proxy: super::desired::Proxy) -> Self {
        Self {
            enabled: proxy.enabled,
            server: proxy.server,
            bypass_rules: proxy.bypass_rules,
        }
    }
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
            browser_mode: PersistedBrowserMode::Relay,
            proxy: PersistedProxy {
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
            browser_mode: self.browser_mode.into_domain(),
            proxy: self.proxy.clone().into_domain(),
            launch_at_startup: self.launch_at_startup,
            gateway_auto_start: self.gateway_auto_start,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum StateFileError {
    CannotRead,
    CannotWrite,
}

pub struct DesiredState {
    state_dir: PathBuf,
    persisted: PersistedDesired,
}

impl DesiredState {
    pub fn open(state_dir: &Path) -> Result<Self, StateFileError> {
        if !state_dir.is_absolute() {
            return Err(StateFileError::CannotRead);
        }
        match fs::create_dir(state_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !fs::metadata(state_dir)
                    .map_err(|_| StateFileError::CannotRead)?
                    .is_dir()
                {
                    return Err(StateFileError::CannotRead);
                }
            }
            Err(_) => return Err(StateFileError::CannotRead),
        }
        let state_dir = state_dir
            .canonicalize()
            .map_err(|_| StateFileError::CannotRead)?;
        let persisted = load(&state_dir)?;
        Ok(Self {
            state_dir,
            persisted,
        })
    }

    pub fn replace(&mut self, correlation: String, desired: Desired) -> (u64, Option<Outcome>) {
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
        self.persisted.browser_mode = PersistedBrowserMode::from_domain(desired.browser_mode);
        self.persisted.proxy = PersistedProxy::from_domain(desired.proxy);
        self.persisted.launch_at_startup = desired.launch_at_startup;
        self.persisted.gateway_auto_start = desired.gateway_auto_start;
        self.persisted.effect = PersistedEffect::Pending;
        remember(&mut self.persisted.correlations, &correlation);

        if persist(&self.state_dir, &self.persisted).is_err() {
            return (self.persisted.revision, Some(Outcome::Unknown));
        }

        (self.persisted.revision, None)
    }

    pub fn settle(&mut self, revision: u64, outcome: Outcome) {
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

    pub fn pending(&self) -> Option<PendingDesired> {
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

    pub fn desired(&self) -> Desired {
        self.persisted.desired()
    }

    pub fn desired_snapshot(&self) -> DesiredSnapshot {
        DesiredSnapshot::new(
            self.persisted.browser_mode.into_domain(),
            self.persisted.launch_at_startup,
            self.persisted.gateway_auto_start,
            self.persisted.proxy.enabled,
            self.persisted.proxy.server.clone(),
            self.persisted.proxy.bypass_rules.clone(),
        )
    }

    pub fn snapshot(&self) -> SettingsSnapshot {
        SettingsSnapshot::new(self.desired_snapshot(), self.pending())
    }

    pub fn gateway_auto_start(&self) -> bool {
        self.persisted.gateway_auto_start
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

fn load(state_dir: &Path) -> Result<PersistedDesired, StateFileError> {
    let path = state_dir.join(STATE_FILE);
    let temporary = path.with_extension("tmp");
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if !path.exists() {
        return Ok(PersistedDesired::default());
    }
    let metadata = fs::metadata(&path).map_err(|_| StateFileError::CannotRead)?;
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES {
        return Err(StateFileError::CannotRead);
    }
    let bytes = fs::read(path).map_err(|_| StateFileError::CannotRead)?;
    serde_json::from_slice(&bytes).map_err(|_| StateFileError::CannotRead)
}

fn persist(state_dir: &Path, state: &PersistedDesired) -> Result<(), StateFileError> {
    let bytes = serde_json::to_vec(state).map_err(|_| StateFileError::CannotWrite)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(StateFileError::CannotWrite);
    }
    let path = state_dir.join(STATE_FILE);
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| StateFileError::CannotWrite)?;
    file.write_all(&bytes)
        .map_err(|_| StateFileError::CannotWrite)?;
    file.sync_all().map_err(|_| StateFileError::CannotWrite)?;
    drop(file);
    replace_settings_file(&temporary, &path).map_err(|_| StateFileError::CannotWrite)
}

#[cfg(windows)]
fn replace_settings_file(temporary: &Path, target: &Path) -> std::io::Result<()> {
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x00000001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x00000008;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let existing = nul_terminated_wide_path(temporary);
    let new = nul_terminated_wide_path(target);
    if unsafe {
        MoveFileExW(
            existing.as_ptr(),
            new.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_settings_file(temporary: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(windows)]
fn nul_terminated_wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn path(name: &str) -> PathBuf {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "matcha-environment-settings-{name}-{}-{id}",
            std::process::id()
        ))
    }

    fn desired(mode: BrowserMode, proxy_enabled: bool, server: &str) -> Desired {
        Desired {
            browser_mode: mode,
            proxy: super::super::desired::Proxy {
                enabled: proxy_enabled,
                server: server.to_owned(),
                bypass_rules: "<local>;localhost;127.0.0.1;::1".into(),
            },
            launch_at_startup: false,
            gateway_auto_start: true,
        }
    }

    #[test]
    fn duplicate_correlation_replays_rejected_as_unknown() {
        let root = path("replay-rejected");
        let _ = fs::remove_dir_all(&root);

        let mut state = DesiredState::open(&root).unwrap();
        let (revision, outcome) = state.replace(
            "correlation:rejected".into(),
            desired(BrowserMode::Relay, false, ""),
        );
        assert_eq!(outcome, None);
        state.settle(revision, Outcome::Rejected);

        let (_, replayed) = state.replace(
            "correlation:rejected".into(),
            desired(BrowserMode::Native, true, "127.0.0.1:8080"),
        );
        assert_eq!(replayed, Some(Outcome::Unknown));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replace_then_settle_can_replace_existing_state_file() {
        let root = path("replace-existing");
        let _ = fs::remove_dir_all(&root);

        let mut state = DesiredState::open(&root).unwrap();
        let (first_revision, first_outcome) = state.replace(
            "correlation:first".into(),
            desired(BrowserMode::Relay, false, ""),
        );
        assert_eq!(first_revision, 1);
        assert_eq!(first_outcome, None);
        state.settle(first_revision, Outcome::Confirmed);

        let (second_revision, second_outcome) = state.replace(
            "correlation:second".into(),
            desired(BrowserMode::Native, true, "127.0.0.1:8080"),
        );
        assert_eq!(second_revision, 2);
        assert_eq!(second_outcome, None);
        state.settle(second_revision, Outcome::Confirmed);
        drop(state);

        let state = DesiredState::open(&root).unwrap();
        let snapshot = state.desired_snapshot();
        assert_eq!(snapshot.browser_mode(), BrowserMode::Native);
        assert!(snapshot.proxy_enabled());
        assert_eq!(snapshot.proxy_server(), "127.0.0.1:8080");
        assert!(state.pending().is_none());

        let _ = fs::remove_dir_all(root);
    }
}
