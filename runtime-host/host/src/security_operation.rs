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
pub(crate) enum Outcome {
    Confirmed(Value),
    Rejected,
    Unavailable,
    Unknown,
}

impl Outcome {
    pub(crate) fn from_native(effect: openclaw::operations::SecurityActionEffect) -> Self {
        match effect {
            openclaw::operations::SecurityActionEffect::Applied(value) => Self::Confirmed(value),
            openclaw::operations::SecurityActionEffect::RuntimeRejected => Self::Rejected,
            openclaw::operations::SecurityActionEffect::Unavailable => Self::Unavailable,
            openclaw::operations::SecurityActionEffect::OutcomeUnknown => Self::Unknown,
        }
    }
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

pub(crate) struct Owner {
    path: PathBuf,
    state: Mutex<PersistedState>,
    effect: tokio::sync::Mutex<()>,
}

impl Owner {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(STATE_FILE);
        Ok(Self {
            state: Mutex::new(load(&path)?),
            path,
            effect: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) async fn serialize_effect<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
    ) -> T {
        let _effect = self.effect.lock().await;
        operation.await
    }

    pub(crate) fn recover_pending(&self) -> Result<(), ()> {
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

    pub(crate) fn begin(&self, correlation: &str) -> Result<Option<Outcome>, ()> {
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

    pub(crate) fn settle(&self, correlation: &str, outcome: Outcome) -> Result<(), ()> {
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

fn receipt_outcome(receipt: &PersistedReceipt) -> Outcome {
    match receipt.outcome {
        PersistedOutcome::Confirmed => receipt
            .body
            .clone()
            .map(Outcome::Confirmed)
            .unwrap_or(Outcome::Unknown),
        PersistedOutcome::Rejected => Outcome::Rejected,
        PersistedOutcome::Unavailable => Outcome::Unavailable,
        PersistedOutcome::Pending | PersistedOutcome::Unknown => Outcome::Unknown,
    }
}

fn write_outcome(receipt: &mut PersistedReceipt, outcome: Outcome) {
    match outcome {
        Outcome::Confirmed(body) => {
            receipt.outcome = PersistedOutcome::Confirmed;
            receipt.body = Some(body);
        }
        Outcome::Rejected => {
            receipt.outcome = PersistedOutcome::Rejected;
            receipt.body = None;
        }
        Outcome::Unavailable => {
            receipt.outcome = PersistedOutcome::Unavailable;
            receipt.body = None;
        }
        Outcome::Unknown => {
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
    fs::write(&temporary, bytes).map_err(|_| ())?;
    fs::rename(&temporary, path).map_err(|_| ())
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
        let owner = Owner::open(&root).unwrap();

        assert_eq!(owner.begin("same-operation").unwrap(), None);
        owner
            .settle(
                "same-operation",
                Outcome::Confirmed(serde_json::json!({"backend":"security-core"})),
            )
            .unwrap();
        assert_eq!(
            owner.begin("same-operation").unwrap(),
            Some(Outcome::Confirmed(
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
        let owner = Owner::open(&root).unwrap();
        assert_eq!(owner.begin("pending-operation").unwrap(), None);
        drop(owner);

        let owner = Owner::open(&root).unwrap();
        owner.recover_pending().unwrap();
        assert_eq!(
            owner.begin("pending-operation").unwrap(),
            Some(Outcome::Unknown)
        );

        let _ = fs::remove_dir_all(root);
    }
}
