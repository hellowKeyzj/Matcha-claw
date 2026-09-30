use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    delivery::{self, Outcome as SecurityPolicyDeliveryOutcome},
    domain::model::SecurityPolicyDesired,
    operation,
};

const POLICY_STATE_FILE: &str = "security-policy.v1.json";
const POLICY_STATE_MAX_BYTES: u64 = 256 * 1024;
const RECEIPT_STATE_FILE: &str = "security-operation-receipts.v1.json";
const RECEIPT_STATE_MAX_BYTES: u64 = 512 * 1024;
const MAX_CORRELATIONS: usize = 128;
const MAX_RECEIPTS: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesired {
    revision: u64,
    policy: Value,
    effect: PersistedDeliveryEffect,
    correlations: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedDeliveryEffect {
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
            effect: PersistedDeliveryEffect::Pending,
            correlations: Vec::new(),
        }
    }
}

pub(crate) struct SecurityPolicyDeliveryStore {
    path: PathBuf,
    state: Mutex<PersistedDesired>,
}

impl SecurityPolicyDeliveryStore {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(POLICY_STATE_FILE);
        Ok(Self {
            state: Mutex::new(load_policy(&path)?),
            path,
        })
    }

    pub(crate) fn replace(
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
        state.effect = PersistedDeliveryEffect::Pending;
        remember(&mut state.correlations, correlation);
        persist(&self.path, &*state, POLICY_STATE_MAX_BYTES)?;
        Ok((state.revision, None))
    }

    pub(crate) fn settle(&self, settlement: delivery::Settlement) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.revision != settlement.revision {
            return Ok(());
        }
        state.effect = match settlement.outcome {
            SecurityPolicyDeliveryOutcome::Confirmed => PersistedDeliveryEffect::Confirmed,
            SecurityPolicyDeliveryOutcome::Rejected => PersistedDeliveryEffect::Rejected,
            SecurityPolicyDeliveryOutcome::Unknown => PersistedDeliveryEffect::Unknown,
        };
        persist(&self.path, &*state, POLICY_STATE_MAX_BYTES)
    }

    pub(crate) fn pending(&self) -> Result<Option<(u64, SecurityPolicyDesired)>, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        Ok((state.effect == PersistedDeliveryEffect::Pending)
            .then_some((
                state.revision,
                SecurityPolicyDesired::try_from_policy(&state.policy)?,
            ))
            .filter(|(revision, _)| *revision > 0))
    }

    pub(crate) fn policy(&self) -> Result<Value, ()> {
        Ok(self.state.lock().map_err(|_| ())?.policy.clone())
    }
}

fn effect_outcome(effect: PersistedDeliveryEffect) -> SecurityPolicyDeliveryOutcome {
    match effect {
        PersistedDeliveryEffect::Confirmed => SecurityPolicyDeliveryOutcome::Confirmed,
        PersistedDeliveryEffect::Pending
        | PersistedDeliveryEffect::Rejected
        | PersistedDeliveryEffect::Unknown => SecurityPolicyDeliveryOutcome::Unknown,
    }
}

fn remember(correlations: &mut Vec<String>, correlation: &str) {
    correlations.push(correlation.into());
    if correlations.len() > MAX_CORRELATIONS {
        correlations.drain(..correlations.len() - MAX_CORRELATIONS);
    }
}

fn load_policy(path: &Path) -> Result<PersistedDesired, ()> {
    cleanup_temporary(path)?;
    if !path.exists() {
        return Ok(PersistedDesired::default());
    }
    if fs::metadata(path).map_err(|_| ())?.len() > POLICY_STATE_MAX_BYTES {
        return Err(());
    }
    let mut state: PersistedDesired =
        serde_json::from_slice(&fs::read(path).map_err(|_| ())?).map_err(|_| ())?;
    state.policy = SecurityPolicyDesired::try_from_policy(&state.policy)?.into_policy();
    Ok(state)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReceipts {
    receipts: Vec<PersistedReceipt>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReceipt {
    correlation: String,
    outcome: PersistedOperationOutcome,
    body: Option<Value>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedOperationOutcome {
    Pending,
    Confirmed,
    Rejected,
    Unavailable,
    Unknown,
}

pub(crate) struct SecurityOperationReceiptStore {
    path: PathBuf,
    state: Mutex<PersistedReceipts>,
}

impl SecurityOperationReceiptStore {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(RECEIPT_STATE_FILE);
        Ok(Self {
            state: Mutex::new(load_receipts(&path)?),
            path,
        })
    }

    pub(crate) fn recover_pending(&self) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        let mut changed = false;
        for receipt in &mut state.receipts {
            if receipt.outcome == PersistedOperationOutcome::Pending {
                receipt.outcome = PersistedOperationOutcome::Unknown;
                receipt.body = None;
                changed = true;
            }
        }
        changed
            .then(|| persist(&self.path, &*state, RECEIPT_STATE_MAX_BYTES))
            .transpose()?;
        Ok(())
    }

    pub(crate) fn receipt(&self, correlation: &str) -> Result<Option<operation::Outcome>, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        Ok(state.receipts.iter().find(|receipt| receipt.correlation == correlation)
            .filter(|receipt| receipt.outcome != PersistedOperationOutcome::Pending)
            .map(receipt_outcome))
    }

    pub(crate) fn begin(&self, correlation: &str) -> Result<Option<operation::Outcome>, ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if let Some(receipt) = state
            .receipts
            .iter()
            .find(|receipt| receipt.correlation == correlation)
        {
            return Ok(Some(receipt_outcome(receipt)));
        }
        state.receipts.push(PersistedReceipt {
            correlation: correlation.into(),
            outcome: PersistedOperationOutcome::Pending,
            body: None,
        });
        trim_receipts(&mut state.receipts);
        persist(&self.path, &*state, RECEIPT_STATE_MAX_BYTES)?;
        Ok(None)
    }

    pub(crate) fn settle(&self, correlation: &str, outcome: operation::Outcome) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if let Some(receipt) = state
            .receipts
            .iter_mut()
            .find(|receipt| receipt.correlation == correlation)
        {
            write_outcome(receipt, outcome);
        } else {
            let mut receipt = PersistedReceipt {
                correlation: correlation.into(),
                outcome: PersistedOperationOutcome::Pending,
                body: None,
            };
            write_outcome(&mut receipt, outcome);
            state.receipts.push(receipt);
            trim_receipts(&mut state.receipts);
        }
        persist(&self.path, &*state, RECEIPT_STATE_MAX_BYTES)
    }
}

fn receipt_outcome(receipt: &PersistedReceipt) -> operation::Outcome {
    match receipt.outcome {
        PersistedOperationOutcome::Confirmed => receipt
            .body
            .clone()
            .map(operation::Outcome::Confirmed)
            .unwrap_or(operation::Outcome::Unknown),
        PersistedOperationOutcome::Rejected => operation::Outcome::Rejected,
        PersistedOperationOutcome::Unavailable => operation::Outcome::Unavailable,
        PersistedOperationOutcome::Pending | PersistedOperationOutcome::Unknown => {
            operation::Outcome::Unknown
        }
    }
}

fn write_outcome(receipt: &mut PersistedReceipt, outcome: operation::Outcome) {
    match outcome {
        operation::Outcome::Confirmed(body) => {
            receipt.outcome = PersistedOperationOutcome::Confirmed;
            receipt.body = Some(body);
        }
        operation::Outcome::Rejected => {
            receipt.outcome = PersistedOperationOutcome::Rejected;
            receipt.body = None;
        }
        operation::Outcome::Unavailable => {
            receipt.outcome = PersistedOperationOutcome::Unavailable;
            receipt.body = None;
        }
        operation::Outcome::Unknown => {
            receipt.outcome = PersistedOperationOutcome::Unknown;
            receipt.body = None;
        }
    }
}

fn trim_receipts(receipts: &mut Vec<PersistedReceipt>) {
    if receipts.len() > MAX_RECEIPTS {
        receipts.drain(..receipts.len() - MAX_RECEIPTS);
    }
}

fn load_receipts(path: &Path) -> Result<PersistedReceipts, ()> {
    cleanup_temporary(path)?;
    if !path.exists() {
        return Ok(PersistedReceipts::default());
    }
    if fs::metadata(path).map_err(|_| ())?.len() > RECEIPT_STATE_MAX_BYTES {
        return Err(());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| ())?).map_err(|_| ())
}

fn cleanup_temporary(path: &Path) -> Result<(), ()> {
    let temporary = path.with_extension("tmp");
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    Ok(())
}

fn persist<T: Serialize>(path: &Path, state: &T, max_bytes: u64) -> Result<(), ()> {
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() as u64 > max_bytes {
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
    replace_file(&temporary, path)
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), ()> {
    if cfg!(windows) {
        let backup = destination.with_extension("bak");
        let _ = fs::remove_file(&backup);
        if destination.exists() {
            fs::rename(destination, &backup).map_err(|_| ())?;
        }
        match fs::rename(source, destination) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                Ok(())
            }
            Err(_) => {
                if backup.exists() {
                    let _ = fs::rename(&backup, destination);
                }
                Err(())
            }
        }
    } else {
        fs::rename(source, destination).map_err(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "security-store-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn duplicate_correlation_replays_rejected_policy_as_unknown() {
        let root = temp_root("delivery-rejected-replay");
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
            .settle(delivery::Settlement {
                revision,
                outcome: SecurityPolicyDeliveryOutcome::Rejected,
            })
            .unwrap();

        let (_, replayed) = store.replace("rejected", desired).unwrap();
        assert_eq!(replayed, Some(SecurityPolicyDeliveryOutcome::Unknown));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_temporary_state_is_not_loaded_as_durable_state() {
        let root = temp_root("delivery-tmp");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(POLICY_STATE_FILE);
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
        let root = temp_root("delivery-normalized-read");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(POLICY_STATE_FILE),
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
        let root = temp_root("delivery-recovery");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityPolicyDeliveryStore::open(&root).unwrap();
        let desired = SecurityPolicyDesired::try_from_wire(&serde_json::json!({
            "input": { "policy": { "preset": "relaxed", "securityPolicyVersion": 1, "runtime": {} } }
        }))
        .unwrap();
        let (revision, _) = store.replace("pending", desired).unwrap();
        assert_eq!(
            store
                .pending()
                .unwrap()
                .map(|(pending_revision, _)| pending_revision),
            Some(revision)
        );
        store
            .settle(delivery::Settlement {
                revision,
                outcome: SecurityPolicyDeliveryOutcome::Unknown,
            })
            .unwrap();
        assert_eq!(store.pending().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_operation_returns_settled_owner_outcome() {
        let root = temp_root("operation-duplicate");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityOperationReceiptStore::open(&root).unwrap();

        assert_eq!(store.begin("same-operation").unwrap(), None);
        store
            .settle(
                "same-operation",
                operation::Outcome::Confirmed(serde_json::json!({"backend":"security-core"})),
            )
            .unwrap();
        assert_eq!(
            store.begin("same-operation").unwrap(),
            Some(operation::Outcome::Confirmed(
                serde_json::json!({"backend":"security-core"})
            ))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_marks_pending_operation_unknown_without_replay() {
        let root = temp_root("operation-recovery");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityOperationReceiptStore::open(&root).unwrap();
        assert_eq!(store.begin("pending-operation").unwrap(), None);
        drop(store);

        let store = SecurityOperationReceiptStore::open(&root).unwrap();
        store.recover_pending().unwrap();
        assert_eq!(
            store.begin("pending-operation").unwrap(),
            Some(operation::Outcome::Unknown)
        );

        let _ = fs::remove_dir_all(root);
    }
}
