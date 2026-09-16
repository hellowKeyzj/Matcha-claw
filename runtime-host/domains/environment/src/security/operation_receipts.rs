use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const STATE_FILE: &str = "security-operation-receipts.v1.json";
const MAX_STATE_BYTES: u64 = 512 * 1024;
const MAX_RECEIPTS: usize = 128;

#[derive(Clone, Debug, PartialEq)]
pub enum SecurityOperationOutcome {
    Confirmed(Value),
    Rejected,
    Unavailable,
    Unknown,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    receipts: Vec<PersistedReceipt>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReceipt {
    correlation: String,
    outcome: PersistedOutcome,
    body: Option<Value>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedOutcome {
    Pending,
    Confirmed,
    Rejected,
    Unavailable,
    Unknown,
}

pub struct SecurityOperationReceiptStore {
    path: PathBuf,
    state: Mutex<PersistedState>,
}

impl SecurityOperationReceiptStore {
    pub fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(STATE_FILE);
        Ok(Self {
            state: Mutex::new(load(&path)?),
            path,
        })
    }

    pub fn recover_pending(&self) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        let mut changed = false;
        for receipt in &mut state.receipts {
            if receipt.outcome == PersistedOutcome::Pending {
                receipt.outcome = PersistedOutcome::Unknown;
                receipt.body = None;
                changed = true;
            }
        }
        changed.then(|| persist(&self.path, &state)).transpose()?;
        Ok(())
    }

    pub fn begin(&self, correlation: &str) -> Result<Option<SecurityOperationOutcome>, ()> {
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
            outcome: PersistedOutcome::Pending,
            body: None,
        });
        trim_receipts(&mut state.receipts);
        persist(&self.path, &state)?;
        Ok(None)
    }

    pub fn settle(&self, correlation: &str, outcome: SecurityOperationOutcome) -> Result<(), ()> {
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
                outcome: PersistedOutcome::Pending,
                body: None,
            };
            write_outcome(&mut receipt, outcome);
            state.receipts.push(receipt);
            trim_receipts(&mut state.receipts);
        }
        persist(&self.path, &state)
    }
}

fn receipt_outcome(receipt: &PersistedReceipt) -> SecurityOperationOutcome {
    match receipt.outcome {
        PersistedOutcome::Confirmed => receipt
            .body
            .clone()
            .map(SecurityOperationOutcome::Confirmed)
            .unwrap_or(SecurityOperationOutcome::Unknown),
        PersistedOutcome::Rejected => SecurityOperationOutcome::Rejected,
        PersistedOutcome::Unavailable => SecurityOperationOutcome::Unavailable,
        PersistedOutcome::Pending | PersistedOutcome::Unknown => SecurityOperationOutcome::Unknown,
    }
}

fn write_outcome(receipt: &mut PersistedReceipt, outcome: SecurityOperationOutcome) {
    match outcome {
        SecurityOperationOutcome::Confirmed(body) => {
            receipt.outcome = PersistedOutcome::Confirmed;
            receipt.body = Some(body);
        }
        SecurityOperationOutcome::Rejected => {
            receipt.outcome = PersistedOutcome::Rejected;
            receipt.body = None;
        }
        SecurityOperationOutcome::Unavailable => {
            receipt.outcome = PersistedOutcome::Unavailable;
            receipt.body = None;
        }
        SecurityOperationOutcome::Unknown => {
            receipt.outcome = PersistedOutcome::Unknown;
            receipt.body = None;
        }
    }
}

fn trim_receipts(receipts: &mut Vec<PersistedReceipt>) {
    if receipts.len() > MAX_RECEIPTS {
        receipts.drain(..receipts.len() - MAX_RECEIPTS);
    }
}

fn load(path: &Path) -> Result<PersistedState, ()> {
    let temporary = path.with_extension("tmp");
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    if fs::metadata(path).map_err(|_| ())?.len() > MAX_STATE_BYTES {
        return Err(());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| ())?).map_err(|_| ())
}

fn persist(path: &Path, state: &PersistedState) -> Result<(), ()> {
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(());
    }
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| ())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    drop(file);
    crate::persistence::replace_file(&temporary, path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "security-operation-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn duplicate_operation_returns_settled_owner_outcome() {
        let root = temp_root("duplicate");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityOperationReceiptStore::open(&root).unwrap();

        assert_eq!(store.begin("same-operation").unwrap(), None);
        store
            .settle(
                "same-operation",
                SecurityOperationOutcome::Confirmed(serde_json::json!({"backend":"security-core"})),
            )
            .unwrap();
        assert_eq!(
            store.begin("same-operation").unwrap(),
            Some(SecurityOperationOutcome::Confirmed(
                serde_json::json!({"backend":"security-core"})
            ))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_marks_pending_operation_unknown_without_replay() {
        let root = temp_root("recovery");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = SecurityOperationReceiptStore::open(&root).unwrap();
        assert_eq!(store.begin("pending-operation").unwrap(), None);
        drop(store);

        let store = SecurityOperationReceiptStore::open(&root).unwrap();
        store.recover_pending().unwrap();
        assert_eq!(
            store.begin("pending-operation").unwrap(),
            Some(SecurityOperationOutcome::Unknown)
        );

        let _ = fs::remove_dir_all(root);
    }
}
