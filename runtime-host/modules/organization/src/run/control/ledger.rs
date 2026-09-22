use std::collections::BTreeMap;

use super::ControlNodeResolution;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ControlResolutionLedger {
    resolutions: BTreeMap<String, ControlNodeResolution>,
}

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
        self.resolutions
            .retain(|_, resolution| resolution.graph_run_id() != run_id);
    }

    pub(crate) fn record(&mut self, resolution: ControlNodeResolution) -> ControlResolutionRecord {
        let key = resolution.idempotency_key().to_owned();
        match self.resolutions.get(&key) {
            Some(existing) if existing == &resolution => ControlResolutionRecord::Replayed,
            Some(_) => ControlResolutionRecord::Conflicting,
            None => {
                self.resolutions.insert(key, resolution);
                ControlResolutionRecord::Recorded
            }
        }
    }
}
