use std::collections::BTreeMap;

use super::ControlNodeResolution;

#[derive(Clone, Debug, Default)]
pub struct ControlResolutionLedger {
    resolutions: BTreeMap<String, ControlNodeResolution>,
    transaction: Option<BTreeMap<String, Option<ControlNodeResolution>>>,
}

impl PartialEq for ControlResolutionLedger {
    fn eq(&self, other: &Self) -> bool { self.resolutions == other.resolutions }
}
impl Eq for ControlResolutionLedger {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlResolutionRecord {
    Recorded,
    Replayed,
    Conflicting,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreControlResolutionLedgerError {
    DuplicateIdempotencyKey,
}

impl ControlResolutionLedger {
    pub(crate) fn begin_transaction(&mut self) {
        if self.transaction.is_none() { self.transaction = Some(BTreeMap::new()); }
    }
    pub(crate) fn commit_transaction(&mut self) { self.transaction = None; }
    pub(crate) fn rollback_transaction(&mut self) {
        if let Some(transaction) = self.transaction.take() {
            for (key, previous) in transaction {
                match previous {
                    Some(value) => { self.resolutions.insert(key, value); }
                    None => { self.resolutions.remove(&key); }
                }
            }
        }
    }
    pub(crate) fn changed_keys(&self) -> impl Iterator<Item = &String> {
        self.transaction.iter().flat_map(|transaction| transaction.keys())
    }
    pub(crate) fn import_record(&mut self, resolution: ControlNodeResolution) {
        self.resolutions.insert(resolution.idempotency_key().to_owned(), resolution);
    }
    pub(crate) fn remove_record(&mut self, key: &str) { self.resolutions.remove(key); }
    pub fn resolution(&self, idempotency_key: &str) -> Option<&ControlNodeResolution> {
        self.resolutions.get(idempotency_key)
    }

    pub fn resolutions(&self) -> impl Iterator<Item = &ControlNodeResolution> {
        self.resolutions.values()
    }

    pub(crate) fn restore(
        resolutions: impl IntoIterator<Item = ControlNodeResolution>,
    ) -> Result<Self, RestoreControlResolutionLedgerError> {
        let mut ledger = Self::default();
        for resolution in resolutions {
            let key = resolution.idempotency_key().to_owned();
            if ledger.resolutions.insert(key, resolution).is_some() {
                return Err(RestoreControlResolutionLedgerError::DuplicateIdempotencyKey);
            }
        }
        Ok(ledger)
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &crate::GraphRunId) {
        self.resolutions.retain(|key, resolution| {
            if resolution.graph_run_id() != run_id { return true; }
            if let Some(transaction) = &mut self.transaction {
                transaction.entry(key.clone()).or_insert_with(|| Some(resolution.clone()));
            }
            false
        });
    }

    pub(crate) fn record(&mut self, resolution: ControlNodeResolution) -> ControlResolutionRecord {
        let key = resolution.idempotency_key().to_owned();
        match self.resolutions.get(&key) {
            Some(existing) if existing == &resolution => ControlResolutionRecord::Replayed,
            Some(_) => ControlResolutionRecord::Conflicting,
            None => {
                if let Some(transaction) = &mut self.transaction { transaction.entry(key.clone()).or_insert(None); }
                self.resolutions.insert(key, resolution);
                ControlResolutionRecord::Recorded
            }
        }
    }
}
