use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::policy::SecurityPolicyDesired;

const STATE_FILE: &str = "security-policy.v1.json";
const MAX_STATE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityPolicyDeliveryOutcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityPolicyDeliverySettlement {
    revision: u64,
    outcome: SecurityPolicyDeliveryOutcome,
}

impl SecurityPolicyDeliverySettlement {
    pub const fn new(revision: u64, outcome: SecurityPolicyDeliveryOutcome) -> Self {
        Self { revision, outcome }
    }

    pub const fn revision(self) -> u64 {
        self.revision
    }

    pub const fn outcome(self) -> SecurityPolicyDeliveryOutcome {
        self.outcome
    }
}

impl SecurityPolicyDeliveryOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesired {
    revision: u64,
    policy: Value,
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

impl Default for PersistedDesired {
    fn default() -> Self {
        Self {
            revision: 0,
            policy: SecurityPolicyDesired::default().into_policy(),
            effect: PersistedEffect::Pending,
            correlations: Vec::new(),
        }
    }
}

pub struct SecurityPolicyDeliveryStore {
    path: PathBuf,
    state: Mutex<PersistedDesired>,
}

impl SecurityPolicyDeliveryStore {
    pub fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(STATE_FILE);
        let state = load(&path)?;
        Ok(Self {
            state: Mutex::new(state),
            path,
        })
    }

    pub fn replace(
        &self,
        correlation: &str,
        desired: SecurityPolicyDesired,
    ) -> Result<(u64, Option<SecurityPolicyDeliveryOutcome>), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.correlations.iter().any(|known| known == correlation) {
            return Ok((state.revision, Some(effect_outcome(state.effect))));
        }
        state.revision = state.revision.checked_add(1).ok_or(())?;
        state.policy = desired.into_policy();
        state.effect = PersistedEffect::Pending;
        remember(&mut state.correlations, correlation);
        persist(&self.path, &state)?;
        Ok((state.revision, None))
    }

    pub fn settle(&self, revision: u64, outcome: SecurityPolicyDeliveryOutcome) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.revision != revision {
            return Ok(());
        }
        state.effect = match outcome {
            SecurityPolicyDeliveryOutcome::Confirmed => PersistedEffect::Confirmed,
            SecurityPolicyDeliveryOutcome::Rejected => PersistedEffect::Rejected,
            SecurityPolicyDeliveryOutcome::Unknown => PersistedEffect::Unknown,
        };
        persist(&self.path, &state)
    }

    pub fn pending(&self) -> Result<Option<(u64, SecurityPolicyDesired)>, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        Ok((state.effect == PersistedEffect::Pending)
            .then_some((
                state.revision,
                SecurityPolicyDesired::try_from_policy(&state.policy)?,
            ))
            .filter(|(revision, _)| *revision > 0))
    }

    pub fn policy(&self) -> Result<Value, ()> {
        Ok(self.state.lock().map_err(|_| ())?.policy.clone())
    }
}

fn effect_outcome(effect: PersistedEffect) -> SecurityPolicyDeliveryOutcome {
    match effect {
        PersistedEffect::Confirmed => SecurityPolicyDeliveryOutcome::Confirmed,
        PersistedEffect::Pending | PersistedEffect::Rejected | PersistedEffect::Unknown => {
            SecurityPolicyDeliveryOutcome::Unknown
        }
    }
}

fn remember(correlations: &mut Vec<String>, correlation: &str) {
    correlations.push(correlation.into());
    if correlations.len() > 128 {
        correlations.drain(..correlations.len() - 128);
    }
}

fn load(path: &Path) -> Result<PersistedDesired, ()> {
    let temporary = path.with_extension("tmp");
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if !path.exists() {
        return Ok(PersistedDesired::default());
    }
    if fs::metadata(path).map_err(|_| ())?.len() > MAX_STATE_BYTES {
        return Err(());
    }
    let mut state: PersistedDesired =
        serde_json::from_slice(&fs::read(path).map_err(|_| ())?).map_err(|_| ())?;
    state.policy = SecurityPolicyDesired::try_from_policy(&state.policy)?.into_policy();
    Ok(state)
}

fn persist(path: &Path, state: &PersistedDesired) -> Result<(), ()> {
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(());
    }
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    drop(file);
    crate::persistence::replace_file(&temporary, path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_correlation_replays_rejected_policy_as_unknown() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-rejected-replay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityPolicyDeliveryStore::open(&root).unwrap();
        let desired = SecurityPolicyDesired::try_from_wire(&serde_json::json!({
            "input": { "policy": { "preset": "strict", "securityPolicyVersion": 1, "runtime": {} } }
        }))
        .unwrap();
        let (revision, replayed) = store.replace("rejected", desired.clone()).unwrap();
        assert_eq!(replayed, None);
        store
            .settle(revision, SecurityPolicyDeliveryOutcome::Rejected)
            .unwrap();

        let (_, replayed) = store.replace("rejected", desired).unwrap();
        assert_eq!(replayed, Some(SecurityPolicyDeliveryOutcome::Unknown));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_temporary_state_is_not_loaded_as_durable_state() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(STATE_FILE);
        fs::write(path.with_extension("tmp"), b"not durable").unwrap();
        let store = SecurityPolicyDeliveryStore::open(&root).unwrap();
        assert!(!path.with_extension("tmp").exists());
        let policy = match store.policy() {
            Ok(policy) => policy,
            Err(()) => panic!("fresh security owner policy must be readable"),
        };
        assert_eq!(policy["preset"], "relaxed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persisted_policy_is_normalized_before_reads() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-normalized-read-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(STATE_FILE),
            serde_json::to_vec(&serde_json::json!({
                "revision": 7,
                "policy": {
                    "preset": "balanced",
                    "securityPolicyVersion": 2,
                    "runtime": {
                        "allowDomains": [" api.example.com ", "api.example.com"]
                    }
                },
                "effect": "confirmed",
                "correlations": []
            }))
            .unwrap(),
        )
        .unwrap();

        let store = SecurityPolicyDeliveryStore::open(&root).unwrap();
        let policy = store.policy().unwrap();
        let runtime = &policy["runtime"];
        assert_eq!(policy["preset"], "balanced");
        assert_eq!(
            runtime["allowDomains"],
            serde_json::json!(["api.example.com"])
        );
        assert!(runtime["secrets"].is_object());
        assert!(runtime["secretPatterns"].is_array());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_security_effect_is_not_reopened_for_replay() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityPolicyDeliveryStore::open(&root).unwrap();
        let desired = SecurityPolicyDesired::try_from_wire(&serde_json::json!({
            "input": { "policy": { "preset": "relaxed", "securityPolicyVersion": 1, "runtime": {} } }
        })).unwrap();
        let (revision, _) = store.replace("pending", desired).unwrap();
        assert_eq!(
            store
                .pending()
                .unwrap()
                .map(|(pending_revision, _)| pending_revision),
            Some(revision)
        );
        store
            .settle(revision, SecurityPolicyDeliveryOutcome::Unknown)
            .unwrap();
        assert_eq!(store.pending().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }
}
